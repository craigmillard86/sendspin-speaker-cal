import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMockHa } from '../../custom_components/speaker_tuner/frontend/src/demo/mock-ha.js';
import { simulateTwoWay } from '../../custom_components/speaker_tuner/frontend/src/demo/simulated-speaker.js';
import { HaApi, connectWithToken } from '../../custom_components/speaker_tuner/frontend/src/ha/connection.js';
import { DspWriter } from '../../custom_components/speaker_tuner/frontend/src/ha/dsp-writer.js';
import { listEsphomeDevices, deviceEntities, suggestMapping } from '../../custom_components/speaker_tuner/frontend/src/ha/discover.js';
import { crossoverSettings, settingRoles, expandRoles } from '../../custom_components/speaker_tuner/frontend/src/profiles/profile.js';
import { planPeqFit, curveRms } from '../../custom_components/speaker_tuner/frontend/src/measure/peq.js';
import { applyAndRefine } from '../../custom_components/speaker_tuner/frontend/src/measure/refine.js';
import { tilt } from '../../custom_components/speaker_tuner/frontend/src/dsp/target.js';

const profile = JSON.parse(readFileSync(new URL('../../custom_components/speaker_tuner/frontend/profiles/louder-tas5805m-crossover.json', import.meta.url), 'utf8'));
const mic = { tier: 'calibrated' };
const target = tilt(-1, 1000);

async function setup(options = {}) {
  const mock = createMockHa(profile, { latencyMs: 2, ...options });
  const api = new HaApi(mock.transport);
  const writer = new DspWriter(api, profile, mock.entityFor, { timeoutMs: options.timeoutMs ?? 1000 });
  await writer.start();
  let seed = 1;
  const allRoles = Object.keys(expandRoles(profile));
  const measure = async () => simulateTwoWay(crossoverSettings(profile, writer.values(allRoles)), { noiseDb: 0.15, seed: seed++ });
  const plan = (curve) =>
    planPeqFit({ profile, values: writer.values(allRoles), rangeOf: (r) => writer.range(r), curve, target, mic, boostFloorHz: 1.3 * 42 });
  return { mock, api, writer, measure, plan, allRoles };
}

test('discover finds the ESPHome speaker and maps its entities to roles', async () => {
  const { mock, api } = await setup();
  const devices = await listEsphomeDevices(api);
  assert.deepEqual(devices.map((d) => d.name), ['Demo Speaker']);
  const mapping = suggestMapping(profile, await deviceEntities(api, devices[0].id));
  for (const role of ['media_player', 'crossover_frequency', 'crossover_filter', 'loudness', 'loudness_reference', 'tweeter_mute', 'mid_mute', 'tweeter_invert', 'mid_peq_3_gain', 'tweeter_peq_6_type', 'tweeter_peak_gain', 'crossover_reset']) {
    assert.equal(mapping[role], mock.entityFor[role], role);
  }
});

test('apply and re-measure loop lowers the deviation, then revert restores the session start', async () => {
  const { writer, measure, plan, allRoles } = await setup();
  const snapshot = writer.snapshot(settingRoles(profile));
  const baseline = await measure();
  const rmsOf = (c) => curveRms(c, target, mic);

  const result = await applyAndRefine({ writer, baseline, plan, measure, rmsOf, maxIterations: 3, minImprovementDb: 0.3 });
  assert.ok(result.steps.length >= 1 && result.steps.length <= 3);
  assert.ok(result.steps.every((s) => s.report.ok));
  assert.ok(result.finalRms < result.startRms - 0.5, `rms ${result.startRms.toFixed(2)} -> ${result.finalRms.toFixed(2)}`);

  // the device holds what the last pass wrote
  const last = result.steps[result.steps.length - 1].changes;
  for (const [role, value] of Object.entries(last)) {
    const got = writer.value(role);
    if (typeof value === 'number') assert.ok(Math.abs(got - value) < 1e-6, `${role}: ${got} vs ${value}`);
    else assert.equal(got, value, role);
  }
  // gains stay inside the calibrated tier limits and no band sits within 1/3 octave of the crossover
  const xo = writer.value('crossover_frequency');
  for (let n = 1; n <= 6; n++) {
    for (const d of ['mid', 'tweeter']) {
      const g = writer.value(`${d}_peq_${n}_gain`);
      assert.ok(g >= -12 && g <= 6, `${d} band ${n} gain ${g}`);
      if (g) {
        const f = writer.value(`${d}_peq_${n}_frequency`);
        assert.ok(f < xo / Math.cbrt(2) || f > xo * Math.cbrt(2), `${d} band ${n} at ${f} Hz is too close to the crossover`);
        assert.ok(d === 'mid' ? f < xo : f > xo, `${d} band ${n} at ${f} Hz is on the wrong side`);
      }
    }
  }

  const revert = await writer.write(snapshot);
  assert.ok(revert.ok);
  const now = writer.values(allRoles);
  for (const [role, value] of Object.entries(snapshot)) assert.deepEqual(now[role], value, role);
});

