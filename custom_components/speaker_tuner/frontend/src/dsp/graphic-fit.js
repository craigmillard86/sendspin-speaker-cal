// @ts-check
// Gain-only fit for a fixed-frequency graphic EQ, such as the tas58xx 15-band EQ.
// Each band is a peaking filter at a fixed frequency and Q; only the gains are fitted,
// by least squares with coordinate descent, then rounded to the entity steps.

import { magnitudeDb, peaking } from './biquad.js';
import { alignmentOffset, rmsDeviation } from './metrics.js';
import { goldenMin, quantise } from './fit.js';

/**
 * Bands of the tas58xx 15-band EQ (components/tas58xx/tas58xx_eq_bands.h comments).
 * The DAC's tables come from TI's "Equalizer (Q factor)" design, modelled here as RBJ peaking.
 */
export const TAS58XX_15_BANDS = [
  { f: 20, q: 2 }, { f: 31.5, q: 2 }, { f: 50, q: 1.5 }, { f: 80, q: 1.5 }, { f: 125, q: 1 },
  { f: 200, q: 1 }, { f: 315, q: 0.9 }, { f: 500, q: 0.9 }, { f: 800, q: 0.8 }, { f: 1250, q: 0.8 },
  { f: 2000, q: 0.7 }, { f: 3150, q: 0.7 }, { f: 5000, q: 0.6 }, { f: 8000, q: 0.6 }, { f: 16000, q: 0.5 },
];

/**
 * @typedef {{ f: number, q: number, gain?: { min: number, max: number, step: number } }} GraphicBand
 * @param {{
 *   freqs: ArrayLike<number>, measuredDb: ArrayLike<number>, targetDb: ArrayLike<number>, fs: number,
 *   rules: import('./fit.js').FitRules, bands: GraphicBand[], boostFloorHz?: number, mask?: ArrayLike<boolean>
 * }} input
 */
export function fitGraphic(input) {
  const { freqs, measuredDb, targetDb, fs, rules, bands } = input;
  const n = freqs.length;
  const idx = [];
  for (let i = 0; i < n; i++) if (freqs[i] >= rules.fMin && freqs[i] <= rules.fMax && !input.mask?.[i]) idx.push(i);
  const offset = alignmentOffset(freqs, measuredDb, targetDb, rules.fMin, rules.fMax, input.mask);
  const wanted = new Float64Array(n);
  for (let i = 0; i < n; i++) wanted[i] = targetDb[i] - (measuredDb[i] - offset);

  const limits = bands.map((b) => {
    const r = b.gain ?? { min: -15, max: 15, step: 1 };
    const inRange = b.f >= rules.fMin && b.f <= rules.fMax;
    let max = rules.cutsOnly ? 0 : Math.min(r.max, rules.gainMax);
    if ((input.boostFloorHz ?? 0) > b.f) max = Math.min(max, 0);
    return inRange ? { min: Math.max(r.min, rules.gainMin), max, step: r.step } : { min: 0, max: 0, step: r.step };
  });

  /** @param {number} b @param {number} g */
  const shape = (b, g) => {
    const c = peaking(bands[b].f, g, bands[b].q, fs);
    const out = new Float64Array(n);
    for (const i of idx) out[i] = magnitudeDb(c, freqs[i], fs);
    return out;
  };
  const gains = bands.map(() => 0);
  const resps = bands.map(() => new Float64Array(n));
  const total = new Float64Array(n);
  const costWith = (/** @type {Float64Array} */ without, /** @type {Float64Array} */ resp) => {
    let s = 0;
    for (const i of idx) {
      const d = wanted[i] - without[i] - resp[i];
      s += d * d;
    }
    return s;
  };

  /** set band b's gain to pickGain(response of all the other bands) */
  const update = (/** @type {number} */ b, /** @type {(without: Float64Array) => number} */ pickGain) => {
    const without = new Float64Array(n);
    for (const i of idx) without[i] = total[i] - resps[b][i];
    const g = pickGain(without);
    const resp = shape(b, g);
    for (const i of idx) total[i] = without[i] + resp[i];
    gains[b] = g;
    resps[b] = resp;
  };

  for (let sweep = 0; sweep < 30; sweep++) {
    let moved = 0;
    for (let b = 0; b < bands.length; b++) {
      const { min, max } = limits[b];
      if (min === max) continue;
      const before = gains[b];
      update(b, (without) => goldenMin((g) => costWith(without, shape(b, g)), min, max, 0.01).x);
      moved = Math.max(moved, Math.abs(gains[b] - before));
    }
    if (moved < 0.02) break;
  }

  // round each band to the step its entity accepts
  for (let b = 0; b < bands.length; b++) {
    const { min, max, step } = limits[b];
    update(b, () => quantise(gains[b], { min, max, step }));
  }

  const filterDb = new Float64Array(n);
  bands.forEach((band, b) => {
    const c = peaking(band.f, gains[b], band.q, fs);
    for (let i = 0; i < n; i++) filterDb[i] += magnitudeDb(c, freqs[i], fs);
  });
  const predictedDb = new Float64Array(n);
  for (let i = 0; i < n; i++) predictedDb[i] = measuredDb[i] + filterDb[i];
  return {
    gains,
    predictedDb,
    filterDb,
    offsetDb: offset,
    rmsBefore: rmsDeviation(freqs, measuredDb, targetDb, rules.fMin, rules.fMax, input.mask),
    rmsAfter: rmsDeviation(freqs, predictedDb, targetDb, rules.fMin, rules.fMax, input.mask),
  };
}
