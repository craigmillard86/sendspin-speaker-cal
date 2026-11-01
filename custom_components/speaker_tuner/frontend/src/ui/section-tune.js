// @ts-check
// Tune: the guided steps, the PEQ fit with its predicted result, apply and refine,
// revert, A/B listening and copying the tuning to another speaker.

import { h, field, select, db } from './dom.js';
import { card, feedbackBox, helpButton } from './app.js';
import {
  levelMatch, polarityTest, crossoverScan, delayScan, lowEnd, notchAndAir, baffleSuggestion, boostFloor,
} from '../measure/driver-checks.js';
import { planPeqFit, curveRms, micRules, effectiveBoostFloor, peqFindings, bandChanges } from '../measure/peq.js';
import { applyAndRefine } from '../measure/refine.js';
import { settingRoles } from '../profiles/profile.js';
import { DspWriter } from '../ha/dsp-writer.js';
import { Playback } from '../ha/playback.js';
import { MicMeasurer, sleep } from '../measure/session.js';
import { levelAt1k } from '../dsp/smoothing.js';
import { meanDb, rmsDeviation } from '../dsp/metrics.js';
import { view, normalised } from '../dsp/analyse.js';
import { formatHz } from './chart.js';

/** @typedef {import('./app.js').TunerApp} App */

/** Measurer that goes through the app (session volume, loudness off), for the guided steps. @param {App} app @param {AbortSignal} signal */
function ctxFor(app, signal, { positions = app.settings.checkPositions, showAll = false, test = false } = {}) {
  const inner = app.measurer();
  let shown = 0;
  return {
    writer: /** @type {DspWriter} */ (app.writer),
    profile: /** @type {any} */ (app.profile),
    positions,
    signal,
    onStatus: (/** @type {string} */ t) => app.status(t),
    onPrompt: (/** @type {number} */ i, /** @type {number} */ n) => app.promptPosition(i, n, signal),
    onMeasurement: (/** @type {any} */ m) => {
      // test measurements (settings changed for a comparison) are kept apart from real ones:
      // never offered for the fit, the report or A/B, and only the latest few are saved
      if (test) m.test = true;
      // a step's first measurement goes next to the baseline; the rest of the run joins it
      app.addMeasurement(m, { focus: shown === 0 });
      // scans make many measurements; only the first few stay on the chart
      if (!showAll && ++shown > 2) app.visible.delete(m.id);
      else if (showAll) shown++;
    },
    measurer: {
      name: inner.name,
      getVolume: () => inner.getVolume(),
      setVolume: (/** @type {number} */ v) => inner.setVolume(v),
      autoLevel: (/** @type {any} */ o) => inner.autoLevel(o),
      // every measurement goes through the app (loudness off, session); nearfield keeps its own level
      measure: (/** @type {any} */ req) => app.measure(req, signal, { keepVolume: req.kind === 'nearfield' }),
    },
  };
}

/** Human summary of a write report, with retry/revert for failures. @param {App} app @param {import('../ha/dsp-writer.js').WriteReport} r @param {Record<string, any>} changes */
function reportWrite(app, r, changes) {
  if (r.ok) {
    app.notify(`Written: ${r.written.length} changed, ${r.unchanged.length} already set. Values are saved on the device; wait a minute before power-cycling it.`, 'ok');
    return;
  }
  const failed = r.failed.map((f) => `${f.role}: ${f.error}`).join('; ');
  app.notify(`${r.stopped ? 'Stopped' : 'Writing failed'} after ${r.written.length} values. ${failed} Not written: ${r.remaining.join(', ') || 'none'}.`, 'error');
  /** @type {any} */ (app).pendingRetry = Object.fromEntries(r.remaining.map((k) => [k, changes[k]]));
  app.refresh('tune');
}

/** @param {App} app @param {Record<string, any>} changes @param {string} what */
function applyValues(app, changes, what, onDone) {
  return app.run(`Applying ${what}`, async (signal) => {
    await app.ensureSession();
    const w = /** @type {DspWriter} */ (app.writer);
    const before = Object.fromEntries(Object.keys(changes).map((k) => [k, w.value(k)]));
    const r = await w.write(changes, { signal });
    reportWrite(app, r, changes);
    app.logApplied(what, before, Object.fromEntries(Object.keys(changes).map((k) => [k, w.value(k)])));
    if (r.ok) onDone?.();
    await checkHeadroom(app);
  });
}

/** Read the chain peak-gain sensors; warn above 0 dB and offer headroom compensation. @param {App} app */
async function checkHeadroom(app) {
  const w = /** @type {DspWriter} */ (app.writer);
  if (!app.has('tweeter_peak_gain') && !app.has('mid_peak_gain')) return;
  await sleep(app.demo ? 50 : 2500);
  const peaks = ['tweeter_peak_gain', 'mid_peak_gain'].map((r) => ({ r, v: w.value(r) })).filter((p) => typeof p.v === 'number' && p.v > 0);
  /** @type {any} */ (app).headroomWarning = peaks.length && !w.value('headroom_compensation')
    ? `The ${peaks.map((p) => `${p.r.startsWith('tweeter') ? 'tweeter' : 'mid'} chain peaks at +${p.v.toFixed(1)} dB`).join(' and ')}: loud passages can clip in the DSP.`
    : '';
}

/** @param {string[]} roles @param {App} app */
const missing = (roles, app) => roles.filter((r) => !app.has(r));

/**
 * One guided step block.
 * @param {App} app @param {{ id: string, title: string, text: string, needs: string[], run: (signal: AbortSignal) => Promise<any>,
 *   describe: (r: any) => any, extra?: any, enabled?: boolean, note?: string }} step
 */
