// @ts-check
// The guided tuning steps. Each one measures, works out a suggestion, puts back every
// setting it changed while testing, and returns the suggestion as role values for the
// user to apply (or not).

import { view, normalised, FIT_FRACTION } from '../dsp/analyse.js';
import { crossoverDip, crossoverFlatness, driverLevelMatch } from '../dsp/metrics.js';
import { fitSealedRolloff, f3Of, findTuningFrequency, suggestSubsonic } from '../dsp/lowend.js';
import { detectBreakupPeak, suggestAirGain, suggestBaffleWidth } from '../dsp/compensation.js';
import { targetDb } from '../dsp/target.js';
import { fitToRange } from '../ha/entities.js';
import { peaking, highShelf, magnitudeDb } from '../dsp/biquad.js';

/** A change must make the crossover region at least this much flatter to be suggested. */
export const MIN_FLATNESS_GAIN_DB = 0.2;

/**
 * @typedef {{ writer: import('../ha/dsp-writer.js').DspWriter, measurer: import('./session.js').Measurer,
 *   profile: import('../profiles/profile.js').Profile, positions?: number, signal?: AbortSignal,
 *   onStatus?: (text: string) => void, onPrompt?: (i: number, n: number) => Promise<void>,
 *   onMeasurement?: (m: import('./record.js').MeasurementRecord) => void }} Ctx
 */

/** @param {{ freqs: number[], db: number[] }} c */
const fitView = (c) => view(c, FIT_FRACTION, 24);

/**
 * Write values for the duration of `fn`, then put the previous values back.
 * @template T
 * @param {Ctx} ctx @param {Record<string, any>} temporary @param {() => Promise<T>} fn
 */
async function withValues(ctx, temporary, fn) {
  const before = ctx.writer.snapshot(Object.keys(temporary));
  const report = await ctx.writer.write(temporary, { signal: ctx.signal });
  if (!report.ok) {
    const cleanup = await ctx.writer.write(before);
    const why = `${report.failed[0]?.role ?? 'a setting'}: ${report.failed[0]?.error ?? 'stopped'}`;
    if (!cleanup.ok) throw new Error(`Could not set ${why}, and could not put ${leftOver(cleanup)} back either. Use Revert, which also unmutes both drivers.`);
    if (report.stopped) throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
    throw new Error(`Could not set ${why}`);
  }
  try {
    return await fn();
  } finally {
    // never aborted: the speaker must get its values back even after Stop
    const back = await ctx.writer.write(before);
    if (!back.ok) throw new Error(`Could not put ${leftOver(back)} back after the test. Use Revert, which also unmutes both drivers.`);
  }
}

/** Roles a failed restore left behind, for the error message. @param {import('../ha/dsp-writer.js').WriteReport} r */
function leftOver(r) {
  return [...r.failed.map((f) => f.role), ...r.remaining].join(', ') || 'a setting';
}

/**
 * Measure with one driver muted (or neither).
 * @param {Ctx} ctx @param {'tweeter' | 'mid' | 'full'} which @param {string} label
 */
export async function measureDriver(ctx, which, label) {
  const mutes = {};
  if (which !== 'full' && !(ctx.writer.entities.tweeter_mute && ctx.writer.entities.mid_mute)) {
    throw new Error('Measuring one driver needs the tweeter and mid mute switches mapped in setup.');
  }
  if (which === 'tweeter') Object.assign(mutes, { tweeter_mute: false, mid_mute: true });
  if (which === 'mid') Object.assign(mutes, { tweeter_mute: true, mid_mute: false });
  const run = () => ctx.measurer.measure({
    label, kind: which, positions: ctx.positions ?? 1, signal: ctx.signal, onStatus: ctx.onStatus, onPrompt: ctx.onPrompt,
  });
  const m = which === 'full' ? await run() : await withValues(ctx, mutes, run);
  ctx.onMeasurement?.(m);
  return m;
}

/** @param {Ctx} ctx */
const crossoverHz = (ctx) => Number(ctx.writer.value('crossover_frequency') ?? ctx.profile.defaults?.crossover_frequency ?? 2500);

/**
 * Score of a summed response through the crossover: flatness (std dev, dB) over +-1 octave.
 * @param {{ freqs: number[], db: number[] }} curve @param {number} xo
 */
export function sumScore(curve, xo) {
  const v = fitView(curve);
  return { flatnessDb: crossoverFlatness(v.freqs, v.db, xo), dipDb: crossoverDip(v.freqs, v.db, xo) };
}

/**
 * Level match: measure each driver alone, cut the louder one.
 * @param {Ctx} ctx
 */
