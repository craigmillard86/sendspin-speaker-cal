// @ts-check
// Parametric EQ fit: greedy peaking filters towards a target, then joint refinement.
//
// 1. Line the measurement up with the target (median offset over the fit range).
// 2. Greedy: take the largest remaining deviation that a filter is allowed to fix,
//    fit one peaking biquad there by least squares over a grid of Q values, keep it,
//    and repeat until the deviations are small or the banks are full.
// 3. One joint refinement stage: nudge every filter's frequency, gain and Q in turn,
//    keeping any change that lowers the total error.
// 4. Clamp and quantise to the ranges and steps the DSP entities accept.

import { magnitudeDb, peaking } from './biquad.js';
import { alignmentOffset, rmsDeviation } from './metrics.js';

/**
 * @typedef {{ id: string, maxFilters: number, fLo: number, fHi: number }} Bank
 *   a group of PEQ bands; a filter belongs to the bank whose [fLo, fHi) holds its frequency
 * @typedef {{ min: number, max: number, step: number }} Range
 * @typedef {{ fMin: number, fMax: number, gainMin: number, gainMax: number, cutsOnly?: boolean, minDeviationDb?: number }} FitRules
 * @typedef {{
 *   freqs: ArrayLike<number>, measuredDb: ArrayLike<number>, targetDb: ArrayLike<number>, fs: number,
 *   rules: FitRules, banks: Bank[], ranges: { frequency: Range, gain: Range, q: Range },
 *   exclude?: Array<[number, number]>, boostFloorHz?: number, mask?: ArrayLike<boolean>,
 *   stopDb?: number, maxBoostQ?: number, qGrid?: number[]
 * }} FitInput
 * @typedef {{ bank: string, f: number, gain: number, q: number, type: 'peaking' }} FittedFilter
 * @typedef {{
 *   filters: FittedFilter[], predictedDb: Float64Array, filterDb: Float64Array, offsetDb: number,
 *   rmsBefore: number, rmsAfter: number, rejected: Array<{ f: number, reason: string }>
 * }} FitResult
 */

const FLOOR_SPILL_DB = 1;

export const DEFAULT_Q_GRID = [0.5, 0.6, 0.7, 0.85, 1, 1.2, 1.4, 1.7, 2, 2.4, 2.8, 3.4, 4, 5, 6, 7, 8, 9, 10];

/**
 * Golden-section search for the minimum of f on [a, b].
 * @param {(x: number) => number} f @param {number} a @param {number} b @param {number} [tol]
 */
