// @ts-check
// Measuring with a real microphone: auto-level, then record the room background, play the
// test noise, find where it starts, analyse 10 s of it, and repeat for each mic position.

import { detectOnset, levels } from '../dsp/onset.js';
import { analyseRecording } from '../dsp/analyse.js';
import { measurementFromPositions } from './record.js';

const BACKGROUND_S = 2;
const SKIP_S = 2;
const ANALYSE_S = 10;
const ONSET_TIMEOUT_S = 8;
const NOISE_FILE_S = 20;

/** @param {number} ms @param {AbortSignal} [signal] */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    // an abort that already happened (e.g. Stop pressed during an HA call) must still count
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @typedef {{ label: string, kind: 'full' | 'tweeter' | 'mid' | 'nearfield', positions?: number,
 *   onPrompt?: (index: number, total: number) => Promise<void>, onStatus?: (text: string) => void, signal?: AbortSignal,
 *   settings?: Record<string, any> }} MeasureRequest
 * @typedef {{ volume: number, rmsDbfs: number, reachedCap: boolean }} LevelResult
 * @typedef {{ measure: (req: MeasureRequest) => Promise<import('./record.js').MeasurementRecord>,
 *   autoLevel: (opts?: AutoLevelOptions & { signal?: AbortSignal, onStatus?: (text: string) => void }) => Promise<LevelResult>,
 *   setVolume: (v: number) => Promise<void>, getVolume: () => Promise<number | null>, name: string }} Measurer
 * @typedef {{ start?: number, step?: number, cap?: number, targetDbfs?: number, clipDbfs?: number }} AutoLevelOptions
 */

export class MicMeasurer {
  /**
   * @param {{ recorder: import('../audio/recorder.js').Recorder, playback: import('../ha/playback.js').Playback,
   *   mediaUrl: string, mic: { name: string, tier: string, cal?: { freqs: number[], db: number[] } | null },
   *   timeScale?: number }} deps timeScale < 1 runs the waits faster (tests only)
   */
  constructor({ recorder, playback, mediaUrl, mic, timeScale = 1 }) {
    this.t = timeScale;
    this.recorder = recorder;
    this.playback = playback;
    this.mediaUrl = mediaUrl;
    this.mic = mic;
    this.name = mic.name;
    /** @type {number | null} */
    this.volume = null;
  }

  async getVolume() {
    return this.playback.volume();
  }

  /** @param {number} v */
  async setVolume(v) {
    await this.playback.setVolume(v);
    this.volume = v;
  }

  /**
   * One recording: background, play, wait for the onset, keep 12.5 s after it.
   * @param {AbortSignal} [signal] @param {(t: string) => void} [onStatus]
   */
  async recordOnce(signal, onStatus) {
    const rec = this.recorder;
    const fs = rec.sampleRate;
    rec.start();
    try {
      onStatus?.('Listening to the room…');
      await sleep(BACKGROUND_S * 1000 * this.t, signal);
      await this.playback.play(this.mediaUrl);
      onStatus?.('Waiting for the noise to start…');
      const started = Date.now();
      /** @type {ReturnType<typeof detectOnset>} */
      let onset = null;
      for (;;) {
        await sleep(250 * this.t, signal);
        const samples = rec.peek();
        onset = onset ?? detectOnset(samples, fs, { backgroundSeconds: BACKGROUND_S, timeoutSeconds: ONSET_TIMEOUT_S });
        if (onset) {
          const needed = onset.onsetSample + (SKIP_S + ANALYSE_S + 0.3) * fs;
          const left = Math.max(0, (needed - samples.length) / fs);
          onStatus?.(`Measuring… ${left.toFixed(0)} s`);
          if (samples.length >= needed) break;
        } else if (Date.now() - started > ONSET_TIMEOUT_S * 1000 * this.t) {
          throw new Error('No test noise heard. Check the speaker is on, the media URL in setup plays in Home Assistant, and the right mic is picked.');
        }
      }
      const samples = rec.stop();
      const after = samples.subarray(/** @type {any} */ (onset).onsetSample);
      const { peakDbfs } = levels(after);
      const { spectrum, curve, background } = analyseRecording(samples, fs, {
        onsetSample: /** @type {any} */ (onset).onsetSample,
        skipSeconds: SKIP_S,
        seconds: ANALYSE_S,
        backgroundEnd: Math.round((BACKGROUND_S - 0.2) * fs),
        cal: this.mic.cal ?? null,
      });
      return { spectrum, curve, background, clipped: peakDbfs > -1 };
    } finally {
      if (rec.recording) rec.stop();
      await this.playback.stop().catch(() => {});
    }
  }