export async function levelMatch(ctx) {
  const xo = crossoverHz(ctx);
  const tweeter = await measureDriver(ctx, 'tweeter', 'Tweeter alone');
  const mid = await measureDriver(ctx, 'mid', 'Mid alone');
  const t = fitView(tweeter.curve);
  const m = fitView(mid.curve);
  const match = driverLevelMatch(t.freqs, t.db, m.db, xo);
  /** @type {Record<string, number>} */
  const suggestion = {};
  for (const [role, change] of [['tweeter_gain', match.tweeterChangeDb], ['mid_gain', match.midChangeDb]]) {
    const now = Number(ctx.writer.value(/** @type {string} */ (role)) ?? 0);
    suggestion[/** @type {string} */ (role)] = fitToRange(now + Number(change), ctx.writer.range(/** @type {string} */ (role)));
  }
  return { tweeter, mid, differenceDb: match.differenceDb, suggestion };
}

/**
 * Polarity: measure the sum, flip the tweeter, measure again, keep the flatter.
 * @param {Ctx} ctx @param {{ always?: boolean }} [options] always: test the flip even without a dip
 */
export async function polarityTest(ctx, { always = false } = {}) {
  const xo = crossoverHz(ctx);
  const current = !!ctx.writer.value('tweeter_invert');
  const normal = await measureDriver(ctx, 'full', `Polarity: tweeter ${current ? 'inverted' : 'normal'}`);
  const normalScore = sumScore(normal.curve, xo);
  if (!always && normalScore.dipDb <= 3) {
    return { needed: false, normal: { measurement: normal, ...normalScore }, flipped: null, suggestion: {} };
  }
  const flipped = await withValues(ctx, { tweeter_invert: !current }, () =>
    measureDriver(ctx, 'full', `Polarity: tweeter ${!current ? 'inverted' : 'normal'}`));
  const flippedScore = sumScore(flipped.curve, xo);
  const flip = flippedScore.flatnessDb < normalScore.flatnessDb;
  return {
    needed: true,
    normal: { measurement: normal, ...normalScore },
    flipped: { measurement: flipped, ...flippedScore },
    suggestion: flip ? { tweeter_invert: !current } : {},
  };
}

/**
 * Crossover scan: try each frequency (and filter type), score the sum, keep the flattest.
 * The current setting is always measured too, and a change is only suggested when it is
 * clearly flatter (MIN_FLATNESS_GAIN_DB), not on measurement noise.
 * Frequencies below the entity minimum (the YAML tweeter_min_frequency) are skipped.
 * @param {Ctx} ctx @param {number[]} frequencies @param {string[]} [filters] select options to try
 */
export async function crossoverScan(ctx, frequencies, filters) {
  const range = ctx.writer.range('crossover_frequency');
  const skipped = frequencies.filter((f) => f < range.min || f > range.max);
  const currentFrequency = crossoverHz(ctx);
  const currentFilter = ctx.writer.value('crossover_filter');
  const list = [...new Set([currentFrequency, ...frequencies.filter((f) => f >= range.min && f <= range.max).map((f) => fitToRange(f, range))])];
  // the current filter type is always tried, so there is something to compare against
  const types = filters?.length ? [...new Set([currentFilter, ...filters])] : [currentFilter];
  const results = [];
  for (const filter of types) {
    for (const f of list) {
      const temp = { crossover_frequency: f, ...(filter && filters?.length ? { crossover_filter: filter } : {}) };
      const m = await withValues(ctx, temp, () => measureDriver(ctx, 'full', `Crossover ${f} Hz${filters?.length ? ` ${filter}` : ''}`));
      results.push({ frequency: f, filter, measurement: m, ...sumScore(m.curve, f) });
    }
  }
  results.sort((a, b) => a.flatnessDb - b.flatnessDb);
  const best = results[0];
  const current = results.find((r) => r.frequency === currentFrequency && (!filters?.length || r.filter === currentFilter));
  const worthIt = best && current && best !== current && best.flatnessDb <= current.flatnessDb - MIN_FLATNESS_GAIN_DB;
  return {
    results,
    skipped,
    current,
    suggestion: worthIt
      ? { ...(best.frequency !== currentFrequency ? { crossover_frequency: best.frequency } : {}), ...(filters?.length && best.filter !== currentFilter ? { crossover_filter: best.filter } : {}) }
      : {},
  };
}

/**
 * Signed delay offset to role values: + delays the tweeter, - delays the mid.
 * @param {number} mm
 */
export const delayValues = (mm) => ({ tweeter_delay: Math.max(0, mm), mid_delay: Math.max(0, -mm) });

