import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFrequencyText, applyCalibration } from '../../custom_components/speaker_tuner/frontend/src/dsp/calfile.js';

const sample = readFileSync(new URL('../fixtures/sample-cal.txt', import.meta.url), 'utf8');

test('parses a REW-style cal file with header, comments and mixed separators', () => {
  const cal = parseFrequencyText(sample);
  assert.deepEqual(cal.freqs, [10, 20, 100, 1000, 10000, 20000]);
  assert.deepEqual(cal.db, [-4.2, -1, 0, 0, 1.5, -2]);
  assert.equal(cal.sensitivityDb, -1.378);
  assert.equal(cal.comments.length, 2);
  assert.ok(cal.skipped.includes('not a data line'));
  assert.ok(cal.skipped.some((l) => l.includes('Sens Factor')));
});

test('applies a calibration by subtracting it, interpolated in log frequency', () => {
  const cal = parseFrequencyText(sample);
  const freqs = [5, 20, Math.sqrt(1000 * 10000), 10000, 40000];
  const out = applyCalibration(freqs, [0, 0, 0, 0, 0], cal);
  assert.ok(Math.abs(out[0] - 4.2) < 1e-9, 'held below the file');
  assert.ok(Math.abs(out[1] - 1) < 1e-9);
  assert.ok(Math.abs(out[2] + 0.75) < 1e-9, 'half way in log f between 0 and 1.5 dB');
  assert.ok(Math.abs(out[3] + 1.5) < 1e-9);
  assert.ok(Math.abs(out[4] - 2) < 1e-9, 'held above the file');
});

test('reads a REW frequency-response export with a phase column', () => {
  const text = '* Freq(Hz) SPL(dB) Phase(degrees)\n* comment\n20.0 70.1 -10\n40.0 75.0 -20\n80 79.5 -30\n';
  const fr = parseFrequencyText(text);
  assert.deepEqual(fr.freqs, [20, 40, 80]);
  assert.deepEqual(fr.db, [70.1, 75, 79.5]);
});

test('rejects files without data', () => {
  assert.throws(() => parseFrequencyText('# nothing here\nhello'), /No frequency/);
});
