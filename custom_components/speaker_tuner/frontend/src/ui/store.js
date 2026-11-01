// @ts-check
// Where the tool keeps its data. With the Speaker Tuner integration in Home Assistant,
// everything that describes speakers and tuning is stored there (speakers, profiles, mics,
// targets, cal file, settings, measurements, session, tuning results), so every browser sees
// the same. Only what belongs to this browser stays here: the standalone page's connection,
// which mic input and which speaker this browser uses, and view preferences. localStorage
// also keeps a copy of the rest, so the page starts instantly and works without the
// integration (standalone page, or an older Home Assistant setup).
//
// Every access is wrapped: storage can be missing or full (private windows, blocked site
// data), and the tool still has to work.

import { STORE_GRID } from '../dsp/analyse.js';

const PREFIX = 'speaker-tuner.';

/** Kept in this browser only. */
export const LOCAL_KEYS = new Set(['connection', 'local', 'visible']);
/** Kept in Home Assistant when the integration is there. */
export const SERVER_KEYS = ['mappings', 'profiles', 'mics', 'targets', 'settings', 'cal', 'calName', 'session', 'measurements', 'tuning'];
/** Lists of { id } that are merged by id (not replaced) when a browser's copy meets Home Assistant's. */
const MERGED = new Set(['mappings', 'profiles', 'mics', 'targets', 'measurements']);

const EVENT = 'speaker_tuner_updated';
const SAVE_DELAY_MS = 800;

/**
 * @typedef {{
 *   api: import('../ha/connection.js').HaApi, values: Record<string, any>, client: string,
 *   timers: Map<string, ReturnType<typeof setTimeout>>, unsubscribe: (() => any) | null,
 *   onError: (key: string, message: string) => void,
 * }} Remote
 */
/** @type {Remote | null} */
let remote = null;

