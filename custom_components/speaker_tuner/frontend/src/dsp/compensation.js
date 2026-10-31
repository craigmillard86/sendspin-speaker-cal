// @ts-check
// Suggestions for the fork's fixed compensation filters: tweeter breakup notch, air shelf
// and baffle step.

import { indicesInRange, median, meanDb } from './metrics.js';

/**
 * A narrow peak on the tweeter-alone response above fMin: height against the median of the
 * surrounding octave, Q from its -3 dB width. Null if nothing over minHeightDb.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} db
 * @param {{ fMin?: number, fMax?: number, minHeightDb?: number }} [options]
 */
export function detectBreakupPeak(freqs, db, { fMin = 10000, fMax = 16000, minHeightDb = 3 } = {}) {
  let best = null;
  for (let i = 1; i < freqs.length - 1; i++) {
    const f = freqs[i];
    if (f < fMin || f > fMax) continue;
    if (!(db[i] >= db[i - 1] && db[i] >= db[i + 1])) continue;
    const around = indicesInRange(freqs, f / Math.SQRT2, f * Math.SQRT2).map((j) => db[j]);
    const height = db[i] - median(around);
    if (height >= minHeightDb && (!best || height > best.heightDb)) best = { index: i, f, heightDb: height };
  }
  if (!best) return null;

  // -3 dB points below the peak top
  const level = db[best.index] - 3;
  let lo = best.index;
  while (lo > 0 && db[lo] > level) lo--;
  let hi = best.index;
  while (hi < freqs.length - 1 && db[hi] > level) hi++;
  const bandwidthOct = Math.log2(freqs[hi] / freqs[lo]);
  const q = bandwidthOct > 0 ? Math.sqrt(Math.pow(2, bandwidthOct)) / (Math.pow(2, bandwidthOct) - 1) : 10;
  return {
    frequency: Math.round(best.f / 10) * 10,
    gainDb: Math.max(-24, -Math.round(best.heightDb * 2) / 2),
    q: Math.min(20, Math.max(0.5, Math.round(q * 10) / 10)),
  };
}

/**
 * Air shelf gain: mean of (target - measured) over 10..16 kHz after lining the
 * curves up over 2..8 kHz, rounded to 0.5 dB and clamped to +-6 dB.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} measuredDb @param {ArrayLike<number>} targetDb
 */
export function suggestAirGain(freqs, measuredDb, targetDb) {
  const diff = new Float64Array(freqs.length);
  for (let i = 0; i < diff.length; i++) diff[i] = targetDb[i] - measuredDb[i];
  const reference = meanDb(freqs, diff, 2000, 8000);
  const top = meanDb(freqs, diff, 10000, 16000);
  if (!Number.isFinite(reference) || !Number.isFinite(top)) return 0;
  return Math.max(-6, Math.min(6, Math.round((top - reference) * 2) / 2));
}

/**
 * Baffle width in cm whose step frequency 343 / (pi x width) matches f.
 * @param {number} stepHz
 */
export function baffleWidthForStep(stepHz) {
  return (34300 / (Math.PI * stepHz));
}

/**
 * Baffle step frequency for a width in cm (the fork's formula).
 * @param {number} widthCm
 */
export function baffleStepHz(widthCm) {
  return 34300 / (Math.PI * widthCm);
}

/**
 * Rough baffle step estimate from a far-field mid response: the low plateau (150..300 Hz)
 * sits below the upper plateau (1..2 kHz) by up to 6 dB; the step frequency is where the
 * curve crosses half way. Null if the difference is under 2 dB.
 * Returns the suggested width clamped to the fork's 5..50 cm.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} db @param {{ crossoverHz?: number }} [o]
 */
export function suggestBaffleWidth(freqs, db, { crossoverHz = Infinity } = {}) {
  // the upper plateau has to stay clear of a mid-alone curve's own crossover roll-off
  const highTop = Math.min(2000, crossoverHz / 1.5);
  const low = meanDb(freqs, db, 150, 300);
  const high = meanDb(freqs, db, highTop / 2, highTop);
  if (!(high - low >= 2)) return null;
  const half = (low + high) / 2;
  for (const i of indicesInRange(freqs, 200, 1500)) {
    if (db[i] >= half) {
      const width = baffleWidthForStep(freqs[i]);
      return { stepHz: freqs[i], widthCm: Math.min(50, Math.max(5, Math.round(width))), stepDb: high - low };
    }
  }
  return null;
}
