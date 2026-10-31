// @ts-check
// Tiny DOM helpers, so the UI needs no framework.

/**
 * Create an element. attrs: class, style (string), on<Event> handlers, dataset via data-*,
 * and anything else as a property (value, checked, disabled, hidden...) or attribute.
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...any} children strings, nodes, arrays, or false/null to skip
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'for' || k === 'role') el.setAttribute(k, String(v));
    else if (k in el) /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

/** @param {HTMLElement} el @param {any[]} children */
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Save text or bytes as a file in the browser.
 * @param {string} filename @param {BlobPart} content @param {string} [type]
 */
export function download(filename, content, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Ask the user for a file and read it as text.
 * @param {string} accept
 * @returns {Promise<{ name: string, text: string } | null>}
 */
export function pickTextFile(accept) {
  return new Promise((resolve) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept }));
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, text: await file.text() } : null);
    });
    input.click();
  });
}

/** A labelled form row. @param {string} label @param {Node} control @param {string} [help] */
export function field(label, control, help) {
  const id = control instanceof HTMLElement ? control.id || `f${Math.random().toString(36).slice(2, 8)}` : '';
  if (control instanceof HTMLElement && !control.id) control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, help ? h('div', { class: 'help' }, help) : null);
}

/**
 * <select> from options.
 * @param {Array<{ value: string, label: string }>} options @param {string | undefined} value
 * @param {(v: string) => void} onChange @param {Record<string, any>} [attrs]
 */
export function select(options, value, onChange, attrs = {}) {
  const el = /** @type {HTMLSelectElement} */ (h('select', { ...attrs, onchange: () => onChange(el.value) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))));
  return el;
}

/** Format a dB value with sign. @param {number} x */
export const db = (x) => `${x > 0 ? '+' : ''}${x.toFixed(1)} dB`;
