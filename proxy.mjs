#!/usr/bin/env node
/**
 * wiki-ai-proxy — 把 EaseCation Wiki AI 助手（需登录的 Web 应用）反代成
 *   - 一个 OpenAI 兼容的 /v1/chat/completions 接口（给 ChatGPT-Next-Web / LobeChat / 任何 OpenAI SDK 用）
 *   - 原样透传的 /raw/* （给需要看原始 SSE 事件流、tool_call 卡片用）
 *
 * 鉴权模型（逆向自 /ai/ 前端 bundle assets/AIChat-uScBIgGa.js）：
 *   前端每次都带 credentials:"include"，即依赖浏览器里 `.wiki.easecation.net` 域的
 *   ec_wiki_* Cookie（MediaWiki 登录态）。服务端 401 时返回 {"success":false,"message":"用户未登录"}。
 *   所以这里代理必须持有同一个登录 Cookie。
 *
 * 用法：
 *   1) 浏览器登录 https://wiki.easecation.net → F12 → Application → Cookies →
 *      复制 ec_wiki_session / ec_wikiUserName / ec_wikiUserID / ec_wikiToken 拼成 Cookie 头
 *   2) 写入 .env（见 env.example），或直接 export WIKI_COOKIE='...'
 *   3) node proxy.mjs
 *   4) 客户端 baseURL 指向 http://127.0.0.1:8787/v1 ，apiKey 随便填（或设 PROXY_TOKEN 后填它）
 */
import http from 'node:http';
import process from 'node:process';

const UPSTREAM = 'https://api.wiki.easecation.net';
const PORT = Number(process.env.PROXY_PORT || 8787);
const PROXY_TOKEN = process.env.PROXY_TOKEN || ''; // 可选：保护本代理自身
const WIKI_COOKIE = process.env.WIKI_COOKIE || '';
// 上游对 Origin 做校验：只允许 https://wiki.easecation.net（CORS 预检已实测）
const ORIGIN = process.env.WIKI_ORIGIN || 'https://wiki.easecation.net';

function upstreamHeaders(extra = {}) {
  const h = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    origin: ORIGIN,
    referer: ORIGIN + '/ai/',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    ...extra,
  };
  if (WIKI_COOKIE) {
    const clean = sanitizeCookie(WIKI_COOKIE);
    if (clean) h.cookie = clean;
  }
  return h;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 只列出 cookie 的名字（不泄露值），用于排障 */
function cookieNames() {
  return WIKI_COOKIE.split(';')
    .map((s) => s.split('=')[0].trim())
    .filter(Boolean);
}

/**
 * 清洗 Cookie 串。
 * MediaWiki 的 logout 流程会对一组固定名字（ec_wikiUserName / ec_wikiUserID / ec_wikiToken 等）
 * 无条件下发 "=deleted" 清除指令 —— 那些名字本身不是凭据，带着它们的空值/占位值
 * 只会让上游以为登录态异常，所以这里一律剔掉，只保留有真实取值的项。
 */
