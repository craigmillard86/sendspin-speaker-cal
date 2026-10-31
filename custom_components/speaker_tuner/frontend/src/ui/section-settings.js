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
  // the driver mutes are not tuning settings (no snapshot, no export), but they must always be
  // reachable here: an interrupted single-driver measurement can leave one on
  const mapped = [...settingRoles(profile), 'tweeter_mute', 'mid_mute'].filter((r) => app.has(r));

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

  const resetToYaml = () => resetSpeakerToYaml(app);
  const diff = /** @type {any} */ (app).resetDiff;

  return card('Speaker settings', `${mapped.length} settings`, [
    h('p', { class: 'help' }, 'Every DSP setting the speaker exposes. Changes are written straight away, are part of Revert, and go into the YAML export.'),
    Object.entries(groups).map(([group, list]) => h('fieldset', null,
      h('legend', null, /** @type {any} */ (GROUP_TITLES)[group] ?? `${profile.peq_banks.find((b) => b.id === group)?.name ?? group} PEQ`),
      h('div', { class: 'role-grid' }, list.map((role) => h('div', { class: 'role-row' }, h('label', null, roles[role].label ?? role), control(role)))))),
    app.has('crossover_reset') ? h('div', { class: 'row' }, h('button', { onclick: resetToYaml, disabled: !!app.busy }, 'Reset device to YAML')) : null,
    diff?.length ? h('table', { class: 'small' }, h('tr', null, h('th', null, 'Setting'), h('th', null, 'Before'), h('th', null, 'After reset')),
      diff.map((/** @type {any} */ d) => h('tr', null, h('td', null, d.role), h('td', null, String(d.before)), h('td', null, String(d.after))))) : null,
  ], true, 'settings');
}

/**
 * Press "Reset Crossover to YAML" on the speaker and read the values back, so you can see
 * whether the flashed YAML holds the tuning. Used from All settings and from Save.
 * @param {import('./app.js').TunerApp} app
 */
export function resetSpeakerToYaml(app) {
  return app.run('Resetting the speaker to its YAML', async (signal) => {
    const w = app.writer;
    const profile = app.profile;
    if (!w || !profile) throw new Error('Set up a speaker first.');
    await app.confirm('Reset to YAML?', 'Presses "Reset Crossover to YAML" on the speaker: every value saved from Home Assistant is replaced by the crossover: block in its YAML. Use it after flashing an exported YAML. The values are read back afterwards so you can see what changed.', 'Reset');
    const tuning = settingRoles(profile).filter((r) => app.has(r));
    const before = w.snapshot(tuning);
    await w.press('crossover_reset');
    await sleep(3000, signal);
    const after = w.snapshot(tuning);
    const changed = tuning.filter((r) => JSON.stringify(before[r]) !== JSON.stringify(after[r]));
    /** @type {any} */ (app).resetDiff = changed.map((r) => ({ role: r, before: before[r], after: after[r] }));
    app.notify(changed.length
      ? `${changed.length} values changed. If the YAML holds your exported tuning, nothing should have changed; the list is in All settings.`
      : 'The YAML matches the tuning: every value read back the same.', changed.length ? 'warn' : 'ok');
  });
}