/** @template T @param {string} key @param {T} fallback @returns {T} */
function localLoad(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {any} value */
function localSave(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Is the data kept in Home Assistant? */
export function inHomeAssistant() {
  return !!remote;
}

/** @template T @param {string} key @param {T} fallback @returns {T} */
export function load(key, fallback) {
  if (remote && !LOCAL_KEYS.has(key)) return key in remote.values ? structuredClone(remote.values[key]) : fallback;
  return localLoad(key, fallback);
}

/** @param {string} key @param {any} value @returns {boolean} saved */
export function save(key, value) {
  const cached = localSave(key, value);
  if (!remote || LOCAL_KEYS.has(key)) return cached;
  // unchanged: nothing to send (and no "updated" for the other browsers)
  if (key in remote.values && JSON.stringify(remote.values[key]) === JSON.stringify(value)) return true;
  remote.values[key] = structuredClone(value);
  const r = remote;
  clearTimeout(r.timers.get(key));
  r.timers.set(key, setTimeout(() => push(r, key), SAVE_DELAY_MS));
  return true;
}

/** @param {Remote} r @param {string} key */
async function push(r, key) {
  r.timers.delete(key);
  try {
    await r.api.transport.send({ type: 'speaker_tuner/store/set', key, value: r.values[key] ?? null, client: r.client });
  } catch (e) {
    r.onError(key, /** @type {Error} */ (e).message ?? String(e));
  }
}

/** Send anything still waiting (page closing, disconnecting). */
export function flush() {
  const r = remote;
  if (!r) return;
  for (const [key, t] of r.timers) {
    clearTimeout(t);
    push(r, key);
  }
}

/**
 * @template {{ id: string }} T
 * @param {T[]} server @param {T[]} mine
 * @returns {{ list: T[], added: number }} the server's list plus what only this browser had
 */
function mergeById(server, mine) {
  const have = new Set(server.map((x) => x.id));
  const extra = mine.filter((x) => x && !have.has(x.id));
  return { list: [...server, ...extra], added: extra.length };
}

/**
 * Use Home Assistant's storage, if the integration provides it. Loads every key, then merges
 * in what only this browser had (speakers, profiles, measurements … by id; single values only
 * when Home Assistant has none), and saves the result back. Later changes from other browsers
 * arrive through `onRemoteChange`.
 * @param {import('../ha/connection.js').HaApi} api
 * @param {{ onError: (key: string, message: string) => void, onRemoteChange: (key: string) => void }} handlers
 * @returns {Promise<{ available: boolean, moved: Record<string, number> }>} moved: what this browser added, per key
 */
export async function attachServer(api, { onError, onRemoteChange }) {
  detachServer();
  /** @type {{ updated: Record<string, string> }} */
  let index;
  try {
    index = await api.transport.send({ type: 'speaker_tuner/store/get' });
  } catch {
    return { available: false, moved: {} }; // no integration (standalone page against a plain HA)
  }
  /** @type {Record<string, any>} */
  const values = {};
  // one key per request: the measurement list alone can be large
  for (const key of Object.keys(index.updated ?? {})) {
    const r = await api.transport.send({ type: 'speaker_tuner/store/get', keys: [key] });
    if (key in r.values) values[key] = r.values[key];
  }
  const client = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  remote = { api, values, client, timers: new Map(), unsubscribe: null, onError };
  const r = remote;

  /** @type {Record<string, number>} */
  const moved = {};
  for (const key of SERVER_KEYS) {
    const mine = localLoad(key, undefined);
    if (mine === undefined || mine === null) continue;
    if (!(key in values)) {
      save(key, mine);
      moved[key] = Array.isArray(mine) ? mine.length : 1;
    } else if (MERGED.has(key) && Array.isArray(mine) && Array.isArray(values[key])) {
      const { list, added } = mergeById(values[key], mine);
      if (added) {
        save(key, list);
        moved[key] = added;
      }
    }
  }
  // the browser's copy now matches Home Assistant
  for (const key of Object.keys(values)) localSave(key, values[key]);

  try {
    r.unsubscribe = await api.transport.subscribe({ type: 'subscribe_events', event_type: EVENT }, async (/** @type {any} */ event) => {
      const { key, client: from } = event?.data ?? {};
      if (remote !== r || from === r.client || !key || r.timers.has(key)) return;
      try {
        const got = await api.transport.send({ type: 'speaker_tuner/store/get', keys: [key] });
        if (key in got.values) r.values[key] = got.values[key];
        else delete r.values[key];
        localSave(key, r.values[key] ?? null);
        onRemoteChange(key);
      } catch {
        /* the next change or reload brings it */
      }
    });
  } catch {
    r.unsubscribe = null; // live updates are a nicety; saving still works
  }
  return { available: true, moved };
}

/** Stop using Home Assistant's storage (sending anything still waiting first). */
export function detachServer() {
  if (!remote) return;
  flush();
  try {
    remote.unsubscribe?.();
  } catch {
    /* already closed */
  }
  remote = null;
}

/** @param {number[] | undefined} a */
const pack = (a) => a?.map((x) => Math.round(x * 100) / 100);

/**
 * Measurements without the shared frequency grid, rounded to 0.01 dB, to fit in storage.
 * @param {import('../measure/record.js').MeasurementRecord[]} list
 */
export function saveMeasurements(list) {
  const compact = list.map((m) => ({
    ...m,
    curve: { db: pack(m.curve.db) },
    background: m.background ? { db: pack(m.background.db) } : null,
    snrDb: pack(m.snrDb),
    spreadDb: pack(m.spreadDb),
  }));
  return save('measurements', compact);
}

/** @returns {import('../measure/record.js').MeasurementRecord[]} */
export function loadMeasurements() {
  const grid = Array.from(STORE_GRID);
  return load('measurements', []).map((/** @type {any} */ m) => ({
    ...m,
    curve: { freqs: grid, db: m.curve.db },
    background: m.background ? { freqs: grid, db: m.background.db } : null,
  }));
}
