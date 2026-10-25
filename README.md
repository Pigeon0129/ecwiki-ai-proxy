# ecwiki-ai-proxy
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-43853D?style=for-the-badge&logo=node.js&logoColor=white)

把 [EaseCation Wiki](https://wiki.easecation.net) 站内 AI 助手 反代成 **OpenAI 兼容接口**，
让你能在 ChatGPT-Next-Web / LobeChat / Cherry Studio / 任何 OpenAI SDK 里直接用它。

---

## 它解决什么问题

`wiki.easecation.net` 的 AI 助手（[Wiki AI](https://wiki.easecation.net/Wiki_AI)）是嵌在 wiki 里的
一个 iframe，后端在 `api.wiki.easecation.net`，**只认浏览器的登录 Cookie**，且只允许 wiki 域的 Origin。
这个代理做三件事：

1. 带上你的 `ec_wiki*` Cookie 和伪造的 `Origin` / `Referer` 去请求上游；
2. 把上游的 Responses 风格 SSE 翻译成标准 OpenAI Chat Completions 流；
3. 给你一个 `http://127.0.0.1:8787/v1` 的 base URL，任何 OpenAI 客户端都能接。

## 快速开始

需要 **Node.js ≥ 18**（用到内置 `fetch`）。

```bash
git clone https://github.com/Pigeon0129/ecwiki-ai-proxy.git
cd ecwiki-ai-proxy

cp .env.example .env
# 编辑 .env，填入 WIKI_COOKIE
```

### 获取 Cookie

1. 浏览器登录 <https://wiki.easecation.net>；
2. `F12` → Application（应用）/ 存储 → Cookies → `https://wiki.easecation.net`；
3. 复制以下 **三条** 的 Value，拼成一行：

   | Cookie | 说明 |
   |---|---|
   | `ec_wiki_session` | 会话 ID |
   | `ec_wikiUserName` | 用户名（URL 编码后的） |
   | `ec_wikiUserID` | 用户 ID |

   ```text
   WIKI_COOKIE=ec_wiki_session=xxxx; ec_wikiUserName=xxxx; ec_wikiUserID=12345
   ```

### 启动

```bash
# Linux / macOS
set -a; source .env; set +a
node proxy.mjs

# Windows PowerShell
$env:WIKI_COOKIE="ec_wiki_session=...; ec_wikiUserName=...; ec_wikiUserID=..."
node proxy.mjs
```

启动时会**自动验证 Cookie**：

```text
wiki-ai-proxy listening on http://127.0.0.1:8787
  OpenAI base:  http://127.0.0.1:8787/v1
  cookie:       已配置 → ec_wiki_session, ec_wikiUserName, ec_wikiUserID
  ✅ cookie 有效，当前登录用户：<用户名>
```

看到 ✅ 就可以用了。看到 ❌ 说明 Cookie 过期或被轮换，重新登录再取一次。

### 接入客户端

| 配置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | 留空（若设了 `PROXY_TOKEN` 则填它） |
| Model | `wiki-ai` |

## API

| 路由 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容，支持 `stream` |
| `GET /v1/models` | 模型列表，返回 `wiki-ai` |
| `POST /raw/responses` | 原样透传上游 SSE（想看 `tool_call` / `tool_result` 时用） |
| `GET /user` | 当前登录用户 —— **判断 Cookie 是否有效的唯一标准** |
| `GET /ai/quota` | 今日剩余次数 |
| `GET /diagnose` | 一次性诊断：cookie 名单 + 上游实测 + 结论 |
| `GET /health` | 探活 |

### 示例

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"wiki-ai","messages":[{"role":"user","content":"起床战争怎么玩？"}]}'
```

流式：

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"wiki-ai","stream":true,"messages":[{"role":"user","content":"密室杀手怎么玩？"}]}'
```

## 上游协议（逆向所得）

AI 助手实际是三层结构：

```text
wiki.easecation.net            MediaWiki 1.43.1（登录态在此签发）
      └─ iframe → service.wiki.easecation.net   静态 SPA（Vultr/OSS + CDN）
                        └─ fetch → api.wiki.easecation.net   真后端（阿里云函数计算）
```

`Wiki_AI` 词条的 wikitext 只有一行：

```wikitext
{{#微件:覆盖页面为URL|url=https://service.wiki.easecation.net/ai}}
```

所以直接抓页面 HTML 拿不到内容，必须走 `api.php?action=query&prop=revisions`。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/ai/v1/responses` | 对话，请求体 `{input, session_id?, stream: true}` |
| `GET` | `/ai/quota` | `{daily_limit, used_today, remaining, resets_at}` |
| `GET` | `/user` | `{userinfo:{id, name, groups, registrationdate}}` |

### SSE 事件

会话 ID 通过 SSE **注释行**下发：

```text
:sessionId: 90e49d53-fc7e-4105-a925-79165af77afe
```

`data:` 行的事件类型：

| `type` | 字段 | 含义 |
|---|---|---|
| `meta.session_id` | `sessionId` | 会话 ID（后续请求可回传续聊） |
| `response.tool_call` | `name`, `arguments` | 开始调用工具 |
| `response.tool_result` | `name`, `output` | 工具返回 |
| `response.output_text.delta` | `delta` | 正文增量 |
| `response.completed` | `response.output[0].content[0].text`、`model` | 结束，附完整文本 |

以 `data: [DONE]` 结束。事件命名与 OpenAI 的 **Responses API** 同源
（`response.output_text.delta` / `response.completed`），只是把工具调用拆成了独立事件。

### 真实事件序列

一次提问（「起床战争是什么？」）的完整序列：

```text
meta.session_id
tool_call       query_page          {"keyword":"起床战争"}
tool_result     query_page          共找到 140 个相关页面...
tool_call       open_page_context   {"page_name":"起床战争","keyword":"介绍|玩法|简介","context_lines":5}
tool_result     open_page_context   // 模式介绍 ...
output_text.delta  ×26
response.completed                  model: qwen3.7-plus
done
```




## 限制与注意事项

- **每日额度仅 10 次**（`daily_limit: 10`，UTC 16:00 重置）。
- **仅限个人使用。** 

## 免责声明

本项目仅用于**学习和个人技术研究**，不做任何保证。使用者需自行承担全部责任，
包括但不限于遵守目标站点的服务条款与相关法律法规。请勿用于任何商业用途或未授权场景。

如果这个项目为你提供了帮助，欢迎点个 ⭐。

## License

[MIT](LICENSE)
