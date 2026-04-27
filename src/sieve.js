'use strict';

const { markers, escapeRegex } = require('./delimiter');
const { parseToolCallsFromText, stripToolErrors } = require('./parser');
const { findOutsideThink } = require('./think');

// ============================================================
// Streaming ToolSieve with prefix-match protection
// Normal text passes through immediately; buffers only when
// a tool call marker (or partial prefix of one) is detected.
// ============================================================

// All markers we watch for in streaming mode
const STREAM_MARKERS = [
  markers.TC_START,             // primary: rare-char
  '##TOOL_CALL##',             // legacy fallback
  '<tool_call>',
  '<function_call>',
  '{"name":',
];

const END_MARKERS = {
  [markers.TC_START]: markers.TC_END,
  '##TOOL_CALL##': '##END_CALL##',
  '<tool_call>': '</tool_call>',
  '<function_call>': '</function_call>',
};

/**
 * Find the safe cut index: if text ends with a prefix of any marker,
 * we must keep that suffix in the buffer (prefix-match protection).
 */
function findSafeCut(text, markerList) {
  let minKeep = 0;
  for (const marker of markerList) {
    for (let i = marker.length - 1; i > 0; i--) {
      if (text.endsWith(marker.slice(0, i))) {
        minKeep = Math.max(minKeep, i);
      }
    }
  }
  return text.length - minKeep;
}

class ToolSieve {
  constructor(allowedNames) {
    this.allowed = allowedNames;
    this.buffer = '';
    this.inToolBlock = false;
    this.currentEndMarker = null;
    this.thinkDepth = 0;
    this._thinkScanPos = 0; // tracks how far we've scanned for think tags
  }

  feed(chunk) {
    this.buffer += chunk;

    // Track <think> depth (only scan new content)
    this._updateThinkState();

    if (!this.inToolBlock) {
      // Don't detect markers inside <think> blocks
      if (this.thinkDepth === 0) {
        for (const marker of STREAM_MARKERS) {
          const idx = this.buffer.indexOf(marker);
          if (idx >= 0) {
            this.inToolBlock = true;
            this.currentEndMarker = END_MARKERS[marker] || null;
            const textBefore = this.buffer.slice(0, idx);
            this._sliceBuffer(idx);
            return { text: stripToolErrors(textBefore), done: false };
          }
        }
      }

      // Prefix-match protection: keep potential partial marker at the end
      const safeCut = findSafeCut(this.buffer, STREAM_MARKERS);
      if (safeCut > 0) {
        const safe = this.buffer.slice(0, safeCut);
        this._sliceBuffer(safeCut);
        return { text: stripToolErrors(safe), done: false };
      }
      return { text: '', done: false };
    }

    // In tool block: wait for end marker
    if (this.currentEndMarker) {
      const endIdx = this.buffer.indexOf(this.currentEndMarker);
      if (endIdx >= 0) {
        // Check if there are more tool blocks after this one
        const blockEnd = endIdx + this.currentEndMarker.length;
        const remaining = this.buffer.slice(blockEnd);

        // Look for another TC_START after this block
        let hasMore = false;
        for (const marker of STREAM_MARKERS) {
          if (remaining.indexOf(marker) >= 0) {
            hasMore = true;
            break;
          }
        }

        if (!hasMore) {
          // Check if remaining might be start of another marker (partial)
          const safeCut = findSafeCut(remaining, STREAM_MARKERS);
          if (safeCut < remaining.length) {
            // Partial marker detected, keep buffering
            return { text: '', done: false };
          }
        }

        // Parse all accumulated tool blocks
        const { calls } = parseToolCallsFromText(this.buffer, this.allowed);
        if (calls.length > 0) {
          this._setBuffer(remaining);
          this.inToolBlock = false;
          return { toolCalls: calls, done: true };
        }
      }
    } else {
      // JSON-style marker: bail if buffer too large (prevents getting stuck on false positive)
      if (this.buffer.length > 2000) {
        const text = this.buffer;
        this._setBuffer('');
        this.inToolBlock = false;
        return { text: stripToolErrors(text), done: false };
      }
      try {
        JSON.parse(this.buffer.trim());
        const { calls } = parseToolCallsFromText(this.buffer, this.allowed);
        this._setBuffer('');
        this.inToolBlock = false;
        if (calls.length > 0) return { toolCalls: calls, done: true };
      } catch { /* incomplete JSON, keep buffering */ }
    }

    return { text: '', done: false };
  }

  /** Safely replace buffer and reset think scan position */
  _sliceBuffer(fromIndex) {
    this.buffer = this.buffer.slice(fromIndex);
    this._thinkScanPos = Math.max(0, this._thinkScanPos - fromIndex);
  }

  _setBuffer(value) {
    this.buffer = value;
    this._thinkScanPos = 0;
    // Re-scan think state for new buffer content
    this.thinkDepth = 0;
    this._updateThinkState();
  }

  flush() {
    if (this.buffer) {
      const { calls, cleaned } = parseToolCallsFromText(this.buffer, this.allowed);
      this.buffer = '';
      this._thinkScanPos = 0;
      if (calls.length > 0) return { toolCalls: calls, text: cleaned };
      return { text: stripToolErrors(cleaned) };
    }
    return { text: '' };
  }

  _updateThinkState() {
    // Only scan new content since last scan position
    const buf = this.buffer;
    let i = this._thinkScanPos;
    while (i < buf.length) {
      if (buf.startsWith('<think>', i)) {
        this.thinkDepth++;
        i += 7;
      } else if (buf.startsWith('</think>', i)) {
        this.thinkDepth = Math.max(0, this.thinkDepth - 1);
        i += 8;
      } else {
        i++;
      }
    }
    this._thinkScanPos = i;
  }
}

module.exports = { ToolSieve, findSafeCut };
