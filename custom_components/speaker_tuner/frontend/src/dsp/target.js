// @ts-check
// Target curves: a list of [frequency, dB] points, interpolated in log frequency.

import { interpLogF } from './smoothing.js';

/** @typedef {{ name: string, points: Array<[number, number]> }} Target */

/** @type {Target} */
export const FLAT = { name: 'Flat', points: [[20, 0], [20000, 0]] };

/**
 * Flat to `cornerHz`, then `dbPerOctave` above it.
 * @param {number} dbPerOctave
 * @param {number} cornerHz
 * @returns {Target}
 */
export function tilt(dbPerOctave = -1, cornerHz = 1000) {
  const octaves = Math.log2(20000 / cornerHz);
  return {
    name: `Tilt ${dbPerOctave} dB/oct above ${cornerHz} Hz`,
    points: [[20, 0], [cornerHz, 0], [20000, Math.round(dbPerOctave * octaves * 100) / 100]],
  };
}

/**
 * Validate and sort a user-edited target.
 * @param {any} target
 * @returns {Target}
 */
export function normaliseTarget(target) {
  if (!target || !Array.isArray(target.points) || target.points.length < 1) {
    throw new Error('A target needs at least one [frequency, dB] point.');
  }
  const points = target.points.map((/** @type {any} */ p, /** @type {number} */ i) => {
    const f = Number(p[0]);
    const db = Number(p[1]);
    if (!(f > 0) || !Number.isFinite(db)) throw new Error(`Target point ${i + 1} is not [frequency > 0, dB].`);
    return /** @type {[number, number]} */ ([f, db]);
  });
  points.sort((a, b) => a[0] - b[0]);
  return { name: String(target.name ?? 'Custom'), points };
}

/**
 * Target in dB at each frequency. The target is shifted so it reads 0 dB at 1 kHz,
 * matching the measurement normalisation.
 * @param {Target} target
 * @param {ArrayLike<number>} freqs
 */
export function targetDb(target, freqs) {
  const xs = target.points.map((p) => p[0]);
  const ys = target.points.map((p) => p[1]);
  const at1k = interpLogF(xs, ys, 1000);
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) out[i] = interpLogF(xs, ys, freqs[i]) - at1k;
  return out;
}
