// @ts-check
// Exports: ESPHome YAML from the profile template, measurements as CSV, filters for REW.

import { expandRoles, optionCode, crossoverSettings, activeBanks, bankFilters } from './profile.js';
import { render } from './template.js';
import { VERSION } from '../version.js';

/** Number without float noise or trailing zeros: 2500, -2.5, 0.71. @param {number} x */
export function formatNumber(x) {
  if (!Number.isFinite(x)) return '0';
  const r = Math.round(x * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * Template values: every role as text (numbers plain, switches true/false, selects as their
 * label), selects also as `<role>_code` (e.g. LR4, PEAKING), plus meta values.
 * @param {import('./profile.js').Profile} profile @param {Record<string, any>} values
 * @param {{ deviceName?: string, tweeterMinFrequency?: number, date?: Date }} [meta]
 */
export function templateValues(profile, values, { deviceName = '', tweeterMinFrequency, date = new Date() } = {}) {
  const roles = expandRoles(profile);
  /** @type {Record<string, string>} */
  const out = {
    tool_version: VERSION,
    profile_name: profile.name,
    device_name: deviceName || 'unknown',
    date: date.toISOString().slice(0, 10),
    dsp_sample_rate: formatNumber(profile.dsp_sample_rate ?? 96000),
    tweeter_min_frequency: formatNumber(tweeterMinFrequency ?? profile.defaults?.tweeter_min_frequency ?? 500),
    // a literal "{{" in a user's own YAML (kept in full-file templates)
    _lb: '{{',
  };
  for (const [role, spec] of Object.entries(roles)) {
    const v = values[role] ?? profile.defaults?.[role] ?? spec.default;
    if (spec.domain === 'number') out[role] = formatNumber(Number(v ?? (spec.field === 'frequency' ? 1000 : spec.field === 'q' ? 1 : 0)));
    else if (spec.domain === 'switch') out[role] = v === true || v === 'on' ? 'true' : 'false';
    else if (spec.domain === 'select') {
      const label = v ?? Object.values(spec.options ?? {})[0] ?? '';
      out[role] = String(label);
      out[`${role}_code`] = String(optionCode(spec.options, label)).toUpperCase();
    }
  }
  return out;
}

/**
 * Values Home Assistant accepts but the fork's YAML validators would reject.
 * @param {ReturnType<typeof crossoverSettings>} s
 */
export function forkYamlProblems(s) {
  const problems = [];
  if (s.subsonic_frequency > 0 && s.subsonic_frequency < 10) problems.push(`Subsonic filter ${s.subsonic_frequency} Hz: the YAML needs 0 (off) or 10 to 100 Hz.`);
  if (s.baffle_width > 0 && s.baffle_width < 5) problems.push(`Baffle width ${s.baffle_width} cm: the YAML needs 0 (off) or 5 to 50 cm.`);
  if (s.tweeter_notch.frequency > 0 && s.tweeter_notch.frequency < 1000) problems.push(`Tweeter notch ${s.tweeter_notch.frequency} Hz: the YAML needs 0 (off) or 1000 to 20000 Hz.`);
  const { f0, fp } = s.linkwitz;
  if ((f0 === 0) !== (fp === 0)) problems.push('Linkwitz transform: set both f0 and fp, or neither.');
  if ((f0 > 0 && f0 < 15) || (fp > 0 && fp < 15)) problems.push('Linkwitz f0 and fp must be 0 (off) or 15 to 200 Hz.');
  if (s.frequency < s.tweeter_min_frequency) problems.push(`Crossover ${s.frequency} Hz is below tweeter_min_frequency ${s.tweeter_min_frequency} Hz.`);
  return problems;
}

/** Settings that protect the tweeter or depend on wiring: never exported as a silent default. */
const CRITICAL_ROLES = {
  'tas58xx-crossover': ['crossover_frequency', 'crossover_filter', 'crossover_tweeter_channel'],
};

/**
 * Values the export would have to invent. A YAML that says tweeter_channel: LEFT because the
 * entity wasn't mapped, or 500 Hz as the tweeter minimum, can put the wrong signal on a tweeter.
 * @param {import('./profile.js').Profile} profile @param {Record<string, any>} values role values read from the device
 * @param {{ tweeterMinFrequency?: number }} [meta]
 */
export function exportGaps(profile, values, { tweeterMinFrequency } = {}) {
  const gaps = [];
  const known = Object.values(values).filter((v) => v !== null && v !== undefined).length;
  if (!known) gaps.push('The speaker is not reporting any values (offline?). Export once it is back, or the YAML is all defaults.');
  for (const role of CRITICAL_ROLES[/** @type {keyof typeof CRITICAL_ROLES} */ (profile.component)] ?? []) {
    if (values[role] === null || values[role] === undefined) {
      gaps.push(`${role} is not mapped or not reported, so the export uses the profile default. Check that line against your speaker before flashing.`);
    }
  }
  if (profile.component === 'tas58xx-crossover' && tweeterMinFrequency === undefined) {
    gaps.push('The tweeter minimum frequency is unknown (crossover frequency not mapped), so the export uses 500 Hz. Set tweeter_min_frequency to your YAML value before flashing.');
  }
  return gaps;
}

/**
 * @param {import('./profile.js').Profile} profile @param {Record<string, any>} values
 * @param {{ deviceName?: string, tweeterMinFrequency?: number, date?: Date }} [meta]
 */
export function exportYaml(profile, values, meta = {}) {
  if (!profile.yaml_template) throw new Error('This profile has no YAML template.');
  const yaml = render(profile.yaml_template, templateValues(profile, values, meta));
  const problems = [
    ...exportGaps(profile, values, meta),
    ...(profile.component === 'tas58xx-crossover'
      ? forkYamlProblems(crossoverSettings(profile, { ...values, tweeter_min_frequency: meta.tweeterMinFrequency }))
      : []),
  ];
  return { yaml, problems };
}

/** @param {string} s */
const csvSafe = (s) => String(s).replace(/[\r\n]+/g, ' ');

/**
 * One measurement as two columns, frequency and dB, with # metadata lines. REW imports it.
 * @param {import('../measure/record.js').MeasurementRecord} m
 */
export function measurementCsv(m) {
  const head = [
    `# Speaker Tuner ${VERSION}`,
    `# label: ${csvSafe(m.label)}`,
    `# time: ${m.time}`,
    `# kind: ${m.kind}`,
    `# mic: ${csvSafe(m.mic)} (${m.tier})`,
    `# positions: ${m.positions}`,
    `# volume: ${m.volume ?? 'unknown'}`,
    '# dB values are relative (pink noise slope removed, mic calibration applied); 1/48 octave grid',
    ...(m.settings ? [`# settings: ${csvSafe(JSON.stringify(m.settings))}`] : []),
    'frequency_hz,db',
  ];
  const rows = m.curve.freqs.map((f, i) => `${f.toFixed(2)},${m.curve.db[i].toFixed(2)}`);
  return [...head, ...rows, ''].join('\n');
}

/**
 * Several measurements side by side on the shared grid.
 * @param {import('../measure/record.js').MeasurementRecord[]} list
 */
export function measurementsCsv(list) {
  if (!list.length) return '';
  const head = [
    `# Speaker Tuner ${VERSION}`,
    ...list.map((m, i) => `# column ${i + 1}: ${csvSafe(m.label)} | ${m.time} | ${m.kind} | ${csvSafe(m.mic)} (${m.tier}) | positions ${m.positions} | volume ${m.volume ?? 'unknown'}`),
    ['frequency_hz', ...list.map((m) => `"${m.label.replace(/"/g, "'")}"`)].join(','),
  ];
  const freqs = list[0].curve.freqs;
  const rows = freqs.map((f, i) => [f.toFixed(2), ...list.map((m) => (m.curve.db[i] ?? NaN).toFixed(2))].join(','));
  return [...head, ...rows, ''].join('\n');
}

/**
 * Current PEQ in REW's filter settings text format (Equaliser: Generic).
 * @param {import('./profile.js').Profile} profile @param {Record<string, any>} values
 */
export function rewFilters(profile, values) {
  const type = { peaking: 'PK', low_shelf: 'LSQ', high_shelf: 'HSQ' };
  const lines = ['Filter Settings file', '', `Speaker Tuner ${VERSION}`, `Dated: ${new Date().toISOString()}`, '', `Notes: ${profile.name}`, '', 'Equaliser: Generic'];
  let n = 1;
  for (const bank of activeBanks(profile)) {
    lines.push(`# ${bank.name ?? bank.id}`);
    for (const f of bankFilters(profile, values, bank.id)) {
      lines.push(`Filter ${String(n++).padStart(2)}: ON  ${type[f.type].padEnd(4)} Fc ${formatNumber(f.f).padStart(7)} Hz  Gain ${f.gain.toFixed(1).padStart(5)} dB  Q ${f.q.toFixed(2).padStart(5)}`);
    }
  }
  return lines.join('\n') + '\n';
}
