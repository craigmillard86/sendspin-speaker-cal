// @ts-check
// The app: state, services and the page skeleton. Sections live in their own modules and
// are re-rendered one at a time with app.refresh('name').

import { h } from './dom.js';
import { ResponseChart } from './chart.js';
import * as store from './store.js';
import { HaApi, connectWithToken } from '../ha/connection.js';
import { DspWriter } from '../ha/dsp-writer.js';
import { Playback } from '../ha/playback.js';
import { expandRoles, settingRoles, checkProfile } from '../profiles/profile.js';
import { view, normalised, CHART_FRACTION } from '../dsp/analyse.js';
import { levelAt1k, interpLogF } from '../dsp/smoothing.js';
import { targetDb } from '../dsp/target.js';
import { whileAwake, abortMessage } from '../audio/wakelock.js';
import { MicMeasurer } from '../measure/session.js';
import { SimMeasurer } from '../demo/sim-measurer.js';
import { createMockHa } from '../demo/mock-ha.js';
import { VERSION } from '../version.js';
import { renderConnect } from './section-connect.js';
import { renderSpeaker } from './section-speaker.js';
import { renderMic } from './section-mic.js';
import { renderMeasure } from './section-measure.js';
import { renderTune } from './section-tune.js';
import { renderSettings } from './section-settings.js';
import { renderExport } from './section-export.js';

const ASSETS = new URL('../../', import.meta.url);
export const SHIPPED = {
  profiles: ['louder-tas5805m-crossover', 'generic-single-driver-peq', 'tas58xx-15band-graphic'],
  mics: ['umik-1', 'akg-ck32', 'av-receiver', 'phone', 'unknown'],
  targets: ['tilt-minus1db-oct-above-1k', 'flat'],
};

/**
 * @typedef {{ id: string, name: string, profile: string, device_id?: string, entities: Record<string, string>, media_url?: string }} DeviceMapping
 * @typedef {{ snapshot: Record<string, any>, volume: number | null, levelVolume: number | null, started: string, deviceId: string, relevelled?: boolean }} Session
 */

export class TunerApp {
  /**
   * @param {HTMLElement | ShadowRoot} root
   * @param {{ mode: 'panel' | 'standalone', api?: HaApi }} options
   */
  constructor(root, { mode, api }) {
    this.root = root;
    this.mode = mode;
    this.api = api ?? null;
    this.demo = false;
    /** @type {Record<string, import('../profiles/profile.js').Profile>} */
    this.profiles = {};
    /** @type {Record<string, any>} */
    this.mics = {};
    /** @type {Record<string, any>} */
    this.targets = {};
    /** @type {DeviceMapping[]} */
    this.mappings = store.load('mappings', []);
    this.settings = {
      mappingId: '',
      micDeviceId: '',
      micProfile: 'unknown',
      tier: /** @type {'calibrated' | 'uncalibrated' | 'unknown'} */ ('unknown'),
      target: 'tilt-minus1db-oct-above-1k',
      positions: 3,
      checkPositions: 1,
      crossoverList: '2000, 2500, 3000',
      ...store.load('settings', {}),
    };
    /** @type {{ freqs: number[], db: number[] } | null} */
    this.cal = store.load('cal', null);
    this.measurements = store.loadMeasurements();
    /** @type {Set<string>} */
    this.visible = new Set(this.measurements.slice(-2).map((m) => m.id));
    /** @type {Session | null} */
    this.session = store.load('session', null);
    /** @type {DspWriter | null} */
    this.writer = null;
    /** @type {import('../audio/recorder.js').Recorder | null} */
    this.recorder = null;
    /** @type {{ label: string, freqs: number[], db: number[] } | null} */
    this.preview = null;
    /** @type {any} */
    this.plan = null;
    /** @type {Record<string, any>} results of the guided steps, by step */
    this.results = {};
    this.busy = '';
    /** @type {AbortController | null} */
    this.abort = null;
    /** @type {Record<string, HTMLElement>} */
    this.sections = {};
    /** @type {any} */
    this._settingsTimer = 0;
    /** loudness was switched off for measuring and goes back on when the task ends */
    this.restoreLoudness = false;
    /** @type {Record<string, (app: TunerApp) => HTMLElement>} */
    this.renderers = {
      connect: renderConnect, speaker: renderSpeaker, mic: renderMic, measure: renderMeasure,
      tune: renderTune, settings: renderSettings, export: renderExport,
    };
  }

