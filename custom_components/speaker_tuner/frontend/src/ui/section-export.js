// @ts-check
// Export: ESPHome YAML from the profile template, REW filters, the tuning report and the
// device mapping.

import { h, download } from './dom.js';
import { card } from './app.js';
import { exportYaml, rewFilters } from '../profiles/export.js';
import { expandRoles, settingRoles } from '../profiles/profile.js';
import { curveRms } from '../measure/peq.js';
import { tuningReport } from './report.js';

/** @param {import('./app.js').TunerApp} app */
export function renderExport(app) {
  const profile = app.profile;
  const w = app.writer;
  if (!profile || !w) return card('Export', 'Set up a speaker first', [h('p', { class: 'help' }, 'Set up a speaker first.')]);
  const values = app.values();
  const name = app.mapping?.name ?? 'speaker';
  const fileBase = name.replace(/[^\w-]+/g, '_').toLowerCase();
  /** @type {{ yaml: string, problems: string[] }} */
  let out = { yaml: '', problems: [] };
  let error = '';
  try {
    out = exportYaml(profile, values, { deviceName: name, tweeterMinFrequency: app.has('crossover_frequency') ? w.range('crossover_frequency').min : undefined });
  } catch (e) {
    error = /** @type {Error} */ (e).message;
  }

  const report = () => {
    const roles = expandRoles(profile);
    const fulls = app.measurements.filter((m) => m.kind === 'full' && (!app.session || m.time >= app.session.started));
    const pick = (/** @type {any} */ m) => (m ? { label: m.label, curve: m.curve, rms: curveRms(m.curve, app.target, app.mic) } : null);
    const before = app.session?.snapshot ?? {};
    const changes = settingRoles(profile)
      .filter((r) => r in before && JSON.stringify(before[r]) !== JSON.stringify(values[r]))
      .map((r) => ({ role: r, label: roles[r].label ?? r, before: before[r], after: values[r] }));
    const html = tuningReport({
      title: `Tuning report: ${name}`, profileName: profile.name, deviceName: name, mic: app.mic.name, tier: app.mic.tier,
      target: app.target, before: pick(fulls[0]), after: fulls.length > 1 ? pick(fulls[fulls.length - 1]) : null, changes, yaml: out.yaml,
    });
    download(`${fileBase}-tuning-report.html`, html, 'text/html');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(out.yaml);
      app.notify('YAML copied.', 'ok');
    } catch {
      app.notify('Could not copy; select the text and copy it instead.', 'warn');
    }
  };

  const mapping = app.mapping;
  return card('Export', 'ESPHome YAML, filters, report', [
    h('p', { class: 'help' }, 'The settings are already saved on the device. Put them in its YAML too, so they survive a factory reset and can be shared: paste this into the device config, flash, then use "Reset device to YAML" in Speaker settings.'),
    error ? h('p', { class: 'notice notice-error' }, error) : null,
    out.problems.length ? h('div', { class: 'notice notice-warn' }, h('strong', null, 'ESPHome would reject some values: '), h('ul', null, out.problems.map((p) => h('li', null, p)))) : null,
    h('textarea', { class: 'code', rows: 14, readOnly: true, spellcheck: false }, out.yaml),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => download(`${fileBase}-tuning.yaml`, out.yaml, 'text/yaml'), disabled: !out.yaml }, 'Download YAML'),
      h('button', { onclick: copy, disabled: !out.yaml }, 'Copy'),
      h('button', { onclick: () => download(`${fileBase}-filters.txt`, rewFilters(profile, values)) }, 'REW filter file'),
      h('button', { onclick: report }, 'Tuning report (HTML)'),
      mapping && !app.demo ? h('button', { class: 'link', onclick: () => download(`${fileBase}-mapping.json`, JSON.stringify(mapping, null, 2), 'application/json') }, 'Device mapping (personal: holds your entity IDs)') : null),
  ]);
}