  /** @param {MeasureRequest} req */
  async measure(req) {
    const n = Math.max(1, req.positions ?? 1);
    const takes = [];
    for (let i = 0; i < n; i++) {
      if (n > 1) await req.onPrompt?.(i, n);
      req.onStatus?.(n > 1 ? `Position ${i + 1} of ${n}` : 'Measuring');
      takes.push(await this.recordOnce(req.signal, req.onStatus));
    }
    return measurementFromPositions(req, takes, { mic: this.mic, volume: this.volume, cal: this.mic.cal ?? null });
  }

  /**
   * Raise the volume from `start` in `step`s until the mic RMS reaches targetDbfs, never past
   * `cap`. Stops with an error if the mic clips, since that means its gain is too high.
   * @param {AutoLevelOptions & { signal?: AbortSignal, onStatus?: (text: string) => void }} [o]
   * @returns {Promise<LevelResult>}
   */
  async autoLevel({ start = 0.1, step = 0.05, cap = 0.6, targetDbfs = -30, clipDbfs = -3, signal, onStatus } = {}) {
    const rec = this.recorder;
    const fs = rec.sampleRate;
    let volume = start;
    await this.setVolume(volume);
    rec.start();
    try {
      await sleep(BACKGROUND_S * 1000 * this.t, signal);
      await this.playback.play(this.mediaUrl);
      let played = Date.now();
      /** @type {ReturnType<typeof detectOnset>} */
      let onset = null;
      while (!onset) {
        await sleep(250 * this.t, signal);
        onset = detectOnset(rec.peek(), fs, { backgroundSeconds: BACKGROUND_S, riseDb: 6, timeoutSeconds: ONSET_TIMEOUT_S });
        if (!onset && Date.now() - played > ONSET_TIMEOUT_S * 1000 * this.t) {
          throw new Error('No test noise heard while levelling. Check the speaker, the media URL and the mic.');
        }
      }
      for (;;) {
        await sleep(1500 * this.t, signal); // let the new volume reach the speaker
        const all = rec.peek();
        const window = all.subarray(Math.max(0, all.length - Math.round(0.8 * fs)));
        const { rmsDbfs, peakDbfs } = levels(window);
        onStatus?.(`Volume ${Math.round(volume * 100)}%: mic ${rmsDbfs.toFixed(1)} dBFS`);
        if (peakDbfs > clipDbfs) {
          await this.setVolume(Math.max(0, volume - step));
          throw new Error(`The mic is close to clipping (${peakDbfs.toFixed(1)} dBFS peak at ${Math.round(volume * 100)}% volume). Turn the mic or interface gain down and level again.`);
        }
        if (rmsDbfs >= targetDbfs) return { volume, rmsDbfs, reachedCap: false };
        if (volume + step > cap + 1e-9) return { volume, rmsDbfs, reachedCap: true };
        volume = Math.round((volume + step) * 100) / 100;
        await this.setVolume(volume);
        if (Date.now() - played > (NOISE_FILE_S - 4) * 1000 * this.t) {
          await this.playback.play(this.mediaUrl);
          played = Date.now();
          await sleep(1500 * this.t, signal);
        }
      }
    } finally {
      if (rec.recording) rec.stop();
      await this.playback.stop().catch(() => {});
    }
  }
}