  // ---------- startup ----------

  async start() {
    this.layout();
    await this.loadAssets();
    if (this.api) await this.connected();
    else if (this.mode === 'standalone') await this.reconnect();
    this.refresh();
  }

  /** Standalone page: log in again with a remembered token. */
  async reconnect() {
    const saved = store.load('connection', { url: '', token: '' });
    if (!saved.url || !saved.token) return;
    try {
      this.api = new HaApi(await connectWithToken(saved.url, saved.token));
      await this.connected();
    } catch (e) {
      this.api = null;
      this.notify(`Could not reconnect to ${saved.url}: ${/** @type {Error} */ (e).message}`, 'warn');
    }
  }

  async loadAssets() {
    const get = async (/** @type {string} */ path) => (await fetch(new URL(path, ASSETS))).json();
    for (const id of SHIPPED.profiles) this.profiles[id] = checkProfile(await get(`profiles/${id}.json`));
    for (const id of SHIPPED.mics) this.mics[id] = await get(`mics/${id}.json`);
    for (const id of SHIPPED.targets) this.targets[id] = await get(`targets/${id}.json`);
    for (const p of store.load('profiles', [])) this.profiles[p.id] = p;
    for (const m of store.load('mics', [])) this.mics[m.id] = m;
    for (const t of store.load('targets', [])) this.targets[t.id] = t;
  }

  /** Called once the HA connection is up. */
  async connected() {
    const api = this.api;
    api?.onClose(() => {
      if (this.api !== api) return;
      this.notify('The connection to Home Assistant was lost. Anything in progress stopped; reconnect and check the settings.', 'error');
      this.abort?.abort('disconnected');
    });
    api?.onReconnect(() => {
      if (this.api === api) this.writer?.reload().then(() => this.checkMutes()).catch(() => {});
    });
    if (this.mapping) await this.useMapping(this.mapping.id);
  }

  /**
   * A driver mute left on by an interrupted measurement (page closed, phone locked,
   * connection lost) would silence the speaker until it reboots: say so and offer to fix it.
   */
  checkMutes() {
    const w = this.writer;
    if (!w || this.busy) return;
    const on = ['tweeter_mute', 'mid_mute'].filter((r) => w.value(r) === true);
    if (!on.length) return;
    const fix = h('button', { onclick: async () => {
      const r = await w.write({ tweeter_mute: false, mid_mute: false });
      this.notify(r.ok ? 'Both drivers unmuted.' : `Could not unmute: ${r.failed[0]?.error ?? 'stopped'}`, r.ok ? 'ok' : 'error');
      notice?.remove();
    } }, 'Unmute both drivers');
    const notice = this.notify(`${on.map((r) => (r === 'tweeter_mute' ? 'The tweeter' : 'The mid/bass')).join(' and ')} ${on.length > 1 ? 'are' : 'is'} muted. A measurement may have been interrupted.`, 'warn', fix);
  }

  /** Demo: an in-memory HA with a simulated speaker. */
  async startDemo() {
    const profile = this.profiles['louder-tas5805m-crossover'];
    const mock = createMockHa(profile, { device: 'demo_speaker', latencyMs: 20 });
    this.demo = true;
    this.api = new HaApi(mock.transport);
    const mapping = { id: 'demo', name: 'Demo speaker (simulated)', profile: profile.id, device_id: mock.deviceId, entities: mock.entityFor, media_url: 'demo://pink-noise' };
    this.mappings = [mapping, ...this.mappings.filter((m) => m.id !== 'demo')];
    this.settings.mappingId = 'demo';
    this.settings.micProfile = 'umik-1';
    this.settings.tier = 'calibrated';
    this.measurements = [];
    this.visible.clear();
    this.session = null;
    await this.useMapping('demo');
    this.notify('Demo mode: a simulated two-way speaker with passive radiators in a simulated room. Nothing is sent to a real device, and nothing is saved.', 'info');
    this.refresh();
  }

