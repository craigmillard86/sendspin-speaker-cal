import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinkNoise, removePinkSlope, testSignal } from '../../custom_components/speaker_tuner/frontend/src/dsp/pink.js';
import { welch } from '../../custom_components/speaker_tuner/frontend/src/dsp/welch.js';
import { logGrid, smoothPowerDb } from '../../custom_components/speaker_tuner/frontend/src/dsp/smoothing.js';
import { encodeWav16, decodeWav } from '../../custom_components/speaker_tuner/frontend/src/dsp/wav.js';
import { median } from '../../custom_components/speaker_tuner/frontend/src/dsp/metrics.js';

test('pink slope correction gives a flat result on synthetic pink noise', () => {
  const fs = 48000;
  const noise = pinkNoise(10 * fs, fs, { seed: 7 });
  const { freqs, power } = welch(noise, fs, { nfft: 8192, overlap: 0.5 });
  const grid = logGrid(40, 16000, 12);
  const db = removePinkSlope(grid, smoothPowerDb(freqs, power, 12, grid));
  const mid = median([...db]);
  const worst = Math.max(...db.map((d) => Math.abs(d - mid)));
  assert.ok(worst < 1.5, `largest deviation from flat ${worst.toFixed(2)} dB`);

  // the slope across the band is under 0.1 dB/octave
  const octaves = Math.log2(16000 / 40);
  const slope = (db[db.length - 1] - db[0]) / octaves;
  assert.ok(Math.abs(slope) < 0.15, `slope ${slope.toFixed(3)} dB/oct`);
});

test('uncorrected pink noise falls about 3 dB per octave', () => {
  const fs = 48000;
  const { freqs, power } = welch(pinkNoise(10 * fs, fs, { seed: 3 }), fs);
  const grid = Float64Array.from([250, 500, 1000, 2000, 4000]);
  const db = smoothPowerDb(freqs, power, 3, grid);
  for (let i = 1; i < db.length; i++) {
    const step = db[i] - db[i - 1];
    assert.ok(Math.abs(step + 3.01) < 0.6, `octave step ${step.toFixed(2)} dB`);
  }
});

test('test signal is 20 s, 48 kHz, 16-bit mono with 1 s fades, and round-trips through WAV', () => {
  const signal = testSignal();
  assert.equal(signal.length, 20 * 48000);
  assert.equal(signal[0], 0);
  assert.ok(Math.abs(signal[signal.length - 1]) < 1e-6);
  const wav = encodeWav16(signal, 48000);
  assert.equal(wav.length, 44 + signal.length * 2);
  const back = decodeWav(wav);
  assert.equal(back.fs, 48000);
  assert.equal(back.channels, 1);
  assert.equal(back.bits, 16);
  assert.equal(back.samples.length, signal.length);
  const i = 10 * 48000;
  assert.ok(Math.abs(back.samples[i] - signal[i]) < 1 / 16000);
  // never clips
  assert.ok(signal.every((x) => Math.abs(x) <= 1));
});
