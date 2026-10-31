// @ts-check
// Writes role values to a speaker through HA and waits for each entity to report the new
// value. Keeps a live copy of the device's states, takes snapshots and reverts them.
//
// A write stops at the first entity that fails to confirm in time, or when the caller
// aborts, and reports exactly what was written and what was not. It never reverts on its
// own: a revert can fail the same way, so the user decides.

import { expandRoles } from '../profiles/profile.js';
import { valueFromState, numberRange, fitToRange, sameValue, serviceFor } from './entities.js';

/**
 * @typedef {{ written: string[], unchanged: string[], failed: Array<{ role: string, error: string }>,
 *   remaining: string[], skipped: string[], stopped: boolean, ok: boolean }} WriteReport
 */

/** Gain fields go last, so a PEQ band only switches on once its frequency and Q are set. */
function writeOrder(/** @type {string} */ role) {
  if (/peq_\d+_gain$/.test(role)) return 2;
  if (/_type$/.test(role)) return 1;
  return 0;
}

export class DspWriter {
  /**
   * @param {import('./connection.js').HaApi} api
   * @param {import('../profiles/profile.js').Profile} profile
   * @param {Record<string, string>} entities role -> entity_id
   * @param {{ timeoutMs?: number }} [options]
   */
  constructor(api, profile, entities, { timeoutMs = 8000 } = {}) {
    this.api = api;
    this.profile = profile;
    this.roles = expandRoles(profile);
    this.entities = entities;
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, any>} */
    this.states = new Map();
    /** @type {Set<() => void>} */
    this.waiters = new Set();
    /** @type {null | (() => any)} */
    this.unsubscribe = null;
    /** @type {null | (() => void)} called after a mapped entity changes */
    this.onChange = null;
  }

  /** Load current states and follow changes. */
  async start() {
    const ids = new Set(Object.values(this.entities));
    this.unsubscribe = await this.api.subscribeStateChanged((event) => {
      const id = event?.data?.entity_id;
      if (!ids.has(id)) return;
      this.states.set(id, event.data.new_state);
      for (const w of [...this.waiters]) w();
      this.onChange?.();
    });
    for (const s of await this.api.getStates()) if (ids.has(s.entity_id)) this.states.set(s.entity_id, s);
  }

  /** Fetch every state again, e.g. after a reconnect, when changes may have been missed. */
  async reload() {
    const ids = new Set(Object.values(this.entities));
    for (const s of await this.api.getStates()) if (ids.has(s.entity_id)) this.states.set(s.entity_id, s);
    for (const w of [...this.waiters]) w();
  }

  async stop() {
    await this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** @param {string} role */
  stateOf(role) {
    const id = this.entities[role];
    return id ? this.states.get(id) : undefined;
  }

  /** @param {string} role */
  value(role) {
    const spec = this.roles[role];
    return spec ? valueFromState(spec.domain, this.stateOf(role)) : null;
  }

  /** @param {string} role */
  range(role) {
    return numberRange(this.roles[role], this.stateOf(role));
  }

  /** Current values of every mapped role (null where unavailable). @param {string[]} roles */
  values(roles) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const r of roles) if (this.entities[r]) out[r] = this.value(r);
    return out;
  }

  /**
   * Values of the given roles, to restore later. Unavailable entities are left out.
   * @param {string[]} roles
   */
  snapshot(roles) {
    const out = this.values(roles);
    for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
    return out;
  }

  /**
   * Resolve when predicate holds for the role's state, reject after the timeout.
   * @param {string} role @param {(value: any) => boolean} predicate @param {AbortSignal} [signal]
   */
  waitFor(role, predicate, signal) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (predicate(this.value(role))) {
          done();
          resolve(undefined);
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`${this.entities[role]} did not report the new value within ${this.timeoutMs / 1000} s`));
      }, this.timeoutMs);
      const onAbort = () => {
        done();
        reject(new Error('Stopped'));
      };
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
      };
      this.waiters.add(check);
      signal?.addEventListener('abort', onAbort);
      check();
    });
  }

  /**
   * Write role values in a safe order and wait for each to be confirmed.
   * @param {Record<string, any>} changes role -> value
   * @param {{ signal?: AbortSignal, onProgress?: (role: string, index: number, total: number) => void }} [options]
   * @returns {Promise<WriteReport>}
   */
  async write(changes, { signal, onProgress } = {}) {
    const order = Object.keys(changes).sort((a, b) => writeOrder(a) - writeOrder(b));
    /** @type {WriteReport} */
    const report = { written: [], unchanged: [], failed: [], remaining: [], skipped: [], stopped: false, ok: true };
    for (let i = 0; i < order.length; i++) {
      const role = order[i];
      if (signal?.aborted) {
        report.stopped = true;
        report.ok = false;
        report.remaining = order.slice(i);
        break;
      }
      const spec = this.roles[role];
      const entity = this.entities[role];
      if (!spec || !entity) {
        report.skipped.push(role);
        continue;
      }
      onProgress?.(role, i, order.length);
      let value = changes[role];
      let step = 0;
      if (spec.domain === 'number') {
        const r = this.range(role);
        value = fitToRange(Number(value), r);
        step = r.step;
      }
      if (sameValue(spec.domain, this.value(role), value, step)) {
        report.unchanged.push(role);
        continue;
      }
      try {
        const call = serviceFor(spec.domain, entity, value);
        await this.api.callService(call.domain, call.service, call.data, call.target);
        await this.waitFor(role, (v) => sameValue(spec.domain, v, value, step), signal);
        report.written.push(role);
      } catch (e) {
        const message = /** @type {Error} */ (e).message;
        report.ok = false;
        if (message === 'Stopped') report.stopped = true;
        else report.failed.push({ role, error: message });
        report.remaining = order.slice(i + (message === 'Stopped' ? 0 : 1));
        break;
      }
    }
    return report;
  }

  /** Press a button role. @param {string} role */
  async press(role) {
    const entity = this.entities[role];
    if (!entity) throw new Error(`No entity mapped for ${role}`);
    await this.api.callService('button', 'press', {}, { entity_id: entity });
  }
}
