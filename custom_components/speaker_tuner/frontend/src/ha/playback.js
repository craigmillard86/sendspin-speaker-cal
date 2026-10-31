// @ts-check
// Test-signal playback on the speaker's media player.

export class Playback {
  /** @param {import('./connection.js').HaApi} api @param {string} entityId */
  constructor(api, entityId) {
    this.api = api;
    this.entityId = entityId;
  }

  async volume() {
    const states = await this.api.getStates();
    const s = states.find((/** @type {any} */ x) => x.entity_id === this.entityId);
    if (!s) throw new Error(`Media player ${this.entityId} not found`);
    const v = s.attributes?.volume_level;
    return typeof v === 'number' ? v : null;
  }

  /** @param {number} level 0..1 */
  setVolume(level) {
    return this.api.callService('media_player', 'volume_set', { volume_level: Math.min(1, Math.max(0, level)) }, { entity_id: this.entityId });
  }

  /** @param {string} mediaUrl media-source:// ID or http URL */
  play(mediaUrl) {
    return this.api.callService('media_player', 'play_media', { media_content_id: mediaUrl, media_content_type: 'music' }, { entity_id: this.entityId });
  }

  stop() {
    return this.api.callService('media_player', 'media_stop', {}, { entity_id: this.entityId });
  }

  /** The player's state in HA, e.g. 'playing', 'idle', 'buffering', 'unavailable'. */
  async state() {
    const states = await this.api.getStates();
    return states.find((/** @type {any} */ x) => x.entity_id === this.entityId)?.state ?? 'not found';
  }

  /**
   * Wait for HA to report the player as playing. A play_media call that HA accepts can still
   * fail on the device (a bad URL, an unsupported file), and the call itself won't say so.
   * @param {number} timeoutMs @param {AbortSignal} [signal]
   */
  async waitUntilPlaying(timeoutMs = 8000, signal) {
    const end = Date.now() + timeoutMs;
    let state = '';
    while (Date.now() < end) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      state = await this.state();
      if (state === 'playing') return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`The speaker's media player (${this.entityId}) did not start playing the test noise; it reports "${state}". Check the test noise URL with "Play 3 s" in the Speaker section, and that the media player that plays files is mapped (on Louder boards the "… Player", not the "… Sendspin Player").`);
  }
}
