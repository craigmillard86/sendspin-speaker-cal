// @ts-check
// Find where the test noise starts in a recording, so playback latency doesn't matter.

/**
 * RMS level in dBFS of consecutive blocks.
 * @param {ArrayLike<number>} samples @param {number} blockSize
 */
export function blockLevelsDb(samples, blockSize) {
  const blocks = Math.floor(samples.length / blockSize);
  const out = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let s = 0;
    for (let i = b * blockSize; i < (b + 1) * blockSize; i++) s += samples[i] * samples[i];
    out[b] = 10 * Math.log10(s / blockSize + 1e-20);
  }
  return out;
}

/**
 * @param {ArrayLike<number>} samples
 * @param {number} fs
 * @param {{ backgroundSeconds?: number, riseDb?: number, blockSeconds?: number, timeoutSeconds?: number }} [options]
 *   backgroundSeconds: the recording starts this long before playback is requested; that part is the room background
 *   timeoutSeconds: give up if nothing starts within this long after the background
 * @returns {{ onsetSample: number, backgroundDb: number } | null}
 */
export function detectOnset(samples, fs, { backgroundSeconds = 2, riseDb = 10, blockSeconds = 0.05, timeoutSeconds = 8 } = {}) {
  const blockSize = Math.max(1, Math.round(fs * blockSeconds));
  const levels = blockLevelsDb(samples, blockSize);
  const bgBlocks = Math.max(1, Math.floor(backgroundSeconds / blockSeconds) - 1);
  const background = [...levels.subarray(0, Math.min(bgBlocks, levels.length))].sort((a, b) => a - b);
  const backgroundDb = background[background.length >> 1] ?? -120;
  const last = Math.min(levels.length, bgBlocks + Math.ceil(timeoutSeconds / blockSeconds));
  // two blocks in a row above the threshold, so a click doesn't count
  for (let b = bgBlocks; b < last - 1; b++) {
    if (levels[b] > backgroundDb + riseDb && levels[b + 1] > backgroundDb + riseDb) {
      return { onsetSample: b * blockSize, backgroundDb };
    }
  }
  return null;
}

/**
 * Peak and RMS level in dBFS, for clip detection and auto-level.
 * @param {ArrayLike<number>} samples
 */
export function levels(samples) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sum += a * a;
  }
  return {
    peakDbfs: 20 * Math.log10(peak + 1e-12),
    rmsDbfs: 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-20),
  };
}
