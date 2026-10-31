// @ts-check
// Log frequency grids, fractional-octave smoothing and log-frequency interpolation.

/**
 * Log-spaced frequencies from fMin to fMax inclusive.
 * @param {number} fMin
 * @param {number} fMax
 * @param {number} pointsPerOctave
 */
export function logGrid(fMin = 20, fMax = 20000, pointsPerOctave = 48) {
  const octaves = Math.log2(fMax / fMin);
  const n = Math.round(octaves * pointsPerOctave) + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fMin * Math.pow(2, i / pointsPerOctave);
  out[n - 1] = fMax;
  return out;
}

/**
 * Linear interpolation in log frequency, holding the end values outside the data.
 * @param {ArrayLike<number>} xs ascending frequencies
 * @param {ArrayLike<number>} ys values at xs
 * @param {number} x
 */
export function interpLogF(xs, ys, x) {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = Math.log(x / xs[lo]) / Math.log(xs[hi] / xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/**
 * Resample a curve onto new frequencies (log-f interpolation).
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} ys
 * @param {ArrayLike<number>} grid
 */
export function resample(xs, ys, grid) {
  const out = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = interpLogF(xs, ys, grid[i]);
  return out;
}

/**
 * Fractional-octave smoothing of a linear power spectrum, returned in dB on a grid.
 * Each grid point is the mean power of the FFT bins within +-1/(2N) octave.
 * Where a band holds no bins (low frequencies) the spectrum is interpolated instead.
 * @param {ArrayLike<number>} freqs FFT bin frequencies, ascending
 * @param {ArrayLike<number>} power linear power per bin
 * @param {number} fraction N in 1/N octave
 * @param {ArrayLike<number>} grid output frequencies
 * @returns {Float64Array} dB
 */
export function smoothPowerDb(freqs, power, fraction, grid) {
  const half = Math.pow(2, 1 / (2 * fraction));
  const out = new Float64Array(grid.length);
  // prefix sums make every band an O(log n) lookup
  const prefix = new Float64Array(power.length + 1);
  for (let k = 0; k < power.length; k++) prefix[k + 1] = prefix[k] + power[k];
  const lowerBound = (/** @type {number} */ f) => {
    let lo = 0;
    let hi = freqs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (freqs[mid] < f) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let i = 0; i < grid.length; i++) {
    const fc = grid[i];
    const a = lowerBound(fc / half);
    const b = lowerBound(fc * half); // exclusive
    let p;
    if (b - a >= 2) {
      p = (prefix[b] - prefix[a]) / (b - a);
    } else {
      p = Math.max(interpLogF(freqs, power, fc), 1e-30);
    }
    out[i] = 10 * Math.log10(Math.max(p, 1e-30));
  }
  return out;
}

/**
 * Fractional-octave smoothing of a curve that is already in dB on some grid.
 * Smooths in the power domain so peaks and dips are treated like the analyser does.
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} db
 * @param {number} fraction
 * @param {ArrayLike<number>} grid
 */
export function smoothDb(xs, db, fraction, grid) {
  const power = new Float64Array(db.length);
  for (let i = 0; i < db.length; i++) power[i] = Math.pow(10, db[i] / 10);
  return smoothPowerDb(xs, power, fraction, grid);
}

/**
 * dB value at 1 kHz by log interpolation, used to normalise curves.
 * @param {ArrayLike<number>} xs
 * @param {ArrayLike<number>} db
 */
export function levelAt1k(xs, db) {
  return interpLogF(xs, db, 1000);
}
