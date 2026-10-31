// @ts-check
// Measure: level once per session, take measurements, list and compare them, import REW
// responses, export CSV/JSON.

import { h, field, select, download, pickTextFile } from './dom.js';
import { card } from './app.js';
import { parseFrequencyText } from '../dsp/calfile.js';
import { importedMeasurement } from '../measure/record.js';
import { measurementCsv, measurementsCsv } from '../profiles/export.js';
import { STORE_GRID } from '../dsp/analyse.js';

/** @param {import('./app.js').TunerApp} app */
export function renderMeasure(app) {
  const ready = !!app.writer;
  const s = app.session;
  const mutes = app.has('tweeter_mute') && app.has('mid_mute');
  const label = /** @type {HTMLInputElement} */ (h('input', { value: '', placeholder: `Measurement ${app.measurements.length + 1}` }));
  let kind = /** @type {'full' | 'tweeter' | 'mid'} */ ('full');
  const kinds = select([
    { value: 'full', label: 'Whole speaker' },
    ...(mutes ? [{ value: 'tweeter', label: 'Tweeter alone' }, { value: 'mid', label: 'Mid alone' }] : []),
  ], kind, (v) => (kind = /** @type {any} */ (v)));
  const positions = /** @type {HTMLInputElement} */ (h('input', { type: 'number', min: 1, max: 9, value: app.settings.positions }));

  const level = () => app.run('Setting the measurement level', async (signal) => {
    const session = await app.ensureSession();
    const r = await app.measurer().autoLevel({ signal, onStatus: (t) => app.status(t) });
    if (session.levelVolume !== null) session.relevelled = true;
    session.levelVolume = r.volume;
    app.persist();
    app.notify(r.reachedCap
      ? `Reached the volume cap (${Math.round(r.volume * 100)}%) with the mic at ${r.rmsDbfs.toFixed(1)} dBFS. Measurements will be noisier; move the mic closer or raise its gain.`
      : `Level set: volume ${Math.round(r.volume * 100)}%, mic ${r.rmsDbfs.toFixed(1)} dBFS. Every measurement this session uses this volume.`, r.reachedCap ? 'warn' : 'ok');
  });

  const measure = () => app.run('Measuring', async (signal) => {
    if (!app.session || app.session.levelVolume === null) {
      await app.confirm('Level first?', 'This session has no measurement level yet. Set it now? The speaker will play pink noise and get gradually louder.', 'Set level');
      const r = await app.measurer().autoLevel({ signal, onStatus: (t) => app.status(t) });
      const session = await app.ensureSession();
      session.levelVolume = r.volume;
      app.persist();
    }
    const n = Math.max(1, Math.min(9, Number(positions.value) || 1));
    const m = kind === 'full' ? null : kind;
    const prep = m === 'tweeter' ? { tweeter_mute: false, mid_mute: true } : m === 'mid' ? { tweeter_mute: true, mid_mute: false } : null;
    const writer = /** @type {any} */ (app.writer);
    if (prep) await writer.write(prep, { signal });
    try {
      const rec = await app.measure({ label: label.value.trim() || `Measurement ${app.measurements.length + 1}`, kind, positions: n }, signal);
      app.addMeasurement(rec);
    } finally {
      if (prep) await writer.write({ tweeter_mute: false, mid_mute: false });
    }
  });

  const importRew = async () => {
    const file = await pickTextFile('.txt,.frd,.csv,text/plain');
    if (!file) return;
    try {
      const fr = parseFrequencyText(file.text);
      app.addMeasurement(importedMeasurement(file.name.replace(/\.\w+$/, ''), fr));
      app.notify(`Imported ${file.name}. Treated as calibrated; the fit uses it like any measurement.`, 'ok');
    } catch (e) {
      app.notify(/** @type {Error} */ (e).message, 'error');
    }
  };
  const importJson = async () => {
    const file = await pickTextFile('.json,application/json');
    if (!file) return;
    try {
      const list = JSON.parse(file.text);
      if (!Array.isArray(list)) throw new Error('Expected a list of measurements.');
      for (const m of list) {
        if (!m?.curve?.db || m.curve.db.length !== STORE_GRID.length) throw new Error('A measurement in that file is not on this tool\'s frequency grid.');
        app.addMeasurement({ ...m, id: `${m.id}-i${Date.now().toString(36)}` });
      }
    } catch (e) {
      app.notify(/** @type {Error} */ (e).message, 'error');
    }
  };

  const list = h('ul', { class: 'mlist' }, [...app.measurements].reverse().map((m) => {
    const lowConf = m.mask ? Math.round((m.mask.filter(Boolean).length / m.mask.length) * 100) : 0;
    const flags = [
      m.kind !== 'full' ? { tweeter: 'tweeter alone', mid: 'mid alone', nearfield: 'nearfield' }[m.kind] : '',
      m.positions > 1 ? `${m.positions} positions` : '',
      m.source === 'rew' ? 'imported' : '',
      m.clipped ? 'clipped' : '',
      m.relevelled ? 're-levelled' : '',
      lowConf > 5 ? `${lowConf}% low confidence` : '',
    ].filter(Boolean);
    const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: app.visible.has(m.id), 'aria-label': `Show ${m.label}`, onchange: () => {
      if (box.checked) app.visible.add(m.id);
      else app.visible.delete(m.id);
      app.updateChart();
    } }));
    return h('li', null,
      box,
      h('span', { class: 'swatch', style: `background: var(--series-${((/** @type {any} */ (m).slot ?? 0) % 8) + 1})` }),
      h('span', { class: 'mlabel' }, h('strong', null, m.label), h('span', { class: 'muted' }, ` ${new Date(m.time).toLocaleString()} · ${m.mic} (${m.tier})${flags.length ? ` · ${flags.join(' · ')}` : ''}`)),
      h('span', { class: 'row tight' },
        h('button', { class: 'link', onclick: () => download(`${m.label.replace(/[^\w-]+/g, '_')}.csv`, measurementCsv(m), 'text/csv') }, 'CSV'),
        h('button', { class: 'link danger-text', onclick: () => {
          app.measurements = app.measurements.filter((x) => x.id !== m.id);
          app.visible.delete(m.id);
          app.persist();
          app.refresh('measure');
          app.updateChart();
        } }, 'Delete')));
  }));

  const summary = `${app.measurements.length} measurement${app.measurements.length === 1 ? '' : 's'}${s?.levelVolume ? ` · level ${Math.round(s.levelVolume * 100)}%` : ''}`;
  return card('Measure', summary, [
    !ready ? h('p', { class: 'help' }, 'Set up a speaker first.') : null,
    h('p', { class: 'help' }, 'Set the level once per session. The speaker plays pink noise and gets louder until the mic hears enough. After that every measurement uses the same volume, so they can be compared.'),
    h('div', { class: 'row' },
      h('button', { onclick: level, disabled: !ready || !!app.busy }, s?.levelVolume ? 'Re-level' : 'Set level'),
      s?.levelVolume ? h('span', { class: 'muted' }, `Session started ${new Date(s.started).toLocaleTimeString()}, volume ${Math.round(s.levelVolume * 100)}%`) : null),
    h('div', { class: 'row' }, field('Label', label), field('What', kinds), field('Mic positions', positions)),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: measure, disabled: !ready || !!app.busy }, 'Measure'),
      h('button', { onclick: importRew }, 'Import REW response')),
    app.measurements.length ? list : h('p', { class: 'muted' }, 'No measurements yet.'),
    app.measurements.length ? h('div', { class: 'row' },
      h('button', { onclick: () => download('speaker-tuner-measurements.csv', measurementsCsv(app.measurements.filter((m) => app.visible.has(m.id)).length ? app.measurements.filter((m) => app.visible.has(m.id)) : app.measurements), 'text/csv') }, 'CSV of shown'),
      h('button', { onclick: () => download('speaker-tuner-measurements.json', JSON.stringify(app.measurements), 'application/json') }, 'Export all (JSON)'),
      h('button', { onclick: importJson }, 'Import JSON'),
      h('button', { class: 'link danger-text', onclick: async () => {
        try {
          await app.confirm('Delete all measurements?', 'This removes every measurement stored in this browser.', 'Delete all');
          app.measurements = [];
          app.visible.clear();
          app.persist();
          app.refresh('measure');
          app.updateChart();
        } catch {
          /* cancelled */
        }
      } }, 'Delete all')) : h('div', { class: 'row' }, h('button', { onclick: importJson }, 'Import JSON')),
  ], !!ready);
}
