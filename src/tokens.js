'use strict';

// ============================================================
// Simple token estimation (zero dependencies)
// Rough approximation: ~4 chars per token for English,
// ~2 chars per token for CJK. Uses a blend.
// ============================================================

function estimateTokens(text) {
  if (!text) return 0;
  // Count CJK characters
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

function estimateMessageTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += 4; // message overhead
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    }
    if (msg.role) total += 1;
  }
  total += 3; // reply priming
  return total;
}

/**
 * Ensure response has a usage field.
 * Fills in estimates where upstream returned 0 or missing.
 */
function ensureUsage(responseJson, promptTokens, completionText) {
  const estCompletion = estimateTokens(completionText);
  const existing = responseJson.usage || {};

  const prompt = existing.prompt_tokens || promptTokens;
  const completion = existing.completion_tokens || estCompletion;

  responseJson.usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    // Preserve any extra fields from upstream (e.g., reasoning_tokens)
    ...existing,
    // Override zero values
    ...((!existing.prompt_tokens || existing.prompt_tokens === 0) ? { prompt_tokens: prompt } : {}),
    ...((!existing.completion_tokens || existing.completion_tokens === 0) ? { completion_tokens: completion } : {}),
    ...((!existing.total_tokens || existing.total_tokens === 0) ? { total_tokens: prompt + completion } : {}),
  };

  return responseJson;
}

module.exports = { estimateTokens, estimateMessageTokens, ensureUsage };
