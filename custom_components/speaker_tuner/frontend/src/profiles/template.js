// @ts-check
// {{placeholder}} templates for the YAML export. Deliberately tiny: names only, no logic,
// so anyone can write a template for their own component without reading code.

/** @param {string} template */
export function placeholders(template) {
  return [...new Set([...template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];
}

/**
 * Fill a template. Unknown placeholders are an error that names them all, so a typo in a
 * profile shows up straight away instead of as broken YAML.
 * @param {string} template @param {Record<string, string | number | boolean>} values
 */
export function render(template, values) {
  const missing = placeholders(template).filter((k) => !(k in values));
  if (missing.length) throw new Error(`The profile's YAML template uses values the tool doesn't have: ${missing.join(', ')}`);
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => String(values[k]));
}
