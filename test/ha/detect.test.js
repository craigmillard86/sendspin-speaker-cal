import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectBoard, rankProfiles, chipOf } from '../../custom_components/speaker_tuner/frontend/src/ha/detect.js';
import { deviceEntities, listEsphomeDevices } from '../../custom_components/speaker_tuner/frontend/src/ha/discover.js';

const FE = '../../custom_components/speaker_tuner/frontend/';
const json = (/** @type {string} */ p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const catalogue = json(`${FE}boards/sonocotta.json`);
const registry = json('../fixtures/registry-louder-s3-cab.json');
const api = { deviceRegistry: async () => registry.devices, entityRegistry: async () => registry.entities, getStates: async () => [] };
const profiles = Object.fromEntries(['louder-tas5805m-crossover', 'generic-single-driver-peq', 'tas58xx-15band-graphic']
  .map((id) => [id, json(`${FE}profiles/${id}.json`)]));

test('chip from the model Home Assistant shows', () => {
  assert.equal(chipOf('esp32-s3'), 'esp32-s3');
  assert.equal(chipOf('esp32-s3-devkitc-1'), 'esp32-s3');
  assert.equal(chipOf('esp32dev'), 'esp32');
  assert.equal(chipOf('esp32'), 'esp32');
  assert.equal(chipOf('esp32-c3'), null);
  assert.equal(chipOf('Bulb'), null);
});

test('a speaker without project: is recognised from its entities and chip (real registry)', async () => {
  const [speaker] = await listEsphomeDevices(api);
  assert.equal(speaker.manufacturer, 'Espressif');
  const entities = await deviceEntities(api, speaker.id);
  const d = detectBoard(speaker, entities, catalogue);
  assert.equal(d.confidence, 'likely');
  assert.equal(d.chip, 'esp32-s3');
  assert.deepEqual(d.components.sort(), ['tas58xx', 'tas58xx-crossover']);
  assert.ok(d.candidates.some((f) => f.id === 'louder'));
  assert.ok(!d.candidates.some((f) => f.id === 'hifi'), 'no-DSP boards are never guessed from entities');
  assert.match(d.name, /Louder-ESP32-S3 family \(TAS5805M or TAS5825M\) with the crossover fork/);
  assert.equal(d.tunable, true);
});

test('the crossover profile ranks first for the real speaker', async () => {
  const [speaker] = await listEsphomeDevices(api);
  const entities = await deviceEntities(api, speaker.id);
  const d = detectBoard(speaker, entities, catalogue);
  const ranked = rankProfiles(profiles, entities, d.components);
  assert.equal(ranked[0].id, 'louder-tas5805m-crossover');
  assert.equal(ranked[0].found, ranked[0].total - 1); // all but tuning mode, which this build doesn't have
  assert.ok(ranked[0].score > ranked[1].score * 2);
});

test('factory firmware names the exact board', () => {
  const d = detectBoard({ manufacturer: 'sonocotta', model: 'louder-esp32s3-plus-sendspin-eth' }, [], catalogue);
  assert.equal(d.confidence, 'certain');
  assert.equal(d.family?.id, 'louder-plus');
  assert.equal(d.chip, 'esp32-s3');
  assert.equal(d.name, 'Sonocotta Louder-ESP32-S3-Plus');
  const pro = detectBoard({ manufacturer: 'sonocotta', model: 'louder-esp32s3-pro-sendspin-tft' }, [], catalogue);
  assert.equal(pro.family?.id, 'louder-pro');
  const mini = detectBoard({ manufacturer: 'sonocotta', model: 'louder-esp32s3-mini-42-sendspin' }, [], catalogue);
  assert.equal(mini.family?.id, 'louder-mini');
});

test('a board without DSP says it cannot be tuned', () => {
  const d = detectBoard({ manufacturer: 'sonocotta', model: 'hifi-esp32-sendspin' }, [], catalogue);
  assert.equal(d.family?.id, 'hifi');
  assert.equal(d.tunable, false);
  assert.match(d.family?.why ?? '', /no adjustable DSP/);
});

test('an unknown device is reported as such', () => {
  const d = detectBoard({ manufacturer: 'Espressif', model: 'esp32dev' }, [{ name: 'Living room light' }], catalogue);
  assert.equal(d.confidence, 'none');
  assert.equal(d.name, 'ESP32 device');
});
