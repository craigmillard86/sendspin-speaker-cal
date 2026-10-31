// @ts-check
// Speaker profiles: what a speaker type can do, independent of anyone's entity IDs.
//
// A profile lists its roles (things the tool can read or write, like "crossover_frequency"),
// each with the HA domain, value range and name hints used by discovery. PEQ band roles are
// generated from `peq_banks`, e.g. bank prefix "mid_peq_" with 6 bands gives
// mid_peq_1_frequency ... mid_peq_6_type. A device mapping (device-mapping.js) then links
// roles to the entity IDs of one actual speaker.

/**
 * @typedef {'number' | 'switch' | 'select' | 'button' | 'sensor' | 'media_player'} Domain
 * @typedef {{ domain: Domain, label?: string, group?: string, min?: number, max?: number, step?: number,
 *   unit?: string, options?: Record<string, string>, hints?: string[], default?: any, bank?: string, band?: number,
 *   field?: string }} RoleSpec
 * @typedef {{ min: number, max: number, step: number }} Range
 * @typedef {{ id: string, name?: string, type: 'parametric' | 'graphic', bands?: number, role_prefix: string,
 *   domain?: 'below_crossover' | 'above_crossover' | 'full', ranges?: { frequency: Range, gain: Range, q: Range },
 *   type_options?: Record<string, string>, frequencies?: number[], q?: number[], gain?: Range }} PeqBank
 * @typedef {{ id: string, name: string, version?: number, component: string, enclosure?: 'sealed' | 'ported' | 'passive_radiator',
 *   dsp_sample_rate?: number, drivers?: Array<{ id: string, name: string }>,
 *   crossover?: { filter_options: Record<string, string> }, peq_banks: PeqBank[], roles: Record<string, RoleSpec>,
 *   defaults?: Record<string, any>, yaml_template?: string, notes?: string }} Profile
 */

const DEFAULT_PEQ_RANGES = {
  frequency: { min: 20, max: 20000, step: 1 },
  gain: { min: -15, max: 15, step: 0.5 },
  q: { min: 0.1, max: 10, step: 0.05 },
};
const DEFAULT_TYPE_OPTIONS = { peaking: 'Peaking', low_shelf: 'Low Shelf', high_shelf: 'High Shelf' };

/** @param {string} s */
const title = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * All roles of a profile, with the PEQ band roles generated.
 * @param {Profile} profile
 * @returns {Record<string, RoleSpec>}
 */
export function expandRoles(profile) {
  /** @type {Record<string, RoleSpec>} */
  const roles = { ...profile.roles };
  for (const bank of profile.peq_banks ?? []) {
    if (bank.type === 'graphic') {
      (bank.frequencies ?? []).forEach((f, i) => {
        const key = `${bank.role_prefix}${i + 1}_gain`;
        const g = bank.gain ?? { min: -15, max: 15, step: 1 };
        roles[key] = {
          domain: 'number', label: `${bank.name ?? bank.id} ${f} Hz`, group: bank.id, bank: bank.id, band: i + 1, field: 'gain',
          min: g.min, max: g.max, step: g.step, unit: 'dB', hints: [key], ...profile.roles[key],
        };
      });
      continue;
    }
    const ranges = { ...DEFAULT_PEQ_RANGES, ...bank.ranges };
    for (let n = 1; n <= (bank.bands ?? 0); n++) {
      const base = `${bank.role_prefix}${n}_`;
      const label = `${bank.name ?? title(bank.id)} PEQ ${n}`;
      for (const field of /** @type {const} */ (['frequency', 'gain', 'q'])) {
        roles[base + field] = {
          domain: 'number', label: `${label} ${field === 'q' ? 'Q' : title(field)}`, group: bank.id, bank: bank.id, band: n, field,
          ...ranges[field], unit: field === 'frequency' ? 'Hz' : field === 'gain' ? 'dB' : undefined,
          hints: [base + field], ...profile.roles[base + field],
        };
      }
      roles[`${base}type`] = {
        domain: 'select', label: `${label} Type`, group: bank.id, bank: bank.id, band: n, field: 'type',
        options: bank.type_options ?? DEFAULT_TYPE_OPTIONS, hints: [`${base}type`], ...profile.roles[`${base}type`],
      };
    }
  }
  return roles;
}

