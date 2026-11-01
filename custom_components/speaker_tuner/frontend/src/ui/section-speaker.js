// @ts-check
// Setup, part 1: which speaker. Pick or import a profile, discover the ESPHome device's
// entities, assign them to roles, and place the test noise file.

import { h, field, select, download, pickTextFile } from './dom.js';
import { card } from './app.js';
import * as store from './store.js';
import { listEsphomeDevices, deviceEntities, suggestMapping } from '../ha/discover.js';
import { detectBoard, rankProfiles } from '../ha/detect.js';
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
  // a saved speaker: fetch its entities, so every role is a list to pick from again
  // (they used to be listed only straight after Discover)
  const a = /** @type {any} */ (app);
  if (!d.candidates && d.device_id && app.api && !app.demo && a.loadingEntitiesFor !== d.device_id) {
    a.loadingEntitiesFor = d.device_id;
    deviceEntities(app.api, d.device_id)
      .then((list) => {
        if (draft(app) === d) {
          d.candidates = list;
          app.refresh('speaker');
        }
      })
      .catch(() => {})
      .finally(() => (a.loadingEntitiesFor = null));
  }

  const speakers = select(
    [{ value: '', label: 'New speaker…' }, ...app.mappings.map((m) => ({ value: m.id, label: m.name }))],
    app.settings.mappingId,
    // switching speakers also stops following the old one (no measuring a speaker that
    // isn't on screen); never while a task is using it
    (id) => app.run(id ? 'Switching speaker' : 'New speaker', async () => {
      /** @type {any} */ (app).draft = null;
      await app.useMapping(id);
    }),
    { disabled: !!app.busy },
  );

  // with a device picked, each profile says how many of its settings the device has, best first
  /** @type {Array<{ id: string, found: number, total: number }> | undefined} */
  const ranking = /** @type {any} */ (d).ranking;
  const order = ranking ? ranking.map((r) => app.profiles[r.id]).filter(Boolean) : Object.values(app.profiles);
  const fit = (/** @type {string} */ id) => {
    const r = ranking?.find((x) => x.id === id);
    return r ? ` · ${r.found} of ${r.total} settings found` : '';
  };
  const profiles = select(order.map((p) => ({ value: p.id, label: `${p.name}${fit(p.id)}` })), d.profile, (id) => {
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
    // which board this is, and the profile that fits it best
    const dd = /** @type {any} */ (d);
    if (app.boards && dev) {
      const det = detectBoard(dev, d.candidates, app.boards);
      dd.board = { name: det.name, confidence: det.confidence, tunable: det.tunable, why: det.family?.why ?? null, reasons: det.reasons };
      dd.ranking = rankProfiles(app.profiles, d.candidates, det.components);
    } else {
      dd.ranking = rankProfiles(app.profiles, d.candidates);
    }
    const best = dd.ranking[0];
    if (best && best.found > 0) d.profile = best.id;
    d.entities = suggestMapping(app.profiles[d.profile], d.candidates);
    if (!d.name) d.name = dev?.name ?? id;
    if (!d.id) d.id = `m${Date.now().toString(36)}`;
  });

  const saveDraft = async () => {
    if (!d.name) d.name = 'My speaker';
    if (!d.id) d.id = `m${Date.now().toString(36)}`;
    // the board stays with the speaker; the profile ranking was only for picking
    const { candidates, ranking, ...mapping } = /** @type {any} */ (d);
    app.saveMapping(mapping);
    await app.useMapping(mapping.id);
    app.notify(`Saved "${mapping.name}".`, 'ok');
    app.refresh();
  };

  const devices = /** @type {any} */ (app).devices ?? [];
  const body = [
    field('Speaker', speakers, store.inHomeAssistant()
      ? 'Speakers, profiles, measurements and tuning results are saved in Home Assistant: every browser sees them.'
      : app.mode === 'standalone' && !app.demo ? 'Saved in this browser. With the Speaker Tuner integration installed in Home Assistant they are saved there instead, for every browser.' : 'Saved in this browser.'),
    h('div', { class: 'row' },
      field('Speaker profile', profiles, profile?.notes),
      h('div', { class: 'row tight' },
        h('button', { onclick: importProfile }, 'Import profile'),
        profile ? h('button', { onclick: () => download(`${profile.id}.json`, JSON.stringify(profile, null, 2), 'application/json') }, 'Export profile') : null)),
    field('Name', /** @type {HTMLElement} */ (h('input', { value: d.name, placeholder: 'Living room left', oninput: (/** @type {any} */ e) => (d.name = e.target.value) }))),
    h('div', { class: 'row' },
      h('button', { onclick: discover, disabled: !ready || !!app.busy || app.demo }, 'Discover devices'),
      devices.length ? select([{ value: '', label: 'Pick the ESPHome device…' }, ...devices.map((/** @type {any} */ x) => ({ value: x.id, label: `${x.name}${x.manufacturer && x.manufacturer.toLowerCase() !== 'espressif' ? ` (${x.manufacturer} ${x.model})` : x.model ? ` (${x.model})` : ''}${x.subDevices ? ` · ${x.subDevices} sub-device${x.subDevices === 1 ? '' : 's'}` : ''}` }))], d.device_id ?? '', pickDevice) : null),
    detected(app, d),
    !ready ? h('p', { class: 'help' }, 'Connect to Home Assistant first, or try the demo.') : null,
    profile ? roleEditor(app, d, profile) : null,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: saveDraft, disabled: !profile || !!app.busy }, 'Save speaker'),
      app.mapping && !app.demo ? h('button', { class: 'link danger-text', disabled: !!app.busy, onclick: () => app.run('Forgetting the speaker', async () => {
        app.mappings = app.mappings.filter((m) => m.id !== app.mapping?.id);
        /** @type {any} */ (app).draft = null;
        await app.useMapping('');
        app.persist();
      }) }, 'Forget this speaker') : null),
    noiseFile(app, d),
  ];
  const summary = app.mapping ? `${app.mapping.name} · ${app.profile?.name ?? 'unknown profile'}` : 'No speaker set up';
  return card('Speaker', summary, body, !app.mapping);
}