export function goldenMin(f, a, b, tol = 0.01) {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  while (Math.abs(b - a) > tol) {
    if (fc < fd) {
      b = d; d = c; fd = fc;
      c = b - g * (b - a); fc = f(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + g * (b - a); fd = f(d);
    }
  }
  const x = (a + b) / 2;
  return { x, value: f(x) };
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** @param {number} v @param {Range} r */
export function quantise(v, r) {
  const stepped = r.step > 0 ? Math.round((v - r.min) / r.step) * r.step + r.min : v;
  // trim float noise such as 0.30000000000000004
  return clamp(Math.round(stepped * 1e6) / 1e6, r.min, r.max);
}

/**
 * @param {FitInput} input
 * @returns {FitResult}
 */
export function fitPeq(input) {
  const { freqs, measuredDb, targetDb, fs, rules, banks, ranges } = input;
  const exclude = input.exclude ?? [];
  const boostFloor = input.boostFloorHz ?? 0;
  const stopDb = Math.max(input.stopDb ?? 1, rules.minDeviationDb ?? 0);
  const maxBoostQ = input.maxBoostQ ?? 8;
  const gainMax = rules.cutsOnly ? 0 : Math.min(rules.gainMax, ranges.gain.max);
  const gainMin = Math.max(rules.gainMin, ranges.gain.min);
  const qGrid = (input.qGrid ?? DEFAULT_Q_GRID).filter((q) => q >= ranges.q.min && q <= ranges.q.max);
  // refinement stays within the grid's Q span: very wide filters spill into everything
  const qLo = Math.max(ranges.q.min, Math.min(...qGrid));
  const qHi = ranges.q.max;

  const n = freqs.length;
  /** @type {number[]} */
  const idx = [];
  for (let i = 0; i < n; i++) {
    if (freqs[i] >= rules.fMin && freqs[i] <= rules.fMax && !input.mask?.[i]) idx.push(i);
  }

  const offset = alignmentOffset(freqs, measuredDb, targetDb, rules.fMin, rules.fMax, input.mask);
  // the correction we would like the filters to make
  const wanted = new Float64Array(n);
  // below the boost floor a deficit is left alone: raising it is not allowed, and a little
  // spill (up to FLOOR_SPILL_DB) from a boost above the floor is tolerated rather than fought
  const floorZone = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    wanted[i] = targetDb[i] - (measuredDb[i] - offset);
    if (freqs[i] < boostFloor && wanted[i] >= 0) floorZone[i] = 1;
  }
  /** error the filters still have to fix at point i */
  const residual = (/** @type {number} */ i, /** @type {Float64Array} */ total) => {
    if (!floorZone[i]) return wanted[i] - total[i];
    if (total[i] > FLOOR_SPILL_DB) return FLOOR_SPILL_DB - total[i];
    return total[i] < 0 ? -total[i] : 0;
  };

  /** @param {number} f */
  const bankFor = (f) => banks.find((b) => f >= b.fLo && f < b.fHi);
  /** @param {number} f */
  const excluded = (f) => exclude.some(([lo, hi]) => f >= lo && f <= hi);
  /** @param {number} f */
  const frequencyAllowed = (f) =>
    f >= rules.fMin && f <= rules.fMax && f >= ranges.frequency.min && f <= ranges.frequency.max && !excluded(f) && !!bankFor(f);

  /** @param {number} f @param {number} g @param {number} q */
  const shape = (f, g, q) => {
    const c = peaking(f, g, q, fs);
    const out = new Float64Array(n);
    for (const i of idx) out[i] = magnitudeDb(c, freqs[i], fs);
    return out;
  };
  /** @param {Float64Array} total */
  const cost = (total) => {
    let s = 0;
    for (const i of idx) {
      const d = residual(i, total);
      s += d * d;
    }
    return s;
  };
  /** @param {Float64Array} a @param {Float64Array} b @param {number} sign */
  const combine = (a, b, sign = 1) => {
    const out = new Float64Array(n);
    for (const i of idx) out[i] = a[i] + sign * b[i];
    return out;
  };
  /** @param {{ f: number, gain: number, q: number }} p */
  const valid = (p) =>
    frequencyAllowed(p.f) &&
    p.gain >= gainMin && p.gain <= gainMax &&
    p.q >= qLo && p.q <= qHi &&
    !(p.gain > 0 && (p.q > maxBoostQ || p.f < boostFloor));

  /** @type {Array<{ bank: string, f: number, gain: number, q: number, resp: Float64Array }>} */
  const filters = [];
  /** @type {Array<{ f: number, reason: string }>} */
  const rejected = [];
  const banned = new Set();
  let total = new Float64Array(n);
  const capacity = banks.reduce((s, b) => s + b.maxFilters, 0);

  // ----- greedy -----
  for (let guard = 0; filters.length < capacity && guard < 200; guard++) {
    let pick = -1;
    let pickAbs = 0;
    for (const i of idx) {
      // no filter is started below the floor just to trim spill from a boost above it
      if (banned.has(i) || floorZone[i]) continue;
      const r = residual(i, total);
      const f = freqs[i];
      if (Math.abs(r) < stopDb || Math.abs(r) <= pickAbs) continue;
      if (!frequencyAllowed(f)) continue;
      const bank = /** @type {Bank} */ (bankFor(f));
      if (filters.filter((x) => x.bank === bank.id).length >= bank.maxFilters) continue;
      if (r > 0 && (gainMax <= 0 || f < boostFloor)) continue;
      if (r < 0 && gainMin >= 0) continue;
      pick = i;
      pickAbs = Math.abs(r);
    }
    if (pick < 0) break;

    const f = freqs[pick];
    const boost = residual(pick, total) > 0;
    const before = cost(total);
    let best = { q: 1, gain: 0, value: before, resp: new Float64Array(n) };
    for (const q of qGrid) {
      const { x: gain, value } = goldenMin(
        (g) => cost(combine(total, shape(f, g, q))),
        boost ? 0 : gainMin,
        boost ? gainMax : 0,
      );
      if (value < best.value) best = { q, gain, value, resp: shape(f, gain, q) };
    }

    if (best.gain > 0 && best.q > maxBoostQ) {
      // a narrow dip that only a high-Q boost fits: most likely a room cancellation
      rejected.push({ f, reason: 'narrow null, not boosted' });
      banned.add(pick);
      continue;
    }
    if (before - best.value < 1e-6 * Math.max(1, before) || Math.abs(best.gain) < 0.1) {
      banned.add(pick);
      continue;
    }
    const bank = /** @type {Bank} */ (bankFor(f));
    filters.push({ bank: bank.id, f, gain: best.gain, q: best.q, resp: best.resp });
    total = combine(total, best.resp);
  }

  // ----- joint refinement -----
  const stages = [
    { fRatio: Math.pow(2, 1 / 24), qRatio: 1.1, gStep: 0.25 },
    { fRatio: Math.pow(2, 1 / 96), qRatio: 1.02, gStep: 0.05 },
  ];
  for (const stage of stages) {
    for (let pass = 0; pass < 40; pass++) {
      let improved = false;
      for (const flt of filters) {
        const tries = [
          { ...flt, f: flt.f * stage.fRatio }, { ...flt, f: flt.f / stage.fRatio },
          { ...flt, q: flt.q * stage.qRatio }, { ...flt, q: flt.q / stage.qRatio },
          { ...flt, gain: flt.gain + stage.gStep }, { ...flt, gain: flt.gain - stage.gStep },
        ];
        const without = combine(total, flt.resp, -1);
        let bestCost = cost(total);
        for (const t of tries) {
          if (!valid(t)) continue;
          const bank = bankFor(t.f);
          if (!bank || bank.id !== flt.bank) continue;
          const resp = shape(t.f, t.gain, t.q);
          const c = cost(combine(without, resp));
          if (c < bestCost - 1e-9) {
            bestCost = c;
            flt.f = t.f; flt.gain = t.gain; flt.q = t.q; flt.resp = resp;
            improved = true;
          }
        }
        total = combine(without, flt.resp);
      }
      if (!improved) break;
    }
  }

  // ----- clamp, quantise, drop filters that rounded to nothing -----
  /** @type {FittedFilter[]} */
  const out = [];
  for (const flt of filters) {
    const f = quantise(flt.f, ranges.frequency);
    let gain = quantise(clamp(flt.gain, gainMin, gainMax), ranges.gain);
    gain = clamp(gain, gainMin, gainMax);
    let q = quantise(flt.q, ranges.q);
    if (gain > 0) q = Math.min(q, maxBoostQ);
    if (Math.abs(gain) < 1e-9) continue;
    const bank = bankFor(f) ?? banks.find((b) => b.id === flt.bank);
    out.push({ bank: /** @type {Bank} */ (bank).id, f, gain, q, type: 'peaking' });
  }
  out.sort((a, b) => a.f - b.f);

  const filterDb = new Float64Array(n);
  for (const p of out) {
    const c = peaking(p.f, p.gain, p.q, fs);
    for (let i = 0; i < n; i++) filterDb[i] += magnitudeDb(c, freqs[i], fs);
  }
  const predictedDb = new Float64Array(n);
  for (let i = 0; i < n; i++) predictedDb[i] = measuredDb[i] + filterDb[i];

  return {
    filters: out,
    predictedDb,
    filterDb,
    offsetDb: offset,
    rmsBefore: rmsDeviation(freqs, measuredDb, targetDb, rules.fMin, rules.fMax, input.mask),
    rmsAfter: rmsDeviation(freqs, predictedDb, targetDb, rules.fMin, rules.fMax, input.mask),
    rejected,
  };
}

/**
 * Banks for a two-way speaker: the mid takes filters below the crossover and the tweeter
 * above it, with +-1/3 octave around the crossover left alone.
 * @param {number} crossoverHz @param {number} midBands @param {number} tweeterBands
 */
export function twoWayBanks(crossoverHz, midBands = 6, tweeterBands = 6) {
  const third = Math.pow(2, 1 / 3);
  return {
    banks: [
      { id: 'mid', maxFilters: midBands, fLo: 0, fHi: crossoverHz },
      { id: 'tweeter', maxFilters: tweeterBands, fLo: crossoverHz, fHi: Infinity },
    ],
    exclude: /** @type {Array<[number, number]>} */ ([[crossoverHz / third, crossoverHz * third]]),
  };
}

/**
 * Fit rules for each mic tier, from the README.
 * @param {'calibrated' | 'uncalibrated' | 'unknown'} tier
 * @returns {FitRules}
 */
export function tierRules(tier) {
  switch (tier) {
    case 'calibrated':
      return { fMin: 60, fMax: 16000, gainMin: -12, gainMax: 6 };
    case 'uncalibrated':
      return { fMin: 200, fMax: 10000, gainMin: -10, gainMax: 3 };
    default:
      return { fMin: 300, fMax: 8000, gainMin: -12, gainMax: 0, cutsOnly: true, minDeviationDb: 3 };
  }
}
