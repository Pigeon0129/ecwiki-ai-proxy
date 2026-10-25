# EaseCation Wiki AI 助手 — 反代研究笔记

目标：`https://wiki.easecation.net` 的站内 AI 助手。
结论：它不是一个普通的聊天页面，而是 **iframe 套一个独立 SPA + 独立后端**，且**强制要求 MediaWiki 登录态**。

---

## 1. 页面是怎么挂上去的

`wiki.easecation.net/Wiki_AI` 这个词条的 wikitext 只有一行：

```wikitext
{{#微件:覆盖页面为URL
|url=https://service.wiki.easecation.net/ai}}
```

- `#微件:` 是 Widget 扩展（外部站点 `service.wiki.easecation.net` 的页面被拉进来）。
- `覆盖页面为URL` 是一种"把这个词条整页替换掉"的用法 —— 所以直接抓 Wiki_AI 的 HTML 拿不到内容，
  必须走 `api.php?action=query&titles=Wiki%20AI&prop=revisions&rvprop=content` 读原文才看得到。

另有 `Wiki_Service` 词条指向 `https://service.wiki.easecation.net/`（Wiki 的站外服务首页）。

## 2. 三层结构

```
wiki.easecation.net          MediaWiki 本体（登录态在这里签发）
        └── iframe
service.wiki.easecation.net  「Wiki Service」前端，一个 Vite+React SPA
        ├── /ai/               AI 助手页面（lazy chunk: assets/AIChat-*.js）
        └── 静态资源托管在阿里云 OSS + CDN（响应头 x-oss-request-id、Tengine）
                │  fetch(..., {credentials:"include"})
                ▼
api.wiki.easecation.net      真正的后端（阿里云函数计算 FC，响应头 X-Fc-Request-Id）
        ├── POST /ai/v1/responses
        ├── GET  /ai/quota
        └── GET  /user
```

注意 `service.wiki.easecation.net` **只是静态站**：抓 `/ai/` 返回的是 649 字节的 `index.html`，
所有 `/assets/*.js` 也都是 OSS 直出。**真正的 AI 逻辑全在 `api.wiki.easecation.net`。**

## 3. 后端接口（逆向自 `assets/AIChat-uScBIgGa.js`）

### 3.1 `POST https://api.wiki.easecation.net/ai/v1/responses`

请求体由调用方构造（`index-DQbQH65q.js`）：

```js
await R({ input: r, session_id: h, stream: true }, evt => { ... })
```

- `input`：用户输入字符串
- `session_id`：会话 id，**首轮不传**，由服务端通过 SSE 注释行下发
- `stream: true`：必填，该接口是 SSE

完整 curl（把 Cookie 换成自己的）：

```bash
curl -N 'https://api.wiki.easecation.net/ai/v1/responses' \
  -H 'content-type: application/json' \
  -H 'origin: https://wiki.easecation.net' \
  -H 'referer: https://wiki.easecation.net/ai/' \
  -H 'cookie: ec_wiki_session=...; ec_wikiUserName=...; ec_wikiUserID=...; ec_wikiToken=...' \
  --data '{"input":"起床战争怎么玩","stream":true}'
```

### 3.2 响应：SSE，两种行格式

**A. 注释行下发 session_id（注意是 `:` 开头的 SSE 注释，不是 `data:`）**

```
:sessionId: 0b9f...-xxxx
```

前端解析逻辑：`if (u.startsWith(":sessionId:")) { ... }`。

**B. `data:` 数据行，JSON 事件，共 5 种**

| `type` | 字段 | 含义 |
|---|---|---|
| `meta.session_id` | `sessionId` | 前端把 `:sessionId:` 注释行转成这个事件；后续请求回传 |
| `response.tool_call` | `name`, `arguments` | AI 开始调用工具（UI 显示「正在搜索/正在调用」卡片） |
| `response.tool_result` | `name`, `output` | 工具返回（UI 显示「工具返回」） |
| `response.output_text.delta` | `delta` | 正文增量，逐字追加 |
| `response.completed` | `response.output[0].content[0].text`、`response.session_id` | 结束，附完整文本与最终 session id |

以 `data: [DONE]` 结束。

