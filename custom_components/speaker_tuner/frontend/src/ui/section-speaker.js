// @ts-check
// Setup, part 1: which speaker. Pick or import a profile, discover the ESPHome device's
// entities, assign them to roles, and place the test noise file.

import { h, field, select, download, pickTextFile } from './dom.js';
import { card } from './app.js';
import * as store from './store.js';
import { listEsphomeDevices, deviceEntities, suggestMapping } from '../ha/discover.js';
import { uploadMedia, MEDIA_FOLDER } from '../ha/connection.js';
import { Playback } from '../ha/playback.js';
import { expandRoles, checkProfile } from '../profiles/profile.js';
import { validate } from '../profiles/validate.js';
import { testSignal } from '../dsp/pink.js';
import { encodeWav16 } from '../dsp/wav.js';
import { sleep } from '../measure/session.js';

const NOISE_FILE = 'speaker-tuner-pink-20s.wav';
const GROUP_TITLES = {
  playback: 'Playback', crossover: 'Crossover', drivers: 'Drivers', compensation: 'Compensation', monitor: 'Monitoring and buttons',
};

/**
 * Mapping being edited: kept on the app between re-renders.
 * @typedef {{ id: string, name: string, profile: string, device_id?: string, entities: Record<string, string>, media_url?: string,
 *   candidates?: import('../ha/discover.js').DeviceEntity[] }} Draft
 */

/** @param {import('./app.js').TunerApp} app @returns {Draft} */
function draft(app) {
  const a = /** @type {any} */ (app);
  if (!a.draft) {
    const m = app.mapping;
    a.draft = m ? { ...m, entities: { ...m.entities } } : { id: '', name: '', profile: Object.keys(app.profiles)[0] ?? '', entities: {} };
  }
  return a.draft;
}

/** @param {import('./app.js').TunerApp} app */
export function renderSpeaker(app) {
  const d = draft(app);
  const profile = app.profiles[d.profile];
  const ready = !!app.api;

  const speakers = select(
    [{ value: '', label: 'New speaker…' }, ...app.mappings.map((m) => ({ value: m.id, label: m.name }))],
    app.settings.mappingId,
    async (id) => {
      /** @type {any} */ (app).draft = null;
      if (id) await app.useMapping(id);
      else app.settings.mappingId = '';
      app.refresh();
    },
  );

  const profiles = select(Object.values(app.profiles).map((p) => ({ value: p.id, label: p.name })), d.profile, (id) => {
    d.profile = id;
    if (d.candidates) d.entities = suggestMapping(app.profiles[id], d.candidates);
    app.refresh('speaker');
  });

  const importProfile = async () => {
    const file = await pickTextFile('.json,application/json');
    if (!file) return;
    try {
      const p = JSON.parse(file.text);
      const schema = await (await fetch(new URL('../../schema/profile.schema.json', import.meta.url))).json();
      const problems = validate(schema, p);
      if (problems.length) throw new Error(`That profile has problems:\n${problems.slice(0, 8).join('\n')}`);
      checkProfile(p);
      app.profiles[p.id] = p;
      store.save('profiles', [...store.load('profiles', []).filter((/** @type {any} */ x) => x.id !== p.id), p]);
      d.profile = p.id;
      app.notify(`Imported profile "${p.name}".`, 'ok');
      app.refresh('speaker');
    } catch (e) {
      app.notify(/** @type {Error} */ (e).message, 'error');
    }
  };

  const discover = () => app.run('Looking for ESPHome devices', async () => {
    const devices = await listEsphomeDevices(/** @type {any} */ (app.api));
    /** @type {any} */ (app).devices = devices;
    if (!devices.length) app.notify('No ESPHome devices found in Home Assistant.', 'warn');
  });

  const pickDevice = (/** @type {string} */ id) => app.run('Reading the device\'s entities', async () => {
    const dev = /** @type {any} */ (app).devices?.find((/** @type {any} */ x) => x.id === id);
    d.device_id = id;
    d.candidates = await deviceEntities(/** @type {any} */ (app.api), id);
    d.entities = suggestMapping(profile, d.candidates);
    if (!d.name) d.name = dev?.name ?? id;
    if (!d.id) d.id = `m${Date.now().toString(36)}`;
  });

  const saveDraft = async () => {
    if (!d.name) d.name = 'My speaker';
    if (!d.id) d.id = `m${Date.now().toString(36)}`;
    const { candidates, ...mapping } = d;
    app.saveMapping(mapping);
    await app.useMapping(mapping.id);
    app.notify(`Saved "${mapping.name}".`, 'ok');
    app.refresh();
  };

  const devices = /** @type {any} */ (app).devices ?? [];
  const body = [
    field('Speaker', speakers, 'Each speaker you set up is saved in this browser.'),
    h('div', { class: 'row' },
      field('Speaker profile', profiles, profile?.notes),
      h('div', { class: 'row tight' },
        h('button', { onclick: importProfile }, 'Import profile'),
        profile ? h('button', { onclick: () => download(`${profile.id}.json`, JSON.stringify(profile, null, 2), 'application/json') }, 'Export profile') : null)),
    field('Name', /** @type {HTMLElement} */ (h('input', { value: d.name, placeholder: 'Living room left', oninput: (/** @type {any} */ e) => (d.name = e.target.value) }))),
    h('div', { class: 'row' },
      h('button', { onclick: discover, disabled: !ready || !!app.busy || app.demo }, 'Discover devices'),
      devices.length ? select([{ value: '', label: 'Pick the ESPHome device…' }, ...devices.map((/** @type {any} */ x) => ({ value: x.id, label: `${x.name}${x.model ? ` (${x.model})` : ''}` }))], d.device_id ?? '', pickDevice) : null),
    !ready ? h('p', { class: 'help' }, 'Connect to Home Assistant first, or try the demo.') : null,
    profile ? roleEditor(app, d, profile) : null,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: saveDraft, disabled: !profile }, 'Save speaker'),
      app.mapping && !app.demo ? h('button', { class: 'link danger-text', onclick: () => {
        app.mappings = app.mappings.filter((m) => m.id !== app.mapping?.id);
        app.settings.mappingId = '';
        /** @type {any} */ (app).draft = null;
        app.persist();
        app.refresh();
      } }, 'Forget this speaker') : null),
    noiseFile(app, d),
  ];
  const summary = app.mapping ? `${app.mapping.name} · ${app.profile?.name ?? 'unknown profile'}` : 'No speaker set up';
  return card('Speaker', summary, body, !app.mapping);
}