/**
 * What the board was recognised as, and which profile was picked for it.
 * @param {import('./app.js').TunerApp} app @param {Draft} d
 */
function detected(app, d) {
  const b = /** @type {any} */ (d).board;
  if (!b) return null;
  const r = /** @type {any} */ (d).ranking?.find((/** @type {any} */ x) => x.id === d.profile);
  const sure = b.confidence === 'certain' ? 'Detected' : b.confidence === 'likely' ? 'Looks like' : 'Not recognised';
  return h('div', { class: `detected ${b.tunable === false ? 'notice notice-warn' : ''}` },
    h('p', null, h('b', null, `${sure}: ${b.name}`), b.reasons?.length ? h('span', { class: 'muted' }, ` (${b.reasons.join('; ')})`) : null),
    b.tunable === false ? h('p', null, `This board can't be tuned: ${b.why ?? 'it has no adjustable DSP'}. You can still measure it.`) : null,
    r ? h('p', { class: 'muted' }, `Profile picked to match: ${app.profiles[d.profile]?.name} (${r.found} of ${r.total} settings found). Change it above if it's wrong.`) : null);
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
    // an entity mapped earlier that is no longer on this device stays visible and selectable
    if (current && !options.some((c) => c.entity_id === current)) {
      options.push({ entity_id: current, domain: spec.domain, name: 'not on this device', object: current.split('.')[1] ?? '', state: undefined });
    }
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

  // what discovery found, so a missing kind of entity is obvious
  /** @type {Record<string, number>} */
  const byDomain = {};
  for (const c of candidates) byDomain[c.domain] = (byDomain[c.domain] ?? 0) + 1;
  const subs = new Set(candidates.map((c) => c.device).filter(Boolean));
  const found = candidates.length
    ? `Found ${candidates.length} entities on this speaker${subs.size ? ` and its ${subs.size} sub-device${subs.size === 1 ? '' : 's'} (${[...subs].join(', ')})` : ''}: ${Object.entries(byDomain).map(([dm, n]) => `${n} ${dm.replace('_', ' ')}`).join(', ')}.`
    : '';
  return h('details', { class: 'roles', open: !!candidates.length },
    h('summary', null, `Entity roles (${mapped} assigned)`),
    found ? h('p', { class: 'reason' }, found) : null,
    h('p', { class: 'help' }, candidates.length
      ? 'Suggested from the entity names. Leave a role empty if your speaker does not have it; the features that need it hide themselves.'
      : /** @type {any} */ (app).loadingEntitiesFor ? 'Loading the speaker\'s entities…' : 'Press Discover devices and pick the speaker to choose entities from lists, or type entity IDs.'),
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
