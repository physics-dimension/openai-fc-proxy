'use strict';

const http = require('http');
const { PORT, BIND, UPSTREAM_URL, FC_RETRY_ENABLED, FC_RETRY_MAX, CLIENT_KEYS, UPSTREAM_DS_TOKEN, routes } = require('./src/config');
const { markers } = require('./src/delimiter');
const { handleRequest } = require('./src/proxy');

// ============================================================
// Server startup
// ============================================================

const server = http.createServer(handleRequest);

server.listen(PORT, BIND, () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('  openai-fc-proxy v2.0 — upgraded with AnyToolCall + Toolify');
  console.log('='.repeat(60));
  console.log(`  Listen:       ${BIND}:${PORT}`);
  console.log(`  Upstream:     ${routes ? `${routes.services.length} services (routing)` : UPSTREAM_URL}`);
  console.log(`  Delimiters:   rare-char (random per startup)`);
  console.log(`  TC_START:     ${markers.TC_START}`);
  console.log(`  TC_END:       ${markers.TC_END}`);
  console.log(`  FC Retry:     ${FC_RETRY_ENABLED ? `enabled (max ${FC_RETRY_MAX})` : 'disabled'}`);
  console.log(`  Auth:         ${CLIENT_KEYS ? `${CLIENT_KEYS.size} key(s)` : 'off'}`);
  console.log(`  DS Token:     ${UPSTREAM_DS_TOKEN ? 'configured' : 'off (passthrough)'}`);
  console.log(`  Fallback:     ##TOOL_CALL##, <tool_call>, <function_call>, JSON, code blocks`);
  console.log('='.repeat(60));
  console.log('');
});
