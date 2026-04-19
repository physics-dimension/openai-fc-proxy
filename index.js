const http = require('http');

const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://localhost:11434';
const PORT = parseInt(process.env.PORT || '3003', 10);
const BIND = process.env.BIND || '0.0.0.0';

// ============================================================
// Tool definitions -> system prompt
// ============================================================
function toolsToPrompt(tools) {
  const lines = [];
  lines.push('In this environment you have access to a set of tools you can use to answer the user\'s question.');
  lines.push('You can invoke tools by outputting a block in this exact format:\n');
  lines.push('##TOOL_CALL##');
  lines.push('{"name": "tool_name", "arguments": {"param1": "value1"}}');
  lines.push('##END_CALL##\n');
  lines.push('You may call multiple tools in sequence. Here are the available tools:\n');
  for (const t of tools) {
    const fn = t.function || t;
    lines.push(`### ${fn.name}`);
    if (fn.description) lines.push(fn.description);
    if (fn.parameters) lines.push('Parameters: ' + JSON.stringify(fn.parameters));
    lines.push('');
  }
  lines.push('If you need to call a tool, output ONLY the ##TOOL_CALL## block(s) with no other text.');
  lines.push('After receiving results, use them to form your final answer.');
  lines.push('If no tool is needed, respond normally without any ##TOOL_CALL## blocks.');
  return lines.join('\n');
}

// ============================================================
// Multi-format tool call parser
// Handles: ##TOOL_CALL##, <tool_call>, <function_call>, raw JSON, code blocks
// ============================================================
const TOOL_DOES_NOT_EXIST_RE = /Tool\s+[A-Za-z0-9_.:-]*\s*does not exists?\.?\s*/gi;

function stripToolErrors(text) {
  return text.replace(TOOL_DOES_NOT_EXIST_RE, '').trim();
}

function parseToolCallsFromText(text, allowedNames) {
  let cleaned = stripToolErrors(text);
  let calls = parseDelimitedFormat(cleaned, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeToolBlocks(cleaned) };
  calls = parseXmlToolCall(cleaned, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeXmlToolBlocks(cleaned) };
  calls = parseFunctionCall(cleaned, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeFunctionCallBlocks(cleaned) };
  calls = parseRawJson(cleaned, allowedNames);
  if (calls.length > 0) return { calls, cleaned: '' };
  calls = parseCodeBlock(cleaned, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeCodeBlocks(cleaned) };
  return { calls: [], cleaned };
}

function parseDelimitedFormat(text, allowed) {
  const re = /##TOOL_CALL##\s*([\s\S]*?)\s*##END_CALL##/g;
  const calls = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = tryParseCallJson(m[1].trim(), allowed);
    if (c) calls.push(c);
  }
  return calls;
}
function removeToolBlocks(text) {
  return text.replace(/##TOOL_CALL##[\s\S]*?##END_CALL##/g, '').trim();
}

function parseXmlToolCall(text, allowed) {
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  const calls = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = tryParseCallJson(m[1].trim(), allowed);
    if (c) calls.push(c);
  }
  return calls;
}
function removeXmlToolBlocks(text) {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
}

function parseFunctionCall(text, allowed) {
  const re = /<function_call>\s*([\s\S]*?)\s*<\/function_call>/gi;
  const calls = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = tryParseCallJson(m[1].trim(), allowed);
    if (c) calls.push(c);
  }
  return calls;
}
function removeFunctionCallBlocks(text) {
  return text.replace(/<function_call>[\s\S]*?<\/function_call>/gi, '').trim();
}

function parseCodeBlock(text, allowed) {
  const re = /```(?:tool_call|json)?\s*\n?([\s\S]*?)\n?```/g;
  const calls = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = tryParseCallJson(m[1].trim(), allowed);
    if (c) calls.push(c);
  }
  return calls;
}
function removeCodeBlocks(text) {
  return text.replace(/```(?:tool_call|json)?\s*\n?[\s\S]*?\n?```/g, '').trim();
}

function parseRawJson(text, allowed) {
  const stripped = text.trim();
  const c = tryParseCallJson(stripped, allowed);
  return c ? [c] : [];
}

