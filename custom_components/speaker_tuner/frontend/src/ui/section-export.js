// @ts-check
// Export: ESPHome YAML from the profile template, REW filters, the tuning report and the
// device mapping.

import { h, download } from './dom.js';
import { card } from './app.js';
import { exportYaml, rewFilters } from '../profiles/export.js';
import { expandRoles, settingRoles } from '../profiles/profile.js';
import { SHIPPED } from './app.js';
import { curveRms } from '../measure/peq.js';
import { tuningReport } from './report.js';
import { resetSpeakerToYaml } from './section-settings.js';

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
    const fulls = app.measurements.filter((m) => m.kind === 'full' && !m.test && !m.undone && (!app.session || m.time >= app.session.started));
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
  const fullFile = /** @type {any} */ (profile).source?.kind === 'esphome-yaml' && /^# Speaker Tuner/.test(out.yaml) && /\nesphome:/.test(out.yaml);

  // keep this speaker's tuned values as the profile's recommended settings, for the next
  // speaker of the same build (and for sharing the profile)
  const saveRecommended = () => {
    const a = /** @type {any} */ (app);
    const roles = settingRoles(profile).filter((r) => app.has(r) && values[r] !== null && values[r] !== undefined);
    const rec = {
      values: Object.fromEntries(roles.map((r) => [r, values[r]])),
      source: 'tuning',
      tuned_with: { mic: app.mic.name, tier: app.mic.tier, target: app.target.name, positions: app.settings.positions, rms_after: a.refineResult?.finalRms ?? null },
      date: new Date().toISOString(),
    };
    /** @type {any} */
    let p = structuredClone(profile);
    // a shipped profile stays as shipped: the recommendations go in a copy for this build
    if (SHIPPED.profiles.includes(p.id)) {
      p = { ...p, id: `${p.id}-${(mapping?.id ?? 'x').toLowerCase().replace(/[^a-z0-9-]/g, '')}`, name: `${name} build (${p.name})`, based_on: p.id };
    }
    p.recommended = rec;
    app.saveProfile(p);
    if (mapping && mapping.profile !== p.id) {
      app.saveMapping({ ...mapping, profile: p.id });
      app.useMapping(mapping.id);
    }
    app.notify(`Saved ${roles.length} settings as the recommended settings of "${p.name}". A new speaker set up with this profile is offered them in Tune.`, 'ok');
    app.refresh();
  };

  return card('Export', 'ESPHome YAML, filters, report', [
    h('p', { class: 'help' }, fullFile
      ? 'The settings are already saved on the device. This is your own YAML (from the profile you uploaded) with the crossover: block filled in with them: flash it as it is, then use "Reset speaker to YAML" below.'
      : 'The settings are already saved on the device. Put them in its YAML too, so they survive a factory reset and can be shared: paste this into the device config, flash, then use "Reset device to YAML" in Speaker settings.'),
    error ? h('p', { class: 'notice notice-error' }, error) : null,
    out.problems.length ? h('div', { class: 'notice notice-warn' }, h('strong', null, 'Check before flashing: '), h('ul', null, out.problems.map((p) => h('li', null, p)))) : null,
    h('textarea', { class: 'code', rows: 14, readOnly: true, spellcheck: false }, out.yaml),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => download(`${fileBase}${fullFile ? '' : '-tuning'}.yaml`, out.yaml, 'text/yaml'), disabled: !out.yaml }, fullFile ? 'Download your full YAML' : 'Download YAML'),
      h('button', { onclick: copy, disabled: !out.yaml }, 'Copy'),
      h('button', { onclick: () => download(`${fileBase}-filters.txt`, rewFilters(profile, values)) }, 'REW filter file'),
      h('button', { onclick: report }, 'Tuning report (HTML)'),
      mapping && !app.demo ? h('button', { class: 'link', onclick: () => download(`${fileBase}-mapping.json`, JSON.stringify(mapping, null, 2), 'application/json') }, 'Device mapping (personal: holds your entity IDs)') : null),
    h('div', { class: 'subpanel' },
      h('h4', null, 'Recommended settings for this build'),
      h('p', { class: 'help' }, /** @type {any} */ (profile).recommended?.source === 'tuning'
        ? `The profile has recommended settings from a tuning on ${String(/** @type {any} */ (profile).recommended.date).slice(0, 10)}. Save again to replace them with today's values.`
        : 'Keep these tuned values in the profile, so another speaker of the same build starts from them (and they go with the profile when you share it).'),
      h('button', { onclick: saveRecommended, disabled: !!app.busy || app.demo }, 'Save as recommended for this build')),
    app.has('crossover_reset') ? h('div', { class: 'subpanel' },
      h('h4', null, 'After flashing'),
      h('p', { class: 'help' }, 'Make the speaker take its values from the new YAML, and check they match the tuning.'),
      h('button', { onclick: () => resetSpeakerToYaml(app), disabled: !!app.busy }, 'Reset speaker to YAML')) : null,
  ], true);
}