function sanitizeCookie(raw) {
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      const eq = s.indexOf('=');
      if (eq < 0) return false;
      const name = s.slice(0, eq).trim();
      const value = s.slice(eq + 1).trim();
      if (!value) return false;                       // 空值
      if (/^(deleted|null|undefined|yyyy|xxx+)$/i.test(value)) return false; // 占位/清除标记
      return name.length > 0;
    })
    .join('; ');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!PROXY_TOKEN) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${PROXY_TOKEN}`;
}

/** 把上游 SSE 的一行解析成事件对象；是数据行返回 obj，否则 null */
function parseSseLine(line) {
  if (line.startsWith(':sessionId:')) {
    return { type: 'meta.session_id', sessionId: line.slice(11).trim() };
  }
  if (!line.startsWith('data: ')) return null;
  const payload = line.slice(6).trim();
  if (payload === '[DONE]') return { type: 'done' };
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * 调上游 /ai/v1/responses，逐事件回调。
 * @returns {Promise<void>}
 */
async function callUpstream({ input, session_id }, onEvent, signal) {
  const body = { input, stream: true };
  if (session_id) body.session_id = session_id; // 前端在拿到 meta.session_id 后会回传以续接会话

  const r = await fetch(`${UPSTREAM}/ai/v1/responses`, {
    method: 'POST',
    headers: upstreamHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  if (r.status === 401) throw new Error('AUTH: 请先登录 Wiki（Cookie 缺失或已过期）');
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    let msg = txt;
    try {
      const j = JSON.parse(txt);
      msg = j.message || j.error?.message || txt;
    } catch {
      // 可能是 SSE 形式的错误
      for (const line of txt.split('\n')) {
        const ev = parseSseLine(line.trim());
        if (ev?.delta) { msg = ev.delta; break; }
        if (ev?.type === 'response.completed') {
          msg = ev.response?.output?.[0]?.content?.[0]?.text || msg;
          break;
        }
      }
    }
    throw new Error(`UPSTREAM HTTP ${r.status}: ${msg || r.statusText}`);
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const ev = parseSseLine(line.trim());
      if (ev) onEvent(ev);
    }
  }
}

// ────────────────────────────── OpenAI 兼容层 ──────────────────────────────

function flattenMessages(messages = []) {
  // 上游只吃单轮 "input" 字符串；多轮对话压成一段带说话人标记的文本。
  return messages
    .filter((m) => m.role !== 'system' && typeof m.content === 'string')
    .map((m) => (m.role === 'assistant' ? `助手：${m.content}` : m.content))
    .join('\n');
}

async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return json(res, 400, { error: { message: 'invalid JSON body' } });
  }

  const wantStream = !!payload.stream;
  let input = payload.input ?? flattenMessages(payload.messages);
  if (!input || typeof input !== 'string') {
    input = JSON.stringify(payload.messages ?? payload.input ?? '');
  }

  const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 12);
  const created = Math.floor(Date.now() / 1000);
  const model = payload.model || 'wiki-ai';
  const sessionId = payload.session_id || payload.sessionId || undefined;

  const toolCalls = [];
  let text = '';

  if (wantStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, finish = null) =>
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

    chunk({ role: 'assistant', content: '' });
    try {
      await callUpstream({ input, session_id: sessionId }, (ev) => {
        switch (ev.type) {
          case 'meta.session_id':
            send({ id, object: 'chat.completion.chunk', created, model, session_id: ev.sessionId,
              choices: [{ index: 0, delta: {}, finish_reason: null }] });
            break;
          case 'response.output_text.delta':
            if (ev.delta) { text += ev.delta; chunk({ content: ev.delta }); }
            break;
          case 'response.tool_call':
            // 暴露成 OpenAI 的 tool_call，方便客户端展示「正在搜索 / 工具返回」
            toolCalls.push({ name: ev.name, arguments: ev.arguments });
            chunk({
              tool_calls: [{
                index: toolCalls.length - 1,
                id: `call_${toolCalls.length}`,
                type: 'function',
                function: { name: ev.name, arguments: typeof ev.arguments === 'string' ? ev.arguments : JSON.stringify(ev.arguments) },
              }],
            });
            break;
          case 'response.tool_result':
            // 以 tool 角色消息的形式下发（扩展字段，标准客户端会忽略）
            send({
              id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { tool_result: { name: ev.name, output: ev.output } }, finish_reason: null }],
            });
            break;
          case 'response.completed': {
            const full = ev.response?.output?.[0]?.content?.[0]?.text;
            if (full && !text) { text = full; chunk({ content: full }); }
            break;
          }
          default:
            break;
        }
      }, req.signal);
      chunk({}, 'stop');
      res.write('data: [DONE]\n\n');
    } catch (e) {
      send({ error: { message: e.message } });
    } finally {
      res.end();
    }
    return;
  }

  // 非流式：攒完再一次性返回
  try {
    await callUpstream({ input, session_id: sessionId }, (ev) => {
      if (ev.type === 'response.output_text.delta' && ev.delta) text += ev.delta;
      if (ev.type === 'response.tool_call') toolCalls.push({ name: ev.name, arguments: ev.arguments });
      if (ev.type === 'response.completed') {
        const full = ev.response?.output?.[0]?.content?.[0]?.text;
        if (full) text = full;
      }
    }, req.signal);
  } catch (e) {
    const code = e.message.startsWith('AUTH:') ? 401 : 502;
    return json(res, code, { error: { message: e.message } });
  }

  return json(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    tool_calls: toolCalls,
  });
}

// ────────────────────────────── 原始透传 ──────────────────────────────

async function handleRaw(req, res) {
  try {
    const raw = await readBody(req);
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
    if (!payload.input) return json(res, 400, { message: 'body 需要 {"input":"...","session_id":"..."}' });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    await callUpstream({ input: payload.input, session_id: payload.session_id }, (ev) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }, req.signal);
    res.write('data: [DONE]\n\n');
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  } finally {
    res.end();
  }
}

async function handlePassthrough(req, res, path) {
  try {
    const r = await fetch(`${UPSTREAM}${path}`, { headers: upstreamHeaders({ accept: 'application/json' }) });
    const body = await r.text();
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (e) {
    json(res, 502, { error: { message: e.message } });
  }
}

// ────────────────────────────── 路由 ──────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (path === '/' ) {
      return json(res, 200, {
        ok: true,
        cookie_configured: !!WIKI_COOKIE,
        token_required: !!PROXY_TOKEN,
        endpoints: {
          'GET  /health': '健康检查',
          'GET  /v1/models': 'OpenAI 兼容的模型列表',
          'POST /v1/chat/completions': 'OpenAI 兼容的对话接口（stream 支持）',
          'POST /raw/responses': '原样透传上游 SSE 事件',
          'GET  /user': '上游用户信息（校验 Cookie 是否有效）',
          'GET  /ai/quota': '今日剩余次数',
        },
      });
    }

    if (path === '/health') {
      return json(res, 200, { ok: true, cookie_configured: !!WIKI_COOKIE, cookie_names: cookieNames() });
    }

    // 启动/排障用：不只是"配没配"，而是真的去问上游这个 cookie 认不认
    if (path === '/diagnose') {
      const out = { cookie_names: cookieNames(), checks: {} };
      for (const p of ['/user', '/ai/quota']) {
        try {
          const r = await fetch(`${UPSTREAM}${p}`, { headers: upstreamHeaders({ accept: 'application/json' }) });
          const text = await r.text();
          let body;
          try { body = JSON.parse(text); } catch { body = text; }
          out.checks[p] = { status: r.status, body };
        } catch (e) {
          out.checks[p] = { error: e.message };
        }
      }
      const user = out.checks['/user'];
      out.verdict = user?.status === 200
        ? '✅ Cookie 有效'
        : '❌ Cookie 无效或已过期：重新登录 wiki.easecation.net，只复制 ec_wiki_session 一条的值';
      return json(res, 200, out);
    }

    if (path === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [{ id: 'wiki-ai', object: 'model', owned_by: 'easecation-wiki' }],
      });
    }

    // 上游的只读接口无需本代理鉴权也可校验 Cookie —— 但给它们加上 token 也行
    if (req.method === 'GET' && (path === '/user' || path === '/ai/quota')) {
      if (!authorized(req) && path !== '/user') return json(res, 401, { message: 'invalid proxy token' });
      return handlePassthrough(req, res, path);
    }

    if (!authorized(req)) return json(res, 401, { error: { message: 'invalid proxy token' } });

    if (req.method === 'POST' && path === '/v1/chat/completions') return handleChatCompletions(req, res);
    if (req.method === 'POST' && (path === '/raw/responses' || path === '/ai/v1/responses')) return handleRaw(req, res);

    return json(res, 404, { error: { message: `no route for ${req.method} ${path}` } });
  } catch (e) {
    if (!res.headersSent) return json(res, 500, { error: { message: e.message } });
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`wiki-ai-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  OpenAI base:  http://127.0.0.1:${PORT}/v1`);
  const names = cookieNames();
  console.log(`  cookie:       ${names.length ? '已配置 → ' + names.join(', ') : '⚠️ 未配置 WIKI_COOKIE，上游会返回 401'}`);
  console.log(`  proxy token:  ${PROXY_TOKEN ? '已启用' : '未启用'}`);

  // 启动时主动验一次 cookie，避免用户对着一堆 401 猜
  if (names.length) {
    try {
      const r = await fetch(`${UPSTREAM}/user`, { headers: upstreamHeaders({ accept: 'application/json' }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 200) {
        console.log(`  ✅ cookie 有效，当前登录用户：${j.userinfo?.name ?? '(未知)'}`);
      } else {
        console.log(`  ❌ cookie 无效或已过期（HTTP ${r.status}：${j.message ?? ''}）`);
        console.log(`     重新登录 https://wiki.easecation.net，只复制 ec_wiki_session 一条的值。`);
      }
    } catch (e) {
      console.log(`  ⚠️ 无法校验 cookie：${e.message}`);
    }
  }
});
