// @ts-check
// Model of the tas58xx fork's two-way DSP chain (components/tas58xx/tas58xx_crossover.cpp),
// used to predict what a settings change does, estimate chain peak gain, and simulate a speaker.
//
// Settings use the fork's crossover: YAML keys, e.g.
// { filter: 'LR4', frequency: 2500, tweeter_gain: -3, tweeter_invert: false, tweeter_delay: 0,
//   tweeter_peq: [{ frequency, gain, q, type: 'PEAKING' }], subsonic_frequency, baffle_width,
//   baffle_placement: 'FREESTANDING', tweeter_notch: { frequency, gain, q }, air_gain,
//   linkwitz: { f0, q0, fp, qp }, dsp_sample_rate: 96000 }

import {
  gain, allpassDelay, highpass, lowpass, peaking, lowShelf, highShelf, linkwitzTransform, cascadeResponse,
} from './biquad.js';

const Q_BUTTERWORTH = Math.SQRT1_2;
const Q_LR2 = 0.5;
const Q_BW4 = [0.54119610014619698, 1.30656296487637652];
const BAFFLE_GAIN_DB = { FREESTANDING: 6, NEAR_WALL: 3, CORNER: 0 };

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @typedef {{ frequency: number, gain: number, q: number, type?: string }} PeqSetting
 * @typedef {Record<string, any>} CrossoverSettings
 */

/** @param {PeqSetting} p @param {number} fs */
function peqBand(p, fs) {
  const f = clamp(p.frequency, 20, 20000);
  const g = clamp(p.gain, -15, 15);
  const q = clamp(p.q, 0.1, 10);
  switch (String(p.type ?? 'PEAKING').toUpperCase()) {
    case 'LOW_SHELF':
      return lowShelf(f, g, q, fs);
    case 'HIGH_SHELF':
      return highShelf(f, g, q, fs);
    default:
      return peaking(f, g, q, fs);
  }
}

/** @param {string} filter @param {boolean} hp @param {number} f @param {number} fs */
function crossoverSections(filter, hp, f, fs) {
  const fc = clamp(f, 500, 8000);
  const make = (/** @type {number} */ q) => (hp ? highpass(fc, q, fs) : lowpass(fc, q, fs));
  switch (String(filter).toUpperCase()) {
    case 'LR2':
      return [make(Q_LR2)];
    case 'BW2':
      return [make(Q_BUTTERWORTH)];
    case 'BW4':
      return Q_BW4.map(make);
    default:
      return [make(Q_BUTTERWORTH), make(Q_BUTTERWORTH)];
  }
}

/**
 * The biquads of one driver's chain, in the fork's band order. Loudness is left out:
 * the tool measures with loudness off.
 * @param {CrossoverSettings} s
 * @param {'tweeter' | 'mid'} role
 * @param {{ includeGain?: boolean }} [options]
 */
export function driverCascade(s, role, { includeGain = true } = {}) {
  const fs = s.dsp_sample_rate ?? 96000;
  const tweeter = role === 'tweeter';
  const out = [];
  if (includeGain) out.push(gain(clamp(s[`${role}_gain`] ?? 0, -24, 6), !!s[`${role}_invert`]));
  out.push(allpassDelay(clamp(s[`${role}_delay`] ?? 0, 0, 50), fs));
  const minimum = clamp(s.tweeter_min_frequency ?? 500, 500, 8000);
  out.push(...crossoverSections(s.filter ?? 'LR4', tweeter, clamp(s.frequency ?? 2500, minimum, 8000), fs));
  if (!tweeter) {
    const sub = s.subsonic_frequency ?? 0;
    if (sub >= 10) out.push(highpass(clamp(sub, 10, 100), Q_BUTTERWORTH, fs));
    const lw = s.linkwitz ?? {};
    if ((lw.f0 ?? 0) >= 15 && (lw.fp ?? 0) >= 15) {
      out.push(linkwitzTransform(clamp(lw.f0, 15, 200), clamp(lw.q0 ?? 0.707, 0.3, 2), clamp(lw.fp, 15, 200), clamp(lw.qp ?? 0.5, 0.3, 2), fs));
    }
  }
  for (const p of s[`${role}_peq`] ?? []) out.push(peqBand(p, fs));
  if (tweeter) {
    const n = s.tweeter_notch ?? {};
    if ((n.frequency ?? 0) >= 1000 && (n.gain ?? 0) < 0) out.push(peaking(clamp(n.frequency, 1000, 20000), clamp(n.gain, -24, 0), clamp(n.q ?? 5, 0.5, 20), fs));
    out.push(highShelf(10000, clamp(s.air_gain ?? 0, -6, 6), Q_BUTTERWORTH, fs));
  } else if ((s.baffle_width ?? 0) > 0) {
    const width = clamp(s.baffle_width, 5, 50) / 100;
    const placement = /** @type {keyof typeof BAFFLE_GAIN_DB} */ (String(s.baffle_placement ?? 'FREESTANDING').toUpperCase());
    out.push(lowShelf(343 / (Math.PI * width), BAFFLE_GAIN_DB[placement] ?? 6, Q_BUTTERWORTH, fs));
  }
  return out;
}

/**
 * Highest gain of a driver's chain from 5 Hz to 20 kHz without its trim, as the fork's
 * peak gain sensors report it.
 * @param {CrossoverSettings} s @param {'tweeter' | 'mid'} role
 */
export function chainPeakDb(s, role) {
  const fs = s.dsp_sample_rate ?? 96000;
  const cascade = driverCascade(s, role, { includeGain: false });
  let peak = 0;
  for (let f = 5; f <= Math.min(20000, 0.49 * fs); f *= Math.pow(2, 1 / 24)) {
    const h = cascadeResponse(cascade, f, fs);
    peak = Math.max(peak, Math.hypot(h.re, h.im));
  }
  return 20 * Math.log10(Math.max(peak, 1e-9));
}
