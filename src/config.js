'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// Environment variables + optional JSON config
// ============================================================

const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://localhost:11434';
const PORT = parseInt(process.env.PORT || '3003', 10);
const BIND = process.env.BIND || '0.0.0.0';

// Retry: FC parse retry
const FC_RETRY_ENABLED = process.env.FC_RETRY_ENABLED === 'true';
const FC_RETRY_MAX = Math.min(Math.max(parseInt(process.env.FC_RETRY_MAX || '3', 10), 1), 10);

// Retry: upstream connection retry
const UPSTREAM_RETRY = Math.max(parseInt(process.env.UPSTREAM_RETRY || '1', 10), 1);
const UPSTREAM_RETRY_DELAY = Math.max(parseFloat(process.env.UPSTREAM_RETRY_DELAY || '0.5'), 0.1);

// Client authentication
const CLIENT_KEYS = process.env.CLIENT_KEYS
  ? new Set(process.env.CLIENT_KEYS.split(',').map(k => k.trim()).filter(Boolean))
  : null;

// Multi-upstream routing config file
const ROUTES_FILE = process.env.ROUTES_FILE || '';

let routes = null;
if (ROUTES_FILE) {
  try {
    const raw = fs.readFileSync(path.resolve(ROUTES_FILE), 'utf-8');
    routes = JSON.parse(raw);
  } catch (e) {
    console.error(`[config] Failed to load routes file: ${e.message}`);
  }
}

module.exports = {
  UPSTREAM_URL,
  PORT,
  BIND,
  FC_RETRY_ENABLED,
  FC_RETRY_MAX,
  UPSTREAM_RETRY,
  UPSTREAM_RETRY_DELAY,
  CLIENT_KEYS,
  routes,
};
