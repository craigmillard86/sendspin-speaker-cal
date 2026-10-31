// @ts-check
// Pink noise test signal and the matching -3 dB/octave slope correction.

import { fft, nextPowerOfTwo } from './fft.js';

/**
 * Small seeded PRNG (mulberry32) so the test file is reproducible.
 * @param {number} seed
 */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {() => number} rand */
function gaussian(rand) {
  // Box-Muller
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Pink noise made in the frequency domain: Gaussian spectrum with power falling 1/f,
 * band limited to fLow..fHigh so drivers never see DC or ultrasonics.
 * Returned at the requested RMS level in dBFS.
 * @param {number} length samples
 * @param {number} fs
 * @param {{ seed?: number, fLow?: number, fHigh?: number, rmsDbfs?: number }} [options]
 */
export function pinkNoise(length, fs, { seed = 1, fLow = 15, fHigh = 20000, rmsDbfs = -18 } = {}) {
  const n = nextPowerOfTwo(length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const rand = prng(seed);
  for (let k = 1; k < n / 2; k++) {
    const f = (k * fs) / n;
    if (f < fLow || f > fHigh) continue;
    const amp = 1 / Math.sqrt(f);
    re[k] = gaussian(rand) * amp;
    im[k] = gaussian(rand) * amp;
    // Hermitian symmetry for a real signal
    re[n - k] = re[k];
    im[n - k] = -im[k];
  }
  fft(re, im, true);

  const out = new Float32Array(length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += re[i] * re[i];
  const rms = Math.sqrt(sum / length) || 1;
  const gain = Math.pow(10, rmsDbfs / 20) / rms;
  for (let i = 0; i < length; i++) {
    // soft limit the rare peaks rather than clipping hard
    const x = re[i] * gain;
    out[i] = Math.abs(x) < 0.9 ? x : Math.sign(x) * (0.9 + 0.1 * Math.tanh((Math.abs(x) - 0.9) / 0.1));
  }
  return out;
}

/**
 * Raised-cosine fade in and out, in place.
 * @param {Float32Array} samples
 * @param {number} fs
 * @param {number} seconds
 */
export function applyFades(samples, fs, seconds = 1) {
  const n = Math.min(Math.round(fs * seconds), Math.floor(samples.length / 2));
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    samples[i] *= g;
    samples[samples.length - 1 - i] *= g;
  }
  return samples;
}

/**
 * The test file: 20 s of pink noise with 1 s fades.
 * @param {{ seconds?: number, fs?: number, seed?: number }} [options]
 */
export function testSignal({ seconds = 20, fs = 48000, seed = 1 } = {}) {
  return applyFades(pinkNoise(Math.round(seconds * fs), fs, { seed }), fs, 1);
}

/**
 * Remove the pink slope from a measured curve: pink noise falls 3 dB per octave,
 * so add 10*log10(f / 1 kHz) (about +3.01 dB per octave, 0 dB at 1 kHz).
 * @param {ArrayLike<number>} freqs
 * @param {ArrayLike<number>} db
 */
export function removePinkSlope(freqs, db) {
  const out = new Float64Array(db.length);
  for (let i = 0; i < db.length; i++) out[i] = db[i] + 10 * Math.log10(freqs[i] / 1000);
  return out;
}