/**
 * Role -> entity assignment, grouped, with the entities of the right domain to choose from.
 * @param {import('./app.js').TunerApp} app @param {Draft} d @param {import('../profiles/profile.js').Profile} profile
 */
function roleEditor(app, d, profile) {
  const roles = expandRoles(profile);
  const candidates = d.candidates ?? [];
  /** @type {Record<string, string[]>} */
  const groups = {};
  for (const [role, spec] of Object.entries(roles)) (groups[spec.group ?? 'other'] ??= []).push(role);
  const mapped = Object.values(d.entities).filter(Boolean).length;

  /** @param {string} role */
  const control = (role) => {
    const spec = roles[role];
    const options = candidates.filter((c) => c.domain === spec.domain);
    const current = d.entities[role] ?? '';
    if (!candidates.length) {
      return h('input', { value: current, placeholder: `${spec.domain}.…`, oninput: (/** @type {any} */ e) => {
        const v = e.target.value.trim();
        if (v) d.entities[role] = v;
        else delete d.entities[role];
      } });
    }
    return select([{ value: '', label: '— not used —' }, ...options.map((c) => ({ value: c.entity_id, label: `${c.name} (${c.entity_id})` }))], current, (v) => {
      if (v) d.entities[role] = v;
      else delete d.entities[role];
    });
  };

  return h('details', { class: 'roles', open: !!candidates.length },
    h('summary', null, `Entity roles (${mapped} assigned)`),
    h('p', { class: 'help' }, candidates.length
      ? 'Suggested from the entity names. Leave a role empty if your speaker does not have it; the features that need it hide themselves.'
      : 'Discover the device to pick entities from a list, or type entity IDs.'),
    Object.entries(groups).map(([group, list]) =>
      h('fieldset', null, h('legend', null, /** @type {any} */ (GROUP_TITLES)[group] ?? (profile.peq_banks.find((b) => b.id === group)?.name ?? group) + ' PEQ'),
        h('div', { class: 'role-grid' }, list.map((role) => h('div', { class: 'role-row' },
          h('label', null, roles[role].label ?? role), control(role)))))));
}

/** @param {import('./app.js').TunerApp} app @param {Draft} d */
function noiseFile(app, d) {
  const url = /** @type {HTMLInputElement} */ (h('input', { value: d.media_url ?? '', placeholder: `${MEDIA_FOLDER}/${NOISE_FILE}`, oninput: (/** @type {any} */ e) => (d.media_url = e.target.value.trim()) }));
  const wav = () => encodeWav16(testSignal(), 48000);
  const upload = () => app.run('Uploading the test noise to Home Assistant', async () => {
    const id = await uploadMedia(/** @type {any} */ (app.api), new Blob([wav()], { type: 'audio/wav' }), NOISE_FILE);
    d.media_url = id;
    const m = app.mapping;
    if (m) app.saveMapping({ ...m, media_url: id });
    app.notify(`Uploaded. The test noise is at ${id}`, 'ok');
  });
  const tryIt = () => app.run('Playing 3 seconds of test noise', async (signal) => {
    const player = d.entities.media_player;
    if (!player || !d.media_url) throw new Error('Map the media player and set the test noise URL first.');
    const p = new Playback(/** @type {any} */ (app.api), player);
    await p.play(d.media_url);
    try {
      await sleep(3000, signal);
    } finally {
      await p.stop();
    }
  });
  return h('fieldset', null, h('legend', null, 'Test noise'),
    h('p', { class: 'help' }, '20 seconds of pink noise (48 kHz, 16-bit, mono) with 1 second fades. Upload it to Home Assistant\'s media folder in one click, or download it and place it there yourself.'),
    h('div', { class: 'row' },
      h('button', { onclick: () => download(NOISE_FILE, wav(), 'audio/wav') }, 'Download WAV'),
      h('button', { onclick: upload, disabled: !app.api || app.demo || !!app.busy }, 'Upload to Home Assistant'),
      h('button', { onclick: tryIt, disabled: !app.api || app.demo || !!app.busy }, 'Play 3 s')),
    field('Test noise media URL', url, 'Filled in after uploading. For a file you copied into /media yourself, use media-source://media_source/local/<file name>.'));
}