test('a write that never confirms stops, reports what was and was not written, and does not revert', async () => {
  const stuckRole = 'mid_peq_1_gain';
  const mockProbe = createMockHa(profile);
  const { writer } = await setup({ stuck: [mockProbe.entityFor[stuckRole]], timeoutMs: 150 });
  const changes = { mid_peq_1_frequency: 300, mid_peq_1_q: 2, mid_peq_1_gain: -4, mid_peq_2_frequency: 800, mid_peq_2_gain: -2 };
  const report = await writer.write(changes);
  assert.equal(report.ok, false);
  assert.equal(report.failed[0].role, stuckRole);
  assert.match(report.failed[0].error, /did not report/);
  assert.ok(report.written.includes('mid_peq_1_frequency'));
  assert.ok(report.written.includes('mid_peq_2_frequency'), 'frequencies are written before gains');
  assert.deepEqual(report.remaining, ['mid_peq_2_gain']);
  assert.equal(writer.value('mid_peq_1_frequency'), 300, 'nothing was reverted');
});

test('stop aborts between writes', async () => {
  const { writer } = await setup();
  const controller = new AbortController();
  controller.abort();
  const report = await writer.write({ mid_gain: -1, tweeter_gain: -2 }, { signal: controller.signal });
  assert.equal(report.stopped, true);
  assert.deepEqual(report.remaining.sort(), ['mid_gain', 'tweeter_gain']);
});

test('values are clamped to the entity range HA reports', async () => {
  const { writer } = await setup();
  const report = await writer.write({ crossover_frequency: 100, tweeter_gain: 2.26 });
  assert.ok(report.ok);
  assert.equal(writer.value('crossover_frequency'), 500, 'clamped to the entity minimum');
  assert.equal(writer.value('tweeter_gain'), 2.5, 'quantised to the 0.5 dB step');
});

test('token transport: auth, results and events over a WebSocket', async () => {
  const mock = createMockHa(profile, { latencyMs: 1 });
  class FakeSocket {
    constructor(url) {
      assert.equal(url, 'wss://ha.example:8123/api/websocket');
      this.readyState = 1;
      this.subs = new Map();
      setTimeout(() => this.emit({ type: 'auth_required' }), 1);
    }
    emit(msg) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
    async send(raw) {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') return this.emit(msg.access_token === 'good' ? { type: 'auth_ok' } : { type: 'auth_invalid', message: 'bad token' });
      try {
        if (msg.type === 'subscribe_events') {
          await mock.transport.subscribe(msg, (event) => this.emit({ id: msg.id, type: 'event', event }));
          return this.emit({ id: msg.id, type: 'result', success: true, result: null });
        }
        const result = await mock.transport.send(msg);
        this.emit({ id: msg.id, type: 'result', success: true, result });
      } catch (e) {
        this.emit({ id: msg.id, type: 'result', success: false, error: { message: e.message } });
      }
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  await assert.rejects(connectWithToken('https://ha.example:8123', 'bad', { WebSocketImpl: FakeSocket }), /rejected the token/);
  const transport = await connectWithToken('https://ha.example:8123/', 'good', { WebSocketImpl: FakeSocket });
  const api = new HaApi(transport);
  const writer = new DspWriter(api, profile, mock.entityFor, { timeoutMs: 1000 });
  await writer.start();
  const report = await writer.write({ mid_gain: -2 });
  assert.ok(report.ok);
  assert.equal(writer.value('mid_gain'), -2);
  await assert.rejects(api.callService('select', 'select_option', { option: 'Nope' }, { entity_id: mock.entityFor.crossover_filter }), /not valid/);
});

test('a pass that makes things worse is undone, leaving the best values', async () => {
  const values = { mid_peq_1_gain: 0 };
  const writer = {
    snapshot: (keys) => Object.fromEntries(keys.map((k) => [k, values[k]])),
    write: async (changes) => {
      Object.assign(values, changes);
      return { ok: true, written: Object.keys(changes), unchanged: [], failed: [], remaining: [], skipped: [], stopped: false };
    },
  };
  // pass 1 gets better (5 -> 3), pass 2 gets worse (3 -> 3.4)
  const rmsByGain = { 0: 5, '-3': 3, '-6': 3.4 };
  let pass = 0;
  const result = await applyAndRefine({
    writer, baseline: { gain: 0 }, rmsOf: (c) => rmsByGain[c.gain],
    plan: () => ({ changes: { mid_peq_1_gain: ++pass === 1 ? -3 : -6 }, rmsAfter: 0 }),
    measure: async () => ({ gain: values.mid_peq_1_gain }),
  });
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].undone, true);
  assert.equal(values.mid_peq_1_gain, -3, 'back on the pass 1 values');
  assert.equal(result.finalRms, 3);
  assert.match(result.reason, /pass 2 made it worse and was undone/);
});

test('media upload posts the file to HA\'s local media folder with the token', async () => {
  const { uploadMedia, MEDIA_FOLDER, HaApi: Api } = await import('../../custom_components/speaker_tuner/frontend/src/ha/connection.js');
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ media_content_id: `${MEDIA_FOLDER}/noise.wav` }) };
  };
  const api = new Api({ send: async () => null, subscribe: async () => () => {}, http: { baseUrl: 'https://ha.example:8123', token: () => 'tok' } });
  const id = await uploadMedia(api, new Blob([new Uint8Array(8)], { type: 'audio/wav' }), 'noise.wav', { fetchImpl });
  assert.equal(seen.url, 'https://ha.example:8123/api/media_source/local_source/upload');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.body.get('media_content_id'), 'media-source://media_source/local/speaker-tuner');
  assert.equal(seen.init.body.get('file').type, 'audio/wav');
  assert.equal(id, 'media-source://media_source/local/speaker-tuner/noise.wav');
});
