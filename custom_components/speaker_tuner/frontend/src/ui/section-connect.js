// @ts-check
// Standalone page only: connect to Home Assistant with a long-lived token, or try the demo.
// (The sidebar panel is already logged in.)

import { h, field } from './dom.js';
import { card } from './app.js';
import * as store from './store.js';
import { HaApi, connectWithToken } from '../ha/connection.js';

/** @param {import('./app.js').TunerApp} app */
export function renderConnect(app) {
  const saved = store.load('connection', { url: '', token: '' });
  const url = /** @type {HTMLInputElement} */ (h('input', { type: 'url', placeholder: 'https://homeassistant.local:8123', value: saved.url, autocomplete: 'url' }));
  const token = /** @type {HTMLInputElement} */ (h('input', { type: 'password', placeholder: 'Long-lived access token', value: saved.token, autocomplete: 'off' }));
  const remember = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: !!saved.token }));

  const connect = () => app.run('Connecting to Home Assistant', async () => {
    const t = await connectWithToken(url.value.trim(), token.value.trim());
    app.api = new HaApi(t);
    app.demo = false;
    store.save('connection', { url: url.value.trim(), token: remember.checked ? token.value.trim() : '' });
    await app.connected();
    app.notify('Connected to Home Assistant.', 'ok');
  });

  const connected = !!app.api;
  return card('Connect', app.demo ? 'Demo mode' : connected ? 'Connected' : 'Not connected', [
    h('p', null, 'Use the Speaker Tuner panel in the Home Assistant sidebar if you can: it needs no token. This page is for running the tool from elsewhere.'),
    field('Home Assistant URL', url, 'Use https if this page is on https. The mic only works on https pages or localhost.'),
    field('Long-lived access token', token, 'Create one in Home Assistant: your profile, Security, Long-lived access tokens.'),
    h('label', { class: 'check' }, remember, ' Remember the token in this browser'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: connect, disabled: !!app.busy }, connected && !app.demo ? 'Reconnect' : 'Connect'),
      h('button', { onclick: () => app.startDemo(), disabled: !!app.busy }, 'Try the demo')),
    h('p', { class: 'help' }, 'If connecting fails from another host, add this page\'s address to http: cors_allowed_origins in Home Assistant\'s configuration.yaml (see the README).'),
  ], !connected && !app.demo);
}
