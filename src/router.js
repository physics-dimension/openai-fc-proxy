'use strict';

const { routes, UPSTREAM_URL } = require('./config');

// ============================================================
// Multi-upstream routing + model aliases (inspired by Toolify)
// Falls back to single UPSTREAM_URL when no routes config
// ============================================================

/**
 * Routes config JSON format:
 * {
 *   "services": [
 *     {
 *       "name": "openai",
 *       "base_url": "https://api.openai.com/v1",
 *       "api_key": "sk-xxx",
 *       "models": ["gpt-4o", "gpt-4o-mini"],
 *       "is_default": true
 *     },
 *     {
 *       "name": "google",
 *       "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
 *       "api_key": "xxx",
 *       "models": ["gemini-2.5:gemini-2.5-pro", "gemini-2.5:gemini-2.5-flash"]
 *     }
 *   ]
 * }
 *
 * Model alias: "gemini-2.5:gemini-2.5-pro" means alias "gemini-2.5" maps to "gemini-2.5-pro"
 * When requesting alias, random selection among all entries with same alias prefix
 */

let modelMap = null;     // model/alias → { service, actualModel }
let defaultService = null;

function buildModelMap() {
  if (modelMap) return;
  if (!routes || !routes.services) return;

  modelMap = {};
  const aliasMap = {};  // alias → [{ service, actualModel }]

  for (const svc of routes.services) {
    if (svc.is_default) defaultService = svc;

    for (const entry of (svc.models || [])) {
      if (entry.includes(':')) {
        const [alias, actual] = entry.split(':', 2);
        if (!aliasMap[alias]) aliasMap[alias] = [];
        aliasMap[alias].push({ service: svc, actualModel: actual });
        modelMap[entry] = { service: svc, actualModel: actual };
      } else {
        modelMap[entry] = { service: svc, actualModel: entry };
      }
    }
  }

  // Add alias entries (random selection)
  for (const [alias, targets] of Object.entries(aliasMap)) {
    if (!modelMap[alias]) {
      modelMap[alias] = { __alias: targets };
    }
  }
}

/**
 * Resolve upstream URL and headers for a given model.
 * Returns { upstreamUrl, headers, actualModel }
 */
function resolveUpstream(model, originalHeaders) {
  buildModelMap();

  const headers = {
    'content-type': 'application/json',
  };

  // No routing config: use single UPSTREAM_URL
  if (!modelMap) {
    // Forward auth headers from original request
    if (originalHeaders.authorization) headers['authorization'] = originalHeaders.authorization;
    if (originalHeaders['x-api-key']) headers['x-api-key'] = originalHeaders['x-api-key'];
    if (originalHeaders['anthropic-version']) headers['anthropic-version'] = originalHeaders['anthropic-version'];

    return {
      upstreamUrl: UPSTREAM_URL,
      headers,
      actualModel: model,
    };
  }

  // Lookup model
  let entry = modelMap[model];

  // Resolve alias (random pick)
  if (entry?.__alias) {
    const targets = entry.__alias;
    entry = targets[Math.floor(Math.random() * targets.length)];
  }

  // Fallback to default service
  if (!entry && defaultService) {
    entry = { service: defaultService, actualModel: model };
  }

  if (!entry) {
    // No match at all, fallback to UPSTREAM_URL
    if (originalHeaders.authorization) headers['authorization'] = originalHeaders.authorization;
    return { upstreamUrl: UPSTREAM_URL, headers, actualModel: model };
  }

  const svc = entry.service;
  headers['authorization'] = `Bearer ${svc.api_key}`;

  return {
    upstreamUrl: svc.base_url,
    headers,
    actualModel: entry.actualModel,
  };
}

/**
 * Get the default upstream base URL (for non-chat requests like /v1/models).
 * Uses the default routing service if configured, otherwise UPSTREAM_URL.
 */
function getDefaultUpstreamUrl() {
  buildModelMap();
  if (defaultService) return defaultService.base_url;
  return UPSTREAM_URL;
}

module.exports = { resolveUpstream, getDefaultUpstreamUrl };