function step(app, { id, title, text, needs, run, describe, extra, enabled = true, note }) {
  const lacking = missing(needs, app);
  const result = app.results[id];
  const suggestion = result?.suggestion ?? {};
  const hasSuggestion = Object.keys(suggestion).length > 0;
  if (!isOpen(app, id)) return closedStep(app, id, title, stepChip(result));
  const go = () => app.run(title, async (signal) => {
    // the revert point is taken before the step writes its first test value
    app.ui.tune.open = id;
    await app.ensureSession();
    app.results[id] = await run(signal);
  }, id);
  // the step's state at a glance
  const chip = stepChip(result);
  const roles = app.roles;
  /** @param {any} v */
  const show = (v) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : v === true ? 'on' : v === false ? 'off' : String(v ?? '–'));
  return h('div', { class: 'step', 'data-where': id },
    h('div', { class: 'step-head' },
      stepToggle(app, id, title, chip, true),
      helpButton(id, title.replace(/^\d+\.\s*/, '')),
      h('button', { class: result ? '' : 'primary', onclick: go, disabled: !!app.busy || !app.writer || lacking.length > 0 || !enabled }, result ? 'Run again' : 'Run')),
    h('p', { class: 'help' }, text),
    lacking.length ? h('p', { class: 'reason' }, `Needs these settings mapped in Set up: ${lacking.join(', ')}.`) : null,
    note ? h('p', { class: 'reason' }, note) : null,
    extra ?? null,
    result ? h('div', { class: 'step-result' }, describe(result)) : null,
    hasSuggestion && !result.applied ? h('div', null,
      h('table', { class: 'ba' },
        h('tr', null, h('th', null, 'Setting'), h('th', null, 'Now'), h('th', null, 'Suggested')),
        Object.entries(suggestion).map(([k, v]) => h('tr', null,
          h('td', null, roles[k]?.label ?? k),
          h('td', null, `${show(app.writer?.value(k))}${roles[k]?.unit ? ` ${roles[k].unit}` : ''}`),
          h('td', { class: 'ba-new' }, `${show(v)}${roles[k]?.unit ? ` ${roles[k].unit}` : ''}`)))),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: !!app.busy, onclick: () => applyValues(app, suggestion, title.replace(/^\d+\.\s*/, '').toLowerCase(), () => (result.applied = true)) }, 'Apply'),
        h('span', { class: 'reason' }, 'Nothing changes on the speaker until you apply.'))) : null,
    result && (result.applied || !hasSuggestion) ? nextButton(app, id) : null,
    feedbackBox(id));
}

/** @param {any} result @returns {[string, string]} */
function stepChip(result) {
  if (!result) return ['Not run', ''];
  if (result.applied) return ['Applied', 'chip-ok'];
  return Object.keys(result.suggestion ?? {}).length ? ['Suggested change', 'chip-strong'] : ['Nothing to change', 'chip-ok'];
}

/** One step is open at a time. @param {App} app @param {string} id */
function isOpen(app, id) {
  return app.ui.tune?.open === id;
}

