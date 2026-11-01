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
    offsetDb: peqResult?.offsetDb ?? 0,
    fs,
  };
}

/** @param {number} f */
const hz = (f) => (f >= 1000 ? `${Math.round(f / 100) / 10} kHz` : `${Math.round(f)} Hz`);

/**
 * What the fit found, in words: each correction (bands within a sixth of an octave merged),
 * described by the peak or dip it takes out, and what it deliberately left alone. A band's
 * peak or dip is how far the measurement is from the target at its centre once the other
 * bands have done their part, so overlapping bands are not counted twice.
 * @param {ReturnType<typeof planPeqFit>} plan
 * @returns {Array<{ kind: 'peak' | 'dip' | 'shape' | 'null' | 'floor', f: number, db: number, text: string }>}
 */
export function peqFindings(plan) {
  const fs = plan.fs ?? 96000;
  const near = (/** @type {number} */ f) => {
    let best = 0;
    for (let i = 1; i < plan.freqs.length; i++) if (Math.abs(plan.freqs[i] - f) < Math.abs(plan.freqs[best] - f)) best = i;
    return best;
  };
  /** @param {number} f */
  const rawDev = (f) => {
    const i = near(f);
    return plan.rawDb[i] - plan.offsetDb - plan.targetDb[i];
  };
  // merge bands that sit together (a broad and a narrow cut at one frequency are one fix)
  /** @type {Array<Array<any>>} */
  const groups = [];
  for (const flt of [...plan.filters].sort((x, y) => x.f - y.f)) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(Math.log2(flt.f / last[0].f)) < 1 / 6 && Math.sign(flt.gain) === Math.sign(last[0].gain)) last.push(flt);
    else groups.push([flt]);
  }
  const shapes = (/** @type {any[]} */ fl) => fl.map((x) => ({ type: x.type ?? 'peaking', f: x.f, gain: x.gain, q: x.q }));
  /** @type {Array<{ kind: 'peak' | 'dip' | 'shape' | 'null' | 'floor', f: number, db: number, text: string }>} */
  const out = groups.map((g) => {
    const f = g.reduce((a, x) => a + x.f * Math.abs(x.gain), 0) / g.reduce((a, x) => a + Math.abs(x.gain), 0);
    const gain = Math.max(...g.map((x) => Math.abs(x.gain))) * Math.sign(g[0].gain);
    const others = plan.filters.filter((x) => !g.includes(x));
    const help = others.length ? responseDb(shapes(others), [f], fs)[0] : 0;
    const dev = rawDev(f) + help; // what is left at f for this group to fix
    const cut = gain < 0;
    const amount = g.length > 1 ? `up to ${Math.abs(gain)} dB with ${g.length} bands` : `${Math.abs(gain)} dB`;
    const q = Math.max(...g.map((x) => x.q));
    const width = g.length === 1 && q >= 4 ? 'narrow ' : g.length === 1 && q <= 1 ? 'broad ' : '';
    // a band can be shaping the response with its neighbours rather than taking out a peak or dip of its own
    if ((cut && dev < 0.5) || (!cut && dev > -0.5)) {
      return { kind: /** @type {const} */ ('shape'), f, db: dev, text: `${cut ? 'cut' : 'lift'} of ${amount} around ${hz(f)}, shaping the response together with the bands next to it` };
    }
    return { kind: /** @type {'peak' | 'dip'} */ (cut ? 'peak' : 'dip'), f, db: dev, text: `${width}${cut ? 'peak' : 'dip'} of ${dev > 0 ? '+' : ''}${dev.toFixed(1)} dB around ${hz(f)}: ${cut ? 'cut' : 'lifted'} ${amount}` };
  });
  for (const r of plan.rejected) {
    out.push({ kind: 'null', f: r.f, db: rawDev(r.f), text: `narrow dip of ${rawDev(r.f).toFixed(1)} dB at ${hz(r.f)}: left alone, most likely the room (moving the speaker or the seat changes it; EQ can't)` });
  }
  if (plan.boostFloorHz > plan.rules.fMin) {
    out.push({ kind: 'floor', f: plan.boostFloorHz, db: 0, text: `nothing boosted below ${hz(plan.boostFloorHz)}, to protect the bass driver` });
  }
  return out.sort((x, y) => x.f - y.f);
}

/**
 * Band by band, what a bank holds before and after: frequency, gain, Q and type. Only bands
 * that are on in either are listed; a band going to 0 dB is switched off.
 * @param {import('../profiles/profile.js').Profile} profile
 * @param {Record<string, any>} before role values now
 * @param {Record<string, any>} after role values to write (or written)
 */
export function bandChanges(profile, before, after) {
  const rows = [];
  for (const bank of activeBanks(profile)) {
    if (bank.type === 'graphic') {
      (bank.frequencies ?? []).forEach((f, i) => {
        const role = `${bank.role_prefix}${i + 1}_gain`;
        const was = Number(before[role] ?? 0);
        const now = Number(after[role] ?? was);
        if (was || now) rows.push({ bank: bank.name ?? bank.id, band: i + 1, before: { f, gain: was, q: bank.q?.[i] ?? 1 }, after: { f, gain: now, q: bank.q?.[i] ?? 1 } });
      });
      continue;
    }
    for (let n = 1; n <= (bank.bands ?? 0); n++) {
      const p = `${bank.role_prefix}${n}_`;
      const get = (/** @type {Record<string, any>} */ v, /** @type {Record<string, any>} */ fallback) => ({
        f: Number(v[`${p}frequency`] ?? fallback[`${p}frequency`] ?? 1000),
        gain: Number(v[`${p}gain`] ?? fallback[`${p}gain`] ?? 0),
        q: Number(v[`${p}q`] ?? fallback[`${p}q`] ?? 1),
      });
      const was = get(before, {});
      const now = get(after, before);
      if (was.gain || now.gain) rows.push({ bank: bank.name ?? bank.id, band: n, before: was, after: now });
    }
  }
  return rows;
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