这套事件名和 OpenAI 的 **Responses API** 高度对齐（`response.output_text.delta` / `response.completed`），
只是多包了 `tool_call` / `tool_result` 两个事件，并且把 `function_call` 简化成了独立事件。

### 3.3 `GET https://api.wiki.easecation.net/ai/quota`

实测返回：

```json
{"daily_limit": 10, "used_today": 2, "remaining": 8, "resets_at": "2026-10-24T16:00:00Z"}
```

前端渲染为「今日剩余次数：N」。**每人每天 10 次**，`resets_at` 是 UTC 16:00（即北京时间次日 0 点）。

### 3.4 `GET https://api.wiki.easecation.net/user`

实测返回：

```json
{"userinfo":{
  "id":12345,
  "name":"<用户名>",
  "groups":["*","user","autoconfirmed"],
  "registrationdate":"2025-10-28T15:54:03Z"
}}
```

前端拿来显示用户名（失败则显示「游客」）。**这个接口是判断 Cookie 是否有效的硬标准。**

### 3.5 后端模型与工具（实测）

`response.completed` 事件里暴露了真实模型：

```json
{"id":"resp_1792831633","object":"response","model":"qwen3.7-plus","status":"completed", ...}
```

即后端跑的是 **qwen3.7-plus**。它有两个工具，均**由上游自行执行**，我们只收到通知：

| 工具 | 参数 | 作用 |
|---|---|---|
| `query_page` | `{keyword}` | 全文检索 Wiki，返回命中页面列表（ID/字数/更新时间/摘要） |
| `open_page_context` | `{page_name, keyword, context_lines}` | 抓取指定页面里命中正则的段落上下文 |

一次典型提问的事件顺序：`meta.session_id` → `tool_call(query_page)` → `tool_result` →
`tool_call(open_page_context)` → `tool_result` → 若干 `output_text.delta` → `response.completed`。

## 4. 鉴权：这是反代最关键的一点

- 三个接口都是 `credentials: "include"` —— 靠 Cookie，不靠 Bearer token。
- 未登录时后端返回 **401** + `{"success": false, "message": "用户未登录"}`。
- Cookie 前缀是 `ec_wiki`，`Domain=.wiki.easecation.net`（带前导点），所以浏览器会把它们一起发给
  `api.wiki.easecation.net` 和 `service.wiki.easecation.net` —— 这是跨子域免登的原因。

### 4.1 `ec_wikiToken` 到底存不存在？—— 不存在

**你在 F12 里看不到 `ec_wikiToken` 是对的，它大概率根本不是一个真实 cookie。**

依据：匿名访问 `Special:UserLogin`，Wiki 会在 `ec_wiki_session` 之后紧跟四条 `=deleted` 清除指令：

```
Set-Cookie: ec_wiki_session=3a263n...; path=/; domain=.wiki.easecation.net; secure; HttpOnly
Set-Cookie: ec_wiki_session=deleted; expires=...Max-Age=0
Set-Cookie: ec_wikiUserName=deleted; ...
Set-Cookie: ec_wikiUserID=deleted; ...
Set-Cookie: ec_wikiToken=deleted; ...
```

这是 MediaWiki `User::logout()` 的清理逻辑，它对一组**固定名字**无条件下发删除指令，
不管这些 cookie 当前存不存在。所以 `ec_wikiToken` 只是删除流程里出现过的一个**名字**。

### 4.2 各 cookie 的实测结论

用已登录账号实测（`ec_wiki_session=gh5bk...`）：

| Cookie | 是否真实存在 | 是否必需 |
|---|---|---|
| `ec_wiki_session` | ✅ 存在 | ✅ 必需 |
| `ec_wikiUserName` | 未知（本次填了） | 大概率不必需 |
| `ec_wikiUserID` | 未知（本次填了） | 大概率不必需 |
| `ec_wikiToken` | ❌ **不是真实 cookie** | ❌ 不必需 |