const INPUT_KEYS = ['input', 'arguments', 'args', 'parameters'];
function tryParseCallJson(raw, allowed) {
  let repaired = raw.replace(/"name="/g, '"name": "').replace(/"name\s*=\s*"/g, '"name": "');
  let parsed;
  try { parsed = JSON.parse(repaired); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  if (Array.isArray(parsed.tool_calls)) {
    const fn = parsed.tool_calls[0]?.function;
    if (fn) parsed = fn;
  }

  const name = parsed.name;
  if (!name || typeof name !== 'string') return null;

  let args = null;
  for (const k of INPUT_KEYS) {
    if (parsed[k] !== undefined) { args = parsed[k]; break; }
  }
  if (args === null) args = {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { value: args }; }
  }

  return {
    id: 'call_' + Math.random().toString(36).slice(2, 11),
    type: 'function',
    function: {
      name: normalizeName(name, allowed),
      arguments: typeof args === 'string' ? args : JSON.stringify(args)
    }
  };
}

function normalizeName(name, allowed) {
  if (!allowed || allowed.size === 0) return name;
  if (allowed.has(name)) return name;
  const lower = name.toLowerCase();
  for (const a of allowed) {
    if (a.toLowerCase() === lower) return a;
  }
  return name;
}

// ============================================================
// Streaming ToolSieve
// Streams normal text through, buffers only when tool syntax detected
// ============================================================
const TOOL_MARKERS = ['##TOOL_CALL##', '<tool_call>', '<function_call>', '{"name":', '"tool_calls"'];

class ToolSieve {
  constructor(allowedNames) {
    this.allowed = allowedNames;
    this.buffer = '';
    this.inToolBlock = false;
    this.endMarkers = { '##TOOL_CALL##': '##END_CALL##', '<tool_call>': '</tool_call>', '<function_call>': '</function_call>' };
    this.currentEndMarker = null;
  }

  feed(chunk) {
    this.buffer += chunk;
    if (!this.inToolBlock) {
      for (const marker of TOOL_MARKERS) {
        const idx = this.buffer.indexOf(marker);
        if (idx >= 0) {
          this.inToolBlock = true;
          this.currentEndMarker = this.endMarkers[marker] || null;
          const textBefore = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx);
          return { text: stripToolErrors(textBefore), done: false };
        }
      }
      const maxLen = Math.max(...TOOL_MARKERS.map(m => m.length));
      if (this.buffer.length > maxLen) {
        const safe = this.buffer.slice(0, this.buffer.length - maxLen);
        this.buffer = this.buffer.slice(this.buffer.length - maxLen);
        return { text: stripToolErrors(safe), done: false };
      }
      return { text: '', done: false };
    } else {
      if (this.currentEndMarker) {
        const endIdx = this.buffer.indexOf(this.currentEndMarker);
        if (endIdx >= 0) {
          const block = this.buffer.slice(0, endIdx + this.currentEndMarker.length);
          this.buffer = this.buffer.slice(endIdx + this.currentEndMarker.length);
          this.inToolBlock = false;
          const { calls } = parseToolCallsFromText(block, this.allowed);
          if (calls.length > 0) return { toolCalls: calls, done: true };
        }
      } else {
        try {
          JSON.parse(this.buffer.trim());
          const { calls } = parseToolCallsFromText(this.buffer, this.allowed);
          this.buffer = '';
          this.inToolBlock = false;
          if (calls.length > 0) return { toolCalls: calls, done: true };
        } catch { /* incomplete */ }
      }
      return { text: '', done: false };
    }
  }

  flush() {
    if (this.buffer) {
      const { calls, cleaned } = parseToolCallsFromText(this.buffer, this.allowed);
      this.buffer = '';
      if (calls.length > 0) return { toolCalls: calls, text: cleaned };
      return { text: stripToolErrors(cleaned) };
    }
    return { text: '' };
  }
}

// ============================================================
// Message transformation
// ============================================================
function transformMessages(messages, toolsPrompt) {
  const out = [];
  let hasSystem = false;
  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content + '\n\n' + toolsPrompt });
      hasSystem = true;
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      let content = msg.content || '';
      for (const tc of msg.tool_calls) {
        const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        content += `\n##TOOL_CALL##\n{"name": "${tc.function.name}", "arguments": ${args}}\n##END_CALL##`;
      }
      out.push({ role: 'assistant', content: content.trim() });
    } else if (msg.role === 'tool') {
      out.push({ role: 'user', content: `[Tool Result for "${msg.name || 'unknown'}"]\n${msg.content}` });
    } else {
      out.push({ role: msg.role, content: msg.content });
    }
  }
  if (!hasSystem) out.unshift({ role: 'system', content: toolsPrompt });
  return out;
}

