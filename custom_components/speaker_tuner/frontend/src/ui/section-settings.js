// @ts-check
// Speaker settings: a control for every mapped DSP entity, written live. Also the
// "Reset device to YAML" button, which reads the values back afterwards and shows what changed.

import { h, select } from './dom.js';
import { card } from './app.js';
import { expandRoles, settingRoles } from '../profiles/profile.js';
import { selectOptions } from '../ha/entities.js';
import { sleep } from '../measure/session.js';

const GROUP_TITLES = { crossover: 'Crossover', drivers: 'Drivers', compensation: 'Compensation', playback: 'Playback' };

/** @param {import('./app.js').TunerApp} app */
export function renderSettings(app) {
  const w = app.writer;
  const profile = app.profile;
  if (!w || !profile) return card('Speaker settings', 'Set up a speaker first', [h('p', { class: 'help' }, 'Set up a speaker first.')]);
  const roles = expandRoles(profile);
  const mapped = settingRoles(profile).filter((r) => app.has(r));

  /** @param {string} role @param {any} value */
  const write = (role, value) => app.run(`Setting ${roles[role].label ?? role}`, async (signal) => {
    await app.ensureSession();
    const r = await w.write({ [role]: value }, { signal });
    if (!r.ok) app.notify(`${role}: ${r.failed[0]?.error ?? 'stopped'}`, 'error');
  });

  /** @param {string} role */
  const control = (role) => {
    const spec = roles[role];
    const value = w.value(role);
    if (spec.domain === 'switch') {
      const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: !!value, disabled: !!app.busy, onchange: () => write(role, box.checked) }));
      return box;
    }
    if (spec.domain === 'select') {
      const options = selectOptions(spec, w.stateOf(role)).map((/** @type {string} */ o) => ({ value: o, label: o }));
      return select(options, value ?? '', (v) => write(role, v), { disabled: !!app.busy });
    }
    const r = w.range(role);
    const input = /** @type {HTMLInputElement} */ (h('input', {
      type: 'number', min: r.min, max: r.max, step: r.step || 'any', value: value ?? '', disabled: !!app.busy,
      onchange: () => input.value !== '' && write(role, Number(input.value)),
    }));
    return h('span', { class: 'num' }, input, spec.unit ? h('span', { class: 'unit' }, spec.unit) : null);
  };

  /** @type {Record<string, string[]>} */
  const groups = {};
  for (const role of mapped) (groups[roles[role].group ?? 'other'] ??= []).push(role);

  const resetToYaml = () => app.run('Resetting the device to its YAML values', async (signal) => {
    await app.confirm('Reset to YAML?', 'Presses "Reset Crossover to YAML" on the device: every saved Home Assistant value is replaced by the crossover: block in its YAML. Use it after flashing an exported YAML. The values are read back afterwards so you can see what changed.', 'Reset');
    const before = w.snapshot(mapped);
    await w.press('crossover_reset');
    await sleep(3000, signal);
    const after = w.snapshot(mapped);
    const changed = mapped.filter((r) => JSON.stringify(before[r]) !== JSON.stringify(after[r]));
    /** @type {any} */ (app).resetDiff = changed.map((r) => ({ role: r, before: before[r], after: after[r] }));
    app.notify(changed.length
      ? `Reset done: ${changed.length} values changed. If the YAML holds your exported tuning, nothing should have changed; see the list below.`
      : 'Reset done: the YAML values match what was set. The tuning is in the YAML.', changed.length ? 'warn' : 'ok');
  });
  const diff = /** @type {any} */ (app).resetDiff;

  return card('Speaker settings', `${mapped.length} settings`, [
    h('p', { class: 'help' }, 'Every DSP setting the speaker exposes. Changes are written straight away, are part of Revert, and go into the YAML export.'),
    Object.entries(groups).map(([group, list]) => h('fieldset', null,
      h('legend', null, /** @type {any} */ (GROUP_TITLES)[group] ?? `${profile.peq_banks.find((b) => b.id === group)?.name ?? group} PEQ`),
      h('div', { class: 'role-grid' }, list.map((role) => h('div', { class: 'role-row' }, h('label', null, roles[role].label ?? role), control(role)))))),
    app.has('crossover_reset') ? h('div', { class: 'row' }, h('button', { onclick: resetToYaml, disabled: !!app.busy }, 'Reset device to YAML')) : null,
    diff?.length ? h('table', { class: 'small' }, h('tr', null, h('th', null, 'Setting'), h('th', null, 'Before'), h('th', null, 'After reset')),
      diff.map((/** @type {any} */ d) => h('tr', null, h('td', null, d.role), h('td', null, String(d.before)), h('td', null, String(d.after))))) : null,
  ]);
}