> **⚠️ 更正 1（上一版说"先只带 session 大概率就够"是错的）**
> 实测只带 `ec_wiki_session` 一条，`GET /user` 返回 **401**；把 `ec_wikiUserName` / `ec_wikiUserID`
> 一起带上才返回 200。也就是说**后端不只认 session**，至少需要 `ec_wikiUserID` 或 `ec_wikiUserName`。
> 具体是哪一条在起作用尚未逐项拆分验证。
>
> **⚠️ 更正 2（我说这个 session "已失效"也是错的）**
> 我当时拿它去查 MediaWiki 的 `api.php?meta=userinfo`，看到 `id:0, anon` 就判定失效 ——
> **这个判断方法本身是错的**：Wiki 没有按标准 MediaWiki 的 cookie 名下发（它叫 `ec_wiki_session`，
> 而标准是 `wikiSession` 之类，`api.php` 根本不认这个名字）。要验证必须用 `GET /user`，
> 它返回 `id:12345` 就说明**完全有效**。
>
> **结论：判断 Cookie 是否可用，唯一标准是 `GET /user` 返回用户名，不是 F12 里看不看得见，也不是 `api.php` 的说法。**

- 登录流程是 **Wiki 自带的 MediaWiki 原生表单**（`Special:UserLogin`，只提交 `title`/`wpName`/`wpPassword`，
  无隐藏 token 域），**没有走 OAuth / MyEC / 统一用户中心**，页面里没有任何 SSO 跳转；
  Wiki 本体是 MediaWiki 1.43.1（`generator: MediaWiki 1.43.1`）。
- 所以：**反代必须持有某人（账号本人）的登录 Cookie**，没法"免登录白嫖"。

### 上游还做了 Origin 校验

对 `/ai/v1/responses` 发 OPTIONS 预检，返回：

```
Access-Control-Allow-Origin: https://wiki.easecation.net
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: POST
Access-Control-Allow-Headers: content-type
```

即**只允许 wiki 那个 Origin**。服务端大概率同时校验 `Origin`/`Referer` 头，所以反代时这两个头必须伪造。

实测：不带 Cookie 直接 POST，即使带正确 Origin，也是 `401 用户未登录`（说明鉴权在 Origin 校验之前生效，
无法通过改 Origin 绕过）。

## 5. 反代方案

### 5.1 交付物

`proxy.mjs`（本目录）：一个零依赖 Node 脚本（Node ≥ 18，用到内置 `fetch`），提供

| 路由 | 说明 |
|---|---|
| `POST /v1/chat/completions` | **OpenAI 兼容**，支持 `stream`，可直插 ChatGPT-Next-Web / LobeChat / 任意 OpenAI SDK |
| `POST /raw/responses` | 原样透传上游 SSE，保留 `tool_call`/`tool_result` 事件 |
| `GET /v1/models` | 返回 `wiki-ai` |
| `GET /user`、`GET /ai/quota` | 校验 Cookie 是否还有效、看今日剩余次数 |
| `GET /diagnose` | 一次性输出 cookie 名单 + 上游实测结果 + `verdict` |
| `GET /health` | 探活 |

代理**启动时会自动调一次 `/user`**，直接打印「✅ cookie 有效，当前登录用户：xxx」或
「❌ cookie 无效或已过期」，不用你自己猜。另外 `sanitizeCookie()` 会自动剔掉
`=deleted` / 空值 / `yyyy` 这类占位项，避免把 logout 清理痕迹当凭据发出去。

它做了三件事：
1. 注入 `Cookie`、`Origin: https://wiki.easecation.net`、`Referer: https://wiki.easecation.net/ai/`
   （`Origin` 是绕上游 CORS/同源校验的必需项）；
2. 把上游的 Responses 风格 SSE 翻译成 OpenAI Chat Completions 的 chunk 流，
   把 `tool_call`/`tool_result` 映射成 `tool_calls` 和扩展字段 `tool_result`（标准客户端会自动忽略）；
3. 维护 `session_id`（从 `meta.session_id` 事件取，非流式也可以显式传 `session_id` 续聊）——
   不强依赖它，`input` 已经是纯字符串。

### 5.2 跑起来

```bash
cd wiki-ai-proxy
cp .env.example .env      # 填入 WIKI_COOKIE
set -a; source .env; set +a     # Windows PowerShell: $env:WIKI_COOKIE="..."
node proxy.mjs
```

客户端配置：

```
Base URL : http://127.0.0.1:8787/v1
API Key  : (留空，或设了 PROXY_TOKEN 就填它)
Model    : wiki-ai
```

### 5.3 Cookie 怎么拿

