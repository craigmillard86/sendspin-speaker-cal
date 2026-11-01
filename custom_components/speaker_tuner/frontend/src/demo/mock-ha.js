// @ts-check
// An in-memory Home Assistant with one ESPHome speaker, speaking the same WebSocket
// messages the tool uses. Demo mode runs on it, and so do the end-to-end tests.

import { expandRoles, optionLabel } from '../profiles/profile.js';
import { fitToRange } from '../ha/entities.js';

/**
 * @param {import('../profiles/profile.js').Profile} profile
 * @param {{ device?: string, latencyMs?: number, stuck?: string[], volume?: number }} [options]
 *   stuck: entity IDs that accept writes but never change (to test failure handling)
 */
export function createMockHa(profile, { device = 'demo_speaker', latencyMs = 5, stuck = [] , volume = 0.25 } = {}) {
  const roles = expandRoles(profile);
  const deviceId = `device-${device}`;
  /** @type {Map<string, any>} */
  const states = new Map();
  /** @type {Record<string, string>} */
  const entityFor = {};
  /** @type {Set<(event: any) => void>} */
  const listeners = new Set();
  /** @type {Array<{ domain: string, service: string, data: any, target: any }>} */
  const calls = [];
  /** @type {Array<(url: string) => void>} */
  const playListeners = [];

  for (const [role, spec] of Object.entries(roles)) {
    const id = `${spec.domain}.${device}_${role}`;
    entityFor[role] = id;
    const def = profile.defaults?.[role] ?? spec.default;
    /** @type {Record<string, any>} */
    const attributes = { friendly_name: `Demo Speaker ${spec.label ?? role}` };
    let state;
    switch (spec.domain) {
      case 'number':
        Object.assign(attributes, { min: spec.min, max: spec.max, step: spec.step, mode: 'box', unit_of_measurement: spec.unit });
        state = String(def ?? (spec.field === 'frequency' ? 1000 : spec.field === 'q' ? 1 : 0));
        break;
      case 'switch':
        state = def ? 'on' : 'off';
        break;
      case 'select':
        attributes.options = Object.values(spec.options ?? {});
        state = def ?? attributes.options[0];
        break;
      case 'sensor':
        state = '0.0';
        attributes.unit_of_measurement = 'dB';
        break;
      case 'media_player':
        state = 'idle';
        attributes.volume_level = volume;
        break;
      default:
        state = 'unknown';
    }
    if (role === 'crossover_frequency' && profile.defaults?.tweeter_min_frequency) attributes.min = profile.defaults.tweeter_min_frequency;
    states.set(id, { entity_id: id, state, attributes, last_changed: new Date().toISOString() });
  }
  // types of PEQ bands start as Peaking
  for (const [role, spec] of Object.entries(roles)) {
    if (spec.field === 'type') states.get(entityFor[role]).state = optionLabel(spec.options, 'peaking');
  }
  const defaults = new Map([...states].map(([k, v]) => [k, v.state]));

  /** @param {string} id @param {string} state @param {Record<string, any>} [attrs] */
  const setState = (id, state, attrs) => {
    const old = states.get(id);
    const next = { ...old, state, attributes: { ...old.attributes, ...attrs }, last_changed: new Date().toISOString() };
    states.set(id, next);
    const event = { event_type: 'state_changed', data: { entity_id: id, old_state: old, new_state: next } };
    setTimeout(() => listeners.forEach((l) => l(event)), latencyMs);
  };

  /** @param {any} msg */
  const handleService = (msg) => {
    const { domain, service, service_data: data = {}, target = {} } = msg;
    calls.push({ domain, service, data, target });
    const ids = [].concat(target.entity_id ?? data.entity_id ?? []);
    for (const id of ids) {
      const s = states.get(id);
      if (!s) throw new Error(`Entity ${id} not found`);
      if (stuck.includes(id)) continue;
      if (domain === 'number' && service === 'set_value') {
        const v = fitToRange(Number(data.value), { min: s.attributes.min, max: s.attributes.max, step: s.attributes.step });
        setTimeout(() => setState(id, String(v)), latencyMs);
      } else if (domain === 'switch') {
        setTimeout(() => setState(id, service === 'turn_on' ? 'on' : 'off'), latencyMs);
      } else if (domain === 'select' && service === 'select_option') {
        if (!s.attributes.options.includes(data.option)) throw new Error(`Option ${data.option} not valid for ${id}`);
        setTimeout(() => setState(id, data.option), latencyMs);
      } else if (domain === 'media_player' && service === 'volume_set') {
        setTimeout(() => setState(id, s.state, { volume_level: data.volume_level }), latencyMs);
      } else if (domain === 'media_player' && service === 'play_media') {
        setTimeout(() => setState(id, 'playing', { media_content_id: data.media_content_id }), latencyMs);
        playListeners.forEach((l) => l(data.media_content_id));
      } else if (domain === 'media_player' && service === 'media_stop') {
        setTimeout(() => setState(id, 'idle'), latencyMs);
      } else if (domain === 'button' && service === 'press' && id === entityFor.crossover_reset) {
        for (const [eid, value] of defaults) if (!eid.startsWith('media_player.')) setTimeout(() => setState(eid, value), latencyMs);
      }
    }
    return null;
  };

  // the Speaker Tuner integration's data store (speaker_tuner/store/get|set), as in Home Assistant
  /** @type {Map<string, any>} */
  const kv = new Map();
  /** @type {Record<string, string>} */
  const kvUpdated = {};
  /** @type {Set<(event: any) => void>} */
  const storeListeners = new Set();

  /** @param {any} msg */
  const respond = async (msg) => {
    await new Promise((r) => setTimeout(r, latencyMs));
    switch (msg.type) {
      case 'get_states':
        return [...states.values()];
      case 'get_config':
        return { version: '2026.10.0', location_name: 'Demo' };
      case 'config/device_registry/list':
        return [
          { id: deviceId, name: 'Demo Speaker', manufacturer: 'Espressif', model: 'Simulated two-way' },
          { id: 'device-other', name: 'Kitchen Light', manufacturer: 'Other', model: 'Bulb' },
        ];
      case 'config/entity_registry/list':
        return [
          ...[...states.keys()].map((id) => ({
            entity_id: id, device_id: deviceId, platform: 'esphome', disabled_by: null, name: null,
            original_name: states.get(id).attributes.friendly_name.replace(/^Demo Speaker /, ''),
          })),
          { entity_id: 'light.kitchen', device_id: 'device-other', platform: 'hue', disabled_by: null, name: null, original_name: 'Kitchen' },
        ];
      case 'call_service':
        return handleService(msg);
      case 'speaker_tuner/store/get': {
        if (!('keys' in msg)) return { values: {}, updated: { ...kvUpdated } };
        const keys = msg.keys.filter((/** @type {string} */ k) => kv.has(k));
        return { values: Object.fromEntries(keys.map((/** @type {string} */ k) => [k, structuredClone(kv.get(k))])), updated: Object.fromEntries(keys.map((/** @type {string} */ k) => [k, kvUpdated[k]])) };
      }
      case 'speaker_tuner/store/set': {
        const updated = new Date().toISOString();
        if (msg.value === null) {
          kv.delete(msg.key);
          delete kvUpdated[msg.key];
        } else {
          kv.set(msg.key, structuredClone(msg.value));
          kvUpdated[msg.key] = updated;
        }
        setTimeout(() => storeListeners.forEach((l) => l({ event_type: 'speaker_tuner_updated', data: { key: msg.key, client: msg.client, updated } })), latencyMs);
        return { updated };
      }
      case 'subscribe_events':
      case 'unsubscribe_events':
        return null;
      default:
        throw new Error(`Mock HA does not handle ${msg.type}`);
    }
  };

  /** @type {import('../ha/connection.js').Transport} */
  const transport = {
    send: respond,
    subscribe: async (msg, cb) => {
      await respond(msg);
      const set = msg.event_type === 'speaker_tuner_updated' ? storeListeners : listeners;
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    onClose: () => {},
    http: { baseUrl: '', token: () => 'demo' },
  };

  return {
    transport,
    entityFor,
    calls,
    deviceId,
    /** role -> current value as the device holds it */
    valuesByRole() {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [role, id] of Object.entries(entityFor)) {
        const s = states.get(id);
        const spec = roles[role];
        out[role] = spec.domain === 'number' ? Number(s.state) : spec.domain === 'switch' ? s.state === 'on' : s.state;
      }
      return out;
    },
    volume() {
      return states.get(entityFor.media_player)?.attributes.volume_level ?? volume;
    },
    /** @param {string} role @param {string} state */
    setRoleState(role, state) {
      setState(entityFor[role], state);
    },
    /** @param {(url: string) => void} cb */
    onPlay(cb) {
      playListeners.push(cb);
    },
  };
}
