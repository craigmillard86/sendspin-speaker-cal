import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peaking, highShelf, magnitudeDb, responseDb, filterSamples } from '../../custom_components/speaker_tuner/frontend/src/dsp/biquad.js';
import { pinkNoise } from '../../custom_components/speaker_tuner/frontend/src/dsp/pink.js';
import { analyseRecording, normalised, view } from '../../custom_components/speaker_tuner/frontend/src/dsp/analyse.js';
import { detectOnset } from '../../custom_components/speaker_tuner/frontend/src/dsp/onset.js';
import { interpLogF } from '../../custom_components/speaker_tuner/frontend/src/dsp/smoothing.js';
import { fitGraphic, TAS58XX_15_BANDS } from '../../custom_components/speaker_tuner/frontend/src/dsp/graphic-fit.js';
import { tierRules } from '../../custom_components/speaker_tuner/frontend/src/dsp/fit.js';
import { logGrid } from '../../custom_components/speaker_tuner/frontend/src/dsp/smoothing.js';
import { crossoverDip, driverLevelMatch, rmsDeviation } from '../../custom_components/speaker_tuner/frontend/src/dsp/metrics.js';
import { fitSealedRolloff, findTuningFrequency, highpass2Db, suggestSubsonic, linkwitzBoostDb, f3Of } from '../../custom_components/speaker_tuner/frontend/src/dsp/lowend.js';
import { detectBreakupPeak, suggestAirGain, baffleStepHz } from '../../custom_components/speaker_tuner/frontend/src/dsp/compensation.js';
import { snrDb, positionSpreadDb, lowConfidenceMask } from '../../custom_components/speaker_tuner/frontend/src/dsp/confidence.js';
import { targetDb, tilt, FLAT } from '../../custom_components/speaker_tuner/frontend/src/dsp/target.js';

test('peaking biquad reaches its gain at the centre and is flat far away', () => {
  const c = peaking(1000, 6, 2, 96000);
  assert.ok(Math.abs(magnitudeDb(c, 1000, 96000) - 6) < 1e-6);
  assert.ok(Math.abs(magnitudeDb(c, 20, 96000)) < 0.05);
  const hs = highShelf(10000, 4, 0.707, 96000);
  assert.ok(Math.abs(magnitudeDb(hs, 30000, 96000) - 4) < 0.3);
});

test('recording to response: a known filter on pink noise is measured back within 1 dB', () => {
  const fs = 48000;
  const background = 2 * fs;
  const noise = pinkNoise(16 * fs, fs, { seed: 11 });
  const speaker = [peaking(500, 6, 2, fs), peaking(4000, -6, 3, fs)];
  const played = filterSamples(speaker, noise);
  const recording = new Float64Array(background + Math.round(0.37 * fs) + played.length);
  // quiet room noise, then playback after an unknown delay
  for (let i = 0; i < recording.length; i++) recording[i] = (Math.random() - 0.5) * 1e-4;
  recording.set(played.map((x, i) => x + recording[background + Math.round(0.37 * fs) + i]), background + Math.round(0.37 * fs));

  const onset = detectOnset(recording, fs, { backgroundSeconds: 2 });
  assert.ok(onset, 'onset found');
  assert.ok(Math.abs(onset.onsetSample - (background + 0.37 * fs)) < 0.06 * fs, `onset at ${onset.onsetSample / fs} s`);

  const { curve, background: bg } = analyseRecording(recording, fs, { onsetSample: onset.onsetSample, backgroundEnd: background });
  assert.ok(bg, 'background analysed');
  const fit = view(normalised(curve), 12, 24);
  const expected = (f) => speaker.reduce((s, c) => s + magnitudeDb(c, f, fs), 0) - speaker.reduce((s, c) => s + magnitudeDb(c, 1000, fs), 0);
  for (const f of [100, 250, 500, 1000, 2000, 4000, 8000]) {
    const got = interpLogF(fit.freqs, fit.db, f);
    assert.ok(Math.abs(got - expected(f)) < 1, `${f} Hz: measured ${got.toFixed(2)}, expected ${expected(f).toFixed(2)}`);
  }
});

test('no onset in silence', () => {
  const fs = 8000;
  const quiet = new Float64Array(12 * fs).map(() => (Math.random() - 0.5) * 1e-4);
  assert.equal(detectOnset(quiet, fs), null);
});

