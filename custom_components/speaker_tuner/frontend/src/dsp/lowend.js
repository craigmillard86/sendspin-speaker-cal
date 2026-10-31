// @ts-check
// Low-frequency analysis of a nearfield mid/bass measurement:
// - sealed box: fit a 2nd order high-pass to find resonance f0 and Q0 (for Linkwitz)
// - ported / passive radiator: find the tuning frequency fb, the dip in the cone's nearfield output
// - suggest a subsonic high-pass from either

import { median } from './metrics.js';

/**
 * Magnitude in dB of an analogue 2nd order high-pass.
 * @param {number} f @param {number} f0 @param {number} q
 */
export function highpass2Db(f, f0, q) {
  const x = f / f0;
  const re = 1 - x * x;
  const im = x / q;
  return 20 * Math.log10((x * x) / Math.sqrt(re * re + im * im));
}

/**
 * Fit f0 and Q0 of a sealed box roll-off. Searches f0 20..200 Hz and Q 0.3..2,
 * solving the level offset exactly at each point.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} db
 * @param {{ fLow?: number, fHigh?: number }} [range] frequencies used for the fit
 */
export function fitSealedRolloff(freqs, db, { fLow = 15, fHigh = 500 } = {}) {
  const idx = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i] >= fLow && freqs[i] <= fHigh) idx.push(i);
  if (idx.length < 8) throw new Error('Not enough low-frequency points to fit');

  const search = (/** @type {number[]} */ f0s, /** @type {number[]} */ qs) => {
    let best = { f0: f0s[0], q0: qs[0], offset: 0, error: Infinity };
    for (const f0 of f0s) {
      for (const q of qs) {
        let mean = 0;
        for (const i of idx) mean += db[i] - highpass2Db(freqs[i], f0, q);
        mean /= idx.length;
        let err = 0;
        for (const i of idx) err += (db[i] - mean - highpass2Db(freqs[i], f0, q)) ** 2;
        if (err < best.error) best = { f0, q0: q, offset: mean, error: err };
      }
    }
    return best;
  };
  const coarse = search(
    Array.from({ length: 91 }, (_, k) => 20 * Math.pow(10, k / 90)),
    Array.from({ length: 35 }, (_, k) => 0.3 + k * 0.05),
  );
  const fine = search(
    Array.from({ length: 41 }, (_, k) => coarse.f0 * Math.pow(2, (k - 20) / 240)),
    Array.from({ length: 41 }, (_, k) => Math.max(0.3, coarse.q0 - 0.05 + k * 0.0025)),
  );
  return { f0: fine.f0, q0: fine.q0, rmsError: Math.sqrt(fine.error / idx.length) };
}

/**
 * -3 dB frequency of the 2nd order high-pass with this f0 and Q.
 * @param {number} f0 @param {number} q
 */
export function f3Of(f0, q) {
  // |H|^2 = 1/2 solved for x^2 = (f/f0)^2
  const a = 1 / (q * q) - 2;
  const x2 = (-a + Math.sqrt(a * a + 4)) / 2;
  return f0 * Math.sqrt(x2);
}

/**
 * Tuning frequency of a ported or passive-radiator box: the deepest narrow dip in the
 * cone's nearfield response between fLow and fHigh, measured against the median of the
 * surrounding octave. Null if no dip of at least minDepthDb.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} db
 * @param {{ fLow?: number, fHigh?: number, minDepthDb?: number }} [options]
 */
export function findTuningFrequency(freqs, db, { fLow = 20, fHigh = 150, minDepthDb = 6 } = {}) {
  let best = null;
  for (let i = 1; i < freqs.length - 1; i++) {
    const f = freqs[i];
    if (f < fLow || f > fHigh) continue;
    if (!(db[i] <= db[i - 1] && db[i] <= db[i + 1])) continue;
    const around = [];
    for (let j = 0; j < freqs.length; j++) {
      if (freqs[j] >= f / Math.SQRT2 && freqs[j] <= f * Math.SQRT2) around.push(db[j]);
    }
    const depth = median(around) - db[i];
    if (depth >= minDepthDb && (!best || depth > best.depthDb)) best = { fb: f, depthDb: depth };
  }
  return best;
}

/**
 * Subsonic high-pass suggestion, clamped to what the fork accepts (10..100 Hz).
 * Ported/passive radiator: 0.8 x fb. Sealed: 0.7 x the f3 (or the Linkwitz target fp).
 * @param {{ fb?: number, f3?: number }} p
 */
export function suggestSubsonic({ fb, f3 }) {
  const raw = fb ? 0.8 * fb : f3 ? 0.7 * f3 : 0;
  if (!raw) return 0;
  return Math.min(100, Math.max(10, Math.round(raw)));
}

/**
 * Low-frequency boost of a Linkwitz transform, (f0/fp)^2 in dB.
 * @param {number} f0 @param {number} fp
 */
export function linkwitzBoostDb(f0, fp) {
  return 40 * Math.log10(f0 / fp);
}
