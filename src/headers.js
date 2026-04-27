'use strict';

// ============================================================
// Header whitelist (inspired by AnyToolCall)
// Only forward essential headers to upstream
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
 */
function cleanHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) {
      h[k] = v;
    }
  }
  return h;
}

module.exports = { cleanHeaders };
