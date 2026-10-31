// @ts-check
// Browser storage for this tool: device mappings, imported profiles/mics/targets, settings,
// measurements and the session snapshot. Every access is wrapped: storage can be missing
// or full (private windows, blocked site data), and the tool still has to work.

import { STORE_GRID } from '../dsp/analyse.js';

const PREFIX = 'speaker-tuner.';

/** @template T @param {string} key @param {T} fallback @returns {T} */
export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {any} value @returns {boolean} saved */
export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
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
