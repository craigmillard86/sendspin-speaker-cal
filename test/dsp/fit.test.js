import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPeq, tierRules, twoWayBanks } from '../../custom_components/speaker_tuner/frontend/src/dsp/fit.js';
import { responseDb } from '../../custom_components/speaker_tuner/frontend/src/dsp/biquad.js';
import { logGrid } from '../../custom_components/speaker_tuner/frontend/src/dsp/smoothing.js';
import { highpass2Db } from '../../custom_components/speaker_tuner/frontend/src/dsp/lowend.js';
import { effectiveBoostFloor } from '../../custom_components/speaker_tuner/frontend/src/measure/peq.js';

const FS = 96000;
const freqs = logGrid(20, 20000, 24);
const flat = new Float64Array(freqs.length);
const ranges = {
  frequency: { min: 20, max: 20000, step: 1 },
  gain: { min: -15, max: 15, step: 0.5 },
  q: { min: 0.1, max: 10, step: 0.05 },
};
const oneBank = [{ id: 'peq', maxFilters: 6, fLo: 0, fHi: Infinity }];

const strongest = (filters, k) => [...filters].sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain)).slice(0, k).sort((a, b) => a.f - b.f);

test('recovers two peaks on a flat response within 5% in frequency and 1 dB in gain', () => {
  const peaks = [
    { f: 300, gain: 6, q: 3 },
    { f: 3000, gain: 5, q: 2 },
  ];
  const measured = responseDb(peaks, freqs, FS);
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('calibrated'), banks: oneBank, ranges });

  const found = strongest(result.filters, 2);
  assert.equal(found.length, 2);
  for (let k = 0; k < 2; k++) {
    assert.ok(Math.abs(found[k].f - peaks[k].f) / peaks[k].f < 0.05, `filter ${k} at ${found[k].f} Hz, want ${peaks[k].f}`);
    assert.ok(Math.abs(found[k].gain + peaks[k].gain) <= 1, `filter ${k} gain ${found[k].gain}, want ${-peaks[k].gain}`);
  }
  assert.ok(result.rmsAfter < 0.5, `rms after ${result.rmsAfter}`);
  assert.ok(result.rmsAfter < result.rmsBefore);
});

test('quantises to entity steps and stays inside the tier gain limits', () => {
  const measured = responseDb([{ f: 1000, gain: -9, q: 1 }, { f: 5000, gain: 15, q: 2 }], freqs, FS);
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('calibrated'), banks: oneBank, ranges });
  for (const f of result.filters) {
    assert.ok(f.gain >= -12 && f.gain <= 6, `gain ${f.gain}`);
    assert.equal(Math.round(f.gain * 2), f.gain * 2, 'gain on 0.5 dB steps');
    assert.ok(Math.abs(f.q / 0.05 - Math.round(f.q / 0.05)) < 1e-6, `q ${f.q} on 0.05 steps`);
    assert.equal(Math.round(f.f), f.f, 'whole Hz');
  }
  // a +6 dB limit means the -9 dB hole at 1 kHz can only be part filled
  const boosts = result.filters.filter((f) => f.gain > 0);
  assert.ok(boosts.every((f) => f.gain <= 6));
});

test('unknown tier: cuts only, and only deviations over 3 dB', () => {
  const measured = responseDb([{ f: 1000, gain: 2.5, q: 2 }, { f: 3000, gain: 6, q: 2 }, { f: 600, gain: -6, q: 2 }], freqs, FS);
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('unknown'), banks: oneBank, ranges });
  assert.ok(result.filters.length >= 1);
  assert.ok(result.filters.every((f) => f.gain < 0), 'only cuts');
  assert.ok(result.filters.every((f) => f.f >= 300 && f.f <= 8000), 'inside 300 Hz to 8 kHz');
  assert.ok(result.filters.some((f) => Math.abs(f.f - 3000) / 3000 < 0.05), 'the 6 dB peak is cut');
  assert.ok(!result.filters.some((f) => Math.abs(f.f - 1000) / 1000 < 0.1), 'the 2.5 dB peak is left alone');
});

test('never boosts a narrow null', () => {
  const measured = responseDb([{ f: 800, gain: -12, q: 9.5 }], freqs, FS);
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('calibrated'), banks: oneBank, ranges });
  assert.ok(!result.filters.some((f) => f.gain > 0 && f.q > 8), 'no high-Q boost');
  assert.ok(result.rejected.some((r) => Math.abs(r.f - 800) / 800 < 0.1));
});