  // ---------- state ----------

  get mapping() {
    return this.mappings.find((m) => m.id === this.settings.mappingId) ?? null;
  }

  get profile() {
    const m = this.mapping;
    return m ? this.profiles[m.profile] ?? null : null;
  }

  get roles() {
    return this.profile ? expandRoles(this.profile) : {};
  }

  get mic() {
    const p = this.mics[this.settings.micProfile] ?? this.mics.unknown;
    return { ...p, tier: this.settings.tier ?? p.tier, cal: this.cal };
  }

  get target() {
    return this.targets[this.settings.target] ?? this.targets.flat;
  }

  /** @param {string} role */
  has(role) {
    return !!this.mapping?.entities[role];
  }

  /** current value of every mapped role */
  values() {
    return this.writer ? this.writer.values(Object.keys(this.roles)) : {};
  }

  persist() {
    if (this.demo) return;
    store.save('settings', this.settings);
    store.save('mappings', this.mappings.filter((m) => m.id !== 'demo'));
    store.save('session', this.session);
    store.saveMeasurements(this.measurements.slice(-60));
  }

  /** @param {DeviceMapping} mapping */
  saveMapping(mapping) {
    this.mappings = [...this.mappings.filter((m) => m.id !== mapping.id), mapping];
    this.settings.mappingId = mapping.id;
    this.persist();
  }

  /** Start following a device's entities. @param {string} id */
  async useMapping(id) {
    this.settings.mappingId = id;
    /** @type {any} */ (this).draft = null;
    await this.writer?.stop();
    this.writer = null;
    const m = this.mapping;
    const profile = this.profile;
    if (!m || !profile || !this.api) return;
    this.writer = new DspWriter(this.api, profile, m.entities);
    this.writer.onChange = () => this.scheduleSettingsRefresh();
    await this.writer.start();
    this.persist();
    this.checkMutes();
  }

  scheduleSettingsRefresh() {
    clearTimeout(this._settingsTimer);
    this._settingsTimer = setTimeout(() => {
      if (!this.busy) this.refresh('settings');
    }, 300);
  }

  /** @returns {import('../measure/session.js').Measurer} */
  measurer() {
    if (!this.writer || !this.profile) throw new Error('Pick a speaker in setup first.');
    if (this.demo) return new SimMeasurer({ profile: this.profile, writer: this.writer, mic: { name: this.mic.name, tier: this.mic.tier } });
    if (!this.recorder) throw new Error('Pick the microphone in setup first.');
    const player = this.mapping?.entities.media_player;
    if (!player) throw new Error('Map the media player in setup first.');
    if (!this.mapping?.media_url) throw new Error('Set the test noise URL in setup first.');
    return new MicMeasurer({
      recorder: this.recorder, playback: new Playback(/** @type {HaApi} */ (this.api), player),
      mediaUrl: this.mapping.media_url, mic: { name: this.mic.name, tier: this.mic.tier, cal: this.cal },
    });
  }

  // ---------- session ----------

  /** The media player's volume as HA reports it (no mic needed), or null. */
  playerVolume() {
    const v = this.writer?.stateOf('media_player')?.attributes?.volume_level;
    return typeof v === 'number' ? v : null;
  }

  /** @param {number} level */
  async setPlayerVolume(level) {
    const player = this.mapping?.entities.media_player;
    if (!player || !this.api) return;
    await this.api.callService('media_player', 'volume_set', { volume_level: level }, { entity_id: player });
  }

  /** Capture the values to revert to, the first time anything is measured or written. */
  async ensureSession() {
    if (this.session && this.session.deviceId === this.mapping?.id) return this.session;
    const writer = /** @type {DspWriter} */ (this.writer);
    const snapshot = writer.snapshot(settingRoles(/** @type {any} */ (this.profile)));
    const volume = this.playerVolume();
    this.session = { snapshot, volume, levelVolume: null, started: new Date().toISOString(), deviceId: /** @type {any} */ (this.mapping).id };
    this.persist();
    return this.session;
  }

