// @ts-check
// Setup, part 2: the microphone (device, live level, profile, tier, cal file), the target
// curve and how many mic positions to average.

import { h, field, select, pickTextFile } from './dom.js';
import { card } from './app.js';
import * as store from './store.js';
import { micSupport, listMics, openMic, appliedSettings } from '../audio/mic.js';
import { createRecorder } from '../audio/recorder.js';
import { parseFrequencyText } from '../dsp/calfile.js';
import { normaliseTarget } from '../dsp/target.js';

const TIERS = [
  { value: 'calibrated', label: 'Calibrated (cal file loaded): 60 Hz–16 kHz, −12/+6 dB' },
  { value: 'uncalibrated', label: 'Known but uncalibrated: 200 Hz–10 kHz, −10/+3 dB' },
  { value: 'unknown', label: 'Unknown: 300 Hz–8 kHz, cuts over 3 dB only' },
];

/** @param {import('./app.js').TunerApp} app */
export function renderMic(app) {
  const support = micSupport();
  const a = /** @type {any} */ (app);
  const meter = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Mic level', 'aria-valuemin': '-80', 'aria-valuemax': '0' },
    h('div', { class: 'meter-fill' }), h('span', { class: 'meter-text' }, app.recorder ? '' : 'No mic open'));
  const silence = h('div', { class: 'notice notice-warn', hidden: true },
    h('span', { class: 'notice-text' },
      'The browser is getting digital silence from this mic: not quiet, but exactly zero, so the sound never reaches the page. Usual causes:\n',
      '• Windows: Settings > Privacy & security > Microphone: turn on "Let desktop apps access your microphone" (and "Let apps access" for the browser).\n',
      '• Windows Sound settings: the input is muted or at 0, or another app holds it in exclusive mode (close REW or DAW software, or untick "Allow applications to take exclusive control").\n',
      '• An audio interface: the mic\'s input channel is off, or phantom power is off for a condenser mic.\n',
      '• The wrong input: pick another from the list. Then press "Reopen mic".'));
  const info = h('p', { class: 'help mic-info' });
  startMeter(app, meter, silence, info);

  const devices = a.micDevices ?? [];
  const openSelected = (/** @type {string} */ id) => app.run('Opening the microphone', async () => {
    await app.recorder?.close();
    app.recorder = null;
    const stream = await openMic(id || undefined);
    const applied = appliedSettings(stream);
    a.micInfo = { label: stream.getAudioTracks()[0]?.label ?? '', sampleRate: applied.sampleRate };
    app.recorder = await createRecorder(stream);
    app.settings.micDeviceId = id;
    a.micDevices = await listMics();
    a.micWarning = applied.processing.length
      ? `The browser kept ${applied.processing.join(', ')} on for this mic. Measurements may be off; a USB measurement mic or another browser usually avoids it.`
      : '';
    app.persist();
  });

  const micProfiles = select(Object.values(app.mics).map((m) => ({ value: m.id, label: m.name })), app.settings.micProfile, (id) => {
    app.settings.micProfile = id;
    app.settings.tier = app.cal && app.mics[id]?.tier === 'calibrated' ? 'calibrated' : app.mics[id]?.tier ?? 'unknown';
    app.persist();
    app.refresh('mic');
  });
  const tier = select(TIERS, app.settings.tier, (v) => {
    app.settings.tier = /** @type {any} */ (v);
    app.persist();
    app.refresh('mic');
  });
  const loadCal = async () => {
    const file = await pickTextFile('.txt,.cal,.frd,text/plain');
    if (!file) return;
    try {
      const cal = parseFrequencyText(file.text);
      app.cal = { freqs: cal.freqs, db: cal.db };
      a.calName = file.name;
      store.save('cal', app.cal);
      store.save('calName', file.name);
      app.settings.tier = 'calibrated';
      app.persist();
      app.notify(`Loaded ${file.name}: ${cal.freqs.length} points, ${cal.freqs[0]} Hz to ${cal.freqs[cal.freqs.length - 1]} Hz.`, 'ok');
      app.refresh('mic');
      app.updateChart();
    } catch (e) {
      app.notify(/** @type {Error} */ (e).message, 'error');
    }
  };
  const calName = a.calName ?? store.load('calName', '');
  const micProfile = app.mics[app.settings.micProfile];

  const targets = select(Object.values(app.targets).map((t) => ({ value: t.id, label: t.name })), app.settings.target, (id) => {
    app.settings.target = id;
    app.persist();
    app.refresh('mic');
    app.updateChart();
  });
  const editor = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: 5, spellcheck: false },
    app.target.points.map((/** @type {number[]} */ p) => `${p[0]} ${p[1]}`).join('\n')));
  const saveTarget = () => {
    try {
      const points = editor.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[\s,;]+/).map(Number));
      const t = normaliseTarget({ name: `Custom (from ${app.target.name})`, points });
      const id = `custom-${Date.now().toString(36)}`;
      const target = { id, ...t };
      app.targets[id] = target;
      store.save('targets', [...store.load('targets', []), target]);
      app.settings.target = id;
      app.persist();
      app.refresh('mic');
      app.updateChart();
    } catch (e) {
      app.notify(/** @type {Error} */ (e).message, 'error');
    }
  };

  const positions = /** @type {HTMLInputElement} */ (h('input', { type: 'number', min: 1, max: 9, value: app.settings.positions, onchange: () => {
    app.settings.positions = Math.max(1, Math.min(9, Number(positions.value) || 1));
    app.persist();
  } }));
  const checkPositions = /** @type {HTMLInputElement} */ (h('input', { type: 'number', min: 1, max: 9, value: app.settings.checkPositions, onchange: () => {
    app.settings.checkPositions = Math.max(1, Math.min(9, Number(checkPositions.value) || 1));
    app.persist();
  } }));

  const summary = `${micProfile?.name ?? 'No mic profile'} · ${app.settings.tier}${app.recorder ? '' : ' · mic not open'}`;
  return card('Mic and target', summary, [
    app.demo ? h('p', { class: 'help' }, 'Demo mode uses a simulated mic, so no microphone is needed.') : null,
    !support.ok && !app.demo ? h('p', { class: 'notice notice-warn' }, support.reason) : null,
    h('div', { class: 'row' },
      devices.length
        ? select([{ value: '', label: 'Default microphone' }, ...devices.map((/** @type {any} */ m) => ({ value: m.deviceId, label: m.label }))], app.settings.micDeviceId, openSelected)
        : null,
      h('button', { onclick: () => openSelected(app.settings.micDeviceId), disabled: !support.ok || !!app.busy || app.demo }, app.recorder ? 'Reopen mic' : 'Use microphone')),
    meter,
    info,
    silence,
    h('p', { class: 'help' }, 'Speak or tap the mic: the bar should move. If it does not, pick another input.'),
    a.micWarning ? h('p', { class: 'notice notice-warn' }, a.micWarning) : null,
    field('Mic profile', micProfiles, micProfile?.notes),
    field('Mic tier', tier, 'Sets the range and limits the fit may use.'),
    h('div', { class: 'row' },
      h('button', { onclick: loadCal }, app.cal ? 'Replace cal file' : 'Load cal file'),
      app.cal ? h('span', { class: 'muted' }, `${calName || 'Cal file'} loaded`) : h('span', { class: 'muted' }, micProfile?.needs_cal_file ? 'This mic needs its cal file to count as calibrated.' : 'No cal file'),
      app.cal ? h('button', { class: 'link', onclick: () => {
        app.cal = null;
        store.save('cal', null);
        store.save('calName', '');
        if (app.settings.tier === 'calibrated') app.settings.tier = micProfile?.tier === 'calibrated' ? 'uncalibrated' : micProfile?.tier ?? 'unknown';
        app.persist();
        app.refresh('mic');
      } }, 'Remove') : null),
    app.settings.tier === 'calibrated' && !app.cal ? h('p', { class: 'notice notice-warn' }, 'Calibrated tier without a cal file: the fit will trust the mic\'s extremes. Load the cal file, or pick a lower tier.') : null,
    field('Target curve', targets),
    h('details', null, h('summary', null, 'Edit target points'),
      h('p', { class: 'help' }, 'One "frequency dB" pair per line. The curve is shifted to 0 dB at 1 kHz.'), editor,
      h('button', { onclick: saveTarget }, 'Save as a custom target')),
    h('div', { class: 'row' },
      field('Mic positions for the PEQ fit', positions, 'Averaged; 3 is a good start.'),
      field('Mic positions for A/B checks', checkPositions, 'Polarity, crossover and delay tests compare settings at one spot.')),
  ], !app.demo); // stays open: the level meter is what you watch while picking the mic
}