// ============================================================
// HTTP helpers
// ============================================================
function cleanHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'content-length', 'transfer-encoding', 'connection'].includes(k)) continue;
    h[k] = v;
  }
  return h;
}

async function pipeThrough(req, body, res) {
  const headers = cleanHeaders(req);
  const opts = { method: req.method, headers };
  if (req.method === 'POST' && body) {
    opts.body = body;
    headers['content-length'] = Buffer.byteLength(body).toString();
  }
  try {
    const resp = await fetch(UPSTREAM_URL + req.url, opts);
    const rh = {};
    resp.headers.forEach((v, k) => { if (k !== 'transfer-encoding') rh[k] = v; });
    res.writeHead(resp.status, rh);
    if (resp.body) {
      for await (const chunk of resp.body) res.write(chunk);
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message: 'proxy: ' + e.message } }));
  }
}

function makeChunk(id, model, delta, finish) {
  return JSON.stringify({
    id: id || 'chatcmpl-proxy',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{ index: 0, delta, finish_reason: finish }]
  });
}

// ============================================================
// Server
// ============================================================
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString();

    if (!(req.url.includes('/v1/chat/completions') && req.method === 'POST')) {
      return pipeThrough(req, rawBody, res);
    }

    let data;
    try { data = JSON.parse(rawBody); } catch { return pipeThrough(req, rawBody, res); }
    if (!data.tools || data.tools.length === 0) return pipeThrough(req, rawBody, res);

    const allowedNames = new Set(data.tools.map(t => (t.function || t).name));
    const toolsPrompt = toolsToPrompt(data.tools);
    const newMessages = transformMessages(data.messages, toolsPrompt);
    const isStream = data.stream;

    const upBody = { ...data, messages: newMessages };
    delete upBody.tools;
    delete upBody.tool_choice;

    const headers = cleanHeaders(req);
    headers['content-type'] = 'application/json';
    const bodyStr = JSON.stringify(upBody);
    headers['content-length'] = Buffer.byteLength(bodyStr).toString();

    try {
      const resp = await fetch(UPSTREAM_URL + req.url, {
        method: 'POST', headers, body: bodyStr,
      });

      if (!resp.ok) {
        res.writeHead(resp.status, { 'content-type': 'application/json' });
        res.end(await resp.text());
        return;
      }

      if (!isStream) {
        const result = await resp.json();
        const content = result.choices?.[0]?.message?.content || '';
        const { calls, cleaned } = parseToolCallsFromText(content, allowedNames);
        if (calls.length > 0) {
          result.choices[0].message.tool_calls = calls;
          result.choices[0].message.content = cleaned || null;
          result.choices[0].finish_reason = 'tool_calls';
        } else {
          result.choices[0].message.content = stripToolErrors(content);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
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
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
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
                for (let i = 0; i < result.toolCalls.length; i++) {
                  const tc = result.toolCalls[i];
                  res.write(`data: ${makeChunk(streamId, streamModel, {
                    tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }]
                  }, null)}\n\n`);
                }
                res.write(`data: ${makeChunk(streamId, streamModel, {}, 'tool_calls')}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              if (result.text) {
                res.write(`data: ${makeChunk(streamId, streamModel, { content: result.text }, null)}\n\n`);
              }
            }
          }
        }

        const flushed = sieve.flush();
        if (flushed.toolCalls) {
          for (let i = 0; i < flushed.toolCalls.length; i++) {
            const tc = flushed.toolCalls[i];
            res.write(`data: ${makeChunk(streamId, streamModel, {
              tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }]
            }, null)}\n\n`);
          }
          res.write(`data: ${makeChunk(streamId, streamModel, {}, 'tool_calls')}\n\n`);
        } else {
          if (flushed.text) {
            res.write(`data: ${makeChunk(streamId, streamModel, { content: flushed.text }, null)}\n\n`);
          }
          res.write(`data: ${makeChunk(streamId, streamModel, {}, 'stop')}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (e) {
      console.error('[FC-PROXY ERROR]', e.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: 'proxy: ' + e.message } }));
    }
  });
});

server.listen(PORT, BIND, () => {
  console.log(`[openai-fc-proxy] listening on ${BIND}:${PORT} -> ${UPSTREAM_URL}`);
  console.log(`[openai-fc-proxy] parser: ##TOOL_CALL##, <tool_call>, <function_call>, JSON, code blocks`);
  console.log(`[openai-fc-proxy] streaming: ToolSieve passthrough`);
});
