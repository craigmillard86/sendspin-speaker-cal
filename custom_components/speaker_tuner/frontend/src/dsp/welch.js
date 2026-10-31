// @ts-check
// Averaged power spectrum (Welch's method) with a Hann window.

import { fft } from './fft.js';

/**
 * @typedef {{ freqs: Float64Array, power: Float64Array, segments: number }} Spectrum
 * power is a one-sided power spectral density in (full scale)^2 per Hz
 */

/** @param {number} n */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * @param {ArrayLike<number>} samples
 * @param {number} fs sample rate in Hz
 * @param {{ nfft?: number, overlap?: number }} [options]
 * @returns {Spectrum}
 */
export function welch(samples, fs, { nfft = 8192, overlap = 0.5 } = {}) {
  if (samples.length < nfft) throw new Error(`welch: need at least ${nfft} samples, got ${samples.length}`);
  const window = hann(nfft);
  let windowPower = 0;
  for (let i = 0; i < nfft; i++) windowPower += window[i] * window[i];

  const hop = Math.max(1, Math.round(nfft * (1 - overlap)));
  const bins = nfft / 2 + 1;
  const power = new Float64Array(bins);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  let segments = 0;

  for (let start = 0; start + nfft <= samples.length; start += hop) {
    for (let i = 0; i < nfft; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    segments++;
  }

  const scale = 1 / (fs * windowPower * segments);
  const freqs = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    // one-sided: double everything except DC and Nyquist
    power[k] *= scale * (k === 0 || k === bins - 1 ? 1 : 2);
    freqs[k] = (k * fs) / nfft;
  }
  return { freqs, power, segments };
}

/**
 * Power-average several spectra with the same bins (moving-mic positions).
 * @param {Spectrum[]} spectra
 * @returns {Spectrum}
 */
export function averageSpectra(spectra) {
  if (!spectra.length) throw new Error('averageSpectra: nothing to average');
  const power = new Float64Array(spectra[0].power.length);
  for (const s of spectra) {
    if (s.power.length !== power.length) throw new Error('averageSpectra: bin counts differ');
    for (let k = 0; k < power.length; k++) power[k] += s.power[k] / spectra.length;
  }
  return { freqs: spectra[0].freqs, power, segments: spectra.reduce((n, s) => n + s.segments, 0) };
}
