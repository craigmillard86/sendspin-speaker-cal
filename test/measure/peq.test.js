import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planPeqFit, peqFindings, bandChanges } from '../../custom_components/speaker_tuner/frontend/src/measure/peq.js';
import { responseDb } from '../../custom_components/speaker_tuner/frontend/src/dsp/biquad.js';
import { logGrid } from '../../custom_components/speaker_tuner/frontend/src/dsp/smoothing.js';

const profile = JSON.parse(readFileSync(new URL('../../custom_components/speaker_tuner/frontend/profiles/louder-tas5805m-crossover.json', import.meta.url), 'utf8'));
const ranges = { frequency: { min: 20, max: 20000, step: 1 }, gain: { min: -15, max: 15, step: 0.5 }, q: { min: 0.1, max: 10, step: 0.05 } };
const rangeOf = (/** @type {string} */ r) => (r.endsWith('_q') ? ranges.q : r.endsWith('_gain') ? ranges.gain : ranges.frequency);
const mic = { name: 'test', tier: 'calibrated' };
const flat = { name: 'flat', points: [[20, 0], [20000, 0]] };

function speakerWith(peaks) {
  const freqs = logGrid(20, 20000, 48);
  const db = new Float64Array(freqs.length);
  for (const p of peaks) {
    const r = responseDb([{ type: 'peaking', f: p.f, gain: p.gain, q: p.q }], freqs, 96000);
    for (let i = 0; i < db.length; i++) db[i] += r[i];
  }
  return { freqs: Array.from(freqs), db: Array.from(db) };
}

test('findings name each peak and dip the fit corrects, with its size', () => {
  const curve = speakerWith([{ f: 150, gain: 6, q: 2 }, { f: 700, gain: -4, q: 1.5 }]);
  const plan = planPeqFit({ profile, values: {}, rangeOf, curve, target: flat, mic });
  const found = peqFindings(plan);
  const peak = found.find((x) => x.kind === 'peak' && Math.abs(Math.log2(x.f / 150)) < 0.3);
  const dip = found.find((x) => x.kind === 'dip' && Math.abs(Math.log2(x.f / 700)) < 0.3);
  assert.ok(peak, JSON.stringify(found));
  assert.ok(peak.db > 3, `peak size ${peak.db}`);
  assert.match(peak.text, /peak of \+\d/);
  assert.match(peak.text, /cut \d/);
  assert.ok(dip, JSON.stringify(found));
  assert.ok(dip.db < -2, `dip size ${dip.db}`);
  assert.match(dip.text, /lifted/);
  // the boost floor is reported
  assert.ok(found.some((x) => x.kind === 'floor'));
});

test('a narrow null is reported as left alone, not corrected', () => {
  const curve = speakerWith([{ f: 230, gain: -15, q: 12 }]);
  const plan = planPeqFit({ profile, values: {}, rangeOf, curve, target: flat, mic });
  const found = peqFindings(plan);
  assert.ok(found.some((x) => x.kind === 'null' && Math.abs(Math.log2(x.f / 230)) < 0.2), JSON.stringify(found));
  assert.match(found.find((x) => x.kind === 'null')?.text ?? '', /left alone/);
});

test('band changes list bands on before or after, and bands switched off', () => {
  const before = { tweeter_peq_1_frequency: 5000, tweeter_peq_1_gain: -3, tweeter_peq_1_q: 2, mid_peq_2_frequency: 120, mid_peq_2_gain: 0, mid_peq_2_q: 1 };
  const after = { tweeter_peq_1_gain: 0, mid_peq_2_frequency: 150, mid_peq_2_gain: -4.5, mid_peq_2_q: 2.5 };
  const rows = bandChanges(profile, before, after);
  assert.equal(rows.length, 2);
  const tw = rows.find((r) => r.band === 1 && /tweeter/i.test(r.bank));
  assert.deepEqual(tw?.before, { f: 5000, gain: -3, q: 2 });
  assert.equal(tw?.after.gain, 0, 'switched off');
  const mid = rows.find((r) => r.band === 2);
  assert.deepEqual(mid?.after, { f: 150, gain: -4.5, q: 2.5 });
  // nothing on either side: nothing listed
  assert.equal(bandChanges(profile, {}, {}).length, 0);
});
