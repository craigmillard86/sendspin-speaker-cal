import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validate } from '../../custom_components/speaker_tuner/frontend/src/profiles/validate.js';
import { expandRoles, checkProfile, bankValues, bankFilters, mirrorValues, settingRoles, crossoverSettings } from '../../custom_components/speaker_tuner/frontend/src/profiles/profile.js';
import { render, placeholders } from '../../custom_components/speaker_tuner/frontend/src/profiles/template.js';
import { exportYaml, measurementCsv, measurementsCsv, rewFilters, templateValues } from '../../custom_components/speaker_tuner/frontend/src/profiles/export.js';
import { measurementFromPositions } from '../../custom_components/speaker_tuner/frontend/src/measure/record.js';
import { STORE_GRID } from '../../custom_components/speaker_tuner/frontend/src/dsp/analyse.js';

const FRONT = new URL('../../custom_components/speaker_tuner/frontend/', import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, FRONT), 'utf8'));
const files = (dir) => readdirSync(new URL(dir, FRONT)).filter((f) => f.endsWith('.json')).map((f) => `${dir}/${f}`);
const louder = json('profiles/louder-tas5805m-crossover.json');

for (const [dir, schema] of [['profiles', 'schema/profile.schema.json'], ['mics', 'schema/mic.schema.json'], ['targets', 'schema/target.schema.json']]) {
  test(`shipped ${dir} match ${schema}`, () => {
    const s = json(schema);
    const list = files(dir);
    assert.ok(list.length > 0);
    for (const f of list) assert.deepEqual(validate(s, json(f)), [], f);
  });
}

test('the mic list includes the AKG CK32, conservative without a cal file', () => {
  const ck32 = json('mics/akg-ck32.json');
  assert.equal(ck32.tier, 'uncalibrated');
  assert.deepEqual(ck32.range_hz, [100, 12000]);
  assert.ok(ck32.gain_db[1] <= 3);
});

test('validator reports readable problems', () => {
  const s = json('schema/profile.schema.json');
  const bad = { id: 'Bad ID', name: '', component: 'x', peq_banks: [{ id: 'a', type: 'weird', role_prefix: 'a_' }], roles: { r: { domain: 'lamp' } } };
  const errors = validate(s, bad);
  assert.ok(errors.some((e) => e.startsWith('id:')));
  assert.ok(errors.some((e) => e.startsWith('name:')));
  assert.ok(errors.some((e) => e.startsWith('peq_banks[0].type:')));
  assert.ok(errors.some((e) => e.startsWith('roles.r.domain:')));
  assert.throws(() => checkProfile({ id: 'x', name: 'x', component: 'x', peq_banks: [], roles: { a: { domain: 'lamp' } } }), /domain/);
});

test('band roles are generated from the banks', () => {
  const roles = expandRoles(louder);
  for (const d of ['mid', 'tweeter']) {
    for (let n = 1; n <= 6; n++) {
      for (const f of ['frequency', 'gain', 'q', 'type']) assert.ok(roles[`${d}_peq_${n}_${f}`], `${d}_peq_${n}_${f}`);
    }
  }
  assert.equal(roles.mid_peq_3_gain.min, -15);
  assert.deepEqual(roles.mid_peq_3_gain.hints, ['mid_peq_3_gain']);
  assert.ok(!settingRoles(louder).includes('tweeter_mute'), 'mutes are not part of a snapshot');
  assert.ok(settingRoles(louder).includes('tweeter_invert'));
});

test('fitted filters fill bands in frequency order, the rest are switched off', () => {
  const v = bankValues(louder, 'mid', [{ f: 800, gain: -3, q: 2 }, { f: 120, gain: -5, q: 4 }]);
  assert.equal(v.mid_peq_1_frequency, 120);
  assert.equal(v.mid_peq_2_frequency, 800);
  assert.equal(v.mid_peq_1_type, 'Peaking');
  for (let n = 3; n <= 6; n++) assert.equal(v[`mid_peq_${n}_gain`], 0);
  assert.equal(bankFilters(louder, v, 'mid').length, 2);
});

test('graphic profile: the right channel mirrors the left', () => {
  const g = json('profiles/tas58xx-15band-graphic.json');
  const roles = expandRoles(g);
  assert.ok(roles.left_eq_2_gain.hints.includes('left_gain_31_5hz'));
  assert.deepEqual(mirrorValues(g, { left_eq_3_gain: -2, left_eq_9_gain: 1 }), { right_eq_3_gain: -2, right_eq_9_gain: 1 });
});

test('every profile template renders with default values', () => {
  for (const f of files('profiles')) {
    const p = json(f);
    const values = templateValues(p, {});
    assert.doesNotThrow(() => render(p.yaml_template, values), f);
  }
});

