import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profileFromYaml } from '../../custom_components/speaker_tuner/frontend/src/profiles/esphome-yaml.js';
import { shareableProfile, shareLink, REPO } from '../../custom_components/speaker_tuner/frontend/src/profiles/share.js';
import { validate } from '../../custom_components/speaker_tuner/frontend/src/profiles/validate.js';

const FE = '../../custom_components/speaker_tuner/frontend/';
const read = (/** @type {string} */ p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const profiles = Object.fromEntries(['louder-tas5805m-crossover', 'generic-single-driver-peq', 'tas58xx-15band-graphic']
  .map((id) => [id, JSON.parse(read(`${FE}profiles/${id}.json`))]));

test('a shared profile leaves the user\'s file and device names out, keeps the recommendations', () => {
  const y = read('../fixtures/louder-s3-speaker-cab.yaml').replace(/^wifi:\n/m, 'wifi:\n  ap:\n    password: "letmein"\n');
  const { profile } = profileFromYaml(y, profiles);
  profile.recommended.tuned_with = { mic: 'UMIK-1 serial 7001234', tier: 'calibrated', target: 'flat', positions: 3, rms_after: 1.4 };
  const { profile: s, left } = shareableProfile(profile, profiles);
  assert.equal(s.yaml_template, profiles['louder-tas5805m-crossover'].yaml_template, 'the snippet template, not the user\'s file');
  assert.ok(!JSON.stringify(s).includes('letmein'));
  assert.ok(!('name' in s.source) && !('friendly_name' in s.source) && !('packages' in s.source));
  assert.equal(s.recommended.values.crossover_frequency, 2500);
  assert.deepEqual(s.recommended.tuned_with, { tier: 'calibrated', target: 'flat', positions: 3, rms_after: 1.4 });
  assert.ok(left.some((x) => x.includes('your YAML file')));
  assert.deepEqual(validate(JSON.parse(read(`${FE}schema/profile.schema.json`)), s), []);
  assert.ok(profile.yaml_template.includes('esphome:'), 'the original is untouched');
});

test('the issue link carries the profile when it fits, else only the title and board', () => {
  const small = { id: 'x', name: 'Small', board: { name: 'Sonocotta Louder-ESP32-S3' }, component: 'generic', peq_banks: [], roles: {} };
  const a = shareLink(small);
  assert.ok(a.inUrl);
  assert.ok(a.url.startsWith(`${REPO}/issues/new?template=profile.yml`));
  assert.equal(new URL(a.url).searchParams.get('profile'), a.json);
  assert.equal(new URL(a.url).searchParams.get('board'), 'Sonocotta Louder-ESP32-S3');
  const big = shareLink(profiles['louder-tas5805m-crossover']);
  assert.equal(big.inUrl, false);
  assert.equal(new URL(big.url).searchParams.get('profile'), null);
  assert.ok(big.url.length < 1000);
});
