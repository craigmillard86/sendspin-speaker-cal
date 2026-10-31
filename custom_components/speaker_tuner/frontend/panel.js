// @ts-check
// Home Assistant sidebar panel. HA creates <speaker-tuner-panel> and sets `hass`, `narrow`
// and `panel` on it; the app uses HA's own logged-in connection, so no token is needed.

import { TunerApp } from './src/ui/app.js';
import { HaApi, transportFromHass } from './src/ha/connection.js';

class SpeakerTunerPanel extends HTMLElement {
  constructor() {
    super();
    /** @type {any} */
    this._hass = null;
    /** @type {TunerApp | null} */
    this.app = null;
    this.attachShadow({ mode: 'open' });
  }

  /** @param {any} hass */
  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this.start();
    this.applyTheme();
  }

  get hass() {
    return this._hass;
  }

  applyTheme() {
    const page = this.shadowRoot?.querySelector('.page');
    if (page) page.setAttribute('data-theme', this._hass?.themes?.darkMode ? 'dark' : 'light');
  }

  start() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('./app.css', import.meta.url).href;
    const style = document.createElement('style');
    style.textContent = ':host { display: block; height: 100%; overflow: auto; background: var(--primary-background-color); }';
    root.append(css, style);
    this.app = new TunerApp(root, { mode: 'panel', api: new HaApi(transportFromHass(this._hass)) });
    this.app.start().then(() => this.applyTheme()).catch((e) => {
      root.append(Object.assign(document.createElement('p'), { textContent: `Speaker Tuner failed to start: ${e.message}` }));
      console.error(e);
    });
  }
}

if (!customElements.get('speaker-tuner-panel')) customElements.define('speaker-tuner-panel', SpeakerTunerPanel);
