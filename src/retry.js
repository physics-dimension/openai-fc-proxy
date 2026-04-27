'use strict';

const { FC_RETRY_ENABLED, FC_RETRY_MAX, UPSTREAM_RETRY, UPSTREAM_RETRY_DELAY } = require('./config');
const { parseToolCallsFromText } = require('./parser');
const { validateToolCalls } = require('./schema');
const { removeThinkBlocks, findOutsideThink } = require('./think');
const { markers } = require('./delimiter');

// ============================================================
// FC parse retry logic (inspired by Toolify)
// Classifies failure as truncated vs syntax_error, retries accordingly
// ============================================================

function classifyFailure(content) {
  const cleaned = removeThinkBlocks(content);
  const tcStart = markers.TC_START;

  // Check for any tool call marker outside think
  const pos = findOutsideThink(cleaned, tcStart);
  // Also check legacy markers
  const legacyPos = findOutsideThink(cleaned, '##TOOL_CALL##');
  const xmlPos = findOutsideThink(cleaned, '<function_call');

  if (pos === -1 && legacyPos === -1 && xmlPos === -1) return 'no_fc';

  // Check if closing marker is present
  const hasClose =
    cleaned.includes(markers.TC_END) ||
    cleaned.includes('##END_CALL##') ||
    cleaned.includes('</function_call>') ||
    cleaned.includes('</tool_call>');

  return hasClose ? 'syntax_error' : 'truncated';
}

function buildRetryPrompt(type, content, error) {
  if (type === 'truncated') {
    const tail = content.slice(-1000);
    return (
      'Your previous response was cut off before the tool call was complete.\n\n' +
      '**Truncated ending:**\n```\n' + tail + '\n```\n\n' +
      (error ? `**Error:** ${error}\n\n` : '') +
      'Please output the complete tool call again using the correct format. Do NOT add any explanation.'
    );
  }

  return (
    'Your previous response attempted a tool call but the format was invalid.\n\n' +
    `**Error:** ${error || 'Failed to parse tool call'}\n\n` +
    '**Your original response:**\n```\n' + content.slice(-2000) + '\n```\n\n' +
    'Please retry with the correct tool call format. Do NOT output anything else.'
  );
}

/**
 * Trim messages to avoid token explosion during retries.
 * Keeps system message(s) + last N user/assistant turns.
 */
function trimMessagesForRetry(msgs, maxTurns = 6) {
  const system = msgs.filter(m => m.role === 'system');
  const rest = msgs.filter(m => m.role !== 'system');
  return [...system, ...rest.slice(-maxTurns)];
}

/**
 * Attempt to parse tool calls with retry.
 * Non-streaming only. Calls upstream again if parsing fails.
 *
 * @param {string} content - Model response content
 * @param {Set} allowedNames - Allowed tool names
 * @param {Array} toolDefs - Original tool definitions (for schema validation)
 * @param {Array} messages - Current message array
 * @param {Function} callUpstream - async (messages) => { content }
 * @returns {{ calls, cleaned }} or { calls: [], cleaned }
 */
async function parseWithRetry(content, allowedNames, toolDefs, messages, callUpstream) {
  let currentContent = content;
  let currentMessages = [...messages];

  const maxAttempts = FC_RETRY_ENABLED ? FC_RETRY_MAX : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { calls, cleaned } = parseToolCallsFromText(currentContent, allowedNames);

    if (calls.length > 0) {
      // Schema validation
      const validationError = validateToolCalls(calls, toolDefs);
      if (!validationError) {
        if (attempt > 0) console.log(`[fc-proxy] Parse succeeded on retry #${attempt + 1}`);
        return { calls, cleaned };
      }

      // Validation failed
      if (!FC_RETRY_ENABLED || attempt >= maxAttempts - 1) {
        console.warn(`[fc-proxy] Schema validation failed: ${validationError}`);
        return { calls, cleaned }; // Return anyway, let client handle
      }

      const prompt = buildRetryPrompt('syntax_error', currentContent, validationError);
      try {
        currentMessages = trimMessagesForRetry([
          ...currentMessages,
          { role: 'assistant', content: currentContent },
          { role: 'user', content: prompt },
        ]);
        const result = await callUpstream(currentMessages);
        currentContent = result.content;
        console.log(`[fc-proxy] Retry #${attempt + 1}: schema validation error, got ${currentContent.length} chars`);
      } catch (e) {
        console.error(`[fc-proxy] Retry request failed: ${e.message}`);
        return { calls, cleaned };
      }
      continue;
    }

    // No calls parsed
    const failType = classifyFailure(currentContent);
    if (failType === 'no_fc' || !FC_RETRY_ENABLED || attempt >= maxAttempts - 1) {
      return { calls: [], cleaned: currentContent };
    }

    const prompt = buildRetryPrompt(failType, currentContent, null);
    try {
      currentMessages = trimMessagesForRetry([
        ...currentMessages,
        { role: 'assistant', content: currentContent },
        { role: 'user', content: prompt },
      ]);
      const result = await callUpstream(currentMessages);
      currentContent = result.content;
      console.log(`[fc-proxy] Retry #${attempt + 1}: ${failType}, got ${currentContent.length} chars`);
    } catch (e) {
      console.error(`[fc-proxy] Retry request failed: ${e.message}`);
      return { calls: [], cleaned: currentContent };
    }
  }

  return { calls: [], cleaned: currentContent };
}

// ============================================================
// Upstream fetch with connection retry + exponential backoff
// ============================================================

async function fetchWithRetry(url, opts) {
  let lastError;
  for (let attempt = 0; attempt < UPSTREAM_RETRY; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastError = e;
      // Only retry on connection/timeout errors
      if (e.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
          e.cause?.code === 'ECONNREFUSED' ||
          e.cause?.code === 'ECONNRESET' ||
          e.name === 'TypeError') {
        if (attempt < UPSTREAM_RETRY - 1) {
          const delay = UPSTREAM_RETRY_DELAY * Math.pow(2, attempt) * 1000;
          console.log(`[fc-proxy] Upstream connect failed, retry #${attempt + 1} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      throw e;
    }
  }
  throw lastError;
}

module.exports = { parseWithRetry, fetchWithRetry, classifyFailure, buildRetryPrompt };
