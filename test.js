'use strict';

const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');

const PROXY_PORT = 13003 + Math.floor(Math.random() * 100);
const MOCK_PORT = 14003 + Math.floor(Math.random() * 100);
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

let currentHandler = null;
let passed = 0;
let failed = 0;

function post(url, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extraHeaders },
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

const TOOLS = [{
  type: 'function',
  function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
}];

const SEARCH_TOOLS = [{
  type: 'function',
  function: { name: 'search', description: 'Search', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
}];

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
  return 'passthrough (no tools) preserves response';
}

async function testLegacyToolCallFormat() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(!body.tools, 'tools should be stripped');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: '##TOOL_CALL##\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n##END_CALL##' }, finish_reason: 'stop' }],
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'weather?' }], tools: TOOLS,
  });
  const json = JSON.parse(resp.body);
  assert.strictEqual(json.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(json.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.strictEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments).city, 'Tokyo');
  return 'legacy ##TOOL_CALL## format parsed';
}

async function testRareCharDelimiters() {
  // We need to capture the actual delimiter the proxy uses from the system prompt
  let capturedPrompt = '';
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      // Find system message with tool definitions
      const sysMsg = body.messages.find(m => m.role === 'system' && m.content.includes('How to call tools'));
      capturedPrompt = sysMsg?.content || '';

      // Verify that prompt does NOT contain ##TOOL_CALL## (rare-char should be used instead)
      assert.ok(!capturedPrompt.includes('##TOOL_CALL##'), 'Prompt should use rare-char delimiters, not ##TOOL_CALL##');

      // Just return plain text (no tool call)
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'No tools needed.' }, finish_reason: 'stop' }],
      }));
    });
  });
  await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS,
  });
  assert.ok(capturedPrompt.length > 0, 'Should have captured system prompt');
  return 'rare-char delimiters injected in system prompt';
}

async function testXmlFormat() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: '<function_call>\n{"name": "search", "arguments": {"q": "test"}}\n</function_call>' }, finish_reason: 'stop' }],
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'search' }], tools: SEARCH_TOOLS,
  });
  const json = JSON.parse(resp.body);
  assert.strictEqual(json.choices[0].message.tool_calls[0].function.name, 'search');
  return '<function_call> XML fallback parsed';
}

async function testToolErrorStripping() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'Tool get_weather does not exist.\nThe answer is 25 degrees.' }, finish_reason: 'stop' }],
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'weather?' }], tools: TOOLS,
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
        choices: [{ index: 0, message: { role: 'assistant', content: '##TOOL_CALL##\n{"name":"search","arguments":{"q":"a"}}\n##END_CALL##\n##TOOL_CALL##\n{"name":"search","arguments":{"q":"b"}}\n##END_CALL##' }, finish_reason: 'stop' }],
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'search a and b' }], tools: SEARCH_TOOLS,
  });
  const json = JSON.parse(resp.body);
  assert.strictEqual(json.choices[0].message.tool_calls.length, 2);
  return 'multiple tool calls parsed';
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
    model: 'test', stream: true, messages: [{ role: 'user', content: 'weather?' }], tools: TOOLS,
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
  assert.ok(hasToolCall, 'should have tool_calls in stream');
  assert.strictEqual(finishReason, 'tool_calls');
  return 'stream ToolSieve detects tool calls';
}

async function testThinkBlockIgnored() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      // Model mentions ##TOOL_CALL## inside <think> but real answer is plain text
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: '<think>I should use ##TOOL_CALL##\n{"name":"search","arguments":{"q":"x"}}\n##END_CALL## but actually no.</think>\nThe answer is 42.' }, finish_reason: 'stop' }],
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'think?' }], tools: SEARCH_TOOLS,
  });
  const json = JSON.parse(resp.body);
  // Should NOT parse tool calls from inside <think>
  assert.ok(!json.choices[0].message.tool_calls, 'should NOT parse tool calls inside <think>');
  assert.ok(json.choices[0].message.content.includes('42'));
  return '<think> blocks ignored for tool call detection';
}

