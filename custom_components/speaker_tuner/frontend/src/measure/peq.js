// @ts-check
// From a measurement to the role values that the PEQ fit wants written.
//
// The measurement already includes whatever PEQ the speaker has now, so that PEQ is taken
// out first ("raw" response) and the fit always starts from scratch. That way each refine
// pass replaces the bands rather than stacking new filters on old ones.

import { view, normalised, FIT_FRACTION } from '../dsp/analyse.js';
import { responseDb } from '../dsp/biquad.js';
import { fitPeq, tierRules } from '../dsp/fit.js';
import { fitGraphic } from '../dsp/graphic-fit.js';
import { targetDb as targetCurve } from '../dsp/target.js';
import { rmsDeviation } from '../dsp/metrics.js';
import { bankFilters, bankValues, activeBanks, mirrorValues } from '../profiles/profile.js';

/**
 * @typedef {{ tier: 'calibrated' | 'uncalibrated' | 'unknown', range_hz?: [number, number], gain_db?: [number, number],
 *   cuts_only?: boolean, min_deviation_db?: number }} MicRules
 */

/**
 * Fit rules from the mic profile: the tier's rules, narrowed or widened by the mic's own
 * range and gain limits if it sets them.
 * @param {MicRules} mic
 */
export function micRules(mic) {
  const r = tierRules(mic.tier);
  if (mic.range_hz) [r.fMin, r.fMax] = mic.range_hz;
  if (mic.gain_db) [r.gainMin, r.gainMax] = mic.gain_db;
  if (mic.cuts_only !== undefined) r.cutsOnly = mic.cuts_only;
  if (mic.min_deviation_db !== undefined) r.minDeviationDb = mic.min_deviation_db;
  if (r.cutsOnly) r.gainMax = 0;
  return r;
}

/**
 * Banks for the fitter from the profile. "below_crossover" and "above_crossover" banks split
 * at the crossover frequency, with +-1/3 octave around it left alone.
 * @param {import('../profiles/profile.js').Profile} profile @param {number} crossoverHz
 */
export function fitBanks(profile, crossoverHz) {
  const third = Math.pow(2, 1 / 3);
  const parametric = activeBanks(profile).filter((b) => b.type !== 'graphic');
  const split = parametric.some((b) => b.domain === 'below_crossover' || b.domain === 'above_crossover');
  return {
    banks: parametric.map((b) => ({
      id: b.id,
      maxFilters: b.bands ?? 0,
      fLo: b.domain === 'above_crossover' ? crossoverHz : 0,
      fHi: b.domain === 'below_crossover' ? crossoverHz : Infinity,
    })),
    exclude: /** @type {Array<[number, number]>} */ (split ? [[crossoverHz / third, crossoverHz * third]] : []),
  };
}

/**
 * dB response of the PEQ currently set on the speaker, on a grid.
 * @param {import('../profiles/profile.js').Profile} profile @param {Record<string, any>} values @param {ArrayLike<number>} freqs
 */
export function currentPeqDb(profile, values, freqs) {
  const fs = profile.dsp_sample_rate ?? 96000;
  const out = new Float64Array(freqs.length);
  for (const bank of activeBanks(profile)) {
    const r = responseDb(bankFilters(profile, values, bank.id), freqs, fs);
    for (let i = 0; i < out.length; i++) out[i] += r[i];
  }
  return out;
}

/**
 * @param {{
 *   profile: import('../profiles/profile.js').Profile,
 *   values: Record<string, any>,
 *   rangeOf: (role: string) => { min: number, max: number, step: number },
 *   curve: { freqs: number[], db: number[] },
 *   target: import('../dsp/target.js').Target,
 *   mic: MicRules,
 *   boostFloorHz?: number,
 *   mask?: boolean[],
 * }} p
 */