test('two-way banks: filters go to the driver that plays there, nothing near the crossover', () => {
  const xo = 2500;
  const { banks, exclude } = twoWayBanks(xo, 6, 6);
  const measured = responseDb([{ f: 400, gain: 5, q: 2 }, { f: 2600, gain: 5, q: 3 }, { f: 9000, gain: 5, q: 2 }], freqs, FS);
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('calibrated'), banks, exclude, ranges });
  for (const f of result.filters) {
    assert.equal(f.bank, f.f < xo ? 'mid' : 'tweeter');
    assert.ok(f.f < xo / Math.cbrt(2) || f.f > xo * Math.cbrt(2), `filter at ${f.f} Hz is inside the crossover exclusion`);
  }
  assert.ok(result.filters.some((f) => f.bank === 'mid' && Math.abs(f.f - 400) / 400 < 0.05));
  assert.ok(result.filters.some((f) => f.bank === 'tweeter' && Math.abs(f.f - 9000) / 9000 < 0.05));
});

test('respects the bass boost floor', () => {
  const measured = responseDb([{ f: 70, gain: -6, q: 1.5 }, { f: 200, gain: -6, q: 1.5 }], freqs, FS);
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('calibrated'), banks: oneBank, ranges, boostFloorHz: 130 });
  assert.ok(result.filters.filter((f) => f.gain > 0).every((f) => f.f >= 130));
  assert.ok(result.filters.some((f) => f.gain > 0 && Math.abs(f.f - 200) / 200 < 0.1));
  assert.ok(result.filters.every((f) => f.f >= 130), 'no filters spent below the floor fighting boost spill');
});

test('stays within the bank sizes', () => {
  const peaks = [150, 300, 600, 1200, 2400, 4800, 9600].map((f) => ({ f, gain: 4, q: 4 }));
  const measured = responseDb(peaks, freqs, FS);
  const banks = [{ id: 'peq', maxFilters: 3, fLo: 0, fHi: Infinity }];
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('calibrated'), banks, ranges });
  assert.ok(result.filters.length <= 3);
});

test('a deep narrow null is left alone even when the boost limit would make a wider filter fit', () => {
  // -12 dB at Q 9: with boosts capped at +6 dB the best capped fit is a wider filter
  const measured = responseDb([{ f: 800, gain: -12, q: 9 }], freqs, FS);
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('calibrated'), banks: oneBank, ranges });
  const near = result.filters.filter((f) => f.gain > 0 && Math.abs(Math.log2(f.f / 800)) < 1 / 6);
  assert.deepEqual(near, [], 'no boost near the null');
  assert.equal(result.rejected.length, 1);
});

const totalBoost = (result, lo, hi) => {
  let worst = -Infinity;
  result.filterDb.forEach((d, i) => { if (freqs[i] >= lo && freqs[i] <= hi) worst = Math.max(worst, d); });
  return worst;
};

test('boosts do not stack past the tier limit on a wide dip', () => {
  const measured = responseDb([{ f: 300, gain: -15, q: 1.5 }], freqs, FS);
  for (const tier of ['uncalibrated', 'calibrated']) {
    const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules(tier), banks: oneBank, ranges });
    const limit = tierRules(tier).gainMax;
    assert.ok(totalBoost(result, 20, 20000) <= limit + 0.05, `${tier}: total boost ${totalBoost(result, 20, 20000).toFixed(1)} dB, limit ${limit}`);
  }
});

test('boosts placed before a null is recognised are taken out again', () => {
  const measured = responseDb([{ f: 5000, gain: -12, q: 3 }], freqs, FS);
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('uncalibrated'), banks: oneBank, ranges });
  assert.ok(totalBoost(result, 4000, 6000) <= 3.05, `boost into the 5 kHz dip: ${totalBoost(result, 4000, 6000).toFixed(1)} dB`);
});

test('no bass boost at the bottom of the range without a known tuning frequency', () => {
  // a sealed box rolling off at 90 Hz: the fit must not chase the roll-off
  const measured = freqs.map((f) => highpass2Db(f, 90, 0.7));
  const result = fitPeq({ freqs, measuredDb: measured, targetDb: flat, fs: FS, rules: tierRules('calibrated'), banks: oneBank, ranges, boostFloorHz: effectiveBoostFloor(0, 60) });
  assert.ok(totalBoost(result, 20, 60) <= 1.5, `lift below 60 Hz: ${totalBoost(result, 20, 60).toFixed(1)} dB`);
  assert.ok(result.filters.filter((f) => f.gain > 0).every((f) => f.f >= 60 * Math.SQRT2));
});
