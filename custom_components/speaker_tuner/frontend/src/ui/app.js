// @ts-check
// The app: state, services and the page skeleton. Sections live in their own modules and
// are re-rendered one at a time with app.refresh('name').

import { h } from './dom.js';
import { ResponseChart } from './chart.js';
import * as store from './store.js';
import { HaApi, connectWithToken, uploadMedia, MEDIA_FOLDER, NOISE_FILE } from '../ha/connection.js';
import { testSignal } from '../dsp/pink.js';
import { encodeWav16 } from '../dsp/wav.js';
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
import { renderReady } from './section-ready.js';
import { renderSpeakers } from './section-speakers.js';
import { HELP, HELP_ORDER, HELP_ALIAS } from './help.js';

/** The four steps and the cards each one shows. */
export const STEPS = [
  { id: 'setup', label: 'Set up', sections: ['ready', 'connect', 'speaker', 'mic', 'speakers'] },
  { id: 'measure', label: 'Measure', sections: ['measure'] },
  { id: 'tune', label: 'Tune', sections: ['tune'] },
  { id: 'save', label: 'Save', sections: ['export'] },
];

/** How the stored keys are named in messages. */
const STORE_LABELS = /** @type {Record<string, string>} */ ({
  mappings: 'speakers', profiles: 'profiles', mics: 'mic profiles', targets: 'targets', settings: 'settings',
  cal: 'the cal file', session: 'the session', measurements: 'measurements', tuning: 'tuning results',
});

/**
 * A speaker's tuning state for storage: measurements are referred to by id (they are stored
 * once, with the measurements), typed arrays become plain arrays.
 * @param {TunerApp} app
 */
function packTuning(app) {
  const a = /** @type {any} */ (app);
  const pack = (/** @type {any} */ v) => (v == null ? null : JSON.parse(JSON.stringify(v, (_k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x) && x.curve && typeof x.id === 'string') return { $m: x.id };
    if (ArrayBuffer.isView(x)) return Array.from(/** @type {any} */ (x));
    return x;
  })));
  return { results: pack(app.results), refineResult: pack(a.refineResult), peqSet: pack(a.peqSet), history: a.applyLog ?? [] };
}

/** @param {any} v @param {Map<string, any>} byId */
function unpackRefs(v, byId) {
  if (Array.isArray(v)) return v.map((x) => unpackRefs(x, byId));
  if (v && typeof v === 'object') {
    if (typeof v.$m === 'string' && Object.keys(v).length === 1) return byId.get(v.$m) ?? null;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpackRefs(x, byId)]));
  }
  return v;
}

/** @type {TunerApp | null} the app on the page; card() reads its messages */
let currentApp = null;

/** @param {string} s */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Split a message into a short headline and the rest, so a long sentence doesn't become a
 * wall of text: "Level set: volume 25 %. Every measurement ..." -> headline + detail.
 * @param {string} text
 */
