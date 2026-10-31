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
    this._narrow = false;
    this.attachShadow({ mode: 'open' });
  }

  /** @param {any} hass */
  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this.start();
    this.applyTheme();
  }

  /** HA sets this on phones, where the sidebar is hidden and the panel needs a menu button. */
  set narrow(narrow) {
    this._narrow = !!narrow;
    const menu = this.shadowRoot?.querySelector('.ha-menu');
    if (menu instanceof HTMLElement) menu.hidden = !this._narrow;
  }

  disconnectedCallback() {
    // HA removed the panel (navigated away): close the mic and stop following HA. The next
    // `hass` it receives (when shown again) starts a fresh app.
    this.app?.dispose();
    this.app = null;
    this._hass = null;
    this.shadowRoot?.replaceChildren();
  }

  get hass() {
    return this._hass;
  }

  applyTheme() {
    const page = this.shadowRoot?.querySelector('.page');
    if (!page) return;
    const theme = this._hass?.themes?.darkMode ? 'dark' : 'light';
    if (page.getAttribute('data-theme') === theme) return;
    page.setAttribute('data-theme', theme);
    this.app?.chart?.draw(); // canvas colours come from the theme
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
    this.app.start().then(() => {
      // a menu button in the header on phones, like HA's own panels have
      const menu = Object.assign(document.createElement('button'), { className: 'ha-menu link', textContent: '☰', title: 'Menu', hidden: !this._narrow });
      menu.setAttribute('aria-label', 'Open the Home Assistant menu');
      menu.addEventListener('click', () => this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true })));
      root.querySelector('.top')?.prepend(menu);
      this.applyTheme();
    }).catch((e) => {
      root.append(Object.assign(document.createElement('p'), { textContent: `Speaker Tuner failed to start: ${e.message}` }));
      console.error(e);
    });
  }
}

if (!customElements.get('speaker-tuner-panel')) customElements.define('speaker-tuner-panel', SpeakerTunerPanel);
