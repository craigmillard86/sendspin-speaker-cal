// @ts-check
// Read a speaker's ESPHome YAML: what board and DAC it is, which entities it exposes, the
// tuning values it starts from, and turn it into a profile whose export is that same file
// with the tuned values filled in. Secrets are replaced by !secret references before the
// YAML is kept anywhere.

import { Type, DEFAULT_SCHEMA, load } from '../../vendor/js-yaml.mjs';
import { expandRoles, optionLabel } from './profile.js';

/** ESPHome's own tags, kept as opaque values: the tool never follows includes or runs lambdas. */
const TAGS = ['!secret', '!lambda', '!include', '!extend', '!remove', '!env_var', '!include_dir_named', '!include_dir_list', '!include_dir_merge_list', '!include_dir_merge_named', '!force'];
const SCHEMA = DEFAULT_SCHEMA.extend(TAGS.flatMap((tag) => (/** @type {const} */ (['scalar', 'sequence', 'mapping'])).map((kind) => new Type(tag, { kind, construct: (value) => ({ $tag: tag, value }) }))));

/**
 * @typedef {{ domain: string, key: string, platform: string, name: string, device_id?: string }} YamlEntity
 * @typedef {{
 *   name: string, friendlyName: string, project: string | null, chip: string | null,
 *   externalComponents: string[], packages: string[], dac: { platform: string, chip: string | null } | null,
 *   crossover: Record<string, any> | null, entities: YamlEntity[], subDevices: Array<{ id: string, name: string }>,
 *   includes: string[], substitutions: Record<string, string>,
 * }} YamlAnalysis
 */

/** @param {string} text */
export function parseEsphomeYaml(text) {
  try {
    return /** @type {Record<string, any>} */ (load(text, { schema: SCHEMA }) ?? {});
  } catch (e) {
    throw new Error(`That file isn't YAML the tool can read: ${/** @type {Error} */ (e).message.split('\n')[0]}`);
  }
}

/** @param {any} v @param {Record<string, string>} subs */
function resolve(v, subs) {
  if (typeof v !== 'string') return v;
  return v.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => (subs[a ?? b] !== undefined ? String(subs[a ?? b]) : m));
}

/** @param {any} v */
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * What the YAML describes.
 * @param {string} text
 * @returns {YamlAnalysis}
 */
export function analyseEsphomeYaml(text) {
  const doc = parseEsphomeYaml(text);
  /** @type {Record<string, string>} */
  const subs = Object.fromEntries(Object.entries(doc.substitutions ?? {}).map(([k, v]) => [k, typeof v === 'object' ? '' : String(v)]));
  const es = doc.esphome ?? {};
  const esp = doc.esp32 ?? {};
  const variant = String(resolve(esp.variant ?? esp.board ?? '', subs)).toLowerCase().replace(/[^a-z0-9]/g, '');
  const chip = variant.startsWith('esp32s3') ? 'esp32-s3' : variant.startsWith('esp32') || doc.esp32 ? 'esp32' : null;
  const externalComponents = asList(doc.external_components).map((c) => {
    const src = c?.source;
    if (typeof src === 'string') return resolve(src, subs);
    if (src && typeof src === 'object') return `${src.url ?? src.path ?? ''}${src.ref ? `@${src.ref}` : ''}`;
    return '';
  }).filter(Boolean);
  const packages = Object.values(doc.packages ?? {}).map((p) => (typeof p === 'string' ? p : p?.$tag ? `${p.$tag} ${JSON.stringify(p.value)}` : p?.url ? `${p.url}${p.files ? ` ${JSON.stringify(p.files)}` : ''}` : JSON.stringify(p)));
  const dacItem = asList(doc.audio_dac).find((d) => d?.platform);
  /** @type {YamlEntity[]} */
  const entities = [];
  for (const domain of ['number', 'select', 'switch', 'button', 'sensor', 'binary_sensor', 'media_player']) {
    for (const item of asList(doc[domain])) {
      if (!item || typeof item !== 'object') continue;
      if (item.name) entities.push({ domain, key: item.id ?? '', platform: item.platform ?? '', name: String(resolve(item.name, subs)), device_id: item.device_id });
      // components like tas58xx list several entities under one platform entry
      for (const [key, sub] of Object.entries(item)) {
        if (sub && typeof sub === 'object' && !Array.isArray(sub) && !sub.$tag && 'name' in sub) {
          entities.push({ domain, key, platform: item.platform ?? '', name: String(resolve(sub.name, subs)), device_id: sub.device_id });
        }
      }
    }
  }
  const includes = JSON.stringify(doc).match(/"!include[a-z_]*"/g) ? ['!include'] : [];
  if (doc.packages) includes.push('packages:');
  return {
    name: String(resolve(es.name ?? '', subs)),
    friendlyName: String(resolve(es.friendly_name ?? es.name ?? '', subs)),
    project: es.project?.name ? String(resolve(es.project.name, subs)) : null,
    chip,
    externalComponents,
    packages,
    dac: dacItem ? { platform: dacItem.platform, chip: dacItem.tas58xx_dac ? String(resolve(dacItem.tas58xx_dac, subs)) : null } : null,
    crossover: dacItem?.crossover && typeof dacItem.crossover === 'object' ? dacItem.crossover : null,
    entities,
    subDevices: asList(es.devices).map((d) => ({ id: String(d?.id ?? ''), name: String(resolve(d?.name ?? '', subs)) })),
    includes,
    substitutions: subs,
  };
}

