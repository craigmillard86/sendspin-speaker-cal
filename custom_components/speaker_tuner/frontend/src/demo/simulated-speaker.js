// @ts-check
// A made-up two-way speaker with passive radiators, in a made-up room, for demo mode and tests.
// Drivers are summed with phase through the fork's DSP chain model, so polarity, delay,
// crossover frequency and levels change the result the way they would on a real speaker.

import { highpass, lowpass, peaking, lowShelf, cascadeResponse, magnitudeDb, responseDb } from '../dsp/biquad.js';
import { driverCascade } from '../dsp/chain.js';
import { STORE_GRID } from '../dsp/analyse.js';
import { prng } from '../dsp/pink.js';

const FS = 96000;
const SPEED_MM_PER_S = 343000;

// raw drivers, before any DSP
const TWEETER = [highpass(950, 1.1, FS), peaking(4000, 2, 1, FS), peaking(14000, 5, 5, FS)];
const TWEETER_LEVEL_DB = 4; // more sensitive than the mid, so level matching has work to do
const TWEETER_LEAD_MM = 15; // acoustic centre ahead of the mid
const MID = [highpass(45, 0.8, FS), highpass(45, 0.55, FS), lowShelf(450, -5, 0.7, FS), peaking(5500, 5, 3, FS), lowpass(7000, 0.7, FS)];
// the room at the listening position: a mode, a narrow cancellation and a broad bump
const ROOM = [
  { f: 110, gain: 5, q: 4 },
  { f: 230, gain: -9, q: 9 },
  { f: 900, gain: 2.5, q: 2 },
];
// nearfield on the mid cone: the passive radiators take over at fb and the cone nearly stops
const FB = 42;
const NEARFIELD = [highpass(25, 0.7, FS), peaking(FB, -18, 4, FS)];

/**
 * @typedef {{ position?: 'listening' | 'nearfield', mute?: { tweeter?: boolean, mid?: boolean },
 *   volume?: number, noiseDb?: number, seed?: number, positionOffset?: number }} SimOptions
 */

/**
 * Response of the two-way speaker with the given DSP settings (fork crossover: keys).
 * @param {import('../dsp/chain.js').CrossoverSettings} settings
 * @param {SimOptions} [options]
 * @returns {{ freqs: number[], db: number[] }} absolute dB, pink slope already removed
 */
export function simulateTwoWay(settings, { position = 'listening', mute = {}, volume = 0.3, noiseDb = 0.3, seed = 1, positionOffset = 0 } = {}) {
  const freqs = Array.from(STORE_GRID);
  const rand = prng(seed);
  const level = 20 * Math.log10(Math.max(volume, 1e-4)) - 30;
  const tweeterChain = driverCascade(settings, 'tweeter');
  const midChain = driverCascade(settings, 'mid');
  const fsChain = settings.dsp_sample_rate ?? FS;

  const db = freqs.map((f) => {
    if (position === 'nearfield') {
      const h = mute.mid ? { re: 0, im: 0 } : mul(cascadeResponse(MID.slice(0, 1), f, FS), cascadeResponse(NEARFIELD, f, FS), cascadeResponse(midChain, f, fsChain));
      return 20 * Math.log10(Math.hypot(h.re, h.im) + 1e-9) + level + 20;
    }
    let re = 0;
    let im = 0;
    if (!mute.tweeter) {
      const h = mul(cascadeResponse(TWEETER, f, FS), cascadeResponse(tweeterChain, f, fsChain));
      const g = Math.pow(10, TWEETER_LEVEL_DB / 20);
      re += h.re * g;
      im += h.im * g;
    }
    if (!mute.mid) {
      const h = mul(cascadeResponse(MID, f, FS), cascadeResponse(midChain, f, fsChain));
      // the mid is TWEETER_LEAD_MM further away: extra phase lag
      const phi = (-2 * Math.PI * f * TWEETER_LEAD_MM) / SPEED_MM_PER_S;
      re += h.re * Math.cos(phi) - h.im * Math.sin(phi);
      im += h.re * Math.sin(phi) + h.im * Math.cos(phi);
    }
    let out = 20 * Math.log10(Math.hypot(re, im) + 1e-9) + level;
    for (const r of ROOM) out += magnitudeDb(peaking(r.f * (1 + 0.04 * positionOffset), r.gain, r.q, FS), f, FS);
    return out + (rand() - 0.5) * 2 * noiseDb;
  });
  return { freqs, db };
}

/**
 * A single full-range driver with PEQ, for the generic profile.
 * @param {Array<{ f: number, gain: number, q: number, type?: any }>} peq @param {SimOptions} [options]
 */
export function simulateSingle(peq, { volume = 0.3, noiseDb = 0.3, seed = 1, positionOffset = 0 } = {}) {
  const freqs = Array.from(STORE_GRID);
  const rand = prng(seed);
  const base = responseDb(
    [
      { f: 120, gain: 4, q: 3 },
      { f: 230, gain: -9, q: 9 },
      { f: 2500, gain: 4, q: 2 },
      { f: 9000, gain: -4, q: 1.5 },
    ].map((r) => ({ ...r, f: r.f * (1 + 0.04 * positionOffset) })),
    freqs,
    FS,
  );
  const eq = responseDb(peq, freqs, FS);
  const roll = freqs.map((f) => magnitudeDb(highpass(70, 0.7, FS), f, FS));
  const level = 20 * Math.log10(Math.max(volume, 1e-4)) - 30;
  return { freqs, db: freqs.map((_, i) => base[i] + eq[i] + roll[i] + level + (rand() - 0.5) * 2 * noiseDb) };
}

/** Background noise of the simulated room, dB on the store grid. */
export function simulatedBackground() {
  return { freqs: Array.from(STORE_GRID), db: Array.from(STORE_GRID, (f) => -75 + 15 * Math.exp(-f / 60)) };
}

/** @param {...{ re: number, im: number }} hs */
function mul(...hs) {
  let re = 1;
  let im = 0;
  for (const h of hs) {
    const r = re * h.re - im * h.im;
    im = re * h.im + im * h.re;
    re = r;
  }
  return { re, im };
}

export const SIMULATED_FB = FB;
