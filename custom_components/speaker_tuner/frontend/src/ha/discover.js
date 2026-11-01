// @ts-check
// Discovery: list ESPHome devices, list a device's entities, and guess which entity plays
// which profile role. The guesses are only suggestions; the user confirms them in setup.

import { expandRoles } from '../profiles/profile.js';

/** @param {string} s */
export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** @param {any} d */
const deviceName = (d) => d.name_by_user || d.name || d.id;

/**
 * A device and every device below it. ESPHome sub-devices (the `devices:` list in the YAML)
 * are separate devices in Home Assistant, linked to the speaker by via_device_id.
 * @param {any[]} devices @param {string} rootId
 * @returns {Map<string, any>} id -> device, the root included
 */
export function deviceTree(devices, rootId) {
  const byParent = new Map();
  for (const d of devices) {
    if (!d.via_device_id) continue;
    if (!byParent.has(d.via_device_id)) byParent.set(d.via_device_id, []);
    byParent.get(d.via_device_id).push(d);
  }
  /** @type {Map<string, any>} */
  const out = new Map();
  const queue = devices.filter((d) => d.id === rootId);
  while (queue.length) {
    const d = queue.shift();
    if (out.has(d.id)) continue; // a loop in the registry must not hang us
    out.set(d.id, d);
    queue.push(...(byParent.get(d.id) ?? []));
  }
  return out;
}

/**
 * ESPHome speakers: devices with ESPHome entities on them or on their sub-devices. A
 * sub-device is listed under its speaker, not as a speaker of its own.
 * @param {import('./connection.js').HaApi} api
 * @returns {Promise<Array<{ id: string, name: string, model?: string, manufacturer?: string, sw_version?: string, subDevices: number }>>}
 */
