'use strict';

// ============================================================
// Basic JSON Schema validator (inspired by Toolify)
// Supports: type, required, enum, properties, items
// ============================================================

function typeName(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeOk(v, t) {
  if (t === 'object') return typeof v === 'object' && v !== null && !Array.isArray(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'string') return typeof v === 'string';
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (t === 'number') return typeof v === 'number';
  if (t === 'null') return v === null;
  return true;
}

function validateValue(value, schema, path, depth) {
  if (!schema || typeof schema !== 'object') return [];
  if (depth > 8) return [];

  const errors = [];
  let stype = schema.type;

  // Infer object type from keywords
  if (!stype && (schema.properties || schema.required)) stype = 'object';

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: expected one of [${schema.enum.join(', ')}], got ${JSON.stringify(value)}`);
      return errors;
    }
  }

  // type check
  if (typeof stype === 'string') {
    if (!typeOk(value, stype)) {
      errors.push(`${path}: expected type '${stype}', got '${typeName(value)}'`);
      return errors;
    }
  }

  // object
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    for (const k of required) {
      if (!(k in value)) {
        errors.push(`${path}: missing required property '${k}'`);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        errors.push(...validateValue(v, props[k], `${path}.${k}`, depth + 1));
      }
    }
  }

  // array
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validateValue(value[i], schema.items, `${path}[${i}]`, depth + 1));
    }
  }

  return errors;
}

/**
 * Validate parsed tool calls against tool definitions.
 * Returns error string or null.
 */
function validateToolCalls(calls, toolDefs) {
  if (!toolDefs || toolDefs.length === 0) return null;

  const allowed = {};
  for (const t of toolDefs) {
    const fn = t.function || t;
    if (fn.name) allowed[fn.name] = fn.parameters || {};
  }
  const allowedNames = Object.keys(allowed);

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const name = call.function?.name;
    if (!name) return `Tool call #${i + 1}: missing tool name`;

    if (!allowed[name]) {
      return `Tool call #${i + 1}: unknown tool '${name}'. Allowed: [${allowedNames.join(', ')}]`;
    }

    let args;
    try {
      args = typeof call.function.arguments === 'string'
        ? JSON.parse(call.function.arguments) : call.function.arguments;
    } catch {
      return `Tool call #${i + 1} '${name}': invalid JSON arguments`;
    }

    const errs = validateValue(args, allowed[name], name, 0);
    if (errs.length > 0) {
      const preview = errs.slice(0, 3).join('; ');
      return `Tool call #${i + 1} '${name}': ${preview}`;
    }
  }

  return null;
}

module.exports = { validateToolCalls, validateValue };
