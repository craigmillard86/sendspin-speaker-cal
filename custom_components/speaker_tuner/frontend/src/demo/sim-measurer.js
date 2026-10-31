// @ts-check
// A Measurer for demo mode: "measures" the simulated speaker with whatever the mock HA
// device currently holds, including driver mutes and the media player volume.

import { simulateTwoWay, simulateSingle, simulatedBackground } from './simulated-speaker.js';
import { measurementFromPositions } from '../measure/record.js';
import { crossoverSettings, expandRoles, bankFilters } from '../profiles/profile.js';
import { sleep } from '../measure/session.js';

export class SimMeasurer {
  /**
   * @param {{ profile: import('../profiles/profile.js').Profile, writer: import('../ha/dsp-writer.js').DspWriter,
   *   mic?: { name: string, tier: string }, delayMs?: number }} deps
   */
  constructor({ profile, writer, mic = { name: 'Simulated mic', tier: 'calibrated' }, delayMs = 400 }) {
    this.profile = profile;
    this.writer = writer;
    this.mic = mic;
    this.name = mic.name;
    this.delayMs = delayMs;
    this.roles = Object.keys(expandRoles(profile));
    this.seed = 1;
  }

  async getVolume() {
    return this.writer.stateOf('media_player')?.attributes?.volume_level ?? 0.25;
  }

  /** @param {number} v */
  async setVolume(v) {
    await this.writer.api.callService('media_player', 'volume_set', { volume_level: v }, { entity_id: this.writer.entities.media_player });
    // wait for the player to report it, like a real one does a moment later
    for (let i = 0; i < 200 && Math.abs((await this.getVolume()) - v) > 1e-6; i++) await sleep(5);
  }

  /** @param {{ signal?: AbortSignal, onStatus?: (t: string) => void }} [o] */
  async autoLevel({ signal, onStatus } = {}) {
    for (const v of [0.1, 0.15, 0.2, 0.25]) {
      onStatus?.(`Volume ${Math.round(v * 100)}%`);
      await this.setVolume(v);
      await sleep(this.delayMs / 2, signal);
    }
    return { volume: 0.25, rmsDbfs: -30.4, reachedCap: false };
  }

  /** @param {import('../measure/session.js').MeasureRequest} req */
  async measure(req) {
    const n = Math.max(1, req.positions ?? 1);
    const values = this.writer.values(this.roles);
    const volume = await this.getVolume();
    const takes = [];
    for (let i = 0; i < n; i++) {
      if (n > 1) await req.onPrompt?.(i, n);
      req.onStatus?.(n > 1 ? `Position ${i + 1} of ${n}` : 'Measuring');
      await sleep(this.delayMs, req.signal);
      const options = {
        position: req.kind === 'nearfield' ? /** @type {const} */ ('nearfield') : /** @type {const} */ ('listening'),
        mute: { tweeter: !!values.tweeter_mute, mid: !!values.mid_mute },
        volume,
        seed: this.seed++,
        positionOffset: n > 1 ? i - (n - 1) / 2 : 0,
      };
      const curve = this.profile.component === 'tas58xx-crossover'
        ? simulateTwoWay(crossoverSettings(this.profile, values), options)
        : simulateSingle(this.profile.peq_banks.flatMap((b) => bankFilters(this.profile, values, b.id)), options);
      takes.push({ curve, background: simulatedBackground() });
    }
    return measurementFromPositions(req, takes, { mic: this.mic, volume });
  }
}
