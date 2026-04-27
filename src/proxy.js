'use strict';

const { UPSTREAM_URL, FC_RETRY_ENABLED } = require('./config');
const { markers } = require('./delimiter');
const { toolsToPrompt } = require('./prompt');
const { parseToolCallsFromText, stripToolErrors } = require('./parser');
const { transformMessages, hasToolHistory } = require('./messages');
const { ToolSieve } = require('./sieve');
const { parseWithRetry, fetchWithRetry } = require('./retry');
const { resolveUpstream } = require('./router');
const { authenticate } = require('./auth');
const { estimateMessageTokens, ensureUsage } = require('./tokens');
const { cleanHeaders } = require('./headers');

// ============================================================
// HTTP proxy core
// ============================================================

function makeChunk(id, model, delta, finish) {
  return JSON.stringify({
    id: id || 'chatcmpl-proxy',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

/**
 * Transparent pipe-through for non-chat-completion requests.
 */
async function pipeThrough(req, body, res, upstreamBaseUrl) {
  const headers = cleanHeaders(req);
  const opts = { method: req.method, headers };
  if (req.method === 'POST' && body) {
    opts.body = body;
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body).toString();
  }
  try {
    const base = upstreamBaseUrl.replace(/\/+$/, '');
    const resp = await fetchWithRetry(base + req.url, opts);
    const rh = {};
    resp.headers.forEach((v, k) => { if (k !== 'transfer-encoding') rh[k] = v; });
    res.writeHead(resp.status, rh);
    if (resp.body) {
      for await (const chunk of resp.body) res.write(chunk);
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'proxy: ' + e.message } }));
  }
}

/**
 * Main request handler.
 */
async function handleRequest(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString();

    // Auth check
    const authError = authenticate(req);
    if (authError) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: authError, type: 'authentication_error' } }));
      return;
    }

    // Only intercept POST /v1/chat/completions
    if (!(req.url.includes('/v1/chat/completions') && req.method === 'POST')) {
      return pipeThrough(req, rawBody, res, UPSTREAM_URL);
    }

    let data;
    try { data = JSON.parse(rawBody); } catch { return pipeThrough(req, rawBody, res, UPSTREAM_URL); }

    const requestHasTools = Array.isArray(data.tools) && data.tools.length > 0;
    const requestHasToolHistory = hasToolHistory(data.messages);

    // No tools and no tool history: pure passthrough
    if (!requestHasTools && !requestHasToolHistory) {
      return pipeThrough(req, rawBody, res, UPSTREAM_URL);
    }

    // Resolve upstream
    const { upstreamUrl, headers: upHeaders, actualModel } = resolveUpstream(
      data.model, req.headers
    );

    const allowedNames = requestHasTools
      ? new Set(data.tools.map(t => (t.function || t).name).filter(Boolean))
      : new Set();

    const toolsPrompt = requestHasTools ? toolsToPrompt(data.tools, data.tool_choice) : '';
    const newMessages = transformMessages(data.messages, toolsPrompt, {
      hasTools: requestHasTools,
    });

    const isStream = data.stream;
    const promptTokens = estimateMessageTokens(newMessages);

    const upBody = { ...data, model: actualModel, messages: newMessages };
    delete upBody.tools;
    delete upBody.tool_choice;

    const bodyStr = JSON.stringify(upBody);
    upHeaders['content-length'] = Buffer.byteLength(bodyStr).toString();

    const baseUrl = upstreamUrl.replace(/\/+$/, '');
    const requestUrl = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

    try {
      const resp = await fetchWithRetry(requestUrl, {
        method: 'POST',
        headers: upHeaders,
        body: bodyStr,
      });

      if (!resp.ok) {
        res.writeHead(resp.status, { 'content-type': 'application/json' });
        res.end(await resp.text());
        return;
      }

      if (!isStream) {
        await handleNonStream(resp, res, data, allowedNames, newMessages, upHeaders, requestUrl, actualModel, promptTokens);
      } else {
        await handleStream(resp, res, allowedNames, promptTokens);
      }
    } catch (e) {
      console.error('[fc-proxy] Error:', e.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'proxy: ' + e.message } }));
    }
  });
}