const SECRET_KEY = /^(password|ssid|psk|key|encryption_key|api_key|token|api_password|ota_password|ap_password|wifi_password)$/i;

/**
 * Replace literal secrets with !secret references, so the YAML can be stored and shared.
 * Values that already are !secret or ${substitution} are left alone.
 * @param {string} text
 * @returns {{ text: string, redacted: string[] }}
 */
export function redactSecrets(text) {
  /** @type {Array<{ indent: number, key: string }>} */
  const stack = [];
  /** @type {string[]} */
  const redacted = [];
  const lines = text.split(/\r?\n/).map((line) => {
    const m = /^(\s*)(-\s+)?([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return line;
    const indent = m[1].length + (m[2]?.length ?? 0);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = m[3];
    const value = m[4].replace(/\s+#.*$/, '').trim();
    stack.push({ indent, key });
    if (!SECRET_KEY.test(key) || !value || value.startsWith('!secret') || value.startsWith('${') || value.startsWith('$') || value === '|' || value === '>') return line;
    const parent = stack.length > 1 ? stack[stack.length - 2].key : '';
    const name = `${parent ? `${parent}_` : ''}${key}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    redacted.push(name);
    return `${m[1]}${m[2] ?? ''}${key}: !secret ${name}`;
  });
  return { text: lines.join('\n'), redacted };
}

/** "2500Hz" → 2500, "-3dB" → -3, "5.0" → 5. @param {any} v */
function num(v) {
  if (typeof v === 'number') return v;
  const m = /^\s*(-?[\d.]+)/.exec(String(v));
  return m ? Number(m[1]) : NaN;
}

/** Crossover block keys whose role name differs. */
const CROSSOVER_ROLE = { frequency: 'crossover_frequency', filter: 'crossover_filter', tweeter_channel: 'crossover_tweeter_channel' };

/**
 * The tuning values the YAML's crossover: block starts the speaker with, as role values
 * (selects as their Home Assistant labels). Only roles the profile has.
 * @param {YamlAnalysis} a @param {import('./profile.js').Profile} profile
 */
export function crossoverValues(a, profile) {
  const roles = expandRoles(profile);
  /** @type {Record<string, any>} */
  const out = {};
  if (!a.crossover) return out;
  /** @param {string} role @param {any} raw */
  const put = (role, raw) => {
    const spec = roles[role];
    if (!spec) return;
    const v = resolve(raw, a.substitutions);
    if (spec.domain === 'number') {
      const n = num(v);
      if (Number.isFinite(n)) out[role] = n;
    } else if (spec.domain === 'switch') out[role] = v === true || String(v).toLowerCase() === 'true';
    else if (spec.domain === 'select') {
      const code = String(v);
      const hit = Object.entries(spec.options ?? {}).find(([k]) => k.toLowerCase() === code.toLowerCase());
      out[role] = hit ? hit[1] : optionLabel(spec.options, code);
    }
  };
  for (const [k, v] of Object.entries(a.crossover)) {
    if (k in CROSSOVER_ROLE) put(/** @type {any} */ (CROSSOVER_ROLE)[k], v);
    else if ((k === 'tweeter_notch' || k === 'linkwitz') && v && typeof v === 'object') {
      for (const [sub, x] of Object.entries(v)) put(`${k}_${sub}`, x);
    } else if (/_peq$/.test(k) && Array.isArray(v)) {
      v.forEach((band, i) => {
        for (const [field, x] of Object.entries(band ?? {})) put(`${k}_${i + 1}_${field}`, x);
      });
    } else put(k, v);
  }
  return out;
}

/**
 * The crossover block of a profile's snippet template, with its ${xo_…} substitutions
 * replaced by the {{placeholders}} they stand for, so it can go straight into a full file.
 * @param {string} template @returns {{ block: string, indent: number } | null}
 */
function crossoverBlockOf(template) {
  /** @type {Record<string, string>} */
  const subs = {};
  for (const m of template.matchAll(/^ {2}(\w+): "([^"]*)"$/gm)) subs[m[1]] = m[2];
  const start = template.search(/^(\s*)crossover:\s*$/m);
  if (start < 0) return null;
  const block = template.slice(start).replace(/\$\{(\w+)\}/g, (m, k) => subs[k] ?? m).replace(/\s+$/, '');
  return { block, indent: /^(\s*)/.exec(block)?.[1].length ?? 0 };
}

/**
 * Where the crossover: block under the DAC sits in the user's text: [start, end) line indexes.
 * @param {string[]} lines
 */
function findCrossover(lines) {
  let inDac = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^audio_dac:/.test(lines[i])) inDac = true;
    else if (/^[A-Za-z_]/.test(lines[i])) inDac = false;
    const m = /^(\s+)crossover:\s*(#.*)?$/.exec(lines[i]);
    if (inDac && m) {
      const indent = m[1].length;
      let end = i + 1;
      while (end < lines.length && (lines[end].trim() === '' || (/^(\s*)/.exec(lines[end])?.[1].length ?? 0) > indent)) end++;
      while (end > i + 1 && lines[end - 1].trim() === '') end--; // keep blank lines after the block
      return { start: i, end, indent };
    }
  }
  return null;
}

/**
 * A full-file template: the user's (redacted) YAML with its crossover: block replaced by the
 * base profile's block, so the export is the user's own file with the tuned values in it.
 * Literal "{{" in the user's YAML (C++ in lambdas) is kept through the {{_lb}} placeholder.
 * @param {string} text redacted YAML @param {string} baseTemplate
 * @returns {string | null} null when the YAML has no crossover block to fill
 */
export function fullTemplate(text, baseTemplate) {
  const base = crossoverBlockOf(baseTemplate);
  const lines = text.replace(/\{\{/g, '{{_lb}}').split(/\r?\n/);
  const at = findCrossover(lines);
  if (!base || !at) return null;
  const shift = at.indent - base.indent;
  const block = base.block.split('\n').map((l) => (shift >= 0 ? ' '.repeat(shift) + l : l.slice(Math.min(-shift, /^(\s*)/.exec(l)?.[1].length ?? 0))));
  const header = [
    '# Speaker Tuner {{tool_version}}: {{profile_name}}',
    '# {{device_name}}, exported {{date}}. This is your YAML with the crossover: block filled in with',
    '# the tuned values. Flash it, then press "Reset Crossover to YAML" so these replace the values',
    '# saved on the device.',
    '',
  ];
  return [...header, ...lines.slice(0, at.start), ...block, ...lines.slice(at.end)].join('\n');
}

/**
 * A profile for this speaker, built from its YAML on top of the shipped profile of the same
 * kind: the YAML's starting values become the recommended settings, its file the export.
 * @param {string} rawText the uploaded YAML
 * @param {Record<string, import('./profile.js').Profile>} profiles the shipped/known profiles
 * @param {{ board?: { name: string, confidence: string } | null, now?: Date }} [meta]
 */
export function profileFromYaml(rawText, profiles, { board = null, now = new Date() } = {}) {
  const { text, redacted } = redactSecrets(rawText);
  const a = analyseEsphomeYaml(text);
  const hasCrossover = !!a.crossover || a.entities.some((e) => e.key === 'crossover_frequency');
  const isTas = a.dac?.platform === 'tas58xx' || a.externalComponents.some((c) => /esphome-tas58xx/.test(c));
  const baseId = hasCrossover ? 'louder-tas5805m-crossover' : isTas ? 'tas58xx-15band-graphic' : 'generic-single-driver-peq';
  const base = profiles[baseId];
  if (!base) throw new Error(`The base profile ${baseId} isn't loaded.`);
  const slug = (a.name || a.friendlyName || 'speaker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const full = base.yaml_template ? fullTemplate(text, base.yaml_template) : null;
  const values = crossoverValues(a, base);
  /** @type {any} */
  const profile = structuredClone(base);
  // PEQ bands: as many as the YAML exposes per bank
  for (const bank of profile.peq_banks ?? []) {
    if (bank.type === 'graphic') continue;
    const n = Math.max(0, ...a.entities.map((e) => new RegExp(`^${bank.role_prefix}(\\d+)_gain$`).exec(e.key)).filter(Boolean).map((m) => Number(/** @type {RegExpExecArray} */ (m)[1])));
    if (n > 0) bank.bands = Math.min(bank.bands ?? n, n);
  }
  Object.assign(profile, {
    id: `yaml-${slug}`,
    name: `${a.friendlyName || a.name || 'My speaker'} (from its YAML)`,
    version: 1,
    notes: `Built from ${a.friendlyName || a.name || 'the speaker'}'s ESPHome YAML on ${now.toISOString().slice(0, 10)}, on top of "${base.name}".${redacted.length ? ` Secrets replaced by !secret: ${redacted.join(', ')}.` : ''}`,
    based_on: base.id,
    source: { kind: 'esphome-yaml', name: a.name, friendly_name: a.friendlyName, project: a.project, chip: a.chip, dac: a.dac?.chip ?? a.dac?.platform ?? null, components: a.externalComponents, packages: a.packages },
    ...(board ? { board } : {}),
    ...(full ? { yaml_template: full } : {}),
    recommended: Object.keys(values).length ? { values, source: 'yaml', tuned_with: null, date: now.toISOString() } : undefined,
  });
  if (!profile.recommended) delete profile.recommended;
  return {
    profile,
    analysis: a,
    redacted,
    fullFile: !!full,
    summary: [
      a.friendlyName || a.name,
      a.chip?.toUpperCase().replace('ESP32-S3', 'ESP32-S3'),
      a.dac ? (a.dac.chip ?? a.dac.platform.toUpperCase()) : null,
      hasCrossover ? 'crossover fork' : null,
      (profile.peq_banks ?? []).filter((/** @type {any} */ b) => b.type !== 'graphic' && !b.mirror_of).map((/** @type {any} */ b) => b.bands).join(' + ') + ' PEQ bands',
      a.subDevices.length ? `${a.subDevices.length} sub-devices` : null,
      redacted.length ? `${redacted.length} secret${redacted.length === 1 ? '' : 's'} kept as !secret` : null,
    ].filter(Boolean).join(' · '),
    warnings: [
      ...(a.includes.length ? ['It uses packages: or !include, which the tool can\'t follow: settings defined in those files are not part of this profile, and the export keeps those lines as they are.'] : []),
      ...(!full && base.yaml_template ? ['No crossover: block was found under audio_dac:, so the export stays a snippet to paste in.'] : []),
    ],
  };
}
