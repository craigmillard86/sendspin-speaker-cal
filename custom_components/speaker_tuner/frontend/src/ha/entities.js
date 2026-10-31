// @ts-check
// Converting between HA entity states and role values, and the service calls that set them.

/**
 * Role value from an HA state object, or null if unavailable.
 * number/sensor: number, switch: boolean, select: option label, media_player: state string.
 * @param {string} domain @param {any} state
 */
export function valueFromState(domain, state) {
  if (!state || state.state === 'unavailable' || state.state === 'unknown') return null;
  switch (domain) {
    case 'number':
    case 'sensor': {
      const x = parseFloat(state.state);
      return Number.isFinite(x) ? x : null;
    }
    case 'switch':
      return state.state === 'on';
    default:
      return state.state;
  }
}

/**
 * Range of a number entity: HA's attributes win over the profile's, since they come from
 * the device itself (e.g. the crossover frequency minimum is the YAML tweeter_min_frequency).
 * @param {import('../profiles/profile.js').RoleSpec} spec @param {any} [state]
 */
export function numberRange(spec, state) {
  const a = state?.attributes ?? {};
  return {
    min: Number.isFinite(a.min) ? a.min : spec.min ?? -Infinity,
    max: Number.isFinite(a.max) ? a.max : spec.max ?? Infinity,
    step: Number.isFinite(a.step) ? a.step : spec.step ?? 0,
  };
}

/** Options a select entity offers, from HA, else the profile. */
export function selectOptions(/** @type {import('../profiles/profile.js').RoleSpec} */ spec, /** @type {any} */ state) {
  return state?.attributes?.options ?? Object.values(spec.options ?? {});
}

/**
 * Clamp and quantise a number to what the entity accepts.
 * @param {number} value @param {{ min: number, max: number, step: number }} r
 */
export function fitToRange(value, r) {
  let v = Math.min(r.max, Math.max(r.min, value));
  if (r.step > 0 && Number.isFinite(r.min)) v = Math.round((v - r.min) / r.step) * r.step + r.min;
  else if (r.step > 0) v = Math.round(v / r.step) * r.step;
  v = Math.round(v * 1e6) / 1e6;
  return Math.min(r.max, Math.max(r.min, v));
}

/**
 * Whether an entity already holds a value.
 * @param {string} domain @param {any} current @param {any} wanted @param {number} [step]
 */
export function sameValue(domain, current, wanted, step = 0) {
  if (current === null || current === undefined) return false;
  if (domain === 'number') return Math.abs(Number(current) - Number(wanted)) <= Math.max(step / 2, 1e-6);
  return current === wanted;
}

/**
 * The service call that sets a role value.
 * @param {string} domain @param {string} entityId @param {any} value
 * @returns {{ domain: string, service: string, data: Record<string, any>, target: { entity_id: string } }}
 */
export function serviceFor(domain, entityId, value) {
  const target = { entity_id: entityId };
  switch (domain) {
    case 'number':
      return { domain: 'number', service: 'set_value', data: { value }, target };
    case 'switch':
      return { domain: 'switch', service: value ? 'turn_on' : 'turn_off', data: {}, target };
    case 'select':
      return { domain: 'select', service: 'select_option', data: { option: value }, target };
    case 'button':
      return { domain: 'button', service: 'press', data: {}, target };
    default:
      throw new Error(`Cannot set a ${domain} entity`);
  }
}
