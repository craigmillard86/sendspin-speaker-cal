// @ts-check
// A self-contained HTML tuning report (no scripts, no external files): profile, mic,
// before/after chart against the target, RMS figures, changed settings and the YAML.

import { view, normalised } from '../dsp/analyse.js';
import { targetDb } from '../dsp/target.js';
import { VERSION } from '../version.js';

/** @param {string} s */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[/** @type {'&'} */ (c)]);

/**
 * @param {{ title: string, profileName: string, deviceName: string, mic: string, tier: string,
 *   target: import('../dsp/target.js').Target,
 *   before?: { label: string, curve: { freqs: number[], db: number[] }, rms: number } | null,
 *   after?: { label: string, curve: { freqs: number[], db: number[] }, rms: number } | null,
 *   changes: Array<{ role: string, label: string, before: any, after: any }>, yaml: string }} r
 */
export function tuningReport(r) {
  const W = 720;
  const H = 300;
  const pad = { l: 40, r: 10, t: 10, b: 24 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const lines = [r.before, r.after].filter(Boolean).map((m) => view(normalised(/** @type {any} */ (m).curve), 24, 24));
  const all = lines.flatMap((l) => l.db.filter((_, i) => l.freqs[i] >= 40 && l.freqs[i] <= 16000));
  const lo = Math.floor((Math.min(...all, -10) - 3) / 5) * 5;
  const hi = Math.ceil((Math.max(...all, 10) + 3) / 5) * 5;
  const x = (/** @type {number} */ f) => pad.l + (Math.log(f / 20) / Math.log(1000)) * pw;
  const y = (/** @type {number} */ d) => pad.t + ((hi - d) / (hi - lo)) * ph;
  const path = (/** @type {{ freqs: number[], db: number[] }} */ l) =>
    l.freqs.map((f, i) => `${i ? 'L' : 'M'}${x(f).toFixed(1)},${y(Math.max(lo, Math.min(hi, l.db[i]))).toFixed(1)}`).join('');
  const grid = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const tgrid = lines[0]?.freqs ?? [];
  const target = { freqs: tgrid, db: Array.from(targetDb(r.target, tgrid)) };
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Frequency response before and after tuning">
    ${grid.map((f) => `<line x1="${x(f)}" x2="${x(f)}" y1="${pad.t}" y2="${pad.t + ph}" class="g"/><text x="${x(f)}" y="${H - 6}" class="t" text-anchor="middle">${f >= 1000 ? f / 1000 + 'k' : f}</text>`).join('')}
    ${Array.from({ length: (hi - lo) / 5 + 1 }, (_, i) => lo + i * 5).map((d) => `<line x1="${pad.l}" x2="${pad.l + pw}" y1="${y(d)}" y2="${y(d)}" class="g"/><text x="${pad.l - 6}" y="${y(d) + 4}" class="t" text-anchor="end">${d}</text>`).join('')}
    ${tgrid.length ? `<path d="${path(target)}" class="target"/>` : ''}
    ${lines.map((l, i) => `<path d="${path(l)}" class="s${i + 1}"/>`).join('')}
  </svg>`;
  const legend = [r.before && ['s1', `${r.before.label}: ${r.before.rms.toFixed(2)} dB RMS from target`], r.after && ['s2', `${r.after.label}: ${r.after.rms.toFixed(2)} dB RMS from target`], ['target', `Target: ${r.target.name}`]]
    .filter(Boolean).map((e) => `<li><span class="sw ${/** @type {any} */ (e)[0]}"></span>${esc(/** @type {any} */ (e)[1])}</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)}</title>
<style>
:root { color-scheme: light; --bg:#fcfcfb; --text:#0b0b0b; --muted:#52514e; --grid:#e4e3df; --s1:#eb6834; --s2:#2a78d6; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg:#1a1a19; --text:#f0efec; --muted:#c3c2b7; --grid:#3a3936; --s1:#d95926; --s2:#3987e5; } }
body { background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 760px; padding: 16px; }
h1 { font-size: 1.4em; } h2 { font-size: 1.1em; margin-top: 1.6em; }
.muted { color: var(--muted); } svg { width: 100%; height: auto; }
.g { stroke: var(--grid); stroke-width: 1; } .t { fill: var(--muted); font-size: 11px; }
path { fill: none; stroke-width: 2; stroke-linejoin: round; } .s1 { stroke: var(--s1); } .s2 { stroke: var(--s2); }
.target { stroke: var(--muted); stroke-dasharray: 6 4; }
ul.legend { list-style: none; padding: 0; } ul.legend li { margin: 2px 0; }
.sw { display: inline-block; width: 14px; height: 3px; margin-right: 8px; vertical-align: middle; border-radius: 2px; }
.sw.s1 { background: var(--s1); } .sw.s2 { background: var(--s2); } .sw.target { border-top: 2px dashed var(--muted); height: 0; }
table { border-collapse: collapse; width: 100%; font-size: 14px; } td, th { border-bottom: 1px solid var(--grid); padding: 4px 6px; text-align: left; }
pre { background: color-mix(in srgb, var(--grid) 40%, transparent); padding: 12px; overflow: auto; font-size: 12px; border-radius: 6px; }
</style></head><body>
<h1>${esc(r.title)}</h1>
<p class="muted">${esc(r.deviceName)} · ${esc(r.profileName)} · mic: ${esc(r.mic)} (${esc(r.tier)}) · ${new Date().toLocaleString()} · Speaker Tuner ${VERSION}</p>
${lines.length ? svg : '<p>No measurements in this report.</p>'}
<ul class="legend">${legend}</ul>
<h2>Settings changed</h2>
${r.changes.length ? `<table><tr><th>Setting</th><th>Before</th><th>After</th></tr>${r.changes.map((c) => `<tr><td>${esc(c.label)}</td><td>${esc(String(c.before))}</td><td>${esc(String(c.after))}</td></tr>`).join('')}</table>` : '<p>None.</p>'}
<h2>ESPHome YAML</h2>
<pre>${esc(r.yaml)}</pre>
</body></html>
`;
}