test('template errors name the missing placeholders', () => {
  assert.deepEqual(placeholders('a {{x}} b {{ y }} {{x}}'), ['x', 'y']);
  assert.throws(() => render('{{nope}} {{gone}}', {}), /nope, gone/);
});

test('Louder YAML export uses the fork keys and units', () => {
  const values = {
    crossover_frequency: 2800, crossover_filter: 'LR4 24dB/oct', tweeter_gain: -4.5, tweeter_invert: true,
    mid_peq_1_frequency: 120, mid_peq_1_gain: -5, mid_peq_1_q: 4, mid_peq_1_type: 'Peaking',
    baffle_placement: 'Near Wall', subsonic_frequency: 34,
  };
  const { yaml, problems } = exportYaml(louder, values, { deviceName: 'Test cab', tweeterMinFrequency: 1800, date: new Date('2026-10-31T12:00:00Z') });
  assert.deepEqual(problems, []);
  for (const line of [
    'xo_filter: "LR4"', 'xo_frequency: "2800Hz"', 'xo_tweeter_min_frequency: "1800Hz"', 'xo_tweeter_gain: "-4.5dB"',
    'xo_tweeter_invert: "true"', 'xo_baffle_placement: "NEAR_WALL"', 'xo_subsonic_frequency: "34Hz"',
    'mid_peq_1_frequency: "120Hz"', 'mid_peq_1_gain: "-5dB"', 'mid_peq_1_q: "4"', 'mid_peq_1_type: "PEAKING"', 'mid_peq_2_gain: "0dB"',
    '    crossover:', '      filter: ${xo_filter}', '      tweeter_channel: LEFT', '      mid_peq:', '        - frequency: ${mid_peq_1_frequency}',
    '      dsp_sample_rate: 96000Hz', '# Device: Test cab, exported 2026-10-31',
  ]) {
    assert.ok(yaml.includes(line), `missing: ${line}`);
  }
  assert.ok(!yaml.includes('{{'), 'all placeholders filled');
});

test('export flags values the fork YAML would reject', () => {
  const { problems } = exportYaml(louder, { subsonic_frequency: 5, linkwitz_f0: 50, linkwitz_fp: 0, baffle_width: 3 }, { tweeterMinFrequency: 1800 });
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => /Subsonic/.test(p)));
  assert.ok(problems.some((p) => /Linkwitz/.test(p)));
  assert.ok(problems.some((p) => /Baffle/.test(p)));
});

test('crossover settings from role values', () => {
  const s = crossoverSettings(louder, { crossover_filter: 'Butterworth 12dB/oct', tweeter_invert: true, mid_peq_2_gain: -3, mid_peq_2_frequency: 400, mid_peq_2_q: 2 });
  assert.equal(s.filter, 'BW2');
  assert.equal(s.tweeter_invert, true);
  assert.deepEqual(s.mid_peq, [{ frequency: 400, gain: -3, q: 2, type: 'PEAKING' }]);
  assert.equal(s.tweeter_gain, -3, 'unmapped roles fall back to the profile default');
});

test('CSV and REW exports', () => {
  const curve = { freqs: Array.from(STORE_GRID), db: Array.from(STORE_GRID, () => 1.234) };
  const m = measurementFromPositions({ label: 'Before, "quoted"', kind: 'full' }, [{ curve }], { mic: { name: 'UMIK-1', tier: 'calibrated' }, volume: 0.25 });
  const csv = measurementCsv(m);
  const lines = csv.trim().split('\n');
  assert.ok(lines.includes('frequency_hz,db'));
  assert.equal(lines.filter((l) => !l.startsWith('#') && l !== 'frequency_hz,db').length, STORE_GRID.length);
  assert.ok(lines.includes('20.00,1.23'));
  const wide = measurementsCsv([m, m]).trim().split('\n');
  assert.equal(wide.filter((l) => l.startsWith('frequency_hz')).length, 1);
  assert.equal(wide[wide.length - 1].split(',').length, 3);

  const rew = rewFilters(louder, { mid_peq_1_frequency: 120, mid_peq_1_gain: -5, mid_peq_1_q: 4, tweeter_peq_1_frequency: 9000, tweeter_peq_1_gain: 2, tweeter_peq_1_q: 1.5 });
  assert.match(rew, /Filter  1: ON  PK   Fc     120 Hz  Gain  -5.0 dB  Q  4.00/);
  assert.match(rew, /Filter  2: ON  PK   Fc    9000 Hz  Gain   2.0 dB  Q  1.50/);
});

test('version is the same in package.json, manifest.json and the app', async () => {
  const { VERSION } = await import('../../custom_components/speaker_tuner/frontend/src/version.js');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../../custom_components/speaker_tuner/manifest.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, VERSION);
  assert.equal(manifest.version, VERSION);
});
