// @ts-check
// A small JSON Schema validator: enough of draft 2020-12 for this tool's own schemas
// (type, required, properties, additionalProperties, items, enum, min/max, minLength,
// minItems/maxItems, pattern, local $ref). Errors read like "roles.loudness.domain: must be one of ...".

/**
 * @param {any} schema @param {any} value @param {any} [root]
 * @returns {string[]} problems, empty when valid
 */
export function validate(schema, value, root = schema) {
  /** @type {string[]} */
  const errors = [];
  walk(schema, value, '', root, errors);
  return errors;
}

/** @param {any} v */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/**
 * @param {any} schema @param {any} v @param {string} path @param {any} root @param {string[]} errors
 */
function walk(schema, v, path, root, errors) {
  if (!schema || typeof schema !== 'object') return;
  const at = path || '(top)';
  if (schema.$ref) {
    const ref = String(schema.$ref);
    if (!ref.startsWith('#/')) throw new Error(`Only local $ref is supported: ${ref}`);
    const target = ref.slice(2).split('/').reduce((o, k) => o?.[k], root);
    walk(target, v, path, root, errors);
    return;
  }
  if (schema.enum && !schema.enum.some((/** @type {any} */ e) => e === v)) {
    errors.push(`${at}: must be one of ${schema.enum.map((/** @type {any} */ e) => JSON.stringify(e)).join(', ')}`);
    return;
  }
  if (schema.type) {
    const want = [].concat(schema.type);
    const got = typeOf(v);
    const ok = want.some((t) => t === got || (t === 'number' && got === 'integer'));
    if (!ok) {
      errors.push(`${at}: should be ${want.join(' or ')}, not ${got}`);
      return;
    }
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${at}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${at}: must be at most ${schema.maximum}`);
  }
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.length < schema.minLength) errors.push(`${at}: must not be empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errors.push(`${at}: "${v}" does not match ${schema.pattern}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} items`);
    if (schema.items) v.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, root, errors));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const key of schema.required ?? []) if (!(key in v)) errors.push(`${at}: missing "${key}"`);
    const props = schema.properties ?? {};
    for (const [key, value] of Object.entries(v)) {
      const child = path ? `${path}.${key}` : key;
      if (key in props) walk(props[key], value, child, root, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown field "${key}"`);
      else if (typeof schema.additionalProperties === 'object') walk(schema.additionalProperties, value, child, root, errors);
    }
  }
}
