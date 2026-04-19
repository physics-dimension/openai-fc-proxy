const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');

const PROXY_PORT = 13003 + Math.floor(Math.random() * 100);
const MOCK_PORT = 14003 + Math.floor(Math.random() * 100);
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

let currentHandler = null;
let passed = 0;
let failed = 0;

function post(url, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

function setHandler(fn) { currentHandler = fn; }

// ============================================================
// Tests
// ============================================================

async function testPassthrough() {
  setHandler((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }] }));
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', { model: 'test', messages: [{ role: 'user', content: 'hi' }] });
  const json = JSON.parse(resp.body);
  assert.strictEqual(json.choices[0].message.content, 'Hello!');
  assert.strictEqual(json.choices[0].finish_reason, 'stop');
  return 'passthrough (no tools) preserves response';
}

async function testNonStreamToolCalls() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(!body.tools, 'tools stripped');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: '##TOOL_CALL##\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n##END_CALL##' }, finish_reason: 'stop' }]
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]
  });
  const json = JSON.parse(resp.body);
  assert.strictEqual(json.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(json.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.strictEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments).city, 'Tokyo');
  return 'non-stream ##TOOL_CALL## -> tool_calls';
}

async function testStreamPassthrough() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      ['Hello', ' world', '!'].forEach((w, i) => {
        res.write(`data: ${JSON.stringify({ id: 'c1', model: 'test', choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: w } : { content: w }, finish_reason: null }] })}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ id: 'c1', model: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', { model: 'test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  let text = '';
  for (const line of resp.body.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try { const d = JSON.parse(line.slice(6)); if (d.choices?.[0]?.delta?.content) text += d.choices[0].delta.content; } catch {}
    }
  }
  assert.ok(text.includes('Hello') && text.includes('world'));
  return 'stream passthrough (no tools)';
}

async function testStreamToolCalls() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const p of ['##TOOL', '_CALL##\n{"name":', ' "get_weather",', ' "arguments": {"city":', ' "Berlin"}}\n##END', '_CALL##']) {
        res.write(`data: ${JSON.stringify({ id: 'c2', model: 'test', choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', stream: true,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]
  });
  let hasToolCall = false, finishReason = null;
  for (const line of resp.body.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try {
        const d = JSON.parse(line.slice(6));
        if (d.choices?.[0]?.delta?.tool_calls) hasToolCall = true;
        if (d.choices?.[0]?.finish_reason) finishReason = d.choices[0].finish_reason;
      } catch {}
    }
  }
  assert.ok(hasToolCall, 'should have tool_calls');
  assert.strictEqual(finishReason, 'tool_calls');
  return 'stream ToolSieve detects tool calls';
}

async function testXmlFormat() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: '<function_call>\n{"name": "search", "arguments": {"q": "test"}}\n</function_call>' }, finish_reason: 'stop' }]
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test',
    messages: [{ role: 'user', content: 'search' }],
    tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]
  });
  const json = JSON.parse(resp.body);
  assert.strictEqual(json.choices[0].message.tool_calls[0].function.name, 'search');
  return '<function_call> XML format parsed';
}

async function testToolErrorStripping() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'Tool get_weather does not exist.\nThe answer is 25 degrees.' }, finish_reason: 'stop' }]
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: {} } }]
  });
  const json = JSON.parse(resp.body);
  assert.ok(!json.choices[0].message.content.includes('does not exist'));
  assert.ok(json.choices[0].message.content.includes('25 degrees'));
  return '"Tool X does not exist" errors stripped';
}

async function testMultiTool() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: '##TOOL_CALL##\n{"name": "search", "arguments": {"q": "a"}}\n##END_CALL##\n##TOOL_CALL##\n{"name": "search", "arguments": {"q": "b"}}\n##END_CALL##' }, finish_reason: 'stop' }]
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'search a and b' }],
    tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]
  });
  const json = JSON.parse(resp.body);
  assert.strictEqual(json.choices[0].message.tool_calls.length, 2);
  assert.strictEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments).q, 'a');
  assert.strictEqual(JSON.parse(json.choices[0].message.tool_calls[1].function.arguments).q, 'b');
  return 'multiple tool calls in one response';
}

async function testModelsEndpoint() {
  setHandler((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-1' }] }));
  });
  const resp = await get(PROXY_URL + '/v1/models');
  const json = JSON.parse(resp.body);
  assert.ok(json.data);
  assert.strictEqual(json.data[0].id, 'model-1');
  return '/v1/models passthrough';
}

// ============================================================
// Runner
// ============================================================
const tests = [
  testPassthrough, testNonStreamToolCalls, testStreamPassthrough,
  testStreamToolCalls, testXmlFormat, testToolErrorStripping,
  testMultiTool, testModelsEndpoint,
];

(async () => {
  const mockServer = http.createServer((req, res) => {
    if (currentHandler) currentHandler(req, res);
    else { res.writeHead(500); res.end('no handler'); }
  });
  await new Promise(r => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

  const proxyProc = spawn(process.execPath, [__dirname + '/index.js'], {
    env: { ...process.env, PORT: String(PROXY_PORT), UPSTREAM_URL: `http://127.0.0.1:${MOCK_PORT}`, BIND: '127.0.0.1' },
    stdio: 'pipe',
  });

  await new Promise(r => setTimeout(r, 600));

  console.log(`openai-fc-proxy test suite (proxy :${PROXY_PORT} -> mock :${MOCK_PORT})\n`);

  for (const test of tests) {
    try {
      const desc = await test();
      passed++;
      console.log(`  PASS  ${desc}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${test.name}: ${e.message}`);
    }
  }

  console.log(`\n${passed}/${tests.length} passed`);
  proxyProc.kill();
  mockServer.close();
  process.exit(failed > 0 ? 1 : 0);
})();