  /**
   * Measure with the session's settled volume, loudness off and tuning mode on.
   * Loudness is switched back on when the whole task ends (see run()), not after every
   * measurement, so a 30-measurement scan doesn't toggle it 60 times.
   * @param {Omit<import('../measure/session.js').MeasureRequest, 'signal'>} req @param {AbortSignal} signal
   * @param {{ keepVolume?: boolean }} [o] keepVolume: measure at whatever volume is set now (nearfield)
   */
  async measure(req, signal, { keepVolume = false } = {}) {
    const session = await this.ensureSession();
    const measurer = this.measurer();
    const writer = /** @type {DspWriter} */ (this.writer);
    /** @type {Record<string, any>} */
    const prep = {};
    if (this.has('tuning_mode')) prep.tuning_mode = true;
    if (this.has('loudness') && writer.value('loudness') === true) {
      prep.loudness = false;
      this.restoreLoudness = true;
    }
    const r = await writer.write(prep, { signal });
    if (!r.ok) {
      if (r.stopped) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
      throw new Error(`Could not prepare the speaker for measuring (${r.failed[0]?.role}: ${r.failed[0]?.error}).`);
    }
    if (!keepVolume && session.levelVolume !== null && (await measurer.getVolume()) !== session.levelVolume) await measurer.setVolume(session.levelVolume);
    const rec = await measurer.measure({ ...req, signal, onPrompt: (i, n) => this.promptPosition(i, n, signal), onStatus: (t) => this.status(t) });
    rec.relevelled = !!session.relevelled;
    rec.settings = writer.snapshot(settingRoles(/** @type {any} */ (this.profile)));
    if (rec.clipped) this.notify('The mic clipped during that measurement. Turn the mic gain down and level again.', 'warn');
    return rec;
  }

  /** @param {import('../measure/record.js').MeasurementRecord} rec */
  addMeasurement(rec) {
    const used = new Set(this.measurements.map((m) => /** @type {any} */ (m).slot));
    let slot = 0;
    while (used.has(slot) && slot < 64) slot++;
    /** @type {any} */ (rec).slot = slot;
    this.measurements.push(rec);
    this.visible.add(rec.id);
    this.persist();
    this.refresh('measure');
    this.updateChart();
  }

  // ---------- running tasks ----------

  /**
   * Run a long task: one at a time, with a Stop button, wake lock, and errors shown.
   * @param {string} label @param {(signal: AbortSignal) => Promise<void>} task
   */
  async run(label, task) {
    if (this.busy) return this.notify(`Wait for "${this.busy}" to finish, or press Stop.`, 'warn');
    this.busy = label;
    this.abort = new AbortController();
    this.status(label);
    this.refresh();
    try {
      await whileAwake(task, this.abort.signal);
    } catch (e) {
      const err = /** @type {any} */ (e);
      const reason = this.abort?.signal.reason;
      // only a real abort is reported as "Stopped": an error raised while stopping (say a
      // setting that could not be put back) must still be shown
      if (err?.name === 'AbortError' || err?.message === 'Stopped') {
        if (reason !== 'disconnected') this.notify(abortMessage(reason), reason === 'hidden' ? 'warn' : 'info');
      } else {
        this.notify(err?.message ?? String(err), 'error');
        console.error(err);
      }
    } finally {
      if (this.restoreLoudness && this.writer) {
        this.restoreLoudness = false;
        const r = await this.writer.write({ loudness: true }).catch((/** @type {Error} */ e) => ({ ok: false, failed: [{ error: e.message }] }));
        if (!r.ok) this.notify(`Loudness was switched off for measuring and could not be switched back on: ${r.failed[0]?.error ?? 'stopped'}. Turn it on in Speaker settings.`, 'error');
      }
      this.busy = '';
      this.abort = null;
      this.status('');
      this.refresh();
    }
  }

  /** @param {string} text */
  status(text) {
    const bar = this.el?.status;
    if (!bar) return;
    bar.hidden = !text && !this.busy;
    bar.querySelector('.status-text').textContent = text || this.busy;
  }