async function testMessageMerging() {
  // Verify that consecutive same-role messages are merged
  let capturedMessages = [];
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      capturedMessages = body.messages;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    });
  });
  await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] },
      { role: 'tool', name: 'search', tool_call_id: 'c1', content: 'result1' },
      { role: 'tool', name: 'search', tool_call_id: 'c2', content: 'result2' },
      { role: 'user', content: 'thanks' },
    ],
    tools: SEARCH_TOOLS,
  });
  // Two consecutive tool→user messages should be merged into one user message
  const userMsgs = capturedMessages.filter(m => m.role === 'user');
  // The two tool results become user messages and should get merged
  // then "thanks" is also user, so it all merges
  for (let i = 1; i < capturedMessages.length; i++) {
    assert.notStrictEqual(
      capturedMessages[i].role === capturedMessages[i - 1].role &&
      capturedMessages[i].role !== 'system',
      true,
      `Adjacent messages ${i - 1} and ${i} should not have same role "${capturedMessages[i].role}"`
    );
  }
  return 'adjacent same-role messages merged';
}

async function testToolHistoryCleanup() {
  // Send request WITHOUT tools but WITH tool history
  let capturedMessages = [];
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      capturedMessages = body.messages;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      }));
    });
  });
  await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test',
    messages: [
      { role: 'user', content: 'weather' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }] },
      { role: 'tool', name: 'get_weather', tool_call_id: 'c1', content: '25 degrees' },
      { role: 'user', content: 'ok thanks' },
    ],
    // No tools!
  });
  // Should NOT have any role: "tool" in the output (should be converted to user)
  const toolMsgs = capturedMessages.filter(m => m.role === 'tool');
  assert.strictEqual(toolMsgs.length, 0, 'tool messages should be converted');
  // assistant.tool_calls should be stripped
  const assistantMsgs = capturedMessages.filter(m => m.role === 'assistant');
  for (const m of assistantMsgs) {
    assert.ok(!m.tool_calls, 'assistant.tool_calls should be stripped');
  }
  return 'tool history cleaned when no tools in request';
}

async function testUsageField() {
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Upstream returns no usage
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      }));
    });
  });
  const resp = await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS,
  });
  const json = JSON.parse(resp.body);
  assert.ok(json.usage, 'should have usage field');
  assert.ok(json.usage.prompt_tokens > 0, 'prompt_tokens > 0');
  assert.ok(json.usage.total_tokens > 0, 'total_tokens > 0');
  return 'usage field estimated when upstream omits it';
}

async function testDeveloperRole() {
  let capturedMessages = [];
  setHandler((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      capturedMessages = body.messages;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    });
  });
  await post(PROXY_URL + '/v1/chat/completions', {
    model: 'test',
    messages: [
      { role: 'developer', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ],
    tools: TOOLS,
  });
  // developer should become system
  assert.ok(!capturedMessages.find(m => m.role === 'developer'), 'developer role should be converted');
  const sys = capturedMessages.find(m => m.role === 'system');
  assert.ok(sys, 'should have system message');
  assert.ok(sys.content.includes('You are helpful'), 'original developer content preserved');
  return 'developer role converted to system';
}

async function testModelsPassthrough() {
  setHandler((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-1' }] }));
  });
  const resp = await get(PROXY_URL + '/v1/models');
  const json = JSON.parse(resp.body);
  assert.ok(json.data);
  assert.strictEqual(json.data[0].id, 'model-1');
  return '/v1/models passthrough works';
}

// ============================================================
// Runner
// ============================================================
const tests = [
  testPassthrough,
  testLegacyToolCallFormat,
  testRareCharDelimiters,
  testXmlFormat,
  testToolErrorStripping,
  testMultiTool,
  testStreamToolCalls,
  testThinkBlockIgnored,
  testMessageMerging,
  testToolHistoryCleanup,
  testUsageField,
  testDeveloperRole,
  testModelsPassthrough,
];

(async () => {
  const mockServer = http.createServer((req, res) => {
    if (currentHandler) currentHandler(req, res);
    else { res.writeHead(500); res.end('no handler'); }
  });
  await new Promise(r => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

  const proxyProc = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, PORT: String(PROXY_PORT), UPSTREAM_URL: `http://127.0.0.1:${MOCK_PORT}`, BIND: '127.0.0.1' },
    stdio: 'pipe',
  });

  // Capture proxy stderr for debugging
  let proxyStderr = '';
  proxyProc.stderr.on('data', d => { proxyStderr += d.toString(); });

  await new Promise(r => setTimeout(r, 800));

  console.log(`openai-fc-proxy v2 test suite (proxy :${PROXY_PORT} -> mock :${MOCK_PORT})\n`);

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

  console.log(`\n${passed}/${tests.length} passed${failed > 0 ? ` (${failed} failed)` : ''}`);
  if (failed > 0 && proxyStderr) {
    console.log('\nProxy stderr:\n' + proxyStderr.slice(-2000));
  }
  proxyProc.kill();
  mockServer.close();
  process.exit(failed > 0 ? 1 : 0);
})();
