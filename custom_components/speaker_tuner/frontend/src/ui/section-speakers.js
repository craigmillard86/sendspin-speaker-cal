// @ts-check
// Every speaker set up, with what is kept for each, to open or delete them.

import { h } from './dom.js';
import { card } from './app.js';
import * as store from './store.js';

/** @param {import('./app.js').TunerApp} app */
export function renderSpeakers(app) {
  const tuning = store.load('tuning', /** @type {Record<string, any>} */ ({}));
  const rows = app.mappings.filter((m) => m.id !== 'demo').map((m) => {
    const ms = app.measurements.filter((x) => /** @type {any} */ (x).speaker === m.id);
    const t = tuning[m.id];
    const last = [...(t?.history ?? []).filter((/** @type {any} */ x) => x?.at && x?.what).map((/** @type {any} */ x) => x.at), ...ms.map((x) => x.time)].filter(Boolean).sort().pop();
    const applies = (t?.history ?? []).filter((/** @type {any} */ x) => x && x.at && x.what);
    return { m, measurements: ms.length, applied: applies.length, last };
  });

  const remove = (/** @type {typeof rows[number]} */ r) => app.run(`Deleting ${r.m.name}`, async (signal) => {
    await app.confirm(`Delete "${r.m.name}"?`, [
      `It goes from every browser, with ${r.measurements} measurement${r.measurements === 1 ? '' : 's'} and ${r.applied ? `its history of ${r.applied} change${r.applied === 1 ? '' : 's'}` : 'its tuning results'}.`,
      'The speaker itself keeps every setting it has now. Set it up again any time with Discover devices.',
    ].join('\n\n'), 'Delete', signal);
    const id = r.m.id;
    const current = app.mapping?.id === id;
    app.mappings = app.mappings.filter((m) => m.id !== id);
    app.measurements = app.measurements.filter((x) => /** @type {any} */ (x).speaker !== id);
    for (const v of [...app.visible]) if (!app.measurements.some((x) => x.id === v)) app.visible.delete(v);
    const all = store.load('tuning', /** @type {Record<string, any>} */ ({}));
    delete all[id];
    store.save('tuning', all);
    if (app.session?.deviceId === id) app.session = null;
    if (current) {
      /** @type {any} */ (app).draft = null;
      await app.useMapping('');
    }
    app.persist();
    app.notify(`Deleted "${r.m.name}".`, 'ok');
    app.updateChart();
  }, 'speakers');

  const open = (/** @type {string} */ id) => app.run('Switching speaker', async () => {
    /** @type {any} */ (app).draft = null;
    await app.useMapping(id);
    app.focusSetup('speaker');
  }, 'speakers');

  const date = (/** @type {string | undefined} */ t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'never');
  const unassigned = app.measurements.filter((x) => !(/** @type {any} */ (x).speaker) && !x.test).length;
  return card('Speakers', `${rows.length} set up`, [
    h('p', { class: 'help' }, store.inHomeAssistant()
      ? 'Every speaker set up, in Home Assistant, so the list is the same in every browser. Deleting one removes what the tool keeps for it; the speaker keeps its settings.'
      : 'Every speaker set up in this browser. Deleting one removes what the tool keeps for it; the speaker keeps its settings.'),
    rows.length ? h('ul', { class: 'mlist speakers' }, rows.map((r) => h('li', null,
      h('span', { class: 'mlabel' },
        h('strong', null, r.m.name), r.m.id === app.mapping?.id ? h('span', { class: 'chip chip-ok' }, 'in use') : null,
        h('span', { class: 'muted' }, ` ${app.profiles[r.m.profile]?.name ?? r.m.profile} · ${r.measurements} measurement${r.measurements === 1 ? '' : 's'} · last used ${date(r.last)}${/** @type {any} */ (r.m).board?.name && /** @type {any} */ (r.m).board.confidence !== 'none' ? ` · ${/** @type {any} */ (r.m).board.name}` : ''}`)),
      h('span', { class: 'row tight' },
        r.m.id === app.mapping?.id ? null : h('button', { class: 'link', disabled: !!app.busy, onclick: () => open(r.m.id) }, 'Open'),
        h('button', { class: 'link danger-text', disabled: !!app.busy, onclick: () => remove(r) }, 'Delete'))))) : h('p', { class: 'muted' }, 'No speakers yet.'),
    unassigned ? h('p', { class: 'muted' }, `${unassigned} older measurement${unassigned === 1 ? ' was' : 's were'} made before measurements were kept per speaker; ${unassigned === 1 ? 'it stays' : 'they stay'} in Measure until you delete ${unassigned === 1 ? 'it' : 'them'} there.`) : null,
  ], true, 'speakers');
}