export function splitMessage(text) {
  const m = text.match(/^(.{8,90}?[.:!?])\s+(.+)$/s);
  return m ? { h: m[1].replace(/[.:]$/, ''), d: m[2] } : { h: text, d: '' };
}

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
    /** @type {import('../ha/detect.js').BoardCatalogue | null} boards the tool can recognise */
    this.boards = null;
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
      step: '',
      ...store.load('settings', {}),
      ...store.load('local', {}),
    };
    /** @type {{ freqs: number[], db: number[] } | null} */
    this.cal = store.load('cal', null);
    this.measurements = store.loadMeasurements();
    /** @type {Set<string>} */
    this.visible = new Set(store.load('visible', null) ?? this.measurements.slice(-2).map((m) => m.id));
    /** form fields the user is filling in, kept across re-renders */
    this.ui = {};
    /** @type {Session | null} */
    this.session = store.load('session', null);
    /** @type {DspWriter | null} */
    this.writer = null;
    /** @type {import('../audio/recorder.js').Recorder | null} */
    this.recorder = null;
    /** @type {string | null} the part of Set up shown in place of the checklist */
    this.setupFocus = null;
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
    /** @type {Promise<any> | null} the running task */
    this.task = null;
    /** loudness was switched off for measuring and goes back on when the task ends */
    this.restoreLoudness = false;
    /** @type {Record<string, (app: TunerApp) => HTMLElement>} */
    this.renderers = {
      connect: renderConnect, ready: renderReady, speaker: renderSpeaker, mic: renderMic, speakers: renderSpeakers, measure: renderMeasure,
      tune: renderTune, settings: renderSettings, export: renderExport,
    };
    /** the step on screen */
    this.step = /** @type {string} */ (this.settings.step ?? '');
    /**
     * Messages shown inside the card they belong to, by card ("where").
     * @type {Record<string, Array<{ kind: string, h: string, d: string, action?: { label: string, fn: () => void } }>>}
     */
    this.feedback = {};
    /** @type {Array<{ kind: string, text: string, time: string }>} everything said this session */
    this.history = [];
    /** @type {Map<string, { kind: string, text: string, action?: { label: string, fn: () => void } }>} device-level problems */
    this.alerts = new Map();
    /** the card the running task belongs to, and the last card the user clicked in */
    this.taskWhere = /** @type {string | null} */ (null);
    this.lastWhere = /** @type {string | null} */ (null);
    this.lastWhereAt = 0;
    /** @type {'settings' | 'messages' | 'help' | null} */
    this.drawer = null;
    /** @type {string | null} the help topic shown; null shows the list of topics */
    this.helpTopic = null;
    this.chartSmall = false;
    currentApp = this;
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
      this.alert('reconnect', 'warn', `Could not reconnect to ${saved.url}. ${/** @type {Error} */ (e).message}`, { label: 'Open Set up', fn: () => this.goStep('setup', 'connect') });
    }
  }

  async loadAssets() {
    const get = async (/** @type {string} */ path) => (await fetch(new URL(path, ASSETS))).json();
    for (const id of SHIPPED.profiles) this.profiles[id] = checkProfile(await get(`profiles/${id}.json`));
    // profiles shared by other builders (profiles/contrib/index.json lists them)
    try {
      for (const id of (await get('profiles/contrib/index.json')).profiles ?? []) {
        try {
          this.profiles[id] = checkProfile(await get(`profiles/contrib/${id}.json`));
        } catch {
          /* one broken contribution must not stop the app */
        }
      }
    } catch {
      /* no contributions yet */
    }
    for (const id of SHIPPED.mics) this.mics[id] = await get(`mics/${id}.json`);
    for (const id of SHIPPED.targets) this.targets[id] = await get(`targets/${id}.json`);
    try {
      this.boards = await get('boards/sonocotta.json');
    } catch {
      this.boards = null; // detection is a help, not a need
    }
    for (const p of store.load('profiles', [])) this.profiles[p.id] = p;
    for (const m of store.load('mics', [])) this.mics[m.id] = m;
    for (const t of store.load('targets', [])) this.targets[t.id] = t;
  }

  /** Called once the HA connection is up. */
  async connected() {
    const api = this.api;
    api?.onClose(() => {
      if (this.api !== api) return;
      this.alert('connection', 'error', 'Lost the connection to Home Assistant. Anything in progress stopped; settings already written are kept.', this.mode === 'standalone' ? { label: 'Reconnect', fn: () => this.reconnect().then(() => this.refresh()) } : undefined);
      this.abort?.abort('disconnected');
    });
    api?.onReconnect(() => {
      if (this.api !== api) return;
      this.clearAlert('connection');
      this.toast('Reconnected to Home Assistant.');
      this.writer?.reload().then(() => this.checkMutes()).catch(() => {});
      // other browsers may have saved while this one was away
      this.attachStore().catch(() => {});
    });
    await this.attachStore().catch((e) => this.alert('store', 'warn', `Could not read the saved data from Home Assistant: ${/** @type {Error} */ (e).message}`));
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
    if (!on.length) return this.clearAlert('mute');
    this.alert('mute', 'warn', `${on.map((r) => (r === 'tweeter_mute' ? 'The tweeter' : 'The mid/bass')).join(' and ')} ${on.length > 1 ? 'are' : 'is'} muted. A measurement may have been interrupted before it could unmute.`, {
      label: 'Unmute',
      fn: async () => {
        const r = await w.write({ tweeter_mute: false, mid_mute: false });
        if (r.ok) {
          this.clearAlert('mute');
          this.toast('Both drivers unmuted.');
        } else this.alert('mute', 'error', `Could not unmute: ${r.failed[0]?.error ?? 'stopped'}`);
      },
    });
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
    this.toast('Demo mode: a simulated speaker in a simulated room. Nothing is sent to a real device.');
    this.step = 'measure';
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
    // what belongs to this browser (which speaker and mic it uses, the open step) stays here;
    // the rest of the settings are shared through Home Assistant
    const { mappingId, micDeviceId, micProfile, tier, step, ...shared } = this.settings;
    store.save('local', { mappingId, micDeviceId, micProfile, tier, step });
    store.save('settings', shared);
    if (this.mapping) {
      const all = store.load('tuning', /** @type {Record<string, any>} */ ({}));
      all[this.mapping.id] = packTuning(this);
      store.save('tuning', all);
    }
    store.save('mappings', this.mappings.filter((m) => m.id !== 'demo'));
    store.save('session', this.session);
    // keep every real measurement (up to 150) but only the last 20 scan tests: one delay scan
    // alone makes about 30, and they must not push the baseline out
    const tests = this.measurements.filter((m) => m.test);
    const keepTests = new Set(tests.slice(-20).map((m) => m.id));
    const kept = this.measurements.filter((m) => !m.test || keepTests.has(m.id));
    const real = kept.filter((m) => !m.test);
    const dropReal = new Set(real.slice(0, Math.max(0, real.length - 150)).map((m) => m.id));
    const toSave = kept.filter((m) => !dropReal.has(m.id));
    if (!store.saveMeasurements(toSave)) this.alert('storage', 'warn', 'This browser would not save the measurements (storage full or blocked). Export them as JSON to keep them.');
    store.save('visible', [...this.visible]);
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
    this.plan = null;
    this.preview = null;
    this.results = {};
    this.restoreTuning();
    const m = this.mapping;
    const profile = this.profile;
    if (!m || !profile || !this.api) return;
    this.writer = new DspWriter(this.api, profile, m.entities);
    this.writer.onChange = () => this.scheduleSettingsRefresh();
    await this.writer.start();
    this.persist();
    this.checkMutes();
  }

  /** A mapped entity changed in HA: show it in Speaker settings and Export, without
   *  disturbing anything the user is editing. */
  scheduleSettingsRefresh() {
    clearTimeout(this._settingsTimer);
    this._settingsTimer = setTimeout(() => {
      if (this.busy) return;
      for (const name of ['settings', 'export']) {
        // never replace a section while the user is typing in it: removing a focused input
        // blurs it, and the blur would write the half-typed value to the speaker
        if (this.sections[name]?.contains(this.activeElement())) this.scheduleSettingsRefresh();
        else this.refresh(name);
      }
    }, 300);
  }

  /** The focused element, inside the panel's shadow root too. */
  activeElement() {
    return this.root instanceof ShadowRoot ? this.root.activeElement : document.activeElement;
  }

  /** Close the mic, stop following HA and stop any task (the HA panel was removed). */
  /** Keep a profile the user made or imported (with the integration: in Home Assistant). @param {any} profile */
  saveProfile(profile) {
    this.profiles[profile.id] = profile;
    store.save('profiles', [...store.load('profiles', []).filter((/** @type {any} */ x) => x.id !== profile.id), profile]);
  }

  /** This speaker's Tune results, PEQ report and history, as saved (with Home Assistant: by any browser). */
  restoreTuning() {
    const a = /** @type {any} */ (this);
    const t = this.mapping && !this.demo ? store.load('tuning', /** @type {Record<string, any>} */ ({}))[this.mapping.id] : null;
    const byId = new Map(this.measurements.map((m) => [m.id, m]));
    const revive = (/** @type {any} */ v) => unpackRefs(v, byId);
    this.results = revive(t?.results) ?? {};
    a.refineResult = revive(t?.refineResult) ?? null;
    a.peqSet = revive(t?.peqSet) ?? null;
    // every Apply on this speaker (not the Messages list, this.history; 0.3.0 saved that here by mistake)
    a.applyLog = (t?.history ?? []).filter((/** @type {any} */ x) => x && x.at && x.what);
  }

  /**
   * Record what was written to the speaker, for the history (and the report).
   * @param {string} what @param {Record<string, any>} before @param {Record<string, any>} after
   */
  logApplied(what, before, after) {
    const a = /** @type {any} */ (this);
    a.applyLog = [...(a.applyLog ?? []), { at: new Date().toISOString(), what, before, after }].slice(-50);
    this.persist();
  }

  /** Use Home Assistant's storage when the integration provides it, moving this browser's data there. */
  async attachStore() {
    if (this.demo || !this.api) return;
    const r = await store.attachServer(this.api, {
      onError: (key, message) => this.alert('store', 'error', `Could not save ${STORE_LABELS[key] ?? key} in Home Assistant: ${message}`),
      onRemoteChange: (key) => {
        // one save elsewhere can change several keys: reload and say so once
        const a = /** @type {any} */ (this);
        (a.remoteKeys ??= new Set()).add(STORE_LABELS[key] ?? key);
        clearTimeout(a.remoteTimer);
        a.remoteTimer = setTimeout(() => {
          const what = [...a.remoteKeys];
          a.remoteKeys = null;
          this.reloadFromStore();
          this.toast(`Updated from another device: ${what.join(', ')}.`);
        }, 400);
      },
    });
    if (!r.available) return;
    this.reloadFromStore();
    const moved = Object.entries(r.moved).filter(([k]) => STORE_LABELS[k]);
    if (moved.length) this.notify(`Moved from this browser to Home Assistant: ${moved.map(([k, n]) => (n > 1 ? `${n} ${STORE_LABELS[k]}` : STORE_LABELS[k])).join(', ')}. Every browser now sees them.`, 'ok');
  }

  /** Read everything again from the store (after attaching to Home Assistant, or another browser changed something). */
  reloadFromStore() {
    const a = /** @type {any} */ (this);
    this.mappings = store.load('mappings', []);
    this.settings = { ...this.settings, ...store.load('settings', {}), ...store.load('local', {}) };
    this.cal = store.load('cal', null);
    a.calName = undefined;
    this.measurements = store.loadMeasurements();
    this.session = store.load('session', null);
    for (const p of store.load('profiles', [])) this.profiles[p.id] = p;
    for (const m of store.load('mics', [])) this.mics[m.id] = m;
    for (const t of store.load('targets', [])) this.targets[t.id] = t;
    for (const id of [...this.visible]) if (!this.measurements.some((m) => m.id === id)) this.visible.delete(id);
    if (!this.busy) this.restoreTuning();
    this.refresh();
    this.updateChart();
  }

  async dispose() {
    store.detachServer();
    this.abort?.abort('stopped');
    clearTimeout(this._settingsTimer);
    // let a stopped task put its test values back (that needs the writer still listening)
    if (this.task) await Promise.race([this.task, new Promise((r) => setTimeout(r, 15000))]);
    await this.recorder?.close().catch(() => {});
    this.recorder = null;
    await this.writer?.stop().catch(() => {});
    this.writer = null;
  }

  /** @returns {import('../measure/session.js').Measurer} */
  measurer() {
    if (!this.writer || !this.profile) throw new Error('Pick a speaker in setup first.');
    if (this.demo) return new SimMeasurer({ profile: this.profile, writer: this.writer, mic: { name: this.mic.name, tier: this.mic.tier } });
    if (!this.recorder) throw new Error('Pick the microphone in setup first.');
    const player = this.mapping?.entities.media_player;
    if (!player) throw new Error('Map the media player in setup first.');
    const mapping = this.mapping;
    return new MicMeasurer({
      recorder: this.recorder, playback: new Playback(/** @type {HaApi} */ (this.api), player),
      mediaUrl: () => this.ensureNoise(mapping), mic: { name: this.mic.name, tier: this.mic.tier, cal: this.cal },
    });
  }

  /**
   * The test noise for a speaker: its own address if it has one, else the one already in
   * Home Assistant for the other speakers, else uploaded now. The tool's own file is checked
   * once per session and uploaded again if it has gone from the media folder.
   * @param {DeviceMapping | null} [m]
   * @returns {Promise<string>}
   */
  async ensureNoise(m = this.mapping) {
    if (!m) throw new Error('Pick a speaker in setup first.');
    if (this.demo) return m.media_url ?? 'demo://pink-noise';
    const api = /** @type {HaApi} */ (this.api);
    const ours = (/** @type {string | undefined} */ u) => !!u && u.startsWith(`${MEDIA_FOLDER}/`);
    let url = m.media_url || /** @type {any} */ (this.settings).noiseUrl || '';
    // an address the user set (a file they host elsewhere): theirs to keep working
    if (url && !ours(url)) return url;
    const a = /** @type {any} */ (this);
    if (url && !a.noiseChecked?.has(url) && !(await noiseInMediaFolder(api, url))) url = '';
    if (!url) {
      this.status('Uploading the test noise to Home Assistant');
      url = await uploadMedia(api, new Blob([encodeWav16(testSignal(), 48000)], { type: 'audio/wav' }), NOISE_FILE);
      this.notify(`Put the test noise in Home Assistant's media folder (${url.replace('media-source://media_source/local/', 'media/')}). Every speaker uses it.`, 'ok');
    }
    (a.noiseChecked ??= new Set()).add(url);
    if (/** @type {any} */ (this.settings).noiseUrl !== url) /** @type {any} */ (this.settings).noiseUrl = url;
    if (m.media_url !== url) {
      const saved = { ...m, media_url: url };
      this.mappings = this.mappings.map((x) => (x.id === m.id ? saved : x));
    }
    this.persist();
    return url;
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
    /** @type {any} */ (rec).speaker = this.mapping?.id; // which speaker it belongs to
    rec.settings = writer.snapshot(settingRoles(/** @type {any} */ (this.profile)));
    if (rec.clipped) this.notify('The mic clipped during that measurement. Turn the mic gain down and level again.', 'warn');
    return rec;
  }

  /** @param {import('../measure/record.js').MeasurementRecord} rec */
  addMeasurement(rec, { focus = true } = {}) {
    const used = new Set(this.measurements.map((m) => /** @type {any} */ (m).slot));
    let slot = 0;
    while (used.has(slot) && slot < 64) slot++;
    /** @type {any} */ (rec).slot = slot;
    this.measurements.push(rec);
    // the Measure list goes back to its first page, where the new one is
    if (this.ui.measure) this.ui.measure.page = 0;
    if (focus) {
      // the chart shows the new measurement next to the baseline; the rest stay a tap away
      // in the legend. Nearfield curves are on their own scale, so they show alone.
      this.visible.clear();
      const base = rec.kind === 'nearfield' ? null : this.baseline();
      if (base) this.visible.add(base.id);
    }
    this.visible.add(rec.id);
    this.persist();
    this.refresh('measure');
    this.updateChart();
  }

  /**
   * The measurement others are compared with: the first whole-speaker measurement of this
   * session (else the first one at all), not a test and not an undone pass.
   */
  baseline() {
    const real = this.measurements.filter((m) => m.kind === 'full' && !m.test && !m.undone);
    const since = this.session?.started ? new Date(this.session.started).getTime() : 0;
    return real.find((m) => new Date(m.time).getTime() >= since) ?? real[0] ?? null;
  }

  // ---------- running tasks ----------

  /**
   * Run a long task: one at a time, in the activity bar with Stop, wake lock on. What it says
   * (results, errors) appears in the card it was started from.
   * @param {string} label @param {(signal: AbortSignal) => Promise<void>} task
   * @param {string} [where] the card it belongs to; by default the one the user clicked in
   */
  async run(label, task, where) {
    if (this.busy) return this.toast(`Wait for "${this.busy}" to finish, or press Stop.`);
    this.busy = label;
    this.taskWhere = where ?? this.recentWhere() ?? 'global';
    delete this.feedback[this.taskWhere];
    this.renderFeedback(this.taskWhere);
    this.abort = new AbortController();
    this.status(label);
    this.refresh();
    try {
      this.task = whileAwake(task, this.abort.signal);
      await this.task;
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
        if (!r.ok) this.alert('loudness', 'error', `Loudness was switched off for measuring and could not be switched back on (${r.failed[0]?.error ?? 'stopped'}). Turn it on in All settings.`, { label: 'All settings', fn: () => this.openDrawer('settings') });
      }
      this.busy = '';
      this.abort = null;
      this.task = null;
      this.taskWhere = null;
      this.status('');
      this.persist();
      this.refresh();
    }
  }

  /** Activity bar: what is running now, with Stop. @param {string} text */
  status(text) {
    const bar = this.el?.activity;
    if (!bar) return;
    bar.hidden = !this.busy;
    this.el.page.classList.toggle('busy', !!this.busy);
    this.el.actTitle.textContent = this.busy;
    this.el.actDetail.textContent = text && text !== this.busy ? text : '';
    this.el.actMeter.hidden = !(this.busy && this.recorder);
    if (this.busy && this.recorder && !this.meterOn) this.runActivityMeter();
  }

  /** The mic level in the activity bar, so you can see the mic hears the noise. */
  runActivityMeter() {
    this.meterOn = true;
    const tick = () => {
      if (!this.busy || !this.recorder) {
        this.meterOn = false;
        return;
      }
      const { rmsDbfs, peakDbfs, silent } = this.recorder.level();
      const pct = silent ? 0 : Math.max(0, Math.min(100, ((rmsDbfs + 80) / 80) * 100));
      this.el.actLevel.style.width = `${pct}%`;
      this.el.actLevelText.textContent = silent ? 'silent' : peakDbfs > -3 ? 'too loud' : rmsDbfs < -60 ? 'quiet' : 'hearing';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** The card the user last clicked in, if that was recent. */
  recentWhere() {
    return Date.now() - this.lastWhereAt < 60000 ? this.lastWhere : null;
  }

  /**
   * Say something. Inside a task, or right after a click, it appears in that card; otherwise
   * successes are a short toast and problems go to the alert strip.
   * @param {string} text @param {'info' | 'warn' | 'error' | 'ok'} [kind]
   * @param {{ label: string, fn: () => void }} [action]
   */
  notify(text, kind = 'info', action) {
    const where = this.taskWhere ?? this.recentWhere();
    if (where && where !== 'global') return this.say(where, kind, text, action);
    if (kind === 'ok' || kind === 'info') return this.toast(text);
    return this.alert(`msg-${Date.now()}`, kind, text, action);
  }

  /**
   * A message inside a card, under the button that caused it.
   * @param {string} where @param {string} kind @param {string} text @param {{ label: string, fn: () => void }} [action]
   */
  say(where, kind, text, action) {
    const { h: head, d } = splitMessage(text);
    const list = (this.feedback[where] ??= []);
    list.push({ kind, h: head, d, action });
    if (list.length > 3) list.shift();
    this.log(kind, text);
    this.renderFeedback(where);
  }

  /** A short message that goes away by itself (background events, small confirmations). @param {string} text */
  toast(text) {
    this.log('ok', text);
    const t = h('div', { class: 'toast', role: 'status' }, text);
    this.el?.toasts.append(t);
    setTimeout(() => t.remove(), 5000);
  }

  /**
   * A device-level problem in the strip under the steps, until it is resolved or dismissed.
   * @param {string} id @param {string} kind @param {string} text @param {{ label: string, fn: () => void }} [action]
   */
  alert(id, kind, text, action) {
    this.alerts.set(id, { kind, text, action });
    this.log(kind, text);
    this.renderAlerts();
  }

  /** @param {string} id */
  clearAlert(id) {
    if (this.alerts.delete(id)) this.renderAlerts();
  }

  /** @param {string} kind @param {string} text */
  log(kind, text) {
    this.history.unshift({ kind, text, time: new Date().toLocaleTimeString() });
    if (this.history.length > 100) this.history.pop();
    if (this.el?.msgCount) this.el.msgCount.textContent = String(this.history.length);
    if (this.drawer === 'messages') this.renderDrawer();
  }

  /** The message boxes of one card. @param {string} where */
  feedbackNodes(where) {
    const icon = { ok: '✓', info: 'i', warn: '!', error: '×' };
    return (this.feedback[where] ?? []).map((m) =>
      h('div', { class: `result result-${m.kind === 'error' ? 'err' : m.kind}`, role: m.kind === 'error' ? 'alert' : 'status' },
        h('span', { class: 'result-mark', 'aria-hidden': 'true' }, /** @type {any} */ (icon)[m.kind] ?? 'i'),
        h('span', { class: 'result-h' }, m.h),
        m.d ? h('span', { class: 'result-d' }, m.d) : null,
        h('span', { class: 'result-acts' },
          m.action ? h('button', { class: 'pill-btn', onclick: () => m.action?.fn() }, m.action.label) : null,
          h('button', { class: 'link', onclick: () => {
            this.feedback[where] = (this.feedback[where] ?? []).filter((x) => x !== m);
            this.renderFeedback(where);
          } }, 'Dismiss'))));
  }

  /** Put a card's messages on screen without re-rendering the card. @param {string} where */
  renderFeedback(where) {
    for (const box of this.root.querySelectorAll(`.feedback[data-for="${where}"]`)) box.replaceChildren(...this.feedbackNodes(where));
  }

  renderAlerts() {
    if (!this.el) return;
    const icon = { warn: '!', error: '×', info: 'i', ok: '✓' };
    this.el.alerts.replaceChildren(...[...this.alerts.entries()].map(([id, a]) =>
      h('div', { class: `alert alert-${a.kind === 'error' ? 'err' : a.kind}`, role: a.kind === 'error' ? 'alert' : 'status' },
        h('span', { class: 'result-mark', 'aria-hidden': 'true' }, /** @type {any} */ (icon)[a.kind] ?? '!'),
        h('span', { class: 'alert-text' }, a.text),
        a.action ? h('button', { class: 'pill-btn', onclick: () => a.action?.fn() }, a.action.label) : null,
        h('button', { class: 'link', onclick: () => this.clearAlert(id) }, 'Dismiss'))));
  }

  /** Open the help for a section or step, or the list of topics. @param {string | null} [topic] */
  openHelp(topic = null) {
    this.helpTopic = topic && HELP[topic] ? topic : null;
    this.openDrawer('help');
    this.el.drawer.scrollTop = 0;
  }

  /** @param {'settings' | 'messages' | 'help' | null} which */
  openDrawer(which) {
    this.drawer = which;
    this.renderDrawer();
  }

  renderDrawer() {
    const d = this.el.drawer;
    d.hidden = !this.drawer;
    this.el.scrim.hidden = !this.drawer;
    if (!this.drawer) return;
    const close = h('button', { class: 'link', onclick: () => this.openDrawer(null) }, 'Close');
    if (this.drawer === 'help') {
      const t = this.helpTopic ? HELP[this.helpTopic] : null;
      const list = (/** @type {string} */ step) => HELP_ORDER.filter((k) => HELP[k].step === step).map((k) =>
        h('li', null, h('button', { class: 'link', onclick: () => this.openHelp(k) }, HELP[k].title)));
      d.replaceChildren(h('header', { class: 'drawer-head' }, h('h2', null, t ? t.title : 'Help'), h('span', { class: 'spacer' }), close),
        h('div', { class: 'drawer-body help' },
          t ? [
            h('div', { class: 'back-row' }, h('button', { class: 'back-btn', onclick: () => this.openHelp(null) }, 'All help topics')),
            h('p', { class: 'help-step muted' }, t.step),
            h('p', { class: 'help-intro' }, t.intro),
            h('h3', null, 'What to do'), h('ol', null, t.todo.map((x) => h('li', null, x))),
            h('h3', null, 'Why'), h('p', null, t.why),
            h('h3', null, 'What you get'), h('p', null, t.outcome),
            t.tips?.length ? [h('h3', null, 'Good to know'), h('ul', null, t.tips.map((x) => h('li', null, x)))] : null,
          ] : [
            h('p', { class: 'help-intro' }, 'Speaker Tuner measures your speaker with a microphone, finds what to change, writes it to the speaker through Home Assistant and checks the result. Pick a topic, or press ? next to any section or step.'),
            ['Set up', 'Measure', 'Tune', 'Save'].map((step) => [h('h3', null, step), h('ul', { class: 'help-index' }, list(step))]),
          ]));
    } else if (this.drawer === 'messages') {
      const icon = { ok: '✓', info: 'i', warn: '!', error: '×' };
      d.replaceChildren(h('header', { class: 'drawer-head' }, h('h2', null, 'Messages'), h('span', { class: 'spacer' }), close),
        this.history.length
          ? h('ol', { class: 'history' }, this.history.map((m) => h('li', { class: `hist-${m.kind}` },
            h('span', { class: 'result-mark', 'aria-hidden': 'true' }, /** @type {any} */ (icon)[m.kind] ?? 'i'),
            h('span', null, m.text), h('time', null, m.time))))
          : h('p', { class: 'muted drawer-empty' }, 'Nothing yet.'));
    } else {
      d.replaceChildren(h('header', { class: 'drawer-head' }, h('h2', null, 'All settings'), h('span', { class: 'spacer' }), close),
        h('div', { class: 'drawer-body', 'data-where': 'settings' }, this.renderers.settings(this)));
    }
    /** @type {HTMLElement | null} */ (close).focus();
  }

  /** @param {string} id @param {string | null} [focus] part of Set up to open */
  goStep(id, focus = null) {
    const blocked = this.stepBlocked(id);
    if (blocked) {
      this.toast(blocked);
      return;
    }
    this.setupFocus = id === 'setup' ? focus : null;
    this.step = id;
    this.settings.step = id;
    this.persist();
    for (const el of Object.values(this.sections)) el.remove();
    this.sections = {};
    this.refresh();
    this.el.page.scrollIntoView?.({ block: 'start' });
  }

  /**
   * Open one part of Set up (connect, speaker or mic) in place of the checklist.
   * @param {string | null} name
   */
  focusSetup(name) {
    this.setupFocus = name;
    for (const el of Object.values(this.sections)) el.remove();
    this.sections = {};
    this.refresh();
    this.el.page.scrollIntoView?.({ block: 'start' });
  }

  /** A focused Set up card: always open, with the way back to the checklist. @param {HTMLElement} el */
  withBack(el) {
    if (el instanceof HTMLDetailsElement) el.open = true;
    const back = h('button', { class: 'back-btn', onclick: () => this.focusSetup(null) }, 'Checklist');
    // inside the card's body, so it lines up with everything else in the card
    const body = el.querySelector(':scope > .card-body') ?? el;
    body.prepend(h('div', { class: 'back-row' }, back));
  }

  /** The step to show: the saved one, else Set up until a speaker exists, else Measure; never a locked one. */
  currentStep() {
    const want = STEPS.some((st) => st.id === this.step) ? this.step : this.mapping && this.api ? 'measure' : 'setup';
    return this.stepBlocked(want) ? 'setup' : want;
  }

  /** What Set up still needs before measuring, in the checklist's words. */
  setupMissing() {
    const out = [];
    if (!this.api) out.push('Home Assistant');
    if (!(this.mapping && this.writer)) out.push('speaker');
    if (!this.demo && !this.recorder) out.push('microphone');
    return out;
  }

  /**
   * Why a step can't be opened yet, or '' when it can. Measure and Tune need Set up done;
   * Save needs a speaker.
   * @param {string} id
   */
  stepBlocked(id) {
    if (id === 'measure' || id === 'tune') {
      const missing = this.setupMissing();
      return missing.length ? `Finish Set up first: still needs ${missing.join(', ')}.` : '';
    }
    if (id === 'save') return this.api && this.mapping && this.writer ? '' : 'Set up a speaker first.';
    return '';
  }

  /** Which steps are complete, for the step control. */
  stepDone() {
    return {
      setup: !!(this.api && this.writer && (this.demo || this.recorder)),
      measure: this.measurements.some((m) => m.kind === 'full' && !m.test),
      tune: !!this.session && this.measurements.some((m) => m.kind === 'full' && m.label.startsWith('After pass') && !m.undone),
      save: false,
    };
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
      const titleId = `dlg${Date.now().toString(36)}`;
      const cancel = () => {
        close();
        reject(stopped());
      };
      const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Escape') cancel();
          // keep Tab inside the dialog
          if (e.key === 'Tab') {
            const buttons = [...dialog.querySelectorAll('button')];
            const i = buttons.indexOf(/** @type {any} */ (this.activeElement()));
            e.preventDefault();
            /** @type {HTMLElement} */ (buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length])?.focus();
          }
        } },
        h('div', { class: 'modal-box' },
          h('h3', { id: titleId }, title), h('p', null, text),
          h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: () => { close(); resolve(undefined); } }, ok),
            h('button', { onclick: cancel }, 'Cancel'))));
      this.el.page.append(dialog);
      this.log('info', `${title}: ${text}`);
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
    if (!this.demo) store.save('visible', [...this.visible]);
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
    const real = this.measurements.filter((m) => !m.test);
    const tests = this.measurements.filter((m) => m.test);
    const shownTests = tests.filter((m) => this.visible.has(m.id));
    // scan tests fold into one chip; the ones shown stay out so they can be hidden in one tap
    const testsOpen = !!this.legendTestsOpen && tests.length > 0;
    const fixed = series.filter((s) => s.role === 'target' || s.role === 'predicted').map((s) =>
      h('span', { class: 'legend-item' },
        h('span', { class: `swatch ${s.role === 'target' ? 'swatch-target' : 'swatch-predicted'}`, style: s.role === 'target' ? '' : `background: var(--series-${((s.slot ?? 0) % 8) + 1})` }),
        s.label));
    legend.replaceChildren(
      ...real.map((m) => this.legendChip(m)),
      ...(testsOpen ? tests : shownTests).map((m) => this.legendChip(m)),
      tests.length ? h('button', { class: 'legend-chip legend-more', 'aria-expanded': String(testsOpen), onclick: () => {
        this.legendTestsOpen = !testsOpen;
        this.renderLegend(this.shownSeries ?? series);
      } }, testsOpen ? 'Fewer tests ⌃' : `${tests.length - shownTests.length ? `+${tests.length - shownTests.length} ` : ''}scan test${tests.length === 1 ? '' : 's'} ⌄`) : null,
      ...fixed,
      this.measurements.length > 1 ? h('span', { class: 'legend-all' },
        h('button', { class: 'link', onclick: () => this.setShown((m) => !m.test, true, true) }, 'Show all'),
        h('button', { class: 'link', onclick: () => this.setShown(() => true, false) }, 'Hide all')) : null);
    if (!this.measurements.length) legend.append(h('span', { class: 'muted' }, 'No measurements yet.'));
    else if (!series.length) legend.append(h('span', { class: 'muted' }, 'Tap a measurement to show it.'));
    this.shownSeries = series;
    if (!this.el.table.hidden) this.fillTable(series);
  }

  toggleTable() {
    this.el.table.hidden = !this.el.table.hidden;
    if (!this.el.table.hidden) this.fillTable(this.shownSeries ?? []);
    this.renderHeader();
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
    this.el = {
      page: h('div', { class: 'page' }),
      header: h('div', { class: 'header' }),
      steps: h('nav', { class: 'steps', 'aria-label': 'Steps' }),
      alerts: h('div', { class: 'alerts' }),
      legend: h('div', { class: 'legend' }),
      chartTools: h('div', { class: 'chart-tools' }),
      table: h('div', { class: 'table-view', hidden: true }),
      sections: h('main', { class: 'sections' }),
      toasts: h('div', { class: 'toasts', 'aria-live': 'polite' }),
      actTitle: h('b'),
      actDetail: h('span'),
      actLevel: h('i'),
      actLevelText: h('span', { class: 'act-level-text' }),
      msgCount: h('span', { class: 'badge' }, '0'),
      drawer: h('aside', { class: 'drawer', hidden: true }),
      scrim: h('div', { class: 'scrim', hidden: true, onclick: () => this.openDrawer(null) }),
    };
    this.el.actMeter = h('div', { class: 'act-meter', hidden: true }, h('span', null, 'Mic'), h('span', { class: 'act-track' }, this.el.actLevel), this.el.actLevelText);
    this.el.activity = h('div', { class: 'activity', hidden: true },
      h('div', { class: 'activity-inner' },
        h('span', { class: 'act-spin', 'aria-hidden': 'true' }),
        h('div', { class: 'act-what' }, this.el.actTitle, this.el.actDetail, this.el.actMeter),
        h('button', { class: 'act-stop', 'aria-label': 'Stop', title: 'Stop', onclick: () => {
          this.abort?.abort('stopped');
          this.el.actDetail.textContent = 'Stopping, putting settings back…';
        } }),
        h('span', { class: 'act-progress', 'aria-hidden': 'true' })));
    this.el.page.append(
      h('div', { class: 'top' }, this.el.header, this.el.steps, this.el.alerts),
      h('section', { class: 'chart-card' },
        h('div', { class: 'chart-head' }, this.el.legend, h('span', { class: 'spacer' }), this.el.chartTools),
        h('div', { class: 'chart-wrap' }, canvas, tooltip), this.el.table),
      this.el.sections,
      this.el.toasts,
      this.el.activity,
      this.el.scrim,
      this.el.drawer,
    );
    // remember which card the user is working in: messages from what they start go there
    this.el.page.addEventListener('click', (e) => {
      const el = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest('[data-where]') : null);
      if (el && !this.busy) {
        this.lastWhere = el.dataset.where ?? null;
        this.lastWhereAt = Date.now();
      }
    }, true);
    this.el.page.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drawer) this.openDrawer(null);
    });
    this.root.append(this.el.page);
    this.chart = new ResponseChart(canvas, tooltip);
  }

  renderHeader() {
    const options = [
      ...this.mappings.map((m) => h('option', { value: m.id, selected: m.id === this.settings.mappingId }, m.name)),
      h('option', { value: '__new', selected: !this.mapping }, this.mappings.length ? 'Set up another speaker…' : 'No speaker yet'),
      this.mappings.length && !this.demo ? h('option', { value: '__manage' }, 'Manage speakers…') : null,
    ].filter(Boolean);
    const speaker = /** @type {HTMLSelectElement} */ (h('select', { class: 'speaker-switch', 'aria-label': 'Speaker', disabled: !!this.busy,
      onchange: () => {
        const id = speaker.value;
        if (id === '__new') {
          /** @type {any} */ (this).draft = null;
          this.useMapping('').then(() => this.goStep('setup', 'speaker'));
          return;
        }
        if (id === '__manage') {
          speaker.value = this.settings.mappingId || '__new';
          this.goStep('setup', 'speakers');
          return;
        }
        this.run('Switching speaker', async () => {
          /** @type {any} */ (this).draft = null;
          await this.useMapping(id);
        }, 'global');
      } }, options));
    const conn = this.demo ? 'Demo' : this.api ? 'Connected' : 'Not connected';
    this.el.header.replaceChildren(
      h('div', { class: 'room' }, h('span', { class: 'eyebrow' }, `Speaker Tuner · v${VERSION}`), speaker),
      h('div', { class: 'header-actions' },
        h('span', { class: `conn-pill ${this.api ? '' : 'off'}`, title: conn }, h('span', { class: 'dot' }), h('span', { class: 'hide-sm' }, conn)),
        h('button', { class: 'icon-btn', disabled: !this.writer, onclick: () => this.openDrawer('settings'), title: 'Every setting of this speaker', 'aria-label': 'All settings' },
          h('span', { 'aria-hidden': 'true' }, '⚙'), h('span', { class: 'hide-sm' }, 'All settings')),
        h('button', { class: 'icon-btn', onclick: () => this.openHelp(null), 'aria-label': 'Help' },
          h('span', { 'aria-hidden': 'true' }, '?'), h('span', { class: 'hide-sm' }, 'Help')),
        h('button', { class: 'icon-btn', onclick: () => this.openDrawer('messages'), 'aria-label': 'Messages' },
          h('span', { 'aria-hidden': 'true' }, '☰'), h('span', { class: 'hide-sm' }, 'Messages'), this.el.msgCount)));
    const step = this.currentStep();
    const done = this.stepDone();
    this.el.steps.replaceChildren(...STEPS.map((st, i) => {
      const blocked = this.stepBlocked(st.id);
      // a locked step stays pressable so a tap says why, as a toast
      return h('button', {
        class: `step-tab ${/** @type {any} */ (done)[st.id] && st.id !== step ? 'done' : ''} ${blocked ? 'locked' : ''}`,
        'aria-current': st.id === step ? 'step' : null,
        'aria-disabled': blocked ? 'true' : null,
        title: blocked || null,
        onclick: () => this.goStep(st.id),
      }, h('span', { class: 'n' }, /** @type {any} */ (done)[st.id] && st.id !== step ? '✓' : String(i + 1)), h('span', { class: 'lbl' }, st.label));
    }));
    this.el.chartTools.replaceChildren(
      h('button', { class: 'link', onclick: () => this.toggleTable() }, this.el.table.hidden ? 'Table' : 'Hide table'),
      h('button', { class: 'link', onclick: () => {
        this.chartSmall = !this.chartSmall;
        this.el.page.classList.toggle('chart-small', this.chartSmall);
        this.renderHeader();
        this.chart?.draw();
      } }, this.chartSmall ? 'Bigger chart' : 'Smaller chart'));
  }

  /**
   * Show or hide a measurement on the chart, and keep every list of tick boxes in step.
   * @param {string} id @param {boolean} on
   */
  setVisible(id, on) {
    this.setShown((m) => m.id === id, on);
  }

  /**
   * Show or hide every measurement that matches, and keep every tick box on the page in step.
   * @param {(m: any) => boolean} which @param {boolean} on @param {boolean} [only] hide the rest
   */
  setShown(which, on, only = false) {
    for (const m of this.measurements) {
      const hit = which(m);
      if (hit ? on : only) {
        if (hit) this.visible.add(m.id);
        else this.visible.delete(m.id);
      } else if (hit) this.visible.delete(m.id);
    }
    this.updateChart();
    for (const box of this.root.querySelectorAll('input[data-show]')) {
      /** @type {HTMLInputElement} */ (box).checked = this.visible.has(/** @type {HTMLElement} */ (box).dataset.show ?? '');
    }
    this.refresh('measure');
  }

  /**
   * One legend chip per measurement: a tap shows or hides it; Ctrl/⌘-click or a long press
   * shows only that one.
   * @param {any} m
   */
  legendChip(m) {
    const on = this.visible.has(m.id);
    let pressed = /** @type {any} */ (null);
    let solo = false;
    const only = () => {
      solo = true;
      this.setShown((x) => x.id === m.id, true, true);
    };
    return h('button', {
      class: `legend-chip ${on ? '' : 'off'}`, 'aria-pressed': String(on),
      title: `${on ? 'Hide' : 'Show'} ${m.label}${m.positions > 1 ? ` (${m.positions} positions)` : ''}. Ctrl/⌘-click or hold: show only this one.`,
      onpointerdown: () => {
        solo = false;
        pressed = setTimeout(only, 550);
      },
      onpointerup: () => clearTimeout(pressed),
      onpointerleave: () => clearTimeout(pressed),
      oncontextmenu: (/** @type {Event} */ e) => e.preventDefault(),
      onclick: (/** @type {MouseEvent} */ e) => {
        clearTimeout(pressed);
        if (solo) return; // the long press already did it
        if (e.ctrlKey || e.metaKey) only();
        else this.setVisible(m.id, !on);
      },
    }, h('span', { class: 'swatch', style: `background: var(--series-${((m.slot ?? 0) % 8) + 1})` }), h('span', { class: 'chip-label' }, m.label));
  }

  /** Re-render one section, or every section of the current step. @param {string} [name] */
  refresh(name) {
    const step = this.currentStep();
    let wanted = /** @type {any} */ (STEPS.find((st) => st.id === step)).sections.filter((n) => !(n === 'connect' && this.mode === 'panel'));
    // Set up shows the checklist, or the one part of it the user picked
    if (step === 'setup') wanted = this.setupFocus && wanted.includes(this.setupFocus) ? [this.setupFocus] : ['ready'];
    if (name === 'settings') {
      if (this.drawer === 'settings') this.renderDrawer();
      return;
    }
    // cards that don't belong to the current step leave (the step can change from code too)
    for (const [n, el] of Object.entries(this.sections)) {
      if (!wanted.includes(n)) {
        el.remove();
        delete this.sections[n];
      }
    }
    const names = name ? (wanted.includes(name) ? [name] : []) : wanted;
    for (const n of names) {
      const next = this.renderers[n](this);
      if (step === 'setup' && n === this.setupFocus) this.withBack(next);
      const old = this.sections[n];
      // keep what the user opened or closed, unless the card's default changed (e.g. setup done)
      if (old instanceof HTMLDetailsElement && next instanceof HTMLDetailsElement && old.dataset.default === next.dataset.default) next.open = old.open;
      if (old?.isConnected) old.replaceWith(next);
      else this.el.sections.append(next);
      this.sections[n] = next;
    }
    if (!name) {
      // keep the cards in the step's order
      for (const n of wanted) if (this.sections[n]) this.el.sections.append(this.sections[n]);
      if (this.drawer === 'settings') this.renderDrawer();
      this.updateChart();
    }
    this.renderHeader();
    this.status(this.busy);
  }
}

