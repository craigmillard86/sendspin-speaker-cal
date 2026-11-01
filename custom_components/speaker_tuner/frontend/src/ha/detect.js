// @ts-check
// Which board a discovered ESPHome device is, and which profile fits it best.
//
// Home Assistant names the board only when the firmware sets an ESPHome `project:` (Sonocotta's
// factory images do: manufacturer "sonocotta", model "louder-esp32s3-sendspin"). Configs without
// one report "Espressif" and the chip, so the board family is recognised from the entities its
// DAC component creates, and the chip from the model.

import { expandRoles } from '../profiles/profile.js';
import { suggestMapping } from './discover.js';

/**
 * @typedef {{ id: string, name: string, dac: string, power?: string, chips?: string[], tunable: boolean, why?: string, component?: string, project: string }} BoardFamily
 * @typedef {{ maker: string, source?: string, families: BoardFamily[], components: Record<string, { name: string, fingerprint: string[], min: number }> }} BoardCatalogue
 * @typedef {{
 *   maker: string, family: BoardFamily | null, candidates: BoardFamily[], chip: string | null,
 *   confidence: 'certain' | 'likely' | 'none', components: string[], tunable: boolean | null,
 *   name: string, reasons: string[]
 * }} Detection
 */

/** "esp32-s3", "esp32-s3-devkitc-1", "ESP32S3" → "esp32-s3"; "esp32", "esp32dev" → "esp32". @param {string | undefined} model */
export function chipOf(model) {
  const m = String(model ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!m.startsWith('esp32')) return null;
  if (m.startsWith('esp32s3')) return 'esp32-s3';
  if (/^esp32(dev|wrover|wroom|pico)?/.test(m) && !/^esp32(s2|c3|c6|h2|p4)/.test(m)) return 'esp32';
  return null;
}

const CHIP_NAME = { esp32: 'ESP32', 'esp32-s3': 'ESP32-S3' };

/**
 * Which known DAC components a device's entities show.
 * @param {Array<{ name: string, object?: string }>} entities @param {BoardCatalogue} catalogue
 */
export function componentsOf(entities, catalogue) {
  const names = entities.map((e) => `${e.name} ${String(e.object ?? '').replace(/_/g, ' ')}`.toLowerCase());
  return Object.entries(catalogue.components)
    .filter(([, c]) => c.fingerprint.filter((f) => names.some((n) => n.includes(f))).length >= c.min)
    .map(([id]) => id);
}

/**
 * @param {{ manufacturer?: string, model?: string, name?: string }} device registry device (root)
 * @param {Array<{ name: string, object?: string }>} entities the device's entities (sub-devices included)
 * @param {BoardCatalogue} catalogue
 * @returns {Detection}
 */
export function detectBoard(device, entities, catalogue) {
  const maker = catalogue.maker;
  const components = componentsOf(entities, catalogue);
  const manufacturer = String(device.manufacturer ?? '').toLowerCase();
  const model = String(device.model ?? '').toLowerCase();
  const chip = manufacturer === maker.toLowerCase() ? (/esp32s3/.test(model) ? 'esp32-s3' : /esp32/.test(model) ? 'esp32' : null) : chipOf(model);
  const chipName = chip ? /** @type {Record<string, string>} */ (CHIP_NAME)[chip] : '';
  const withChip = (/** @type {string} */ name) => (chip && !(name.includes('mini') || name.includes('Pro')) ? `${name.replace('-ESP32', `-${chipName}`)}` : name);
  const fork = components.includes('tas58xx-crossover');
  const extras = fork ? ' with the crossover fork' : '';

  // 1. the firmware names its project: certain
  if (manufacturer === maker.toLowerCase()) {
    const family = catalogue.families.find((f) => new RegExp(f.project).test(model)) ?? null;
    if (family) {
      return {
        maker, family, candidates: [family], chip, confidence: 'certain', components, tunable: family.tunable,
        name: `${maker} ${withChip(family.name)}${extras}`,
        reasons: [`its firmware says it is ${maker} "${device.model}"`],
      };
    }
  }

  // 2. a known DAC component's entities, and the chip: the family, not the exact board
  const byComponent = catalogue.families.filter((f) => f.component && components.includes(f.component) && (!chip || !f.chips || f.chips.includes(chip)));
  if (byComponent.length) {
    const comp = catalogue.components[/** @type {string} */ (byComponent[0].component)];
    const names = byComponent.map((f) => withChip(f.name));
    const dacs = [...new Set(byComponent.map((f) => f.dac))].join(' or ');
    return {
      maker, family: byComponent.length === 1 ? byComponent[0] : null, candidates: byComponent, chip, confidence: 'likely', components,
      tunable: byComponent.every((f) => f.tunable) ? true : byComponent.some((f) => f.tunable) ? null : false,
      name: `${maker} ${names.length === 1 ? names[0] : `${names[0]} family`} (${dacs})${extras}`,
      reasons: [
        `it has the ${comp.name} entities`,
        chip ? `it runs on an ${chipName}` : '',
        names.length > 1 ? `it could be: ${names.join(', ')}` : '',
      ].filter(Boolean),
    };
  }

  return {
    maker, family: null, candidates: [], chip, confidence: 'none', components, tunable: null,
    name: chip ? `${chipName} device` : 'Unknown device',
    reasons: ['no known board or DAC component recognised'],
  };
}

/**
 * Every profile, best fit first: how many of its settings the device has (weighted by the
 * share found, so a small generic profile doesn't win on a large build), ties broken by the
 * detected components.
 * @param {Record<string, import('../profiles/profile.js').Profile>} profiles
 * @param {import('./discover.js').DeviceEntity[]} entities
 * @param {string[]} [components] from detectBoard
 * @returns {Array<{ id: string, found: number, total: number, score: number }>}
 */
export function rankProfiles(profiles, entities, components = []) {
  return Object.values(profiles)
    .map((p) => {
      const total = Object.keys(expandRoles(p)).length;
      const found = Object.keys(suggestMapping(p, entities)).length;
      const family = components.includes(p.component) ? 1 : 0;
      return { id: p.id, found, total, score: total ? found * (found / total) + family : 0 };
    })
    .sort((a, b) => b.score - a.score);
}
