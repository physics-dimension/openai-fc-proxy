'use strict';

const { markers, escapeRegex } = require('./delimiter');
const { removeThinkBlocks, findOutsideThink } = require('./think');

// ============================================================
// Multi-format tool call parser
// Priority: rare-char delimiters > ##TOOL_CALL## > <tool_call> > <function_call> > code block > raw JSON
// ============================================================

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
    id: 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    type: 'function',
    function: {
      name: normalizeName(name, allowed),
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
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

// --- Rare-char delimiter parser (primary) ---
// Cache compiled regex (markers are constant per process lifetime)
const _rareCharParseRe = new RegExp(
  `${escapeRegex(markers.TC_START)}\\s*` +
  `${escapeRegex(markers.NAME_START)}([\\s\\S]*?)${escapeRegex(markers.NAME_END)}\\s*` +
  `${escapeRegex(markers.ARGS_START)}([\\s\\S]*?)${escapeRegex(markers.ARGS_END)}\\s*` +
  `${escapeRegex(markers.TC_END)}`,
  'g'
);
const _rareCharRemoveRe = new RegExp(
  `${escapeRegex(markers.TC_START)}[\\s\\S]*?${escapeRegex(markers.TC_END)}`,
  'g'
);

function parseRareCharFormat(text, allowed) {
  _rareCharParseRe.lastIndex = 0;
  const calls = [];
  let match;
  while ((match = _rareCharParseRe.exec(text)) !== null) {
    const name = match[1].trim();
    const argsStr = match[2].trim();
    let args;
    try { args = JSON.parse(argsStr); } catch { continue; }

    calls.push({
      id: 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      type: 'function',
      function: {
        name: normalizeName(name, allowed),
        arguments: JSON.stringify(args),
      },
    });
  }
  return calls;
}

function removeRareCharBlocks(text) {
  _rareCharRemoveRe.lastIndex = 0;
  return text.replace(_rareCharRemoveRe, '').trim();
}

// --- Legacy format parsers (fallback) ---
function parseDelimited(text, allowed) {
  const re = /##TOOL_CALL##\s*([\s\S]*?)\s*##END_CALL##/g;
  const calls = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = tryParseCallJson(m[1].trim(), allowed);
    if (c) calls.push(c);
  }
  return calls;
}
function removeDelimited(text) {
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
function removeXmlToolCall(text) {
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
function removeFunctionCall(text) {
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
function removeCodeBlock(text) {
  return text.replace(/```(?:tool_call|json)?\s*\n?[\s\S]*?\n?```/g, '').trim();
}

function parseRawJson(text, allowed) {
  const c = tryParseCallJson(text.trim(), allowed);
  return c ? [c] : [];
}

// --- Broad error stripping ---
const ERROR_PATTERNS = [
  /Tool\s+[A-Za-z0-9_.:-]*\s*does not exists?\.?\s*/gi,
  /Error:\s*tool\s+['"][^'"]*['"]\s+not found[^\n]*/gi,
  /\bToolError\b[^\n]*/gi,
  /No such tool[^\n]*/gi,
];

function stripToolErrors(text) {
  let result = text;
  for (const re of ERROR_PATTERNS) {
    re.lastIndex = 0;
    result = result.replace(re, '');
  }
  return result.trim();
}

// ============================================================
// Main parse entry point (with <think> awareness)
// ============================================================
function parseToolCallsFromText(rawText, allowedNames) {
  // Strip <think> blocks before parsing
  const text = removeThinkBlocks(stripToolErrors(rawText));

  // 1. Rare-char delimiters (primary)
  let calls = parseRareCharFormat(text, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeRareCharBlocks(text) };

  // 2-6. Legacy fallbacks
  calls = parseDelimited(text, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeDelimited(text) };

  calls = parseXmlToolCall(text, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeXmlToolCall(text) };

  calls = parseFunctionCall(text, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeFunctionCall(text) };

  calls = parseCodeBlock(text, allowedNames);
  if (calls.length > 0) return { calls, cleaned: removeCodeBlock(text) };

  calls = parseRawJson(text, allowedNames);
  if (calls.length > 0) return { calls, cleaned: '' };

  return { calls: [], cleaned: text };
}

module.exports = {
  parseToolCallsFromText,
  parseRareCharFormat,
  stripToolErrors,
  normalizeName,
};
