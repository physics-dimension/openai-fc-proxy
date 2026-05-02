'use strict';

const { UPSTREAM_DS_TOKEN } = require('./config');

// ============================================================
// Header whitelist (inspired by AnyToolCall)
// Only forward essential headers to upstream
// If UPSTREAM_DS_TOKEN is set, replace Authorization header
// ============================================================

const FORWARD_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'anthropic-version',
  'accept',
  'user-agent',
]);

/**
 * Extract only safe headers from the incoming request.
 * If UPSTREAM_DS_TOKEN is configured, override Authorization.
 */
function cleanHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) {
      h[k] = v;
    }
  }
  if (UPSTREAM_DS_TOKEN) {
    h['authorization'] = `Bearer ${UPSTREAM_DS_TOKEN}`;
  }
  return h;
}

module.exports = { cleanHeaders };
