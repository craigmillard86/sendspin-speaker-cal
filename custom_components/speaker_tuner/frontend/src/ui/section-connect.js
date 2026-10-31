// @ts-check
// Standalone page only: connect to Home Assistant with a long-lived token, or try the demo.
// (The sidebar panel is already logged in.)

import { h, field } from './dom.js';
import { card } from './app.js';
import * as store from './store.js';
import { HaApi, connectWithToken } from '../ha/connection.js';

/** @param {import('./app.js').TunerApp} app */
export function renderConnect(app) {
  // what the user typed is kept on the app, so a re-render (e.g. after a failed attempt) doesn't wipe it
  const a = /** @type {any} */ (app);
  if (!a.connectForm) {
    const saved = store.load('connection', { url: '', token: '' });
    a.connectForm = { url: saved.url, token: saved.token, remember: !!saved.token };
  }
  const form = a.connectForm;
  const url = /** @type {HTMLInputElement} */ (h('input', { type: 'url', placeholder: 'https://homeassistant.local:8123', value: form.url, autocomplete: 'url', oninput: () => (form.url = url.value) }));
  const token = /** @type {HTMLInputElement} */ (h('input', { type: 'password', placeholder: 'Long-lived access token', value: form.token, autocomplete: 'off', oninput: () => (form.token = token.value) }));
  const remember = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: form.remember, onchange: () => (form.remember = remember.checked) }));

  const connect = () => app.run('Connecting to Home Assistant', async () => {
    const address = url.value.trim();
    if (!/^https?:\/\/[^/\s]+/i.test(address)) throw new Error('Enter your Home Assistant address, starting with https:// (or http://), for example https://homeassistant.local:8123');
    if (!token.value.trim()) throw new Error('Paste a long-lived access token. Create one in Home Assistant: your profile, Security, Long-lived access tokens.');
    const t = await connectWithToken(address, token.value.trim());
    app.api = new HaApi(t);
    app.demo = false;
    store.save('connection', { url: address, token: remember.checked ? token.value.trim() : '' });
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