/**
 * Roles that hold a DSP setting (written, snapshotted, reverted and exported).
 * Mutes, buttons, sensors and the media player are excluded.
 * @param {Profile} profile
 */
export function settingRoles(profile) {
  return Object.entries(expandRoles(profile))
    .filter(([key, r]) => (r.domain === 'number' || r.domain === 'switch' || r.domain === 'select') && !key.endsWith('_mute') && key !== 'tuning_mode')
    .map(([key]) => key);
}

/** @param {Record<string, string> | undefined} options @param {string} label */
export function optionCode(options, label) {
  if (!options) return label;
  const hit = Object.entries(options).find(([, v]) => v === label);
  return hit ? hit[0] : label;
}

/** @param {Record<string, string> | undefined} options @param {string} code */
export function optionLabel(options, code) {
  return options?.[code] ?? code;
}

/**
 * Value of a role: the mapped entity value if there is one, otherwise the profile default.
 * @param {Profile} profile @param {Record<string, any>} values @param {string} role
 */
function valueOf(profile, values, role) {
  if (values[role] !== undefined && values[role] !== null) return values[role];
  const spec = expandRoles(profile)[role];
  return profile.defaults?.[role] ?? spec?.default;
}

/**
 * PEQ filters of a bank from role values. Bands with 0 dB gain are left out.
 * @param {Profile} profile @param {Record<string, any>} values @param {string} bankId
 * @returns {Array<{ band: number, f: number, gain: number, q: number, type: 'peaking' | 'low_shelf' | 'high_shelf' }>}
 */
export function bankFilters(profile, values, bankId) {
  const bank = profile.peq_banks.find((b) => b.id === bankId);
  if (!bank) return [];
  const out = [];
  if (bank.type === 'graphic') {
    (bank.frequencies ?? []).forEach((f, i) => {
      const g = Number(valueOf(profile, values, `${bank.role_prefix}${i + 1}_gain`) ?? 0);
      if (g) out.push({ band: i + 1, f, gain: g, q: bank.q?.[i] ?? 1, type: /** @type {const} */ ('peaking') });
    });
    return out;
  }
  for (let n = 1; n <= (bank.bands ?? 0); n++) {
    const p = `${bank.role_prefix}${n}_`;
    const gain = Number(valueOf(profile, values, `${p}gain`) ?? 0);
    if (!gain) continue;
    const type = /** @type {any} */ (optionCode(bank.type_options ?? DEFAULT_TYPE_OPTIONS, valueOf(profile, values, `${p}type`) ?? 'Peaking'));
    out.push({
      band: n,
      f: Number(valueOf(profile, values, `${p}frequency`) ?? 1000),
      gain,
      q: Number(valueOf(profile, values, `${p}q`) ?? 1),
      type: ['peaking', 'low_shelf', 'high_shelf'].includes(type) ? type : 'peaking',
    });
  }
  return out;
}

/**
 * Role values for a bank from fitted filters: filters fill bands 1..n in frequency order,
 * the remaining bands get 0 dB (off). Parametric banks only.
 * @param {Profile} profile @param {string} bankId
 * @param {Array<{ f: number, gain: number, q: number }>} filters
 */
export function bankValues(profile, bankId, filters) {
  const bank = profile.peq_banks.find((b) => b.id === bankId);
  if (!bank || bank.type === 'graphic') throw new Error(`No parametric bank ${bankId}`);
  const roles = expandRoles(profile);
  /** @type {Record<string, any>} */
  const out = {};
  const sorted = [...filters].sort((a, b) => a.f - b.f);
  if (sorted.length > (bank.bands ?? 0)) throw new Error(`Bank ${bankId} has ${bank.bands} bands, got ${sorted.length} filters`);
  for (let n = 1; n <= (bank.bands ?? 0); n++) {
    const p = `${bank.role_prefix}${n}_`;
    const f = sorted[n - 1];
    out[`${p}gain`] = f ? f.gain : 0;
    if (f) {
      out[`${p}frequency`] = f.f;
      out[`${p}q`] = f.q;
      out[`${p}type`] = optionLabel(roles[`${p}type`].options, 'peaking');
    }
  }
  return out;
}

