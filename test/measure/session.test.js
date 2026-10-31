import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicMeasurer } from '../../custom_components/speaker_tuner/frontend/src/measure/session.js';
import { pinkNoise } from '../../custom_components/speaker_tuner/frontend/src/dsp/pink.js';
import { peaking, filterSamples } from '../../custom_components/speaker_tuner/frontend/src/dsp/biquad.js';
import { view, normalised } from '../../custom_components/speaker_tuner/frontend/src/dsp/analyse.js';
import { interpLogF } from '../../custom_components/speaker_tuner/frontend/src/dsp/smoothing.js';

const FS = 16000;
const SCALE = 0.02; // 1 s of recording takes 20 ms

/**
 * A recorder whose "room" plays filtered pink noise from a set time after play() is called,
 * at a level that follows the media player volume. Samples appear as (scaled) time passes.
 */
function fakeRig({ latencyS = 0.4, gainPerVolume = 1, silent = false } = {}) {
  const noise = filterSamples([peaking(1000, 6, 2, FS)], pinkNoise(30 * FS, FS, { seed: 5 }));
  let t0 = 0;
  let playAt = Infinity;
  let volume = 0.1;
  const volumeLog = [];
  const sampleAt = (i) => {
    const room = ((i * 2654435761) % 1000) / 1e7; // tiny deterministic hiss
    const k = i - Math.round(playAt * FS);
    return k >= 0 && !silent ? noise[k % noise.length] * volume * gainPerVolume + room : room;
  };
  const elapsedSamples = () => Math.floor(((Date.now() - t0) / 1000 / SCALE) * FS);
  const recorder = {
    sampleRate: FS,
    recording: false,
    start() {
      t0 = Date.now();
      this.recording = true;
    },
    peek() {
      return Float32Array.from({ length: elapsedSamples() }, (_, i) => sampleAt(i));
    },
    stop() {
      this.recording = false;
      return this.peek();
    },
  };
  const playback = {
    async play() {
      playAt = (Date.now() - t0) / 1000 / SCALE + latencyS;
    },
    async stop() {},
    async setVolume(v) {
      volume = v;
      volumeLog.push(v);
    },
    async volume() {
      return volume;
    },
  };
  return { recorder, playback, volumeLog };
}

test('measures through play, onset detection and analysis', async () => {
  const { recorder, playback } = fakeRig();
  const m = new MicMeasurer({ recorder, playback, mediaUrl: 'media-source://x', mic: { name: 'Test', tier: 'calibrated' }, timeScale: SCALE });
  await m.setVolume(0.5);
  const rec = await m.measure({ label: 'Baseline', kind: 'full', positions: 2, onPrompt: async () => {} });
  assert.equal(rec.positions, 2);
  assert.equal(rec.volume, 0.5);
  assert.ok(rec.background, 'background recorded before playback');
  const v = view(normalised(rec.curve), 12, 24);
  const at = (f) => interpLogF(v.freqs, v.db, f);
  assert.ok(Math.abs(at(1000) - at(250) - 6) < 1.5, `peak measured ${(at(1000) - at(250)).toFixed(2)} dB`);
  assert.ok(rec.snrDb.some((x) => x > 30), 'noise well above the background');
});

test('reports no signal when nothing plays', async () => {
  const { recorder, playback } = fakeRig({ silent: true });
  const m = new MicMeasurer({ recorder, playback, mediaUrl: 'x', mic: { name: 'Test', tier: 'unknown' }, timeScale: SCALE });
  await assert.rejects(m.measure({ label: 'x', kind: 'full' }), /No test noise heard/);
});

test('auto-level steps the volume up to the target and stops there', async () => {
  // mic RMS of pink at -18 dBFS file level x volume: target -30 dBFS needs about 25%
  const { recorder, playback, volumeLog } = fakeRig();
  const m = new MicMeasurer({ recorder, playback, mediaUrl: 'x', mic: { name: 'Test', tier: 'calibrated' }, timeScale: SCALE });
  const r = await m.autoLevel({ targetDbfs: -30, cap: 0.6 });
  assert.equal(volumeLog[0], 0.1);
  assert.ok(r.volume >= 0.2 && r.volume <= 0.35, `settled at ${r.volume}`);
  assert.ok(r.rmsDbfs >= -30);
  assert.equal(r.reachedCap, false);
});

test('auto-level never goes past the cap', async () => {
  const { recorder, playback } = fakeRig({ gainPerVolume: 0.05 });
  const m = new MicMeasurer({ recorder, playback, mediaUrl: 'x', mic: { name: 'Test', tier: 'calibrated' }, timeScale: SCALE });
  const r = await m.autoLevel({ targetDbfs: -30, cap: 0.3 });
  assert.equal(r.volume, 0.3);
  assert.equal(r.reachedCap, true);
});

test('auto-level stops with an error when the mic clips', async () => {
  const { recorder, playback } = fakeRig({ gainPerVolume: 40 });
  const m = new MicMeasurer({ recorder, playback, mediaUrl: 'x', mic: { name: 'Test', tier: 'calibrated' }, timeScale: SCALE });
  await assert.rejects(m.autoLevel({}), /close to clipping/);
});
