// @ts-check
// One small API over Home Assistant's WebSocket, from either:
// - the sidebar panel: HA hands the panel a `hass` object with a live connection, or
// - the standalone page: a long-lived access token and our own WebSocket.

/**
 * @typedef {{
 *   send: (msg: Record<string, any>) => Promise<any>,
 *   subscribe: (msg: Record<string, any>, onEvent: (event: any) => void) => Promise<() => Promise<void> | void>,
 *   onClose?: (cb: () => void) => void,
 *   onReconnect?: (cb: () => void) => void,
 *   close?: () => void,
 *   http?: { baseUrl: string, token: () => string | Promise<string> },
 * }} Transport
 */

export class HaApi {
  /** @param {Transport} transport */
  constructor(transport) {
    this.transport = transport;
  }

  getStates() {
    return this.transport.send({ type: 'get_states' });
  }

  getConfig() {
    return this.transport.send({ type: 'get_config' });
  }

  deviceRegistry() {
    return this.transport.send({ type: 'config/device_registry/list' });
  }

  entityRegistry() {
    return this.transport.send({ type: 'config/entity_registry/list' });
  }

  /**
   * @param {string} domain @param {string} service
   * @param {Record<string, any>} [data] @param {{ entity_id: string | string[] }} [target]
   */
  callService(domain, service, data = {}, target) {
    return this.transport.send({ type: 'call_service', domain, service, service_data: data, ...(target ? { target } : {}) });
  }

  /** @param {(event: { data: { entity_id: string, new_state: any, old_state: any } }) => void} cb */
  subscribeStateChanged(cb) {
    return this.transport.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, cb);
  }

  /** @param {() => void} cb */
  onClose(cb) {
    this.transport.onClose?.(cb);
  }

  /** @param {() => void} cb */
  onReconnect(cb) {
    this.transport.onReconnect?.(cb);
  }
}

/**
 * Transport from the `hass` object HA gives a custom panel.
 * @param {any} hass
 * @returns {Transport}
 */
export function transportFromHass(hass) {
  return {
    send: (msg) => hass.connection.sendMessagePromise(msg),
    subscribe: (msg, cb) => hass.connection.subscribeMessage(cb, msg),
    onClose: (cb) => hass.connection.addEventListener('disconnected', cb),
    // HA's frontend reconnects by itself; states that changed in the gap have to be re-read
    onReconnect: (cb) => hass.connection.addEventListener('ready', cb),
    http: {
      baseUrl: typeof hass.hassUrl === 'function' ? hass.hassUrl('').replace(/\/$/, '') : '',
      token: async () => {
        if (hass.auth?.expired && typeof hass.auth.refreshAccessToken === 'function') await hass.auth.refreshAccessToken();
        return hass.auth?.accessToken ?? hass.auth?.data?.access_token;
      },
    },
  };
}

/** @param {string} url */
export function websocketUrl(url) {
  const u = new URL(url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + '/api/websocket';
  return u.toString();
}

/**
 * Connect with a long-lived access token.
 * @param {string} baseUrl e.g. https://homeassistant.local:8123
 * @param {string} token
 * @param {{ WebSocketImpl?: any }} [options]
 * @returns {Promise<Transport>}
 */
export function connectWithToken(baseUrl, token, { WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(websocketUrl(baseUrl));
    let nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    const pending = new Map();
    /** @type {Map<number, (event: any) => void>} */
    const listeners = new Map();
    /** @type {Array<() => void>} */
    const closeCallbacks = [];
    let authed = false;

    const sendRaw = (/** @type {any} */ msg) => ws.send(JSON.stringify(msg));
    /** @param {Record<string, any>} msg */
    const send = (msg) =>
      new Promise((res, rej) => {
        if (ws.readyState !== 1) return rej(new Error('Not connected to Home Assistant'));
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        sendRaw({ ...msg, id });
      });

    /** @type {Transport} */
    const transport = {
      send,
      subscribe: async (msg, cb) => {
        const id = nextId;
        listeners.set(id, cb);
        try {
          await send(msg);
        } catch (e) {
          listeners.delete(id);
          throw e;
        }
        return async () => {
          listeners.delete(id);
          if (ws.readyState === 1) await send({ type: 'unsubscribe_events', subscription: id }).catch(() => {});
        };
      },
      onClose: (cb) => closeCallbacks.push(cb),
      close: () => ws.close(),
      http: { baseUrl: baseUrl.replace(/\/$/, ''), token: () => token },
    };

    ws.onmessage = (/** @type {{ data: string }} */ ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'auth_required') {
        sendRaw({ type: 'auth', access_token: token });
      } else if (msg.type === 'auth_ok') {
        authed = true;
        resolve(transport);
      } else if (msg.type === 'auth_invalid') {
        reject(new Error(`Home Assistant rejected the token: ${msg.message ?? 'invalid'}`));
        ws.close();
      } else if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error(msg.error?.message ?? 'Home Assistant returned an error'));
      } else if (msg.type === 'event') {
        listeners.get(msg.id)?.(msg.event);
      }
    };
    ws.onerror = () => {
      if (!authed) reject(new Error(`Could not connect to ${baseUrl}. Check the URL, and that the page and Home Assistant are both https or both http.`));
    };
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('Connection to Home Assistant closed'));
      pending.clear();
      if (!authed) reject(new Error('Connection to Home Assistant closed before login'));
      closeCallbacks.forEach((cb) => cb());
    };
  });
}

/** Where the test noise goes: /media/speaker-tuner/ on a standard install (HA creates the folder). */
export const MEDIA_FOLDER = 'media-source://media_source/local/speaker-tuner';

/**
 * Upload a file into HA's local media folder (needs an admin user).
 * The result is the uploaded file's media-source:// ID, ready for play_media.
 * @param {HaApi} api @param {Blob} file @param {string} filename
 * @param {{ fetchImpl?: typeof fetch, folder?: string }} [options]
 */
export async function uploadMedia(api, file, filename, { fetchImpl = globalThis.fetch, folder = MEDIA_FOLDER } = {}) {
  const http = api.transport.http;
  if (!http) throw new Error('This connection cannot upload files');
  const form = new FormData();
  form.append('media_content_id', folder);
  form.append('file', file, filename);
  const res = await fetchImpl(`${http.baseUrl}/api/media_source/local_source/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await http.token()}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}). ${res.status === 401 ? 'Uploading needs an admin user. ' : ''}${text}`.trim());
  }
  const body = await res.json();
  return /** @type {string} */ (body.media_content_id);
}
