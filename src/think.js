'use strict';

// ============================================================
// <think> tag handling (inspired by Toolify)
// Strips <think>...</think> blocks, supports nesting
// ============================================================

function removeThinkBlocks(text) {
  while (text.includes('<think>') && text.includes('</think>')) {
    const start = text.indexOf('<think>');
    if (start === -1) break;

    let pos = start + 7;
    let depth = 1;

    while (pos < text.length && depth > 0) {
      if (text.startsWith('<think>', pos)) {
        depth++;
        pos += 7;
      } else if (text.startsWith('</think>', pos)) {
        depth--;
        pos += 8;
      } else {
        pos++;
      }
    }

    if (depth === 0) {
      text = text.slice(0, start) + text.slice(pos);
    } else {
      break; // unclosed think block, stop
    }
  }
  return text;
}

/**
 * Find the last occurrence of `signal` that is NOT inside any <think> block.
 * Returns index or -1.
 */
function findOutsideThink(text, signal) {
  if (!text || !signal) return -1;

  let i = 0;
  let thinkDepth = 0;
  let lastPos = -1;

  while (i < text.length) {
    if (text.startsWith('<think>', i)) {
      thinkDepth++;
      i += 7;
      continue;
    }
    if (text.startsWith('</think>', i)) {
      thinkDepth = Math.max(0, thinkDepth - 1);
      i += 8;
      continue;
    }
    if (thinkDepth === 0 && text.startsWith(signal, i)) {
      lastPos = i;
      i += 1;
      continue;
    }
    i++;
  }

  return lastPos;
}

module.exports = { removeThinkBlocks, findOutsideThink };