// ============================================================
// Non-streaming handler
// ============================================================
async function handleNonStream(resp, res, data, allowedNames, messages, upHeaders, requestUrl, actualModel, promptTokens) {
  const result = await resp.json();

  // Guard against empty/malformed choices
  if (!result.choices || !result.choices[0] || !result.choices[0].message) {
    ensureUsage(result, promptTokens, '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  const content = result.choices[0].message.content || '';

  if (!allowedNames.size) {
    // No tools in request, just clean up any stale tool error text
    result.choices[0].message.content = stripToolErrors(content);
    ensureUsage(result, promptTokens, content);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Parse with retry
  const callUpstream = async (msgs) => {
    const body = JSON.stringify({ model: actualModel, messages: msgs, stream: false });
    const h = { ...upHeaders, 'content-length': Buffer.byteLength(body).toString() };
    const r = await fetchWithRetry(requestUrl, { method: 'POST', headers: h, body });
    const j = await r.json();
    return { content: j.choices?.[0]?.message?.content || '' };
  };

  const { calls, cleaned } = await parseWithRetry(
    content, allowedNames, data.tools, messages, callUpstream
  );

  if (calls.length > 0) {
    // Preserve extra fields from upstream message (reasoning_content etc.)
    const origMsg = result.choices[0].message;
    const newMsg = { role: 'assistant', content: cleaned || null, tool_calls: calls };
    for (const key of Object.keys(origMsg)) {
      if (!['role', 'content', 'tool_calls'].includes(key)) {
        newMsg[key] = origMsg[key];
      }
    }
    result.choices[0].message = newMsg;
    result.choices[0].finish_reason = 'tool_calls';
  } else {
    result.choices[0].message.content = stripToolErrors(content);
  }

  ensureUsage(result, promptTokens, content);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}

// ============================================================
// Streaming handler
// ============================================================
async function handleStream(resp, res, allowedNames, promptTokens) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });

  const sieve = new ToolSieve(allowedNames);
  let streamId = '';
  let streamModel = '';
  let sentRole = false;
  const decoder = new TextDecoder();
  let sseBuffer = '';

  for await (const raw of resp.body) {
    sseBuffer += decoder.decode(raw, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      if (line === 'data: [DONE]') continue;

      let event;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      streamId = streamId || event.id;
      streamModel = streamModel || event.model;

      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      const content = delta.content || '';
      if (!content && !delta.role) continue;

      if (delta.role && !sentRole) {
        res.write(`data: ${makeChunk(streamId, streamModel, { role: 'assistant' }, null)}\n\n`);
        sentRole = true;
      }

      if (content) {
        const result = sieve.feed(content);
        if (result.toolCalls) {
          emitToolCalls(res, streamId, streamModel, result.toolCalls);
          return;
        }
        if (result.text) {
          res.write(`data: ${makeChunk(streamId, streamModel, { content: result.text }, null)}\n\n`);
        }
      }
    }
  }

  // Flush remaining
  const flushed = sieve.flush();
  if (flushed.toolCalls) {
    emitToolCalls(res, streamId, streamModel, flushed.toolCalls);
    return;
  }

  if (flushed.text) {
    res.write(`data: ${makeChunk(streamId, streamModel, { content: flushed.text }, null)}\n\n`);
  }
  res.write(`data: ${makeChunk(streamId, streamModel, {}, 'stop')}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function emitToolCalls(res, id, model, toolCalls) {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    res.write(`data: ${makeChunk(id, model, {
      tool_calls: [{
        index: i,
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }],
    }, null)}\n\n`);
  }
  res.write(`data: ${makeChunk(id, model, {}, 'tool_calls')}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

module.exports = { handleRequest, pipeThrough };
