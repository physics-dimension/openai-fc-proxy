'use strict';

const { CLIENT_KEYS } = require('./config');

// ============================================================
// Client authentication (optional, inspired by Toolify)
// Only active when CLIENT_KEYS env var is set
// ============================================================

/**
 * Validate client API key.
 * Returns null if OK, or error string if unauthorized.
 */
function authenticate(req) {
  if (!CLIENT_KEYS) return null; // No auth configured

  const auth = req.headers.authorization;
  if (!auth) return 'Missing Authorization header';

  const key = auth.replace(/^Bearer\s+/i, '').trim();
  if (!CLIENT_KEYS.has(key)) return 'Invalid API key';

  return null;
}

module.exports = { authenticate };