export async function listEsphomeDevices(api) {
  const [devices, entities] = await Promise.all([api.deviceRegistry(), api.entityRegistry()]);
  const withEsphome = new Set(entities.filter((/** @type {any} */ e) => e.platform === 'esphome' && e.device_id).map((/** @type {any} */ e) => e.device_id));
  const byId = new Map(devices.map((/** @type {any} */ d) => [d.id, d]));
  // a device belongs to an ESPHome speaker if it, or any device below it, has ESPHome entities
  const related = (/** @type {string} */ id) => [...deviceTree(devices, id).keys()].some((x) => withEsphome.has(x));
  // list only the top of each tree: a sub-device is part of its speaker, not one of its own
  const tops = devices
    .filter((/** @type {any} */ d) => related(d.id) && !(d.via_device_id && byId.has(d.via_device_id) && related(d.via_device_id)))
    .map((/** @type {any} */ d) => d.id);
  return tops
    .map((id) => {
      const d = byId.get(id);
      return { id, name: deviceName(d), model: d.model, manufacturer: d.manufacturer, sw_version: d.sw_version, subDevices: deviceTree(devices, id).size - 1 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @typedef {{ entity_id: string, domain: string, name: string, object: string, state: any, device?: string }} DeviceEntity
 * Entities of a speaker and all its sub-devices. An entity on a sub-device is named with the
 * sub-device in front ("Tweeter" + "PEQ 1 Gain" -> "Tweeter PEQ 1 Gain"), which is how it
 * reads in Home Assistant and what the profile's role hints look for.
 * @param {import('./connection.js').HaApi} api @param {string} deviceId
 * @returns {Promise<DeviceEntity[]>}
 */
export async function deviceEntities(api, deviceId) {
  const [devices, entities, states] = await Promise.all([api.deviceRegistry(), api.entityRegistry(), api.getStates()]);
  const tree = deviceTree(devices, deviceId);
  const byId = new Map(states.map((/** @type {any} */ s) => [s.entity_id, s]));
  return entities
    .filter((/** @type {any} */ e) => tree.has(e.device_id) && !e.disabled_by)
    .map((/** @type {any} */ e) => {
      const state = byId.get(e.entity_id);
      const own = e.name || e.original_name || state?.attributes?.friendly_name || e.entity_id;
      const sub = e.device_id !== deviceId ? deviceName(tree.get(e.device_id)) : '';
      // no prefix when the name already says which part it is ("Mid PEQ 1 Gain" on "Mid EQ")
      const first = (/** @type {string} */ t) => t.trim().split(/\s+/)[0]?.toLowerCase();
      const name = sub && first(own) !== first(sub) ? `${sub} ${own}` : own;
      return { entity_id: e.entity_id, domain: e.entity_id.split('.')[0], name, object: e.entity_id.split('.')[1], state, device: sub || undefined };
    });
}

/**
 * Score how well an entity fits a role: 3 exact name match, 2 entity ID ends with a hint,
 * 1 hint appears somewhere, 0 no match. Domains must agree and "avoid" words rule it out.
 * @param {import('../profiles/profile.js').RoleSpec & { avoid?: string[] }} spec @param {DeviceEntity} e
 */
export function matchScore(spec, e) {
  if (e.domain !== spec.domain) return 0;
  const name = slug(e.name);
  const object = e.object;
  if ((spec.avoid ?? []).some((a) => name.includes(slug(a)) || object.includes(slug(a)))) return 0;
  let best = 0;
  for (const raw of spec.hints ?? []) {
    const h = slug(raw);
    if (!h) continue;
    if (name === h || object === h) best = Math.max(best, 3);
    else if (name.endsWith(`_${h}`) || object.endsWith(`_${h}`)) best = Math.max(best, 2);
    else if (name.includes(h) || object.includes(h)) best = Math.max(best, 1);
  }
  return best;
}

/**
 * Suggested role -> entity_id for a profile. Each entity is used at most once; the best
 * scores are assigned first, and a hint that ends the entity ID beats one that is contained.
 * @param {import('../profiles/profile.js').Profile} profile @param {DeviceEntity[]} entities
 */
export function suggestMapping(profile, entities) {
  const roles = expandRoles(profile);
  /** @type {Array<{ role: string, entity: string, score: number, exactness: number }>} */
  const candidates = [];
  for (const [role, spec] of Object.entries(roles)) {
    for (const e of entities) {
      const score = matchScore(/** @type {any} */ (spec), e);
      if (score > 0) {
        // prefer the entity whose ID is shortest beyond the hint, e.g. "..._loudness" over "..._loudness_reference"
        const exactness = -e.object.length;
        candidates.push({ role, entity: e.entity_id, score, exactness });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.exactness - a.exactness);
  /** @type {Record<string, string>} */
  const mapping = {};
  const used = new Set();
  for (const c of candidates) {
    if (mapping[c.role] || used.has(c.entity)) continue;
    mapping[c.role] = c.entity;
    used.add(c.entity);
  }
  return mapping;
}

/**
 * A saved speaker whose entities were renamed in Home Assistant (or whose device was
 * re-flashed under a new name): keep every role whose entity still exists, and map the
 * others again from the device's entities. Returns null when nothing is missing.
 * @param {Record<string, string>} entities role -> entity_id as saved
 * @param {Set<string>} existing entity IDs Home Assistant has now
 * @param {import('../profiles/profile.js').Profile} profile @param {DeviceEntity[]} candidates the device's entities
 * @returns {{ entities: Record<string, string>, fixed: number, lost: string[] } | null}
 */
export function remapMissing(entities, existing, profile, candidates) {
  const missing = Object.entries(entities).filter(([, id]) => id && !existing.has(id)).map(([role]) => role);
  if (!missing.length) return null;
  const kept = Object.fromEntries(Object.entries(entities).filter(([, id]) => id && existing.has(id)));
  const used = new Set(Object.values(kept));
  const suggested = suggestMapping(profile, candidates.filter((c) => !used.has(c.entity_id)));
  /** @type {Record<string, string>} */
  const out = { ...kept };
  const lost = [];
  for (const role of missing) {
    if (suggested[role]) out[role] = suggested[role];
    else lost.push(role);
  }
  return { entities: out, fixed: missing.length - lost.length, lost };
}