/**
 * Collapsible card. Its messages (from buttons inside it) show at the bottom of it.
 * @param {string} title @param {string} summary @param {any[]} body @param {boolean} [open]
 * @param {string} [where] message key; from the title by default
 */
export function card(title, summary, body, open = false, where = slug(title)) {
  return /** @type {HTMLDetailsElement} */ (h('details', { class: 'card', open, 'data-default': open ? 'open' : 'closed', 'data-where': where },
    h('summary', null, h('span', { class: 'card-title' }, title), helpButton(where, title), summary ? h('span', { class: 'card-summary muted' }, summary) : null),
    h('div', { class: 'card-body' }, body, feedbackBox(where))));
}

/**
 * The "?" that opens a section's or step's help, when it has one.
 * @param {string} topic @param {string} title
 */
export function helpButton(topic, title) {
  topic = /** @type {Record<string, string>} */ (HELP_ALIAS)[topic] ?? topic;
  if (!HELP[topic]) return null;
  return h('button', { class: 'help-btn', title: `Help: ${title}`, 'aria-label': `Help: ${title}`, onclick: (/** @type {Event} */ e) => {
    // inside a card's summary: don't open or close the card
    e.preventDefault();
    e.stopPropagation();
    currentApp?.openHelp(topic);
  } }, '?');
}

/** Where a card or block shows its messages. @param {string} where */
export function feedbackBox(where) {
  return h('div', { class: 'feedback', 'data-for': where, 'aria-live': 'polite' }, currentApp?.feedbackNodes(where) ?? []);
}

/**
 * Is the tool's test noise still in the media folder? Unknown (no browse permission, older HA)
 * counts as yes: playing it will tell.
 * @param {HaApi} api @param {string} url
 */
async function noiseInMediaFolder(api, url) {
  try {
    const r = await api.transport.send({ type: 'media_source/browse_media', media_content_id: MEDIA_FOLDER });
    return (r?.children ?? []).some((/** @type {any} */ c) => c.media_content_id === url);
  } catch (e) {
    // the folder doesn't exist yet: nothing was ever uploaded
    return !/not.?found|unknown_path|does not exist/i.test(String(/** @type {any} */ (e)?.message ?? e));
  }
}
