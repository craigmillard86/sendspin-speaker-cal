// @ts-check
// Recording to frequency response: Welch spectrum, 1/48 octave storage grid,
// pink slope removed, mic calibration applied. Views at 1/24 (chart) and 1/12 (fit).

import { welch, averageSpectra } from './welch.js';
import { logGrid, smoothPowerDb, smoothDb, levelAt1k } from './smoothing.js';
import { removePinkSlope } from './pink.js';
import { applyCalibration } from './calfile.js';

export const STORE_FRACTION = 48;
export const CHART_FRACTION = 24;
export const FIT_FRACTION = 12;

/** The grid every stored measurement uses: 1/48 octave, 20 Hz to 20 kHz. */
export const STORE_GRID = logGrid(20, 20000, STORE_FRACTION);

/**
 * @typedef {{ freqs: number[], db: number[] }} Curve
 *   db is absolute: dB re full scale per Hz with the pink slope removed, so curves taken
 *   at the same volume in one session can be compared (driver levels, before/after)
 */

/**
 * Spectrum of a slice of a recording.
 * @param {ArrayLike<number>} samples @param {number} fs @param {number} start @param {number} length
 */
export function spectrumOf(samples, fs, start, length) {
  const slice = Array.prototype.slice.call(samples, start, start + length);
  return welch(slice, fs, { nfft: 8192, overlap: 0.5 });
}

/**
 * @param {import('./welch.js').Spectrum} spectrum
 * @param {{ freqs: ArrayLike<number>, db: ArrayLike<number> } | null} [cal]
 * @param {boolean} [pink] remove the pink slope (false for a background-noise spectrum compared raw)
 * @returns {Curve}
 */
export function curveFromSpectrum(spectrum, cal = null, pink = true) {
  let db = smoothPowerDb(spectrum.freqs, spectrum.power, STORE_FRACTION, STORE_GRID);
  if (pink) db = removePinkSlope(STORE_GRID, db);
  if (cal) db = applyCalibration(STORE_GRID, db, cal);
  return { freqs: Array.from(STORE_GRID), db: Array.from(db) };
}

/**
 * Analyse one recording: skip `skipSeconds` after the onset, use the next `seconds`.
 * The background before playback is analysed too, for SNR.
 * @param {ArrayLike<number>} samples
 * @param {number} fs
 * @param {{ onsetSample: number, skipSeconds?: number, seconds?: number, backgroundEnd?: number,
 *   cal?: { freqs: ArrayLike<number>, db: ArrayLike<number> } | null }} options
 */
export function analyseRecording(samples, fs, { onsetSample, skipSeconds = 2, seconds = 10, backgroundEnd, cal = null }) {
  const start = onsetSample + Math.round(skipSeconds * fs);
  const length = Math.round(seconds * fs);
  if (start + length > samples.length) {
    throw new Error(`Recording too short: need ${((start + length) / fs).toFixed(1)} s, have ${(samples.length / fs).toFixed(1)} s`);
  }
  const spectrum = spectrumOf(samples, fs, start, length);
  const curve = curveFromSpectrum(spectrum, cal);

  let background = null;
  const bgEnd = backgroundEnd ?? onsetSample;
  if (bgEnd >= 3 * 8192) {
    const bg = spectrumOf(samples, fs, 0, bgEnd);
    background = curveFromSpectrum(bg, cal);
  }
  return { curve, spectrum, background };
}

/**
 * Power-average several positions' spectra into one curve.
 * @param {import('./welch.js').Spectrum[]} spectra
 * @param {{ freqs: ArrayLike<number>, db: ArrayLike<number> } | null} [cal]
 */
export function averagePositions(spectra, cal = null) {
  return curveFromSpectrum(averageSpectra(spectra), cal);
}

/**
 * A curve shifted so it reads 0 dB at 1 kHz, or by a given reference.
 * @param {Curve} curve @param {number} [referenceDb]
 */
export function normalised(curve, referenceDb) {
  const ref = referenceDb ?? levelAt1k(curve.freqs, curve.db);
  return { freqs: curve.freqs, db: curve.db.map((d) => d - ref) };
}

/**
 * Smoothed view of a stored curve: 1/fraction octave smoothing, sampled at
 * pointsPerOctave (the fit smooths at 1/12 but samples at 1/24 for finer centre frequencies).
 * @param {Curve} curve @param {number} fraction @param {number} [pointsPerOctave]
 */
export function view(curve, fraction, pointsPerOctave = fraction) {
  const grid = logGrid(20, 20000, pointsPerOctave);
  return { freqs: Array.from(grid), db: Array.from(smoothDb(curve.freqs, curve.db, fraction, grid)) };
}