/** @param {App} app @param {string | null} id */
function openStep(app, id) {
  app.ui.tune.open = id;
  app.refresh('tune');
  if (id) app.root.querySelector(`.step[data-where="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * The step's title and state; pressing it opens or closes the step.
 * @param {App} app @param {string} id @param {string} title @param {[string, string]} chip @param {boolean} open
 */
function stepToggle(app, id, title, chip, open) {
  return h('button', { class: 'step-toggle', 'aria-expanded': String(open), onclick: () => openStep(app, open ? null : id) },
    h('h4', null, title), h('span', { class: `chip ${chip[1]}` }, chip[0]), h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '⌃' : '⌄'));
}

/** A closed step: one line. Its messages still show. @param {App} app @param {string} id @param {string} title @param {[string, string]} chip */
function closedStep(app, id, title, chip) {
  return h('div', { class: 'step step-closed', 'data-where': id }, h('div', { class: 'step-head' }, stepToggle(app, id, title, chip, false), helpButton(id, title.replace(/^\d+\.\s*/, ''))), feedbackBox(id));
}

/** @param {App} app @param {string} id */
function nextButton(app, id) {
  const order = app.ui.tune?.order ?? [];
  const next = order[order.indexOf(id) + 1];
  return next ? h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => openStep(app, next) }, 'Next step')) : null;
}

/** Chart reference level: 1 kHz of the first full measurement shown (as in app.updateChart). @param {App} app */
function chartReference(app) {
  const first = app.measurements.find((m) => app.visible.has(m.id) && m.kind !== 'nearfield');
  return first ? levelAt1k(first.curve.freqs, first.curve.db) : 0;
}

/** @param {App} app */
export function renderTune(app) {
  const ready = !!app.writer && !!app.profile;
  const tier = app.mic.tier;
  const isCrossover = app.profile?.component === 'tas58xx-crossover';
  const fulls = app.measurements.filter((m) => m.kind === 'full' && !m.undone && !m.test);
  const latest = (/** @type {string} */ kind) => [...app.measurements].reverse().find((m) => m.kind === kind);

  const xoInput = /** @type {HTMLInputElement} */ (h('input', { value: app.settings.crossoverList, onchange: () => {
    app.settings.crossoverList = xoInput.value;
    app.persist();
  } }));
  const form = (app.ui.tune ??= { tryFilters: false, baffleWidth: null, open: undefined, order: [] });
  const tryFilters = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: form.tryFilters, onchange: () => (form.tryFilters = tryFilters.checked) }));
  const baffleWidth = /** @type {HTMLInputElement} */ (h('input', { type: 'number', min: 0, max: 50, step: 1, value: form.baffleWidth ?? app.writer?.value('baffle_width') ?? 0, oninput: () => (form.baffleWidth = baffleWidth.value) }));

  // one step open at a time: the first one not done yet, until the user picks another
  const order = [...(isCrossover ? ['lowEnd', 'level', 'polarity', 'crossover', 'delay', 'baffle', 'notch'] : []), 'peq'];
  const done = (/** @type {string} */ id) => (id === 'peq' ? !!(/** @type {any} */ (app).refineResult) : !!app.results[id] && stepChip(app.results[id])[0] !== 'Suggested change');
  form.order = order;
  if (form.open === undefined) form.open = order.find((id) => !done(id)) ?? null;

  const steps = isCrossover ? [
    step(app, {
      id: 'lowEnd', title: '1. Low end (nearfield)', needs: ['subsonic_frequency'],
      text: app.profile?.enclosure === 'sealed'
        ? 'Put the mic 1 cm from the centre of the mid/bass cone. Finds the box resonance for the Linkwitz transform and a safe subsonic filter.'
        : 'Put the mic 1 cm from the centre of the mid/bass cone. Finds the passive radiator (or port) tuning frequency, where the cone barely moves, and suggests a subsonic filter just below it. The PEQ fit will not boost below 1.3 × that frequency.',
      run: async (signal) => {
        await app.confirm('Nearfield measurement', 'Put the mic about 1 cm from the centre of the mid/bass cone, pointing at it. The level is set again for this position and put back afterwards.', 'Measure');
        const ctx = ctxFor(app, signal, { positions: 1 });
        // remember the volume to return to before levelling for the nearfield position changes it
        const back = app.session?.levelVolume ?? app.playerVolume();
        const lvl = await ctx.measurer.autoLevel({ start: 0.05, cap: app.session?.levelVolume ?? 0.3, signal, onStatus: ctx.onStatus });
        return lowEnd(ctx, { nearfieldVolume: lvl.volume, restoreVolume: back });
      },
      describe: (r) => r.enclosure === 'sealed'
        ? `Box resonance about ${Math.round(r.f0)} Hz, Q ${r.q0.toFixed(2)} (f3 ${Math.round(r.f3)} Hz). For a Linkwitz transform pick the target fp and Qp yourself in Speaker settings; each halving of fp is +12 dB of bass boost.`
        : r.fb ? `Tuning frequency about ${Math.round(r.fb)} Hz (cone dip ${r.depthDb.toFixed(0)} dB).` : 'No clear tuning dip found. Set the subsonic filter by hand in Speaker settings.',
    }),
    step(app, {
      id: 'level', title: '2. Driver levels', needs: ['tweeter_mute', 'mid_mute', 'tweeter_gain', 'mid_gain'],
      text: 'Measures each driver alone and cuts the louder one so they meet at the crossover.',
      run: (signal) => levelMatch(ctxFor(app, signal, { showAll: true })),
      describe: (r) => `The tweeter is ${db(r.differenceDb)} relative to the mid.`,
    }),
    step(app, {
      id: 'polarity', title: '3. Polarity', needs: ['tweeter_invert', 'crossover_frequency'],
      text: 'Measures the sum. If there is a dip of more than 3 dB at the crossover, tries the tweeter the other way round and keeps the flatter one.',
      run: (signal) => polarityTest(ctxFor(app, signal, { showAll: true, test: true })),
      describe: (r) => !r.needed ? `Dip at the crossover is ${r.normal.dipDb.toFixed(1)} dB, nothing to fix.`
        : `As is: dip ${r.normal.dipDb.toFixed(1)} dB, spread ${r.normal.flatnessDb.toFixed(2)} dB. Flipped: dip ${r.flipped.dipDb.toFixed(1)} dB, spread ${r.flipped.flatnessDb.toFixed(2)} dB. ${Object.keys(r.suggestion).length ? 'Flipped is flatter.' : 'Keep it as it is.'}`,
    }),
    step(app, {
      id: 'crossover', title: '4. Crossover point', needs: ['crossover_frequency'],
      text: 'Tries each crossover frequency in the list and keeps the one with the flattest sum through the crossover region. Frequencies below the tweeter minimum set in the device YAML are skipped.',
      extra: h('div', { class: 'row' }, field('Frequencies (Hz)', xoInput), app.has('crossover_filter') ? h('label', { class: 'check' }, tryFilters, ' Also try each filter type') : null),
      run: async (signal) => {
        const freqs = xoInput.value.split(/[\s,;]+/).map(Number).filter((f) => f > 0);
        if (!freqs.length) throw new Error('Enter at least one frequency.');
        const filters = tryFilters.checked ? Object.values(app.profile?.crossover?.filter_options ?? {}) : undefined;
        // every crossover point stays on the chart: comparing them is the point of the scan
        const r = await crossoverScan(ctxFor(app, signal, { test: true, showAll: true }), freqs, filters);
        if (r.suggestion.crossover_frequency) {
          // levels shift with the crossover: re-match at the winner
          r.note = 'Run "Driver levels" again after applying, since the levels at the new crossover differ.';
        }
        return r;
      },
      describe: (r) => h('div', null,
        r.skipped.length ? h('p', { class: 'muted' }, `Skipped (outside the allowed range): ${r.skipped.join(', ')} Hz`) : null,
        h('table', { class: 'small' }, h('tr', null, h('th', null, 'Show'), h('th', null, 'Crossover'), h('th', null, 'Spread ±1 oct'), h('th', null, 'Dip')),
          r.results.map((/** @type {any} */ x) => h('tr', null,
            h('td', null, showToggle(app, x.measurement)),
            h('td', null, `${x.frequency} Hz${x.filter && r.results.some((/** @type {any} */ y) => y.filter !== x.filter) ? ` ${x.filter}` : ''}${x === r.current ? ' (now)' : ''}`),
            h('td', null, `${x.flatnessDb.toFixed(2)} dB`), h('td', null, `${x.dipDb.toFixed(1)} dB`)))),
        !Object.keys(r.suggestion).length ? h('p', { class: 'muted' }, 'None is clearly flatter than the current setting, so no change is suggested.') : null,
        r.note ? h('p', { class: 'muted' }, r.note) : null),
    }),
    step(app, {
      id: 'delay', title: '5. Time alignment', needs: ['tweeter_delay', 'mid_delay', 'tweeter_invert', 'crossover_frequency'],
      text: 'Flips the tweeter for the test and scans the delay: the drivers cancel deepest at the crossover when they are best aligned. Then checks the normal sum is no worse. The fork\'s delay is an all-pass approximation, so the best value can differ from the physical offset.',
      run: (signal) => delayScan(ctxFor(app, signal, { test: true })),
      describe: (r) => `Deepest null at ${r.best.offsetMm > 0 ? `tweeter +${r.best.offsetMm}` : r.best.offsetMm < 0 ? `mid +${-r.best.offsetMm}` : '0'} mm (${r.best.dipDb.toFixed(1)} dB). Normal-polarity spread: ${r.confirm.best.flatnessDb.toFixed(2)} dB there vs ${r.confirm.current.flatnessDb.toFixed(2)} dB now${Object.keys(r.suggestion).length ? '' : ', so no change is suggested'}.`,
    }),
    step(app, {
      id: 'baffle', title: '6. Baffle step', needs: ['baffle_width'],
      text: 'Enter the front baffle width, or let the tool estimate it from the latest mid-alone (or whole speaker) measurement. The placement sets the boost: freestanding +6 dB, near a wall +3 dB, corner 0 dB.',
      extra: h('div', { class: 'row' }, field('Baffle width (cm)', baffleWidth),
        h('button', { onclick: () => {
          app.results.baffle = { suggestion: { baffle_width: Math.max(0, Math.min(50, Math.round(Number(baffleWidth.value) || 0))) }, manual: true };
          app.refresh('tune');
        } }, 'Use this width')),
      run: async () => {
        // the whole speaker first: a mid-alone curve has its own crossover roll-off in it
        const m = latest('full') ?? latest('mid');
        if (!m) throw new Error('Measure the mid alone (or the whole speaker) first.');
        const s = baffleSuggestion(m.curve, Number(app.writer?.value('crossover_frequency') ?? Infinity));
        if (!s) return { suggestion: {}, none: true };
        return s;
      },
      describe: (r) => r.manual ? 'Width entered by hand.' : r.none ? 'No clear baffle step in the measurement.' : `Step of ${r.stepDb.toFixed(1)} dB around ${Math.round(r.stepHz)} Hz, about a ${r.widthCm} cm baffle.`,
    }),
    step(app, {
      id: 'notch', title: '7. Tweeter breakup and air', needs: ['tweeter_notch_frequency', 'tweeter_notch_gain', 'tweeter_notch_q', 'air_gain'],
      enabled: tier === 'calibrated',
      note: tier === 'calibrated' ? undefined : 'Needs a calibrated mic: nothing above 10 kHz can be trusted otherwise.',
      text: 'Uses the latest tweeter-alone and whole-speaker measurements: a narrow peak above 10 kHz gets the breakup notch, and the trend above 10 kHz sets the air shelf.',
      run: async () => {
        const t = latest('tweeter');
        const f = latest('full');
        if (!t || !f) throw new Error('Measure the tweeter alone and the whole speaker first (Driver levels does both).');
        const w = /** @type {DspWriter} */ (app.writer);
        const current = Object.fromEntries(['air_gain', 'tweeter_notch_frequency', 'tweeter_notch_gain', 'tweeter_notch_q'].map((r) => [r, Number(w.value(r) ?? 0)]));
        return notchAndAir(t.curve, f.curve, app.target, tier, app.profile?.dsp_sample_rate ?? 96000, current);
      },
      describe: (r) => `${r.notch ? `Breakup peak at ${formatHz(r.notch.frequency)}Hz: notch ${r.notch.gainDb} dB, Q ${r.notch.q}. ` : 'No breakup peak found. '}Air shelf ${db(r.air)}.`,
    }),
  ] : [];

  return card('Tune', ready ? `Mic tier: ${tier}` : 'Set up a speaker first', [
    isCrossover ? h('p', { class: 'help' }, 'Work down the list; press a step to open it. Each step measures, puts back what it changed for the test, and suggests values; nothing changes until you press Apply. Run them again in any order.') : null,
    recommendedBlock(app),
    ...steps,
    peqBlock(app, fulls, chartReference),
    /** @type {any} */ (app).headroomWarning ? h('div', { class: 'notice notice-warn' }, /** @type {any} */ (app).headroomWarning,
      app.has('headroom_compensation') ? h('button', { onclick: () => applyValues(app, { headroom_compensation: true }, 'headroom compensation') }, 'Turn on headroom compensation') : null,
      ' Measure again afterwards: it lowers the level.') : null,
    /** @type {any} */ (app).pendingRetry ? h('div', { class: 'notice notice-error' }, 'Some values were not written.',
      h('button', { onclick: () => {
        const changes = /** @type {any} */ (app).pendingRetry;
        /** @type {any} */ (app).pendingRetry = null;
        applyValues(app, changes, 'the remaining values');
      } }, 'Retry remaining'),
      h('button', { onclick: () => revert(app) }, 'Revert to session start')) : null,
    abBlock(app),
    copyBlock(app),
    h('div', { class: 'row' },
      h('button', { class: 'danger', disabled: !sessionHere(app) || !!app.busy, onclick: () => revert(app) }, 'Revert to session start'),
      sessionHere(app) ? h('span', { class: 'muted' }, `Session started ${new Date(/** @type {any} */ (app.session).started).toLocaleString()}`) : null,
      app.session && !sessionHere(app) ? h('span', { class: 'muted' }, `The open session belongs to another speaker (${app.mappings.find((m) => m.id === app.session?.deviceId)?.name ?? 'removed'}); measuring here starts a new one.`) : null,
      sessionHere(app) ? h('button', { class: 'link', disabled: !!app.busy, onclick: () => endSession(app) }, 'End session') : null),
  ], ready);
}

/** @param {App} app @param {any[]} fulls @param {(app: App) => number} chartReference */
function peqBlock(app, fulls, chartReference) {
  const a = /** @type {any} */ (app);
  // the measurement to fit: the one picked, else the one the shown plan is for, else the latest
  const has = (/** @type {string} */ id) => !!id && fulls.some((m) => m.id === id);
  const baseId = has(a.fitBaseId) ? a.fitBaseId : has(app.plan?.baseId) ? app.plan.baseId : fulls[fulls.length - 1]?.id ?? '';
  const base = fulls.find((m) => m.id === baseId);
  // a plan (table and dotted line) is only ever shown for the measurement it was fitted to
  if (app.plan && app.plan.baseId !== baseId) {
    app.plan = null;
    app.preview = null;
  }
  const title = app.profile?.component === 'tas58xx-crossover' ? '8. PEQ fit' : 'PEQ fit';
  /** @type {[string, string]} */
  const chip = a.refineResult ? ['Applied', 'chip-ok'] : app.plan ? ['Fitted, not applied', 'chip-strong'] : ['Not run', ''];
  if (!isOpen(app, 'peq')) return closedStep(app, 'peq', title, chip);
  const rules = micRules(app.mic);
  const floor = effectiveBoostFloor(boostFloor({ fb: app.results.lowEnd?.fb, subsonic: Number(app.writer?.value('subsonic_frequency') ?? 0) }), rules.fMin);

  const fit = () => {
    if (!base) return app.notify('Measure the whole speaker first.', 'warn');
    try {
      const w = /** @type {DspWriter} */ (app.writer);
      // take out the PEQ the speaker had when this measurement was made, not today's
      const plan = planPeqFit({
        profile: /** @type {any} */ (app.profile), values: { ...app.values(), ...(base.settings ?? {}) }, rangeOf: (r) => w.range(r),
        curve: base.curve, target: app.target, mic: app.mic, boostFloorHz: floor, mask: base.mask,
      });
      app.plan = { ...plan, baseId: base.id };
      const offset = levelAt1k(base.curve.freqs, base.curve.db) - chartReference(app);
      app.visible.add(base.id);
      app.preview = { label: 'Predicted with the new PEQ', freqs: plan.freqs, db: plan.predictedDb.map((/** @type {number} */ d) => d + offset) };
      app.refresh('tune');
      app.updateChart();
    } catch (e) {
      app.notify(/** @type {Error} */ (e).message, 'error');
    }
  };

  const applyRefine = () => app.run('Applying the PEQ and measuring again', async (signal) => {
    if (!base) throw new Error('Measure the whole speaker first.');
    await app.ensureSession();
    const w = /** @type {DspWriter} */ (app.writer);
    const valuesBefore = { ...app.values() };
    /** @type {any} */
    let firstPlan = null;
    let first = true;
    const plan = (/** @type {{ freqs: number[], db: number[] }} */ curve) => {
      // the baseline may be an older measurement: use the settings it was made with; after
      // that each curve was just measured with the values the speaker holds now
      const values = first ? { ...app.values(), ...(base.settings ?? {}) } : app.values();
      const p = planPeqFit({ profile: /** @type {any} */ (app.profile), values, rangeOf: (r) => w.range(r), curve, target: app.target, mic: app.mic, boostFloorHz: floor });
      if (first) firstPlan = p;
      first = false;
      return p;
    };
    /** @type {any[]} */
    const records = [];
    const result = await applyAndRefine({
      writer: w, baseline: base.curve, plan, signal, rmsOf: (c) => curveRms(c, app.target, app.mic),
      measure: async (label) => {
        const rec = await app.measure({ label, kind: 'full', positions: base.positions }, signal);
        app.addMeasurement(rec);
        records.push(rec);
        return rec.curve;
      },
      onStatus: (t) => app.status(t),
      onStep: (s) => {
        if (!s.report.ok) reportWrite(app, s.report, s.changes);
      },
    });
    app.preview = null;
    app.plan = null;
    a.fitBaseId = null;
    for (const s of result.steps) {
      const rec = s.undone ? records[s.iteration - 1] : null;
      if (rec) {
        rec.label += ' (undone)';
        rec.undone = true;
        app.visible.delete(rec.id);
      }
    }
    app.persist();
    app.refresh('measure');
    a.refineResult = result;
    a.peqSet = { before: valuesBefore, after: { ...app.values() }, plan: firstPlan };
    app.logApplied(`the PEQ fit (deviation ${result.startRms.toFixed(2)} → ${result.finalRms.toFixed(2)} dB)`, valuesBefore, { ...app.values() });
    if (app.session) {
      /** @type {any} */ (app.session).ab = { b: w.snapshot(settingRoles(/** @type {any} */ (app.profile))), now: 'B', trim: 0 };
      app.persist();
    }
    const failedUndo = result.steps.find((s) => s.undoReport && !s.undoReport.ok);
    // the worse pass could not be undone: show what is left and offer to retry the undo
    if (failedUndo?.undoReport) reportWrite(app, failedUndo.undoReport, failedUndo.undoValues ?? {});
    if (result.steps.every((s) => s.report.ok) && !failedUndo) {
      app.notify(`RMS deviation ${result.startRms.toFixed(2)} → ${result.finalRms.toFixed(2)} dB after ${result.steps.length} pass${result.steps.length === 1 ? '' : 'es'} (${result.reason}). Values are saved on the device; wait a minute before power-cycling it.`, 'ok');
    }
    await checkHeadroom(app);
  });

  const plan = app.plan;
  const rr = a.refineResult;
  return h('div', { class: 'step', 'data-where': 'peq' },
    h('div', { class: 'step-head' }, stepToggle(app, 'peq', title, chip, true), helpButton('peq', 'PEQ fit')),
    h('p', { class: 'help' }, `Fits up to ${app.profile?.peq_banks.filter((b) => !b.mirror_of).map((b) => `${b.bands ?? b.frequencies?.length} ${b.name ?? b.id}`).join(' + ')} bands towards the target between ${formatHz(rules.fMin)}Hz and ${formatHz(rules.fMax)}Hz, gains ${rules.gainMin} to ${rules.gainMax} dB${rules.cutsOnly ? ' (cuts only)' : ''}. Narrow dips (room cancellations) are never boosted, nor anything below ${Math.round(floor)} Hz. Use a ${app.settings.positions}-position measurement for this.`),
    h('div', { class: 'row' },
      fulls.length ? field('Measurement to fit', select(fulls.map((m) => ({ value: m.id, label: `${m.label} (${m.positions} pos.)` })), baseId, (v) => {
        a.fitBaseId = v;
        app.plan = null;
        app.preview = null;
        app.refresh('tune');
        app.updateChart();
      })) : h('span', { class: 'muted' }, 'Measure the whole speaker first.'),
      h('button', { onclick: fit, disabled: !base || !app.writer }, 'Fit')),
    plan ? h('div', { class: 'step-result' },
      h('p', null, `Predicted deviation from the target: ${plan.rmsBefore.toFixed(2)} → ${plan.rmsAfter.toFixed(2)} dB RMS. Dotted line on the chart.`),
      findingsList(plan),
      h('h5', null, 'What it will set'),
      bandTable(app, app.values(), plan.changes, 'Now', 'New') ?? h('p', { class: 'muted' }, 'No PEQ bands needed within the rules; every band stays off.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: applyRefine, disabled: !!app.busy }, 'Apply and measure again'),
        h('span', { class: 'muted' }, 'Up to 3 passes; stops when a pass gains under 0.3 dB.'))) : null,
    rr && !plan ? h('div', { class: 'step-result' },
      h('p', null, `Last run: deviation ${rr.startRms.toFixed(2)} → ${rr.finalRms.toFixed(2)} dB RMS. ${rr.steps.map((/** @type {any} */ s) => `Pass ${s.iteration}: ${s.rms !== null ? `${s.rms.toFixed(2)} dB` : 'not measured'}${s.undone ? ' (worse, undone)' : ''}`).join('; ')}.`),
      a.peqSet?.plan ? findingsList(a.peqSet.plan) : null,
      a.peqSet ? h('h5', null, 'What it set (read back from the speaker)') : null,
      a.peqSet ? bandTable(app, a.peqSet.before, a.peqSet.after, 'Before', 'Set') ?? h('p', { class: 'muted' }, 'Every PEQ band is off.') : null) : null,
    feedbackBox('peq'));
}

/** @param {App} app */
function revert(app) {
  return app.run('Reverting to the session start', async (signal) => {
    const s = app.session;
    if (!s || !sessionHere(app)) throw new Error('No session for this speaker to revert to.');
    await app.confirm('Revert?', 'Writes back every DSP value captured when this session started, and unmutes both drivers.', 'Revert');
    const values = { ...s.snapshot };
    // mutes are never part of a snapshot (they always start off), but an interrupted
    // single-driver measurement can leave one on
    for (const m of ['tweeter_mute', 'mid_mute']) if (app.has(m)) values[m] = false;
    const r = await /** @type {DspWriter} */ (app.writer).write(values, { signal });
    if (s.volume !== null) await app.setPlayerVolume(s.volume).catch(() => {});
    reportWrite(app, r, s.snapshot);
    if (r.ok) app.notify('Reverted to the values at the start of the session.', 'ok');
  });
}

/** A/B listening between the session start and the tuned values. @param {App} app */
function abBlock(app) {
  const a = /** @type {any} */ (app);
  if (!sessionHere(app) || !app.writer) return null;
  if (!isOpen(app, 'ab')) return closedStep(app, 'ab', 'Listen: A/B', ['Compare before and after', '']);
  // kept with the session, so a reload while on A doesn't lose the tuning
  const ab = (/** @type {any} */ (app.session).ab ??= { b: null, now: null, trim: 0 });
  const tuned = ab.b;
  const gains = app.has('tweeter_gain') && app.has('mid_gain');
  // loudness difference between the first and the last whole-speaker measurement of the session
  const inSession = app.measurements.filter((m) => m.kind === 'full' && !m.test && !m.undone && app.session && m.time >= app.session.started);
  let diff = 0;
  if (inSession.length >= 2) {
    const before = view(inSession[0].curve, 12, 24);
    const after = view(inSession[inSession.length - 1].curve, 12, 24);
    diff = meanDb(after.freqs, after.db, 200, 5000) - meanDb(before.freqs, before.db, 200, 5000);
  }
  const matched = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: a.abMatch ?? true, onchange: () => (a.abMatch = matched.checked) }));
  /** @param {'A' | 'B'} which */
  const play = (which) => app.run(`Switching to ${which}`, async (signal) => {
    const values = { ...(which === 'A' ? app.session?.snapshot : tuned) };
    // trim the louder state so the comparison isn't won by level
    const trim = matched.checked && gains ? (which === 'B' ? -Math.max(0, diff) : -Math.max(0, -diff)) : 0;
    if (trim) for (const g of ['tweeter_gain', 'mid_gain']) values[g] = Number(values[g] ?? 0) + trim;
    const r = await /** @type {DspWriter} */ (app.writer).write(values, { signal });
    ab.now = which;
    ab.trim = trim;
    app.persist();
    reportWrite(app, r, values);
  });
  return h('div', { class: 'step', 'data-where': 'ab' },
    h('div', { class: 'step-head' }, stepToggle(app, 'ab', 'Listen: A/B', ['Compare before and after', ''], true), helpButton('ab', 'Listen: A/B')),
    h('p', { class: 'help' }, 'Play your own music, then switch between A (session start) and B (the tuning). With level matching on, the louder one is turned down by the measured difference so it doesn\'t win just by being louder.'),
    !tuned ? h('p', { class: 'muted' }, 'Apply a PEQ fit first, or save the current values as B.') : null,
    h('div', { class: 'row' },
      h('button', { onclick: () => play('A'), disabled: !!app.busy, class: ab.now === 'A' ? 'primary' : '' }, 'A: before'),
      h('button', { onclick: () => play('B'), disabled: !!app.busy || !tuned, class: ab.now === 'B' ? 'primary' : '' }, 'B: tuned'),
      h('button', { class: 'link', onclick: () => {
        const b = /** @type {DspWriter} */ (app.writer).snapshot(settingRoles(/** @type {any} */ (app.profile)));
        // the gains on the speaker may carry the A/B level-match trim: take it off again
        if (ab.trim) for (const g of ['tweeter_gain', 'mid_gain']) if (g in b) b[g] = Number(b[g]) - ab.trim;
        ab.b = b;
        app.persist();
        app.refresh('tune');
      } }, 'Save current values as B'),
      gains ? h('label', { class: 'check' }, matched, ` Level match (${db(diff)})`) : h('span', { class: 'muted' }, 'Level matching needs the driver gain roles.')),
    ab.now === 'A' && tuned ? h('p', { class: 'reason' }, 'The speaker is on A now. Press B to go back to the tuning.') : null,
    feedbackBox('ab'));
}

/** Copy the tuning to another speaker with the same profile, then verify. @param {App} app */
function copyBlock(app) {
  const a = /** @type {any} */ (app);
  const others = app.mappings.filter((m) => m.id !== app.mapping?.id && m.profile === app.mapping?.profile);
  if (!others.length || !app.writer) return null;
  if (!isOpen(app, 'copy')) return closedStep(app, 'copy', 'Copy to another speaker', [`${others.length} of the same build`, '']);
  if (!others.some((m) => m.id === a.copyTarget)) a.copyTarget = others[0].id;
  // read when a button is pressed, not when the card was drawn: the dropdown can change in between
  const picked = () => /** @type {any} */ (others.find((m) => m.id === a.copyTarget));
  const copy = () => app.run('Copying the tuning', async (signal) => {
    const other = picked();
    await app.confirm('Copy the tuning?', `Writes the DSP values of ${app.mapping?.name} to ${other.name}. Which output drives the tweeter is left as ${other.name} has it, since that depends on its wiring.`, 'Copy');
    const values = /** @type {DspWriter} */ (app.writer).snapshot(settingRoles(/** @type {any} */ (app.profile)).filter((r) => !WIRING_ROLES.includes(r)));
    const w2 = new DspWriter(/** @type {any} */ (app.api), /** @type {any} */ (app.profile), other.entities);
    await w2.start();
    try {
      // what the other speaker had, so the copy can be undone
      a.copyUndo = { id: other.id, name: other.name, values: w2.snapshot(Object.keys(values)) };
      const r = await w2.write(values, { signal });
      reportWrite(app, r, values);
    } finally {
      await w2.stop();
    }
  });
  const verify = () => app.run('Measuring the other speaker', async (signal) => {
    const other = picked();
    const mine = [...app.measurements].reverse().find((m) => m.kind === 'full');
    if (!mine) throw new Error(`Measure ${app.mapping?.name} first, with the mic where it will be for the other speaker.`);
    if (!app.recorder) throw new Error('Open the mic first.');
    await app.confirm('Verify', `Put the mic in the same place relative to ${other.name} as it was for ${app.mapping?.name}.`, 'Measure');
    const m = new MicMeasurer({ recorder: app.recorder, playback: new Playback(/** @type {any} */ (app.api), other.entities.media_player), mediaUrl: () => app.ensureNoise(other), mic: app.mic });
    const theirVolume = await m.getVolume().catch(() => null);
    if (app.session?.levelVolume) await m.setVolume(app.session.levelVolume);
    let rec;
    try {
      rec = await m.measure({ label: `${other.name} after copy`, kind: 'full', positions: mine.positions, signal, onPrompt: (i, n) => app.promptPosition(i, n, signal), onStatus: (t) => app.status(t) });
    } finally {
      if (theirVolume !== null) await m.setVolume(theirVolume).catch(() => {});
    }
    app.addMeasurement(rec);
    const rules = micRules(app.mic);
    const v1 = view(normalised(mine.curve), 12, 24);
    const v2 = view(normalised(rec.curve), 12, 24);
    const diff = rmsDeviation(v1.freqs, v2.db, v1.db, rules.fMin, rules.fMax);
    a.copyResult = diff;
    app.notify(diff > 1.5
      ? `${other.name} differs from ${app.mapping?.name} by ${diff.toFixed(1)} dB RMS. It is worth tuning it in its own session.`
      : `${other.name} matches within ${diff.toFixed(1)} dB RMS.`, diff > 1.5 ? 'warn' : 'ok');
  });
  return h('div', { class: 'step', 'data-where': 'copy' },
    h('div', { class: 'step-head' }, stepToggle(app, 'copy', 'Copy to another speaker', [`${others.length} of the same build`, ''], true), helpButton('copy', 'Copy to another speaker')),
    h('p', { class: 'help' }, 'For a second cabinet of the same build: copy every setting, then measure it once to check it matches.'),
    h('div', { class: 'row' },
      select(others.map((m) => ({ value: m.id, label: m.name })), a.copyTarget, (v) => (a.copyTarget = v)),
      h('button', { onclick: copy, disabled: !!app.busy }, 'Copy settings'),
      h('button', { onclick: verify, disabled: !!app.busy || app.demo }, 'Measure to verify'),
      a.copyUndo ? h('button', { class: 'link', disabled: !!app.busy, onclick: () => undoCopy(app) }, `Undo the copy to ${a.copyUndo.name}`) : null),
    feedbackBox('copy'));
}

/** Roles that depend on how a cabinet is wired, never copied between speakers. */
const WIRING_ROLES = ['crossover_tweeter_channel'];

/** Whether the open session belongs to the speaker on screen. @param {App} app */
function sessionHere(app) {
  return !!app.session && app.session.deviceId === app.mapping?.id;
}

/** End the session: the level and the revert point are forgotten; the volume goes back. @param {App} app */
function endSession(app) {
  return app.run('Ending the session', async () => {
    await app.confirm('End the session?', 'The current values become the new starting point for Revert, the volume goes back to where it was before measuring, and the level is set again next time.', 'End session');
    const s = app.session;
    if (s?.volume !== null && s?.volume !== undefined) await app.setPlayerVolume(s.volume).catch(() => {});
    if (app.has('tuning_mode')) await /** @type {DspWriter} */ (app.writer).write({ tuning_mode: false });
    app.session = null;
    app.persist();
  });
}

/** Put back what the other speaker had before the copy. @param {App} app */
function undoCopy(app) {
  const a = /** @type {any} */ (app);
  return app.run('Undoing the copy', async (signal) => {
    const u = a.copyUndo;
    const other = app.mappings.find((m) => m.id === u?.id);
    if (!u || !other) throw new Error('Nothing to undo.');
    const w2 = new DspWriter(/** @type {any} */ (app.api), /** @type {any} */ (app.profile), other.entities);
    await w2.start();
    try {
      const r = await w2.write(u.values, { signal });
      reportWrite(app, r, u.values);
      if (r.ok) a.copyUndo = null;
    } finally {
      await w2.stop();
    }
  });
}

/**
 * A tick box that shows or hides one measurement on the chart, with its colour.
 * @param {App} app @param {any} m a measurement record
 */
function showToggle(app, m) {
  if (!m) return null;
  const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: app.visible.has(m.id), 'data-show': m.id, 'aria-label': `Show ${m.label} on the chart`,
    onchange: () => app.setVisible(m.id, box.checked) }));
  return h('label', { class: 'check' }, box, h('span', { class: 'swatch', style: `background: var(--series-${((m.slot ?? 0) % 8) + 1})` }));
}

/** The problems the fit found, and what it left alone, as a list. @param {any} plan */
function findingsList(plan) {
  const found = peqFindings(plan);
  if (!found.length) return h('p', null, 'Found nothing worth correcting: the measurement is already close to the target within the rules.');
  const fixes = found.filter((x) => x.kind === 'peak' || x.kind === 'dip' || x.kind === 'shape');
  const alone = found.filter((x) => x.kind === 'null' || x.kind === 'floor');
  const cap = (/** @type {string} */ t) => t[0].toUpperCase() + t.slice(1);
  return h('div', null,
    h('h5', null, 'What it found'),
    fixes.length ? h('ul', { class: 'findings' }, fixes.map((x) => h('li', null, cap(x.text)))) : h('p', null, 'No peaks or dips to correct.'),
    alone.length ? h('ul', { class: 'findings muted' }, alone.map((x) => h('li', null, cap(x.text)))) : null);
}

/**
 * Band by band, before and after. Bands that go to 0 dB read "off".
 * @param {App} app @param {Record<string, any>} before @param {Record<string, any>} after @param {string} wasLabel @param {string} nowLabel
 */
function bandTable(app, before, after, wasLabel, nowLabel) {
  const rows = bandChanges(/** @type {any} */ (app.profile), before, after);
  if (!rows.length) return null;
  const cell = (/** @type {{ f: number, gain: number, q: number }} */ b) => (b.gain ? `${Math.round(b.f)} Hz  ${db(b.gain)}  Q ${b.q.toFixed(2)}` : 'off');
  return h('table', { class: 'small' },
    h('tr', null, h('th', null, 'Band'), h('th', null, wasLabel), h('th', null, nowLabel)),
    rows.map((r) => {
      const same = r.before.gain === r.after.gain && (!r.after.gain || (r.before.f === r.after.f && r.before.q === r.after.q));
      return h('tr', null, h('td', null, `${r.bank} ${r.band}`), h('td', { class: 'muted' }, cell(r.before)), h('td', null, same ? `${cell(r.after)} (unchanged)` : h('b', null, cell(r.after))));
    }));
}

/**
 * The profile's recommended settings (from the speaker's YAML, or saved after a tuning), as a
 * starting point: what differs from now, and Apply.
 * @param {App} app
 */
function recommendedBlock(app) {
  const rec = /** @type {any} */ (app.profile)?.recommended;
  const w = app.writer;
  if (!rec?.values || !w) return null;
  const roles = app.roles;
  const same = (/** @type {any} */ a, /** @type {any} */ b) => (typeof a === 'number' || typeof b === 'number' ? Math.abs(Number(a) - Number(b)) < 1e-6 : String(a) === String(b));
  /** @type {Record<string, any>} */
  const diff = {};
  for (const [role, v] of Object.entries(rec.values)) if (app.has(role) && !same(w.value(role), v)) diff[role] = v;
  const n = Object.keys(diff).length;
  if (!n) return null;
  const t = rec.tuned_with;
  const how = rec.source === 'yaml'
    ? 'the starting values in this speaker\'s YAML'
    : `a tuning${t?.tier ? ` with a ${t.tier} mic` : ''}${t?.target ? `, target "${t.target}"` : ''}${typeof t?.rms_after === 'number' ? `, ${t.rms_after.toFixed(1)} dB from the target` : ''}${rec.date ? ` (${String(rec.date).slice(0, 10)})` : ''}`;
  const open = /** @type {any} */ (app.ui.tune ?? {}).recOpen;
  const rows = Object.entries(diff);
  /** @param {any} v */
  const show = (v) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : v === true ? 'on' : v === false ? 'off' : String(v ?? '–'));
  return h('div', { class: 'step', 'data-where': 'recommended' },
    h('div', { class: 'step-head' }, h('div', { class: 'step-title' }, h('h4', null, 'Recommended settings'), h('span', { class: 'chip chip-strong' }, `${n} differ`))),
    h('p', { class: 'help' }, `This speaker's profile has recommended settings from ${how}. Start from them, then measure and refine with the steps below.`),
    h('table', { class: 'ba' },
      h('tr', null, h('th', null, 'Setting'), h('th', null, 'Now'), h('th', null, 'Recommended')),
      (open ? rows : rows.slice(0, 6)).map(([k, v]) => h('tr', null, h('td', null, roles[k]?.label ?? k), h('td', null, show(w.value(k))), h('td', { class: 'ba-new' }, show(v))))),
    rows.length > 6 ? h('button', { class: 'link', onclick: () => {
      /** @type {any} */ (app.ui.tune).recOpen = !open;
      app.refresh('tune');
    } }, open ? 'Show fewer' : `Show all ${rows.length}`) : null,
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: !!app.busy, onclick: () => applyValues(app, diff, 'the recommended settings') }, 'Apply recommended settings'),
      h('span', { class: 'reason' }, 'Revert to session start undoes it.')),
    feedbackBox('recommended'));
}