  /**
   * @param {string} text @param {'info' | 'warn' | 'error' | 'ok'} [kind] @param {HTMLElement} [action] a button to show
   * @returns {HTMLElement | undefined}
   */
  notify(text, kind = 'info', action) {
    const list = this.el?.notices;
    if (!list) return undefined;
    const n = h('div', { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'notice-icon', 'aria-hidden': 'true' }, { info: 'i', warn: '!', error: '×', ok: '✓' }[kind]),
      h('span', { class: 'notice-text' }, text),
      action ?? null,
      h('button', { class: 'link', onclick: () => n.remove(), 'aria-label': 'Dismiss' }, 'Dismiss'));
    list.append(n);
    if ((kind === 'ok' || kind === 'info') && !action) setTimeout(() => n.remove(), 12000);
    return n;
  }

  /**
   * Modal with Continue / Stop. Resolves on Continue, rejects on Stop.
   * @param {string} title @param {string} text @param {string} [ok]
   */
  confirm(title, text, ok = 'Continue', signal = this.abort?.signal) {
    return new Promise((resolve, reject) => {
      const stopped = () => Object.assign(new Error('Stopped'), { name: 'AbortError' });
      if (signal?.aborted) return reject(stopped());
      // Stop (or the page being hidden) closes the dialog and ends the task
      const onAbort = () => {
        dialog.remove();
        reject(stopped());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const close = () => {
        signal?.removeEventListener('abort', onAbort);
        dialog.remove();
      };
      const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal-box' },
          h('h3', null, title), h('p', null, text),
          h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: () => { close(); resolve(undefined); } }, ok),
            h('button', { onclick: () => { close(); reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })); } }, 'Cancel'))));
      this.el.page.append(dialog);
      /** @type {HTMLElement | null} */ (dialog.querySelector('button.primary'))?.focus();
    });
  }

  /** @param {number} i @param {number} n @param {AbortSignal} [signal] */
  promptPosition(i, n, signal) {
    const where = i === 0
      ? 'Put the mic at your main listening position, at ear height, pointing at the ceiling (or at the speaker for a 0° cal file).'
      : 'Move the mic 30 to 50 cm to a new spot around the listening position (left, right, forward or back), same height.';
    return /** @type {Promise<void>} */ (this.confirm(`Mic position ${i + 1} of ${n}`, where, 'Measure', signal));
  }

  // ---------- chart ----------

  updateChart() {
    if (!this.chart) return;
    const shown = this.measurements.filter((m) => this.visible.has(m.id));
    const firstFull = shown.find((m) => m.kind !== 'nearfield');
    const ref = firstFull ? levelAt1k(firstFull.curve.freqs, firstFull.curve.db) : 0;
    /** @type {import('./chart.js').Series[]} */
    const series = shown.map((m) => {
      // listening-position curves share one reference so relative levels stay visible;
      // nearfield curves are only ever compared with themselves, at 0 dB around 100 Hz
      const c = m.kind === 'nearfield'
        ? normalised(m.curve, interpLogF(m.curve.freqs, m.curve.db, 100))
        : normalised(m.curve, ref);
      const v = view(c, CHART_FRACTION, 48);
      return { id: m.id, label: m.label, freqs: v.freqs, db: v.db, slot: /** @type {any} */ (m).slot ?? 0, mask: m === firstFull ? m.mask : undefined };
    });
    if (this.preview) series.push({ id: 'preview', label: this.preview.label, freqs: this.preview.freqs, db: this.preview.db, slot: 7, role: 'predicted' });
    if (firstFull || this.preview) {
      const grid = series[0]?.freqs ?? [];
      const t = Array.from(targetDb(this.target, grid));
      series.push({ id: 'target', label: `Target: ${this.target.name}`, freqs: grid, db: t, role: 'target' });
    }
    this.chart.set(series);
    this.renderLegend(series);
  }

  /** @param {import('./chart.js').Series[]} series */
  renderLegend(series) {
    const legend = this.el.legend;
    legend.replaceChildren(...series.map((s) =>
      h('span', { class: 'legend-item' },
        h('span', { class: `swatch ${s.role === 'target' ? 'swatch-target' : s.role === 'predicted' ? 'swatch-predicted' : ''}`, style: s.role === 'target' ? '' : `background: var(--series-${((s.slot ?? 0) % 8) + 1})` }),
        s.label)));
    if (!series.length) legend.append(h('span', { class: 'muted' }, 'No measurements shown yet.'));
    const tableBtn = h('button', { class: 'link', onclick: () => this.toggleTable(series) }, this.el.table.hidden ? 'Table view' : 'Hide table');
    legend.append(tableBtn);
    if (!this.el.table.hidden) this.fillTable(series);
  }

  /** @param {import('./chart.js').Series[]} series */
  toggleTable(series) {
    this.el.table.hidden = !this.el.table.hidden;
    this.renderLegend(series);
  }

  /** @param {import('./chart.js').Series[]} series */
  fillTable(series) {
    const freqs = [20, 31.5, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
    const at = (/** @type {import('./chart.js').Series} */ s, /** @type {number} */ f) => {
      const i = s.freqs.findIndex((x) => x >= f);
      return i >= 0 && Number.isFinite(s.db[i]) ? s.db[i].toFixed(1) : '';
    };
    this.el.table.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Hz'), series.map((s) => h('th', null, s.label)))),
      h('tbody', null, freqs.map((f) => h('tr', null, h('td', null, String(f)), series.map((s) => h('td', null, at(s, f))))))));
  }

  // ---------- layout ----------

  layout() {
    const canvas = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'chart-canvas', 'aria-label': 'Frequency response chart' }));
    const tooltip = h('div', { class: 'tooltip', hidden: true });
    const stop = h('button', { class: 'danger', onclick: () => this.abort?.abort('stopped') }, 'Stop');
    this.el = {
      page: h('div', { class: 'page' }),
      notices: h('div', { class: 'notices', 'aria-live': 'polite' }),
      status: h('div', { class: 'statusbar', hidden: true }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'status-text' }), stop),
      legend: h('div', { class: 'legend' }),
      table: h('div', { class: 'table-view', hidden: true }),
      sections: h('div', { class: 'sections' }),
    };
    const header = h('header', { class: 'top' },
      h('h1', null, 'Speaker Tuner'),
      h('span', { class: 'muted' }, `v${VERSION}`),
      h('span', { class: 'spacer' }),
      h('span', { class: 'conn' }));
    this.el.header = header;
    this.el.page.append(
      header,
      h('section', { class: 'card chart-card' }, h('div', { class: 'chart-wrap' }, canvas, tooltip), this.el.legend, this.el.table),
      this.el.status,
      this.el.notices,
      this.el.sections,
    );
    this.root.append(this.el.page);
    this.chart = new ResponseChart(canvas, tooltip);
  }

  /** Re-render one section, or all of them. @param {string} [name] */
  refresh(name) {
    const names = name ? [name] : Object.keys(this.renderers);
    for (const n of names) {
      if (n === 'connect' && this.mode === 'panel') continue;
      const next = this.renderers[n](this);
      const old = this.sections[n];
      // keep what the user opened or closed, unless the card's default changed (e.g. setup done)
      if (old instanceof HTMLDetailsElement && next instanceof HTMLDetailsElement && old.dataset.default === next.dataset.default) next.open = old.open;
      if (old) old.replaceWith(next);
      else this.el.sections.append(next);
      this.sections[n] = next;
    }
    const conn = this.el.header.querySelector('.conn');
    if (conn) conn.textContent = this.demo ? 'Demo mode' : this.api ? 'Connected' : 'Not connected';
    this.status(this.busy);
    if (!name) this.updateChart();
  }
}

/**
 * Collapsible card. @param {string} title @param {string} summary @param {any[]} body @param {boolean} [open]
 */
export function card(title, summary, body, open = false) {
  return /** @type {HTMLDetailsElement} */ (h('details', { class: 'card', open, 'data-default': open ? 'open' : 'closed' },
    h('summary', null, h('span', { class: 'card-title' }, title), summary ? h('span', { class: 'card-summary muted' }, summary) : null),
    h('div', { class: 'card-body' }, body)));
}