1. 浏览器登录 `https://wiki.easecation.net`；
2. F12 → Application/存储 → Cookies → `https://wiki.easecation.net`；
3. 复制 **`ec_wiki_session`**、**`ec_wikiUserName`**、**`ec_wikiUserID`** 三条（**不要去找 `ec_wikiToken`**，
   它不是真实 cookie），拼成一行，值原样粘贴、不要 URL 编码；
4. 启动代理，它**会自己验一次**：

```text
wiki-ai-proxy listening on http://127.0.0.1:8787
  cookie:       已配置 → ec_wiki_session, ec_wikiUserName, ec_wikiUserID
  ✅ cookie 有效，当前登录用户：<用户名>
```

不放心可以随时用 `/diagnose` 看明细：

```bash
curl -s http://127.0.0.1:8787/diagnose | jq
# { "cookie_names": [...],
#   "checks": { "/user": {"status":200, "body":{"userinfo":{"id":12345,"name":"..."}}},
#               "/ai/quota": {"status":200, "body":{"daily_limit":10,"used_today":2,"remaining":8}} },
#   "verdict": "✅ Cookie 有效" }
```

**`GET /user` 返回用户名是判断 Cookie 有效的唯一硬标准。**
（不要用 MediaWiki 的 `api.php?meta=userinfo` 去判 —— 它不认 `ec_wiki_session` 这个名字，
恒返回 `anon`，会误判。）

Cookie 过期后代理会返回 `AUTH: 请先登录 Wiki`，重新登录再取一次即可。

## 6. 注意事项

- **每日额度只有 10 次**（`daily_limit: 10`，UTC 16:00 重置）。实测问三个问题后
  `used_today` 从 2 涨到 5 —— **一次提问可能消耗多次额度**。反代成公用接口会瞬间打光。
  多做实验前先看一眼 `/ai/quota`。
- **工具调用**：`query_page` / `open_page_context` 都是**上游自己执行的**，
  我们只收到 `tool_call` / `tool_result` 通知，不需要也不应该代跑。
- **合规**：这是别人家的服务，Cookie 属于个人账号。反代适合自查 / 个人本地使用；
  公开分发等于把账号额度与责任转给别人，也可能违反 Wiki 使用条款 —— **不要部署到公网**。
- **稳定性**：后端跑在阿里云函数计算上（`X-Fc-Request-Id`），冷启动和超时都由 FC 决定；
  反代侧 `req.signal` 已透传中止。

## 7. 实测记录

| 探测 | 结果 |
|---|---|
| `GET /ai/` 前端页 | 200，649 字节 SPA 壳 |
| `GET /` Wiki_AI 词条 | 200，但内容是"关于 EaseCation…"的通用文案（Scribunto 未渲染），需走 api.php 取源 |
| `OPTIONS /ai/v1/responses` | 200，仅允许 `https://wiki.easecation.net` |
| `POST /ai/v1/responses`（无 Cookie） | **401** `{"success": false, "message": "用户未登录"}` |
| `GET /user`（无 Cookie） | **401** 同上 |
| `GET /ai/quota`（无 Cookie） | **401** 同上 |
| `GET /user`（**只带** `ec_wiki_session`） | **401** → 说明仅 session 不够 |
| `GET /user`（session + userName + userID） | **200** `{"userinfo":{"id":12345,"name":"<用户名>","groups":["*","user","autoconfirmed"]}}` |
| `GET /ai/quota`（同上） | **200** `{"daily_limit":10,"used_today":2,"remaining":8}` |
| `POST /raw/responses` 真实提问 | 完整跑通：`meta.session_id` → 2 组 `tool_call`/`tool_result` → 26 段 `delta` → `response.completed`（`model: qwen3.7-plus`） |
| `POST /v1/chat/completions`（非流式） | 200，正文 + `tool_calls: [query_page, open_page_context]` |
| `POST /v1/chat/completions`（流式） | 200，标准 `chat.completion.chunk` + 扩展 `tool_result` 字段 |
| 本地代理 `/health` `/v1/models` `/diagnose` | 均 200；`/diagnose` 给出 `verdict: ✅ Cookie 有效` |

已全部实测通过。唯一未逐项拆分的是：`ec_wikiUserName` 与 `ec_wikiUserID` 到底哪一条必需
（只测过"三条都要"和"只有 session 不行"两种组合）。