/**
 * Live level bar, updated every frame while the section is on the page, with the
 * digital-silence warning and what the browser actually opened.
 * @param {import('./app.js').TunerApp} app @param {HTMLElement} meter @param {HTMLElement} silence @param {HTMLElement} info
 */
function startMeter(app, meter, silence, info) {
  const fill = /** @type {HTMLElement} */ (meter.querySelector('.meter-fill'));
  const text = /** @type {HTMLElement} */ (meter.querySelector('.meter-text'));
  const tick = () => {
    if (!meter.isConnected && meter.dataset.started) return;
    meter.dataset.started = '1';
    if (app.recorder) {
      const { rmsDbfs, peakDbfs, silent } = app.recorder.level();
      const pct = silent ? 0 : Math.max(0, Math.min(100, ((rmsDbfs + 80) / 80) * 100));
      fill.style.width = `${pct}%`;
      fill.classList.toggle('hot', peakDbfs > -3);
      text.textContent = silent ? 'No signal: digital silence' : `${Math.max(rmsDbfs, -120).toFixed(0)} dBFS${peakDbfs > -3 ? ' · near clipping' : ''}`;
      meter.setAttribute('aria-valuenow', String(Math.round(Math.max(rmsDbfs, -120))));
      silence.hidden = !silent;
      const mi = /** @type {any} */ (app).micInfo;
      const ch = app.recorder.channels();
      info.textContent = mi ? `Open: ${mi.label || 'microphone'} · ${ch || '?'} channel${ch === 1 ? '' : 's'}${ch > 1 ? ' (mixed)' : ''} · ${app.recorder.sampleRate} Hz` : '';
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
