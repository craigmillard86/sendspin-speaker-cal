// @ts-check
// Figures of merit: deviation from target, crossover dip, flatness and driver levels.

/**
 * @param {number[]} values
 */
export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Indices of freqs inside [fMin, fMax].
 * @param {ArrayLike<number>} freqs @param {number} fMin @param {number} fMax
 */
export function indicesInRange(freqs, fMin, fMax) {
  const out = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i] >= fMin && freqs[i] <= fMax) out.push(i);
  return out;
}

/**
 * Offset that best lines a curve up with the target over a range. The median is used so
 * a few big peaks don't shift the whole curve.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} measured @param {ArrayLike<number>} target
 * @param {number} fMin @param {number} fMax @param {ArrayLike<boolean>} [mask] true = ignore that point
 */
export function alignmentOffset(freqs, measured, target, fMin, fMax, mask) {
  const diffs = indicesInRange(freqs, fMin, fMax)
    .filter((i) => !mask?.[i])
    .map((i) => measured[i] - target[i]);
  return median(diffs);
}

/**
 * RMS deviation from target over a range, after median alignment.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} measured @param {ArrayLike<number>} target
 * @param {number} fMin @param {number} fMax @param {ArrayLike<boolean>} [mask]
 */
export function rmsDeviation(freqs, measured, target, fMin, fMax, mask) {
  const offset = alignmentOffset(freqs, measured, target, fMin, fMax, mask);
  const idx = indicesInRange(freqs, fMin, fMax).filter((i) => !mask?.[i]);
  if (!idx.length) return 0;
  let sum = 0;
  for (const i of idx) {
    const d = measured[i] - offset - target[i];
    sum += d * d;
  }
  return Math.sqrt(sum / idx.length);
}

/**
 * Mean dB over a range.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} db @param {number} fMin @param {number} fMax
 */
export function meanDb(freqs, db, fMin, fMax) {
  const idx = indicesInRange(freqs, fMin, fMax);
  if (!idx.length) return NaN;
  return idx.reduce((s, i) => s + db[i], 0) / idx.length;
}

/**
 * Standard deviation of a curve over a range: lower is flatter.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} db @param {number} fMin @param {number} fMax
 */
export function flatness(freqs, db, fMin, fMax) {
  const idx = indicesInRange(freqs, fMin, fMax);
  if (idx.length < 2) return 0;
  const mean = idx.reduce((s, i) => s + db[i], 0) / idx.length;
  return Math.sqrt(idx.reduce((s, i) => s + (db[i] - mean) ** 2, 0) / idx.length);
}

/**
 * Depth of a dip around the crossover in a summed response: the level of the shoulders
 * (1/2 to 1 octave either side) minus the lowest point within 1/3 octave of the crossover.
 * Positive means a dip.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} db @param {number} crossoverHz
 */
export function crossoverDip(freqs, db, crossoverHz) {
  const below = meanDb(freqs, db, crossoverHz / 2, crossoverHz / Math.SQRT2);
  const above = meanDb(freqs, db, crossoverHz * Math.SQRT2, crossoverHz * 2);
  const shoulder = (below + above) / 2;
  const idx = indicesInRange(freqs, crossoverHz / Math.pow(2, 1 / 3), crossoverHz * Math.pow(2, 1 / 3));
  if (!idx.length || !Number.isFinite(shoulder)) return 0;
  const lowest = Math.min(...idx.map((i) => db[i]));
  return shoulder - lowest;
}

/**
 * Flatness score of a summed response through the crossover region (+-1 octave).
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} db @param {number} crossoverHz
 */
export function crossoverFlatness(freqs, db, crossoverHz) {
  return flatness(freqs, db, crossoverHz / 2, crossoverHz * 2);
}

/**
 * Level difference between the drivers, each measured alone, in the band where each one
 * plays on its own (1/2 to 1.5 octaves from the crossover).
 * Returns tweeter minus mid in dB and the gain changes that match them by cutting the louder.
 * @param {ArrayLike<number>} freqs @param {ArrayLike<number>} tweeterDb @param {ArrayLike<number>} midDb
 * @param {number} crossoverHz
 */
export function driverLevelMatch(freqs, tweeterDb, midDb, crossoverHz) {
  const tweeter = meanDb(freqs, tweeterDb, crossoverHz * Math.SQRT2, crossoverHz * Math.pow(2, 1.5));
  const mid = meanDb(freqs, midDb, crossoverHz / Math.pow(2, 1.5), crossoverHz / Math.SQRT2);
  const difference = tweeter - mid;
  return {
    differenceDb: difference,
    tweeterChangeDb: difference > 0 ? -difference : 0,
    midChangeDb: difference < 0 ? difference : 0,
  };
}
