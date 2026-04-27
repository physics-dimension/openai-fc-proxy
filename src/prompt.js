'use strict';

const { markers } = require('./delimiter');

// ============================================================
// tools → system prompt generation
// Includes tool_choice support (inspired by Toolify)
// ============================================================

function toolsToPrompt(tools, toolChoice) {
  const m = markers;
  const lines = [];

  lines.push('You have access to the following tools to help solve problems:\n');

  for (let i = 0; i < tools.length; i++) {
    const fn = tools[i].function || tools[i];
    lines.push(`${i + 1}. **${fn.name}**`);
    if (fn.description) lines.push(`   Description: ${fn.description}`);
    if (fn.parameters) lines.push(`   Parameters: ${JSON.stringify(fn.parameters)}`);
    lines.push('');
  }

  lines.push('### How to call tools\n');
  lines.push('When you need to call a tool, use this EXACT format at the END of your response:\n');
  lines.push(`${m.TC_START}`);
  lines.push(`${m.NAME_START}function_name${m.NAME_END}`);
  lines.push(`${m.ARGS_START}{"param": "value"}${m.ARGS_END}`);
  lines.push(`${m.TC_END}\n`);

  lines.push('### Rules\n');
  lines.push('1. Tool calls MUST be at the END of your response.');
  lines.push('2. Copy the delimiters EXACTLY as shown above.');
  lines.push('3. Arguments must be valid JSON.');
  lines.push('4. You may call multiple tools by outputting multiple blocks in sequence.');
  lines.push('5. If no tool is needed, respond normally without any tool call blocks.');
  lines.push('6. Do NOT output any text after the tool call blocks.');
  lines.push('7. If the conversation contains tool results (wrapped in special markers), use them to form your answer.');

  // tool_choice injection
  const choicePrompt = buildToolChoicePrompt(toolChoice, tools);
  if (choicePrompt) lines.push('\n' + choicePrompt);

  return lines.join('\n');
}

function buildToolChoicePrompt(toolChoice, tools) {
  if (!toolChoice) return '';

  if (toolChoice === 'none') {
    return '**IMPORTANT**: Do NOT call any tools in this response. Answer using only your knowledge.';
  }
  if (toolChoice === 'required' || toolChoice === 'any') {
    return '**IMPORTANT**: You MUST call at least one tool in this response. Do not answer without calling a tool.';
  }
  if (toolChoice === 'auto') {
    return ''; // default behavior
  }

  // Specific tool: { type: "function", function: { name: "xxx" } }
  if (typeof toolChoice === 'object' && toolChoice.function?.name) {
    const name = toolChoice.function.name;
    return `**IMPORTANT**: You MUST call the tool "${name}" in this response. Do not call any other tool.`;
  }

  return '';
}

module.exports = { toolsToPrompt };