/**
 * Role values to the fork's crossover: settings (YAML keys), for prediction and export.
 * Only for profiles with component "tas58xx-crossover".
 * @param {Profile} profile @param {Record<string, any>} values
 */
export function crossoverSettings(profile, values) {
  const roles = expandRoles(profile);
  const v = (/** @type {string} */ role) => valueOf(profile, values, role);
  const num = (/** @type {string} */ role, /** @type {number} */ fallback = 0) => {
    const x = Number(v(role));
    return Number.isFinite(x) ? x : fallback;
  };
  const bool = (/** @type {string} */ role) => v(role) === true || v(role) === 'on';
  const peq = (/** @type {string} */ bankId) =>
    bankFilters(profile, values, bankId).map((p) => ({ frequency: p.f, gain: p.gain, q: p.q, type: p.type.toUpperCase() }));
  return {
    filter: optionCode(profile.crossover?.filter_options, v('crossover_filter') ?? 'LR4 24dB/oct'),
    frequency: num('crossover_frequency', 2500),
    tweeter_min_frequency: num('tweeter_min_frequency', 500),
    tweeter_gain: num('tweeter_gain'),
    mid_gain: num('mid_gain'),
    tweeter_invert: bool('tweeter_invert'),
    mid_invert: bool('mid_invert'),
    tweeter_delay: num('tweeter_delay'),
    mid_delay: num('mid_delay'),
    tweeter_peq: peq('tweeter'),
    mid_peq: peq('mid'),
    subsonic_frequency: num('subsonic_frequency'),
    baffle_width: num('baffle_width'),
    baffle_placement: optionCode(roles.baffle_placement?.options, v('baffle_placement') ?? 'Freestanding'),
    tweeter_notch: { frequency: num('tweeter_notch_frequency'), gain: num('tweeter_notch_gain'), q: num('tweeter_notch_q', 5) },
    air_gain: num('air_gain'),
    linkwitz: { f0: num('linkwitz_f0'), q0: num('linkwitz_q0', 0.707), fp: num('linkwitz_fp'), qp: num('linkwitz_qp', 0.5) },
    headroom_compensation: bool('headroom_compensation'),
    loudness: bool('loudness'),
    loudness_reference: num('loudness_reference'),
    dsp_sample_rate: profile.dsp_sample_rate ?? 96000,
  };
}

/**
 * Cheap structural check, with messages a user can act on. The full JSON Schema lives in
 * schema/profile.schema.json and is checked by validate.js.
 * @param {any} p
 * @returns {Profile}
 */
export function checkProfile(p) {
  if (!p || typeof p !== 'object') throw new Error('Profile is not a JSON object');
  for (const key of ['id', 'name', 'component']) if (typeof p[key] !== 'string' || !p[key]) throw new Error(`Profile needs a "${key}" string`);
  if (!Array.isArray(p.peq_banks)) throw new Error('Profile needs a "peq_banks" list (it can be empty)');
  if (!p.roles || typeof p.roles !== 'object') throw new Error('Profile needs a "roles" object');
  for (const [key, r] of Object.entries(p.roles)) {
    if (!['number', 'switch', 'select', 'button', 'sensor', 'media_player'].includes(/** @type {any} */ (r)?.domain)) {
      throw new Error(`Role "${key}" needs a domain: number, switch, select, button, sensor or media_player`);
    }
  }
  for (const b of p.peq_banks) {
    if (!b.id || !b.role_prefix) throw new Error('Each PEQ bank needs an "id" and a "role_prefix"');
    if (b.type === 'graphic' ? !Array.isArray(b.frequencies) : !(b.bands > 0)) {
      throw new Error(`PEQ bank "${b.id}" needs ${b.type === 'graphic' ? '"frequencies"' : 'a number of "bands"'}`);
    }
  }
  return p;
}