/**
 * Delay scan by the reverse-null method. With the tweeter's polarity flipped for the test,
 * the drivers cancel at the crossover, and the cancellation is deepest when they are best
 * aligned in time. Pink noise carries no phase, but the depth of that null does.
 * A signed offset is scanned coarse then fine (+ delays the tweeter, - the mid), then the
 * best offset is measured once with normal polarity to check the real sum is no worse
 * than with the current delay.
 * @param {Ctx} ctx @param {{ max?: number, coarse?: number, fine?: number }} [o]
 */
export async function delayScan(ctx, { max = 50, coarse = 5, fine = 1 } = {}) {
  // never scan further than the delay entities accept, or results get labelled with offsets
  // that were clamped
  max = Math.min(max, ctx.writer.range('tweeter_delay').max, ctx.writer.range('mid_delay').max);
  const xo = crossoverHz(ctx);
  const invert = !ctx.writer.value('tweeter_invert');
  const currentOffset = Number(ctx.writer.value('tweeter_delay') ?? 0) - Number(ctx.writer.value('mid_delay') ?? 0);
  /** @type {Map<number, any>} */
  const tried = new Map();
  const tryOffset = async (/** @type {number} */ mm) => {
    if (tried.has(mm)) return tried.get(mm);
    const m = await withValues(ctx, delayValues(mm), () => measureDriver(ctx, 'full', `Delay ${mm > 0 ? '+' : ''}${mm} mm (reverse null)`));
    const r = { offsetMm: mm, measurement: m, ...sumScore(m.curve, xo) };
    tried.set(mm, r);
    return r;
  };
  const deepest = () => [...tried.values()].sort((a, b) => b.dipDb - a.dipDb)[0];

  await withValues(ctx, { tweeter_invert: invert }, async () => {
    for (let mm = -max; mm <= max + 1e-9; mm += coarse) await tryOffset(Math.round(mm));
    const centre = deepest().offsetMm;
    for (let mm = centre - coarse + fine; mm < centre + coarse; mm += fine) {
      if (Math.abs(mm) <= max) await tryOffset(Math.round(mm));
    }
  });
  const best = deepest();
  const results = [...tried.values()].sort((a, b) => a.offsetMm - b.offsetMm);

  // check with normal polarity: the new offset against the current one
  const confirm = await withValues(ctx, delayValues(best.offsetMm), () => measureDriver(ctx, 'full', `Delay ${best.offsetMm} mm, normal polarity`));
  const current = await measureDriver(ctx, 'full', `Delay ${currentOffset} mm, normal polarity`);
  const bestScore = sumScore(confirm.curve, xo);
  const currentScore = sumScore(current.curve, xo);
  const better = bestScore.flatnessDb <= currentScore.flatnessDb + 0.1;
  return {
    results, best, currentOffsetMm: currentOffset,
    confirm: { best: bestScore, current: currentScore },
    suggestion: better ? delayValues(best.offsetMm) : {},
  };
}

/**
 * Low end from a nearfield measurement of the mid cone (tweeter muted, separate level).
 * Sealed: f0/Q0 for the Linkwitz transform and a subsonic below the f3.
 * Ported / passive radiator: the tuning frequency fb and a subsonic at 0.8 x fb.
 * @param {Ctx} ctx @param {{ nearfieldVolume?: number, restoreVolume?: number | null }} [o]
 */
export async function lowEnd(ctx, { nearfieldVolume, restoreVolume } = {}) {
  // the volume to go back to is passed in: by the time this runs, levelling for the
  // nearfield position has already changed the player's volume
  const sessionVolume = restoreVolume ?? (await ctx.measurer.getVolume());
  if (nearfieldVolume !== undefined) await ctx.measurer.setVolume(nearfieldVolume);
  // measure the box itself: the bass filters this step suggests are switched off for the test,
  // or the fit would read back the Linkwitz transform or subsonic filter already set
  /** @type {Record<string, any>} */
  const test = {};
  if (ctx.writer.entities.tweeter_mute) Object.assign(test, { tweeter_mute: true, mid_mute: false });
  for (const role of ['linkwitz_f0', 'linkwitz_fp', 'subsonic_frequency', 'baffle_width']) if (ctx.writer.entities[role]) test[role] = 0;
  /** @type {import('./record.js').MeasurementRecord} */
  let m;
  try {
    const run = () => ctx.measurer.measure({ label: 'Nearfield mid', kind: 'nearfield', positions: 1, signal: ctx.signal, onStatus: ctx.onStatus });
    m = Object.keys(test).length ? await withValues(ctx, test, run) : await run();
    ctx.onMeasurement?.(m);
  } finally {
    if (sessionVolume !== null && nearfieldVolume !== undefined) await ctx.measurer.setVolume(sessionVolume);
  }
  const v = view(m.curve, 24, 48);
  const enclosure = ctx.profile.enclosure ?? 'sealed';
  if (enclosure === 'sealed') {
    const fit = fitSealedRolloff(v.freqs, v.db);
    const f3 = f3Of(fit.f0, fit.q0);
    return {
      measurement: m, enclosure, f0: fit.f0, q0: fit.q0, f3,
      suggestion: {
        linkwitz_f0: Math.round(fit.f0), linkwitz_q0: Math.round(fit.q0 * 100) / 100, subsonic_frequency: suggestSubsonic({ f3 }),
      },
    };
  }
  const tuning = findTuningFrequency(v.freqs, v.db);
  return {
    measurement: m, enclosure, fb: tuning?.fb ?? null, depthDb: tuning?.depthDb ?? null,
    suggestion: tuning ? { subsonic_frequency: suggestSubsonic({ fb: tuning.fb }) } : {},
  };
}