export function planPeqFit({ profile, values, rangeOf, curve, target, mic, boostFloorHz = 0, mask }) {
  const fs = profile.dsp_sample_rate ?? 96000;
  const measured = view(normalised(curve), FIT_FRACTION, 24);
  const freqs = measured.freqs;
  const current = currentPeqDb(profile, values, freqs);
  const raw = measured.db.map((d, i) => d - current[i]);
  const tgt = targetCurve(target, freqs);
  const rules = micRules(mic);
  // boosts stay out of the bottom half octave of the fit range even when no tuning frequency
  // or subsonic is known: that is where drivers run out of excursion
  const floor = effectiveBoostFloor(boostFloorHz, rules.fMin);
  const fitMask = mask ? resampleMask(curve.freqs, mask, freqs) : undefined;
  const crossoverHz = Number(values.crossover_frequency ?? profile.defaults?.crossover_frequency ?? 2500);

  /** @type {Record<string, any>} */
  const changes = {};
  const predicted = Float64Array.from(raw);
  const rmsBefore = rmsDeviation(freqs, measured.db, tgt, rules.fMin, rules.fMax, fitMask);

  const parametric = activeBanks(profile).filter((b) => b.type !== 'graphic');
  /** @type {import('../dsp/fit.js').FitResult | null} */
  let peqResult = null;
  if (parametric.length) {
    const first = parametric[0];
    const role = (/** @type {string} */ f) => `${first.role_prefix}1_${f}`;
    const { banks, exclude } = fitBanks(profile, crossoverHz);
    peqResult = fitPeq({
      freqs, measuredDb: raw, targetDb: tgt, fs, rules, banks, exclude, boostFloorHz: floor, mask: fitMask,
      ranges: { frequency: rangeOf(role('frequency')), gain: rangeOf(role('gain')), q: rangeOf(role('q')) },
    });
    for (const b of parametric) Object.assign(changes, bankValues(profile, b.id, peqResult.filters.filter((f) => f.bank === b.id)));
    for (let i = 0; i < predicted.length; i++) predicted[i] += peqResult.filterDb[i];
  }

  for (const bank of activeBanks(profile).filter((b) => b.type === 'graphic')) {
    const bands = (bank.frequencies ?? []).map((f, i) => ({ f, q: bank.q?.[i] ?? 1, gain: rangeOf(`${bank.role_prefix}${i + 1}_gain`) }));
    // graphic banks fit what the parametric banks left over
    const residual = Float64Array.from(predicted);
    const g = fitGraphic({ freqs, measuredDb: residual, targetDb: tgt, fs, rules, bands, boostFloorHz: floor, mask: fitMask });
    g.gains.forEach((gain, i) => (changes[`${bank.role_prefix}${i + 1}_gain`] = gain));
    for (let i = 0; i < predicted.length; i++) predicted[i] += g.filterDb[i];
  }

  Object.assign(changes, mirrorValues(profile, changes));

  return {
    changes,
    freqs,
    measuredDb: measured.db,
    rawDb: raw,
    predictedDb: Array.from(predicted),
    targetDb: Array.from(tgt),
    filters: peqResult?.filters ?? [],
    rejected: peqResult?.rejected ?? [],
    rmsBefore,
    rmsAfter: rmsDeviation(freqs, predicted, tgt, rules.fMin, rules.fMax, fitMask),
    rules,
    boostFloorHz: floor,
  };
}

/**
 * Lowest frequency a boost may sit at: the known floor (1.3 x fb or subsonic), but never
 * inside the bottom half octave of the fit range.
 * @param {number} known @param {number} fMin
 */
export function effectiveBoostFloor(known, fMin) {
  return Math.max(known || 0, fMin * Math.SQRT2);
}

/**
 * RMS deviation of a stored curve from the target over the mic's fit range.
 * @param {{ freqs: number[], db: number[] }} curve @param {import('../dsp/target.js').Target} target @param {MicRules} mic
 */
export function curveRms(curve, target, mic) {
  const v = view(normalised(curve), FIT_FRACTION, 24);
  const rules = micRules(mic);
  return rmsDeviation(v.freqs, v.db, targetCurve(target, v.freqs), rules.fMin, rules.fMax);
}

/**
 * @param {ArrayLike<number>} from @param {boolean[]} mask @param {ArrayLike<number>} to
 */
function resampleMask(from, mask, to) {
  const out = [];
  let j = 0;
  for (let i = 0; i < to.length; i++) {
    while (j < from.length - 1 && Math.abs(from[j + 1] - to[i]) <= Math.abs(from[j] - to[i])) j++;
    out.push(!!mask[j]);
  }
  return out;
}
