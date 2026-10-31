// @ts-check
// Discovery: list ESPHome devices, list a device's entities, and guess which entity plays
// which profile role. The guesses are only suggestions; the user confirms them in setup.

import { expandRoles } from '../profiles/profile.js';

/** @param {string} s */
export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Devices that have at least one ESPHome entity.
 * @param {import('./connection.js').HaApi} api
 * @returns {Promise<Array<{ id: string, name: string, model?: string }>>}
 */
export async function listEsphomeDevices(api) {
  const [devices, entities] = await Promise.all([api.deviceRegistry(), api.entityRegistry()]);
  const esphome = new Set(entities.filter((/** @type {any} */ e) => e.platform === 'esphome' && e.device_id).map((/** @type {any} */ e) => e.device_id));
  return devices
    .filter((/** @type {any} */ d) => esphome.has(d.id))
    .map((/** @type {any} */ d) => ({ id: d.id, name: d.name_by_user || d.name || d.id, model: d.model }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @typedef {{ entity_id: string, domain: string, name: string, object: string, state: any }} DeviceEntity
 * @param {import('./connection.js').HaApi} api @param {string} deviceId
 * @returns {Promise<DeviceEntity[]>}
 */
export async function deviceEntities(api, deviceId) {
  const [entities, states] = await Promise.all([api.entityRegistry(), api.getStates()]);
  const byId = new Map(states.map((/** @type {any} */ s) => [s.entity_id, s]));
  return entities
    .filter((/** @type {any} */ e) => e.device_id === deviceId && !e.disabled_by)
    .map((/** @type {any} */ e) => {
      const state = byId.get(e.entity_id);
      return {
        entity_id: e.entity_id,
        domain: e.entity_id.split('.')[0],
        name: e.name || e.original_name || state?.attributes?.friendly_name || e.entity_id,
        object: e.entity_id.split('.')[1],
        state,
      };
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
