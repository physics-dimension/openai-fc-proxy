'use strict';

const { markers } = require('./delimiter');

// ============================================================
// Message transformation, merging, history cleanup
// ============================================================

/**
 * Merge adjacent messages with the same role (fixes Gemini 400 errors)
 */
function mergeAdjacentMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];

  const merged = [];
  let current = { ...messages[0] };

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === current.role && typeof current.content === 'string' && typeof msg.content === 'string') {
      // Only merge string content; skip merging array (multimodal) content
      current.content = `${current.content}\n\n${msg.content}`;
    } else {
      merged.push(current);
      current = { ...msg };
    }
  }
  merged.push(current);
  return merged;
}

/**
 * Check if message history contains tool-related messages
 */
function hasToolHistory(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    m => m?.role === 'tool' ||
    (m?.role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0)
  );
}

/**
 * Transform messages for upstream:
 * - Inject system prompt with tool definitions
 * - Convert assistant.tool_calls → text with rare-char delimiters
 * - Convert tool messages → user messages with RESULT markers
 * - Convert developer → system
 * - hasTools=false but hasToolHistory=true → strip to plain text
 */
function transformMessages(messages, toolsPrompt, { hasTools }) {
  const m = markers;
  const out = [];
  let hasSystem = false;

  for (const msg of messages) {
    // developer → system conversion
    if (msg.role === 'developer') {
      out.push({
        role: 'system',
        content: (msg.content || '') + (hasTools && toolsPrompt ? '\n\n' + toolsPrompt : ''),
      });
      if (hasTools) hasSystem = true;
      continue;
    }

    if (msg.role === 'system') {
      out.push({
        role: 'system',
        content: (msg.content || '') + (hasTools && toolsPrompt ? '\n\n' + toolsPrompt : ''),
      });
      if (hasTools) hasSystem = true;
      continue;
    }

    // assistant with tool_calls
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      let content = msg.content || '';

      if (hasTools) {
        for (const tc of msg.tool_calls) {
          const args = typeof tc.function.arguments === 'string'
            ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          content += `\n${m.TC_START}\n${m.NAME_START}${tc.function.name}${m.NAME_END}\n${m.ARGS_START}${args}${m.ARGS_END}\n${m.TC_END}`;
        }
      } else {
        // Strip tool_calls to plain text for compatibility
        const names = msg.tool_calls.map(tc => tc.function?.name).filter(Boolean).join(', ');
        content += `\n\n[Called tools: ${names}]`;
      }

      out.push({ role: 'assistant', content: content.trim() });
      continue;
    }

    // tool result messages
    if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'unknown';
      const result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      if (hasTools) {
        out.push({
          role: 'user',
          content: `${m.RESULT_START}[${name}]\n${result}${m.RESULT_END}`,
        });
      } else {
        out.push({
          role: 'user',
          content: `[Tool result: ${name}]\n${result}`,
        });
      }
      continue;
    }

    // passthrough (preserve all original fields)
    out.push({ ...msg });
  }

  if (hasTools && !hasSystem && toolsPrompt) {
    out.unshift({ role: 'system', content: toolsPrompt });
  }

  return mergeAdjacentMessages(out);
}

module.exports = { transformMessages, mergeAdjacentMessages, hasToolHistory };
