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
}
