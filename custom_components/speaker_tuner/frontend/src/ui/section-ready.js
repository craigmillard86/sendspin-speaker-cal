// @ts-check
// Set up, at a glance: what is ready and what still needs doing before measuring, each with
// the button that takes you to it.

import { h } from './dom.js';
import { card } from './app.js';

/** @param {import('./app.js').TunerApp} app */
export function renderReady(app) {
  const open = (/** @type {string} */ name) => () => app.focusSetup(name);
  const items = [
    {
      ok: !!app.api,
      title: 'Home Assistant',
      sub: app.demo ? 'Demo mode: a simulated speaker' : app.api ? (app.mode === 'panel' ? 'Connected through the sidebar panel' : 'Connected') : 'Not connected yet',
      action: app.api ? null : { label: app.mode === 'panel' ? 'Reload the page' : 'Connect', fn: app.mode === 'panel' ? () => location.reload() : open('connect') },
    },
    {
      ok: !!(app.mapping && app.writer),
      title: 'Speaker',
      sub: app.mapping ? `${app.mapping.name} · ${app.profile?.name ?? 'unknown profile'}` : 'Pick the ESPHome speaker and match its settings',
      action: { label: app.mapping ? 'Change' : 'Set up the speaker', fn: open('speaker') },
    },
    {
      ok: app.demo || !!app.recorder,
      title: 'Microphone',
      sub: app.demo ? 'Simulated in demo mode' : app.recorder ? `${app.mic.name} · ${app.mic.tier}` : 'Pick the mic you will measure with',
      action: app.demo ? null : { label: app.recorder ? 'Change' : 'Choose microphone', fn: open('mic') },
    },
    {
      ok: app.demo || !!app.mapping?.media_url,
      title: 'Test noise',
      sub: app.demo ? 'Simulated in demo mode' : app.mapping?.media_url ? 'Pink noise in Home Assistant media' : 'Put the test noise file in Home Assistant',
      action: app.demo ? null : { label: app.mapping?.media_url ? 'Play 3 s' : 'Add the test noise', fn: open('speaker') },
    },
  ];
  const missing = items.filter((i) => !i.ok);
  return card('Ready to measure', missing.length ? `${items.length - missing.length} of ${items.length} ready` : 'All ready', [
    h('ul', { class: 'ready' }, items.map((i) => h('li', null,
      h('span', { class: `mark ${i.ok ? 'mark-ok' : 'mark-no'}`, 'aria-hidden': 'true' }, i.ok ? '✓' : '×'),
      h('span', { class: 'ready-what' }, h('b', null, i.title), h('span', null, i.sub)),
      i.action ? h('button', { class: i.ok ? 'btn' : 'btn primary', onclick: i.action.fn, disabled: !!app.busy }, i.action.label) : h('span')))),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: missing.length > 0, onclick: () => app.goStep('measure') }, 'Next: Measure'),
      missing.length ? h('span', { class: 'reason' }, `Still needed: ${missing.map((i) => i.title.toLowerCase()).join(', ')}`) : null),
  ], true, 'ready');
}
