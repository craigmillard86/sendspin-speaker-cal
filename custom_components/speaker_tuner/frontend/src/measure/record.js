// @ts-check
// A stored measurement: the averaged curve plus what is needed to trust and compare it.

import { averagePositions, view } from '../dsp/analyse.js';
import { snrDb, positionSpreadDb, lowConfidenceMask } from '../dsp/confidence.js';
import { STORE_GRID } from '../dsp/analyse.js';

/**
 * @typedef {{
 *   id: string, label: string, kind: 'full' | 'tweeter' | 'mid' | 'nearfield', time: string,
 *   positions: number, volume: number | null, mic: string, tier: string,
 *   curve: { freqs: number[], db: number[] },
 *   background?: { freqs: number[], db: number[] } | null,
 *   snrDb?: number[], spreadDb?: number[], mask?: boolean[],
 *   clipped?: boolean, relevelled?: boolean, settings?: Record<string, any>, source?: string, undone?: boolean,
 * }} MeasurementRecord
 */

export function newId() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Smoothed to 1/12 octave but kept on the 1/48 store grid, for SNR and spread.
 * @param {{ freqs: number[], db: number[] }} c
 */
const smooth12 = (c) => view(c, 12, 48).db;

/**
 * Average of power across curves on the same grid, in dB.
 * @param {Array<{ freqs: number[], db: number[] }>} curves
 */
export function powerAverage(curves) {
  const n = curves[0].db.length;
  const db = new Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of curves) p += Math.pow(10, c.db[i] / 10);
    db[i] = 10 * Math.log10(p / curves.length);
  }
  return { freqs: curves[0].freqs, db };
}

/**
 * Build a record from one or more takes at different mic positions.
 * Takes either carry a raw `spectrum` (real mic) or just a `curve` (simulation, imports).
 * @param {{ label: string, kind: MeasurementRecord['kind'], settings?: Record<string, any> }} req
 * @param {Array<{ spectrum?: any, curve: { freqs: number[], db: number[] }, background?: any, clipped?: boolean }>} takes
 * @param {{ mic: { name: string, tier: string }, volume: number | null, cal?: any }} meta
 * @returns {MeasurementRecord}
 */
export function measurementFromPositions(req, takes, { mic, volume, cal = null }) {
  const curve = takes.every((t) => t.spectrum) ? averagePositions(takes.map((t) => t.spectrum), cal) : powerAverage(takes.map((t) => t.curve));
  const backgrounds = takes.map((t) => t.background).filter(Boolean);
  const background = backgrounds.length ? powerAverage(backgrounds) : null;
  const snr = background ? Array.from(snrDb(smooth12(curve), smooth12(background))) : undefined;
  const spread = takes.length > 1 ? Array.from(positionSpreadDb(takes.map((t) => smooth12(t.curve)))) : undefined;
  return {
    id: newId(),
    label: req.label,
    kind: req.kind,
    time: new Date().toISOString(),
    positions: takes.length,
    volume,
    mic: mic.name,
    tier: mic.tier,
    curve,
    background,
    snrDb: snr,
    spreadDb: spread,
    mask: lowConfidenceMask({ snr, spread }),
    clipped: takes.some((t) => t.clipped),
    settings: req.settings,
  };
}

/**
 * A record from an imported REW frequency response (absolute SPL is kept as is).
 * @param {string} label @param {{ freqs: number[], db: number[] }} fr
 * @returns {MeasurementRecord}
 */
export function importedMeasurement(label, fr) {
  const grid = Array.from(STORE_GRID);
  const lo = fr.freqs[0];
  const hi = fr.freqs[fr.freqs.length - 1];
  const db = grid.map((f) => interp(fr.freqs, fr.db, f));
  return {
    id: newId(), label, kind: 'full', time: new Date().toISOString(), positions: 1, volume: null,
    mic: 'Imported', tier: 'calibrated', curve: { freqs: grid, db }, source: 'rew',
    mask: grid.map((f) => f < lo || f > hi),
  };
}

/** @param {number[]} xs @param {number[]} ys @param {number} x */
function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const t = Math.log(x / xs[i - 1]) / Math.log(xs[i] / xs[i - 1]);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}
