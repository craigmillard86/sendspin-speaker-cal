import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyseEsphomeYaml, redactSecrets, profileFromYaml, crossoverValues } from '../../custom_components/speaker_tuner/frontend/src/profiles/esphome-yaml.js';
import { exportYaml } from '../../custom_components/speaker_tuner/frontend/src/profiles/export.js';
import { checkProfile } from '../../custom_components/speaker_tuner/frontend/src/profiles/profile.js';
import { validate } from '../../custom_components/speaker_tuner/frontend/src/profiles/validate.js';
import { suggestMapping, deviceEntities } from '../../custom_components/speaker_tuner/frontend/src/ha/discover.js';

const FE = '../../custom_components/speaker_tuner/frontend/';
const read = (/** @type {string} */ p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const example = read('../fixtures/louder-s3-speaker-cab.yaml');
const profiles = Object.fromEntries(['louder-tas5805m-crossover', 'generic-single-driver-peq', 'tas58xx-15band-graphic']
  .map((id) => [id, JSON.parse(read(`${FE}profiles/${id}.json`))]));

test('the fork example is read: board, DAC, crossover, entities', () => {
  const a = analyseEsphomeYaml(example);
  assert.equal(a.name, 'louder-s3-cab');
  assert.equal(a.friendlyName, 'Louder S3 Cab');
  assert.equal(a.chip, 'esp32-s3');
  assert.deepEqual(a.dac, { platform: 'tas58xx', chip: 'TAS5805M' });
  assert.ok(a.externalComponents.some((c) => c.includes('craigmillard86/esphome-tas58xx')), a.externalComponents.join());
  assert.ok(a.crossover);
  assert.ok(a.entities.some((e) => e.key === 'crossover_frequency' && e.name === 'Crossover Frequency'));
  assert.ok(a.entities.some((e) => e.key === 'tweeter_peq_6_gain'));
});

test('the crossover block becomes recommended values, selects as their labels', () => {
  const v = crossoverValues(analyseEsphomeYaml(example), profiles['louder-tas5805m-crossover']);
  assert.equal(v.crossover_frequency, 2500);
  assert.equal(v.tweeter_gain, -3);
  assert.equal(v.loudness, false);
  assert.equal(v.tweeter_notch_q, 5);
  assert.equal(v.linkwitz_q0, 0.707);
  assert.match(String(v.crossover_filter), /LR4/);
  assert.match(String(v.baffle_placement), /free/i);
});

test('literal secrets become !secret; existing references are left alone', () => {
  const yaml = ['wifi:', '  ssid: "Home"', '  password: "hunter2"', '  ap:', '    password: abc', 'api:', '  encryption:', '    key: "AAAA="', 'ota:', '  - platform: esphome', '    password: !secret ota_password', 'x: ${y}'].join('\n');
  const r = redactSecrets(yaml);
  assert.deepEqual(r.redacted, ['wifi_ssid', 'wifi_password', 'ap_password', 'encryption_key']);
  assert.ok(!/hunter2|abc|AAAA|"Home"/.test(r.text), r.text);
  assert.match(r.text, /password: !secret ota_password/);
  assert.match(r.text, /key: !secret encryption_key/);
});

test('a profile from the YAML: validates, maps the real device, full-file export with tuned values', async () => {
  const withSecret = example.replace(/^wifi:\n/m, 'wifi:\n  ap:\n    password: "letmein"\n');
  const r = profileFromYaml(withSecret, profiles, { now: new Date('2026-11-01') });
  checkProfile(r.profile);
  const schema = JSON.parse(read(`${FE}schema/profile.schema.json`));
  assert.deepEqual(validate(schema, r.profile), []);
  assert.equal(r.profile.id, 'yaml-louder-s3-cab');
  assert.equal(r.profile.based_on, 'louder-tas5805m-crossover');
  assert.equal(r.fullFile, true);
  assert.ok(!r.profile.yaml_template.includes('letmein'), 'secret kept out');
  assert.equal(r.profile.recommended.source, 'yaml');
  assert.equal(r.profile.recommended.values.crossover_frequency, 2500);
  assert.match(r.summary, /TAS5805M · crossover fork · 6 \+ 6 PEQ bands/);

  // it still maps the real speaker
  const registry = JSON.parse(read('../fixtures/registry-louder-s3-cab.json'));
  const api = { deviceRegistry: async () => registry.devices, entityRegistry: async () => registry.entities, getStates: async () => [] };
  const entities = await deviceEntities(api, registry.devices.find((/** @type {any} */ d) => !d.via_device_id).id);
  assert.ok(Object.keys(suggestMapping(r.profile, entities)).length >= 77);

  // export: the user's file, crossover block filled in, nothing else changed
  const values = { ...r.profile.recommended.values, crossover_frequency: 2300, tweeter_peq_1_gain: -4.5, tweeter_peq_1_frequency: 4600, tweeter_peq_1_q: 2, tweeter_peq_1_type: Object.values(profiles['louder-tas5805m-crossover'].roles?.tweeter_peq_1_type?.options ?? { a: 'Peaking' })[0] };
  const { yaml } = exportYaml(r.profile, values, { deviceName: 'Louder S3 Cab', tweeterMinFrequency: 1800, date: new Date('2026-11-01') });
  assert.match(yaml, /^# Speaker Tuner/);
  assert.match(yaml, /\n {6}frequency: 2300Hz\n/);
  assert.match(yaml, /gain: -4\.5dB/);
  assert.match(yaml, /enable_pin: \$\{tas58xx_enable_pin\}/, 'the rest of the file is kept');
  assert.match(yaml, /media_player:/);
  assert.equal((yaml.match(/^ {4}crossover:/gm) ?? []).length, 1, 'one crossover block');
  assert.ok(!yaml.includes('{{'), 'every placeholder filled');
});

test('a YAML without a crossover block keeps the snippet export and says why', () => {
  const plain = 'esphome:\n  name: plain\nesp32:\n  variant: esp32\naudio_dac:\n  - platform: tas58xx\n    id: dac\n';
  const r = profileFromYaml(plain, profiles);
  assert.equal(r.profile.based_on, 'tas58xx-15band-graphic');
  assert.equal(r.fullFile, false);
});

test('lambdas with {{ survive the template', () => {
  const y = example.replace(/^esphome:\n/m, 'interval:\n  - interval: 1s\n    then:\n      - lambda: |-\n          int a[1][1] = {{1}};\n\nesphome:\n');
  const r = profileFromYaml(y, profiles);
  const { yaml } = exportYaml(r.profile, r.profile.recommended.values, { deviceName: 'x', tweeterMinFrequency: 1800 });
  assert.match(yaml, /\{\{1\}\}/);
});
