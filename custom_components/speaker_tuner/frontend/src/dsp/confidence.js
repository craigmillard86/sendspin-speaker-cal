// @ts-check
// How much to trust each point of a measurement: signal to background noise, and how much
// the mic positions of a moving-mic measurement disagree.

export const MIN_SNR_DB = 10;
export const MAX_SPREAD_DB = 6;

/**
 * @param {ArrayLike<number>} signalDb smoothed level with the noise playing
 * @param {ArrayLike<number>} noiseDb smoothed background level, same grid and scale
 */
export function snrDb(signalDb, noiseDb) {
  const out = new Float64Array(signalDb.length);
  for (let i = 0; i < out.length; i++) out[i] = signalDb[i] - noiseDb[i];
  return out;
}

/**
 * Largest minus smallest level across positions at each frequency.
 * @param {ArrayLike<number>[]} positionsDb
 */
export function positionSpreadDb(positionsDb) {
  const n = positionsDb[0]?.length ?? 0;
  const out = new Float64Array(n);
  if (positionsDb.length < 2) return out;
  for (let i = 0; i < n; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of positionsDb) {
      lo = Math.min(lo, p[i]);
      hi = Math.max(hi, p[i]);
    }
    out[i] = hi - lo;
  }
  return out;
}

/**
 * Points to leave out of the fit and shade on the chart.
 * @param {{ snr?: ArrayLike<number>, spread?: ArrayLike<number>, minSnrDb?: number, maxSpreadDb?: number }} m
 * @returns {boolean[]} true = low confidence
 */
export function lowConfidenceMask({ snr, spread, minSnrDb = MIN_SNR_DB, maxSpreadDb = MAX_SPREAD_DB }) {
  const n = snr?.length ?? spread?.length ?? 0;
  const out = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (snr && snr[i] < minSnrDb) out[i] = true;
    if (spread && spread[i] > maxSpreadDb) out[i] = true;
  }
  return out;
}
