import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMockHa } from '../../custom_components/speaker_tuner/frontend/src/demo/mock-ha.js';
import { SimMeasurer } from '../../custom_components/speaker_tuner/frontend/src/demo/sim-measurer.js';
import { SIMULATED_FB } from '../../custom_components/speaker_tuner/frontend/src/demo/simulated-speaker.js';
import { HaApi } from '../../custom_components/speaker_tuner/frontend/src/ha/connection.js';
import { DspWriter } from '../../custom_components/speaker_tuner/frontend/src/ha/dsp-writer.js';
import { settingRoles } from '../../custom_components/speaker_tuner/frontend/src/profiles/profile.js';
import {
  levelMatch, polarityTest, crossoverScan, delayScan, lowEnd, notchAndAir, measureDriver, boostFloor,
} from '../../custom_components/speaker_tuner/frontend/src/measure/driver-checks.js';
import { FLAT } from '../../custom_components/speaker_tuner/frontend/src/dsp/target.js';

const profile = JSON.parse(readFileSync(new URL('../../custom_components/speaker_tuner/frontend/profiles/louder-tas5805m-crossover.json', import.meta.url), 'utf8'));

async function rig() {
  const mock = createMockHa(profile, { latencyMs: 1 });
  const writer = new DspWriter(new HaApi(mock.transport), profile, mock.entityFor, { timeoutMs: 1000 });
  await writer.start();
  const measurer = new SimMeasurer({ profile, writer, delayMs: 0 });
  const ctx = { writer, measurer, profile };
  const before = writer.snapshot([...settingRoles(profile), 'tweeter_mute', 'mid_mute']);
  const unchanged = () => assert.deepEqual(writer.snapshot(Object.keys(before)), before, 'test put every setting back');
  return { mock, writer, measurer, ctx, unchanged };
}

test('level match: the hot tweeter is cut so both drivers measure the same', async () => {
  const { writer, ctx, unchanged } = await rig();
  const r = await levelMatch(ctx);
  assert.ok(r.differenceDb > 0.5, `tweeter louder by ${r.differenceDb.toFixed(2)} dB`);
  assert.ok(r.suggestion.tweeter_gain < writer.value('tweeter_gain'));
  assert.equal(r.suggestion.mid_gain, writer.value('mid_gain'));
  unchanged();
  await writer.write(r.suggestion);
  const again = await levelMatch(ctx);
  assert.ok(Math.abs(again.differenceDb) < 0.5, `after: ${again.differenceDb.toFixed(2)} dB`);
});

test('single-driver measurements mute the other driver and restore the mutes', async () => {
  const { ctx, unchanged } = await rig();
  const t = await measureDriver(ctx, 'tweeter', 't');
  const m = await measureDriver(ctx, 'mid', 'm');
  const at = (rec, f) => rec.curve.db[rec.curve.freqs.findIndex((x) => x >= f)];
  assert.ok(at(t, 8000) - at(t, 200) > 25, 'tweeter alone has no bass');
  assert.ok(at(m, 200) - at(m, 12000) > 25, 'mid alone has no treble');
  unchanged();
});

test('polarity: LR4 is kept as is, LR2 asks for the tweeter to be inverted', async () => {
  const { writer, ctx, unchanged } = await rig();
  const lr4 = await polarityTest(ctx, { always: true });
  assert.deepEqual(lr4.suggestion, {}, 'LR4 sums best with both drivers normal');
  unchanged();

  await writer.write({ crossover_filter: 'LR2 12dB/oct' });
  const lr2 = await polarityTest(ctx, { always: true });
  assert.deepEqual(lr2.suggestion, { tweeter_invert: true });
  assert.ok(lr2.flipped.flatnessDb < lr2.normal.flatnessDb);
  assert.equal(writer.value('tweeter_invert'), false, 'the flip was only for the test');
});

test('crossover scan skips frequencies below the tweeter minimum and restores the setting', async () => {
  const { writer, ctx, unchanged } = await rig();
  const r = await crossoverScan(ctx, [100, 2000, 3000]);
  assert.deepEqual(r.skipped, [100]);
  assert.deepEqual(r.results.map((x) => x.frequency).sort(), [2000, 2500, 3000], 'the current 2500 Hz is always measured');
  assert.ok(r.results.every((x) => Number.isFinite(x.flatnessDb)));
  if (r.suggestion.crossover_frequency) {
    const best = r.results.find((x) => x.frequency === r.suggestion.crossover_frequency);
    assert.ok(best.flatnessDb <= r.current.flatnessDb - 0.2, 'only a clear improvement is suggested');
  }
  assert.equal(writer.value('crossover_frequency'), 2500);
  unchanged();
});

test('delay scan: reverse null finds the alignment and the normal sum gets no worse', async () => {
  const { ctx, unchanged } = await rig();
  const r = await delayScan(ctx, { max: 50, coarse: 5, fine: 1 });
  // the tweeter sits 15 mm ahead, and its high-pass adds phase lead on top: with the fork's
  // all-pass approximation the deepest null in the simulation lands near +40 mm
  assert.ok(r.best.offsetMm >= 35 && r.best.offsetMm <= 45, `best offset ${r.best.offsetMm} mm`);
  assert.ok(r.best.dipDb > 15, `null depth ${r.best.dipDb.toFixed(1)} dB`);
  assert.ok(r.confirm.best.flatnessDb <= r.confirm.current.flatnessDb, 'normal-polarity sum is at least as flat');
  assert.deepEqual(r.suggestion, { tweeter_delay: r.best.offsetMm, mid_delay: 0 });
  unchanged();
});

test('low end: the passive radiator tuning is found and a subsonic suggested below it', async () => {
  const { ctx } = await rig();
  const r = await lowEnd(ctx, { nearfieldVolume: 0.1 });
  assert.equal(r.enclosure, 'passive_radiator');
  assert.ok(Math.abs(r.fb - SIMULATED_FB) / SIMULATED_FB < 0.05, `fb ${r.fb}`);
  assert.equal(r.suggestion.subsonic_frequency, Math.round(0.8 * r.fb));
  assert.ok(!('linkwitz_f0' in r.suggestion), 'no Linkwitz on a passive radiator box');
  assert.ok(Math.abs(boostFloor({ fb: r.fb }) - 1.3 * r.fb) < 1e-9);
  assert.equal(await ctx.measurer.getVolume(), 0.25, 'session volume restored');
});

test('notch and air are only offered with a calibrated mic, and find the breakup peak', async () => {
  const { ctx } = await rig();
  const t = await measureDriver(ctx, 'tweeter', 't');
  const f = await measureDriver(ctx, 'full', 'f');
  assert.equal(notchAndAir(t.curve, f.curve, FLAT, 'unknown').allowed, false);
  const r = notchAndAir(t.curve, f.curve, FLAT, 'calibrated');
  assert.ok(r.notch, 'breakup peak found');
  assert.ok(Math.abs(r.notch.frequency - 14000) / 14000 < 0.05, `notch ${r.notch.frequency} Hz`);
  assert.ok(r.suggestion.tweeter_notch_gain < 0);
  // the breakup peak is the notch's job; the air shelf must not cut it a second time
  const noNotch = notchAndAir(t.curve, f.curve, FLAT, 'calibrated');
  assert.ok(Math.abs(r.air) <= 3, `air ${r.air} dB`);
  assert.equal(noNotch.air, r.air);
});