/** Boost floor for the PEQ fit: 1.3 x fb, or 1.3 x the subsonic frequency. @param {{ fb?: number | null, subsonic?: number }} p */
export function boostFloor({ fb, subsonic }) {
  if (fb) return 1.3 * fb;
  if (subsonic && subsonic >= 10) return 1.3 * subsonic;
  return 0;
}

/**
 * Baffle step suggestion from a far-field mid (or full) measurement.
 * @param {{ freqs: number[], db: number[] }} curve
 */
export function baffleSuggestion(curve, crossoverHz = Infinity) {
  const v = fitView(curve);
  const s = suggestBaffleWidth(v.freqs, v.db, { crossoverHz });
  return s ? { ...s, suggestion: { baffle_width: s.widthCm } } : null;
}

/**
 * Tweeter breakup notch (from tweeter alone) and air shelf (from the full response).
 * Calibrated mics only: nobody can judge 10 kHz and up with an unknown mic.
 * @param {{ freqs: number[], db: number[] }} tweeterCurve @param {{ freqs: number[], db: number[] }} fullCurve
 * @param {import('../dsp/target.js').Target} target @param {string} tier @param {number} [fs] DSP sample rate
 * @param {{ air_gain?: number, tweeter_notch_frequency?: number, tweeter_notch_gain?: number, tweeter_notch_q?: number }} [current]
 *   the speaker's present notch and air settings
 */
export function notchAndAir(tweeterCurve, fullCurve, target, tier, fs = 96000, current = {}) {
  if (tier !== 'calibrated') return { allowed: false, suggestion: {} };
  // take the notch and air shelf the speaker has now out of the curves, so the suggestions
  // are absolute settings rather than corrections on top of what is already there
  const now = currentNotchAirDb(current, fs);
  const t0 = fitView(normalised(tweeterCurve));
  const f0 = fitView(normalised(fullCurve));
  const t = { freqs: t0.freqs, db: t0.db.map((d, i) => d - now(t0.freqs[i])) };
  const f = { freqs: f0.freqs, db: f0.db.map((d, i) => d - now(f0.freqs[i])) };
  const notch = detectBreakupPeak(t.freqs, t.db);
  // judge the air shelf on the response as it will be once the notch is in, or the
  // breakup peak gets cut twice
  const notched = notch ? f.db.map((d, i) => d + magnitudeDb(peaking(notch.frequency, notch.gainDb, notch.q, fs), f.freqs[i], fs)) : f.db;
  const air = suggestAirGain(f.freqs, notched, targetDb(target, f.freqs));
  /** @type {Record<string, number>} */
  const suggestion = { air_gain: air };
  if (notch) Object.assign(suggestion, { tweeter_notch_frequency: notch.frequency, tweeter_notch_gain: notch.gainDb, tweeter_notch_q: notch.q });
  return { allowed: true, notch, air, suggestion };
}

/**
 * dB response of the present notch and air shelf (as the fork applies them), as a function of f.
 * @param {{ air_gain?: number, tweeter_notch_frequency?: number, tweeter_notch_gain?: number, tweeter_notch_q?: number }} c
 * @param {number} fs
 */
function currentNotchAirDb(c, fs) {
  const parts = [];
  if (c.air_gain) parts.push(highShelf(10000, c.air_gain, Math.SQRT1_2, fs));
  if ((c.tweeter_notch_frequency ?? 0) >= 1000 && (c.tweeter_notch_gain ?? 0) < 0) {
    parts.push(peaking(c.tweeter_notch_frequency ?? 0, c.tweeter_notch_gain ?? 0, c.tweeter_notch_q ?? 5, fs));
  }
  return (/** @type {number} */ f) => parts.reduce((sum, q) => sum + magnitudeDb(q, f, fs), 0);
}
