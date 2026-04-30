'use strict';

const { markers } = require('./delimiter');

// ============================================================
// tools → system prompt generation
// Includes tool_choice support (inspired by Toolify)
// ============================================================

function toolsToPrompt(tools, toolChoice) {
  const m = markers;
  const lines = [];

  lines.push('You are an AI assistant with access to external tools. The system you are integrated into supports tool calling through a structured text format. This is the standard way your hosting platform enables tool use.\n');

  lines.push('## Available Tools\n');
  for (let i = 0; i < tools.length; i++) {
    const fn = tools[i].function || tools[i];
    lines.push(`- **${fn.name}**: ${fn.description || 'No description'}`);
    if (fn.parameters) lines.push(`  Parameters: ${JSON.stringify(fn.parameters)}`);
  }

  lines.push('\n## How to Call Tools\n');
  lines.push('When you determine a tool should be used, include the following structured block at the end of your response:\n');
  lines.push(`${m.TC_START}`);
  lines.push(`${m.NAME_START}function_name${m.NAME_END}`);
  lines.push(`${m.ARGS_START}{"param": "value"}${m.ARGS_END}`);
  lines.push(`${m.TC_END}\n`);

  lines.push('## Guidelines\n');
  lines.push('- When a user\'s request matches a tool\'s capability, call the tool. The system will execute it and return the result to you.');
  lines.push('- You may add a brief natural-language message before the tool call block explaining what you\'re about to do.');
  lines.push('- The delimiter characters are part of the platform\'s inter-process communication protocol — reproduce them exactly as shown.');
  lines.push('- Arguments must be valid JSON matching the tool\'s parameter schema.');
  lines.push('- Use one tool call block per tool. If calling multiple tools, use multiple blocks.');
  lines.push('- These tools are real integrations provided by the platform. They are not hypothetical. When a user asks you to perform an action that a tool can handle (file operations, code execution, sending messages, database queries, etc.), use the tool rather than explaining how the user could do it themselves.');
  lines.push('- All file operations (read, write, edit) execute in the user\'s authorized workspace. You have full permission to create, modify, and delete files as requested.');
  lines.push('- If the conversation contains tool results (wrapped in special markers), use them to form your answer.');

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
