import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listEsphomeDevices, deviceEntities, suggestMapping, deviceTree } from '../../custom_components/speaker_tuner/frontend/src/ha/discover.js';

const profile = JSON.parse(readFileSync(new URL('../../custom_components/speaker_tuner/frontend/profiles/louder-tas5805m-crossover.json', import.meta.url), 'utf8'));

// A Louder whose YAML puts the driver settings on ESPHome sub-devices (`devices:` + `device_id:`):
// Home Assistant shows them as devices linked to the main one with via_device_id, and the
// entities on them carry short names like "PEQ 1 Gain".
const devices = [
  { id: 'main', name: 'Louder S3 Cab', model: 'esp32-s3', via_device_id: null },
  { id: 'tw', name: 'Tweeter', via_device_id: 'main' },
  { id: 'mid', name: 'Mid', via_device_id: 'main' },
  { id: 'mid-eq', name: 'Mid EQ', via_device_id: 'mid' }, // nested one level deeper
  { id: 'hue', name: 'Hue bridge', via_device_id: null },
  { id: 'lamp', name: 'Lamp', via_device_id: 'hue' },
];
const ent = (entity_id, device_id, original_name, platform = 'esphome') => ({ entity_id, device_id, original_name, name: null, platform, disabled_by: null });
const entities = [
  ent('media_player.louder_s3_cab_player', 'main', 'Player'),
  ent('media_player.louder_s3_cab_sendspin_player', 'main', 'Sendspin Player'),
  ent('number.louder_s3_cab_crossover_frequency', 'main', 'Crossover Frequency'),
  ent('switch.louder_s3_cab_loudness', 'main', 'Loudness'),
  ent('number.tweeter_gain', 'tw', 'Gain'),
  ent('switch.tweeter_invert_polarity', 'tw', 'Invert Polarity'),
  ent('switch.tweeter_mute', 'tw', 'Mute'),
  ent('number.tweeter_peq_1_gain', 'tw', 'PEQ 1 Gain'),
  ent('number.tweeter_peq_1_frequency', 'tw', 'PEQ 1 Frequency'),
  ent('number.mid_gain', 'mid', 'Gain'),
  ent('switch.mid_mute', 'mid', 'Mute'),
  ent('number.mid_eq_peq_1_gain', 'mid-eq', 'Mid PEQ 1 Gain'), // already carries the driver name
  ent('number.mid_eq_peq_1_frequency', 'mid-eq', 'Mid PEQ 1 Frequency'),
  ent('light.lamp', 'lamp', 'Lamp', 'hue'),
];
const api = { deviceRegistry: async () => devices, entityRegistry: async () => entities, getStates: async () => [] };

test('a speaker with sub-devices is listed once, with its sub-devices counted', async () => {
  const list = await listEsphomeDevices(api);
  assert.deepEqual(list.map((d) => [d.name, d.subDevices]), [['Louder S3 Cab', 3]]);
  assert.deepEqual([...deviceTree(devices, 'main').keys()].sort(), ['main', 'mid', 'mid-eq', 'tw']);
});

test('entities on sub-devices are found and named with their sub-device', async () => {
  const list = await deviceEntities(api, 'main');
  assert.equal(list.length, 13, 'everything from the speaker and its three sub-devices, nothing from the lamp');
  const names = Object.fromEntries(list.map((e) => [e.entity_id, e.name]));
  assert.equal(names['number.tweeter_peq_1_gain'], 'Tweeter PEQ 1 Gain');
  assert.equal(names['switch.mid_mute'], 'Mid Mute');
  assert.equal(names['number.mid_eq_peq_1_gain'], 'Mid PEQ 1 Gain', 'not "Mid EQ Mid PEQ 1 Gain"');
  assert.equal(names['media_player.louder_s3_cab_player'], 'Player', 'main-device entities keep their own name');
});

test('roles are suggested across sub-devices', async () => {
  const mapping = suggestMapping(profile, await deviceEntities(api, 'main'));
  assert.equal(mapping.tweeter_peq_1_gain, 'number.tweeter_peq_1_gain');
  assert.equal(mapping.tweeter_peq_1_frequency, 'number.tweeter_peq_1_frequency');
  assert.equal(mapping.tweeter_gain, 'number.tweeter_gain');
  assert.equal(mapping.tweeter_invert, 'switch.tweeter_invert_polarity');
  assert.equal(mapping.tweeter_mute, 'switch.tweeter_mute');
  assert.equal(mapping.mid_gain, 'number.mid_gain');
  assert.equal(mapping.mid_mute, 'switch.mid_mute');
  assert.equal(mapping.mid_peq_1_gain, 'number.mid_eq_peq_1_gain');
  assert.equal(mapping.crossover_frequency, 'number.louder_s3_cab_crossover_frequency');
  assert.equal(mapping.media_player, 'media_player.louder_s3_cab_player', 'the file player, not the Sendspin one');
});