test('graphic EQ fit recovers band gains', () => {
  const fs = 96000;
  const freqs = logGrid(20, 20000, 24);
  const truth = [0, 0, 0, 0, 3, 0, -4, 0, 0, 5, 0, 0, -3, 0, 0];
  const measured = responseDb(TAS58XX_15_BANDS.map((b, i) => ({ f: b.f, gain: truth[i], q: b.q })), freqs, fs);
  const res = fitGraphic({ freqs, measuredDb: measured, targetDb: new Float64Array(freqs.length), fs, rules: tierRules('calibrated'), bands: TAS58XX_15_BANDS });
  TAS58XX_15_BANDS.forEach((b, i) => {
    if (b.f < 60 || b.f > 16000) return;
    assert.ok(Math.abs(res.gains[i] + truth[i]) <= 1, `${b.f} Hz: ${res.gains[i]} vs ${-truth[i]}`);
  });
  assert.ok(res.rmsAfter < res.rmsBefore);
});

test('crossover dip and driver level match', () => {
  const freqs = logGrid(20, 20000, 48);
  const sum = responseDb([{ f: 2500, gain: -8, q: 3 }], freqs, 96000);
  assert.ok(crossoverDip(freqs, sum, 2500) > 6);
  assert.ok(crossoverDip(freqs, new Float64Array(freqs.length), 2500) < 0.01);

  const tweeter = Array.from(freqs, () => 3);
  const mid = Array.from(freqs, () => 0);
  const m = driverLevelMatch(freqs, tweeter, mid, 2500);
  assert.ok(Math.abs(m.differenceDb - 3) < 1e-9);
  assert.equal(m.tweeterChangeDb, -3);
  assert.equal(m.midChangeDb, 0);
});

test('sealed box: fit recovers f0 and Q0', () => {
  const freqs = logGrid(15, 2000, 48);
  const db = Array.from(freqs, (f) => highpass2Db(f, 55, 0.8) + 4);
  const r = fitSealedRolloff(freqs, db);
  assert.ok(Math.abs(r.f0 - 55) / 55 < 0.02, `f0 ${r.f0}`);
  assert.ok(Math.abs(r.q0 - 0.8) < 0.03, `q0 ${r.q0}`);
  assert.ok(f3Of(55, 0.707) > 54 && f3Of(55, 0.707) < 56, 'Butterworth f3 equals f0');
  assert.ok(Math.abs(linkwitzBoostDb(80, 50) - 8.16) < 0.05, 'README example: 80 Hz to 50 Hz is +8.2 dB');
});

test('passive radiator: tuning frequency from the nearfield cone dip', () => {
  const freqs = logGrid(15, 2000, 48);
  const db = Array.from(responseDb([{ f: 42, gain: -18, q: 4 }], freqs, 96000));
  const r = findTuningFrequency(freqs, db);
  assert.ok(r && Math.abs(r.fb - 42) / 42 < 0.03, `fb ${r?.fb}`);
  assert.equal(suggestSubsonic({ fb: r.fb }), Math.round(0.8 * r.fb));
  assert.equal(suggestSubsonic({ fb: 200 }), 100, 'clamped to 100 Hz');
  assert.equal(findTuningFrequency(freqs, Array.from(freqs, () => 0)), null);
});

test('tweeter breakup peak and air shelf suggestions', () => {
  const freqs = logGrid(20, 20000, 48);
  const db = responseDb([{ f: 13000, gain: 6, q: 5 }], freqs, 96000);
  const notch = detectBreakupPeak(freqs, db);
  assert.ok(notch);
  assert.ok(Math.abs(notch.frequency - 13000) / 13000 < 0.03);
  assert.ok(notch.gainDb <= -4 && notch.gainDb >= -7, `gain ${notch.gainDb}`);
  assert.ok(notch.q >= 3 && notch.q <= 8, `q ${notch.q}`);

  const dull = Array.from(freqs, (f) => (f > 10000 ? -3 : 0));
  assert.equal(suggestAirGain(freqs, dull, new Float64Array(freqs.length)), 3);
  assert.ok(Math.abs(baffleStepHz(20) - 546) < 1, 'README: 20 cm gives about 546 Hz');
});

test('confidence mask from SNR and position spread', () => {
  const snr = snrDb([50, 30, 15], [45, 10, 10]);
  assert.deepEqual([...snr], [5, 20, 5]);
  const spread = positionSpreadDb([[0, 0, 0], [1, 8, 2]]);
  assert.deepEqual(lowConfidenceMask({ snr, spread }), [true, true, true]);
  assert.deepEqual(lowConfidenceMask({ snr: [20, 20], spread: [1, 7] }), [false, true]);
});

test('targets are 0 dB at 1 kHz and tilt as specified', () => {
  const t = tilt(-1, 1000);
  const db = targetDb(t, [500, 1000, 2000, 8000]);
  assert.deepEqual([...db].map((d) => Math.round(d * 100) / 100), [0, 0, -1, -3]);
  assert.deepEqual([...targetDb(FLAT, [20, 20000])], [0, 0]);
  const freqs = logGrid(100, 10000, 12);
  assert.ok(rmsDeviation(freqs, Array.from(freqs, () => 5), Array.from(freqs, () => 0), 100, 10000) < 1e-9, 'level offset is ignored');
});
