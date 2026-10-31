// @ts-check
// Tune: the guided steps, the PEQ fit with its predicted result, apply and refine,
// revert, A/B listening and copying the tuning to another speaker.

import { h, field, select, db } from './dom.js';
import { card } from './app.js';
import {
  levelMatch, polarityTest, crossoverScan, delayScan, lowEnd, notchAndAir, baffleSuggestion, boostFloor,
} from '../measure/driver-checks.js';
import { planPeqFit, curveRms, micRules } from '../measure/peq.js';
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
function ctxFor(app, signal, { positions = app.settings.checkPositions, showAll = false } = {}) {
  const inner = app.measurer();
  let shown = 0;
  return {
    writer: /** @type {DspWriter} */ (app.writer),
    profile: /** @type {any} */ (app.profile),
    positions,
    signal,
    onStatus: (/** @type {string} */ t) => app.status(t),
    onPrompt: (/** @type {number} */ i, /** @type {number} */ n) => app.promptPosition(i, n),
    onMeasurement: (/** @type {any} */ m) => {
      app.addMeasurement(m);
      // scans make many measurements; only the first few stay on the chart
      if (!showAll && ++shown > 2) app.visible.delete(m.id);
    },
    measurer: {
      name: inner.name,
      getVolume: () => inner.getVolume(),
      setVolume: (/** @type {number} */ v) => inner.setVolume(v),
      autoLevel: (/** @type {any} */ o) => inner.autoLevel(o),
      measure: (/** @type {any} */ req) => (req.kind === 'nearfield' ? inner.measure(req) : app.measure(req, signal)),
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
function applyValues(app, changes, what) {
  return app.run(`Applying ${what}`, async (signal) => {
    await app.ensureSession();
    const r = await /** @type {DspWriter} */ (app.writer).write(changes, { signal });
    reportWrite(app, r, changes);
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
  const go = () => app.run(title, async (signal) => {
    app.results[id] = await run(signal);
  });
  return h('div', { class: 'step' },
    h('div', { class: 'step-head' }, h('h4', null, title),
      h('button', { onclick: go, disabled: !!app.busy || !app.writer || lacking.length > 0 || !enabled }, result ? 'Run again' : 'Run')),
    h('p', { class: 'help' }, text),
    lacking.length ? h('p', { class: 'muted' }, `Needs these roles mapped in setup: ${lacking.join(', ')}.`) : null,
    note ? h('p', { class: 'muted' }, note) : null,
    extra ?? null,
    result ? h('div', { class: 'step-result' }, describe(result)) : null,
    hasSuggestion ? h('div', { class: 'row' },
      h('span', null, `Suggested: ${Object.entries(suggestion).map(([k, v]) => `${k} = ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`).join(', ')}`),
      h('button', { class: 'primary', disabled: !!app.busy, onclick: () => applyValues(app, suggestion, title.toLowerCase()) }, 'Apply')) : null);
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
  const fulls = app.measurements.filter((m) => m.kind === 'full' && !(/** @type {any} */ (m).undone));
  const latest = (/** @type {string} */ kind) => [...app.measurements].reverse().find((m) => m.kind === kind);

  const xoInput = /** @type {HTMLInputElement} */ (h('input', { value: app.settings.crossoverList, onchange: () => {
    app.settings.crossoverList = xoInput.value;
    app.persist();
  } }));
  const tryFilters = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
  const baffleWidth = /** @type {HTMLInputElement} */ (h('input', { type: 'number', min: 0, max: 50, step: 1, value: app.writer?.value('baffle_width') ?? 0 }));

  const steps = isCrossover ? [
    step(app, {
      id: 'lowEnd', title: '1. Low end (nearfield)', needs: ['subsonic_frequency'],
      text: app.profile?.enclosure === 'sealed'
        ? 'Put the mic 1 cm from the centre of the mid/bass cone. Finds the box resonance for the Linkwitz transform and a safe subsonic filter.'
        : 'Put the mic 1 cm from the centre of the mid/bass cone. Finds the passive radiator (or port) tuning frequency, where the cone barely moves, and suggests a subsonic filter just below it. The PEQ fit will not boost below 1.3 × that frequency.',
      run: async (signal) => {
        await app.confirm('Nearfield measurement', 'Put the mic about 1 cm from the centre of the mid/bass cone, pointing at it. The level is set again for this position and put back afterwards.', 'Measure');
        const ctx = ctxFor(app, signal, { positions: 1 });
        const lvl = await ctx.measurer.autoLevel({ start: 0.05, cap: app.session?.levelVolume ?? 0.3, signal, onStatus: ctx.onStatus });
        return lowEnd(ctx, { nearfieldVolume: lvl.volume });
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
      run: (signal) => polarityTest(ctxFor(app, signal, { showAll: true })),
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
        const r = await crossoverScan(ctxFor(app, signal), freqs, filters);
        if (r.suggestion.crossover_frequency) {
          // levels shift with the crossover: re-match at the winner
          r.note = 'Run "Driver levels" again after applying, since the levels at the new crossover differ.';
        }
        return r;
      },
      describe: (r) => h('div', null,
        r.skipped.length ? h('p', { class: 'muted' }, `Skipped (outside the allowed range): ${r.skipped.join(', ')} Hz`) : null,
        h('table', { class: 'small' }, h('tr', null, h('th', null, 'Crossover'), h('th', null, 'Spread ±1 oct'), h('th', null, 'Dip')),
          r.results.map((/** @type {any} */ x) => h('tr', null, h('td', null, `${x.frequency} Hz${x.filter && r.results.some((/** @type {any} */ y) => y.filter !== x.filter) ? ` ${x.filter}` : ''}`), h('td', null, `${x.flatnessDb.toFixed(2)} dB`), h('td', null, `${x.dipDb.toFixed(1)} dB`)))),
        !Object.keys(r.suggestion).length ? h('p', { class: 'muted' }, 'None is clearly flatter than the current setting, so no change is suggested.') : null,
        r.note ? h('p', { class: 'muted' }, r.note) : null),
    }),
    step(app, {
      id: 'delay', title: '5. Time alignment', needs: ['tweeter_delay', 'mid_delay', 'tweeter_invert', 'crossover_frequency'],
      text: 'Flips the tweeter for the test and scans the delay: the drivers cancel deepest at the crossover when they are best aligned. Then checks the normal sum is no worse. The fork\'s delay is an all-pass approximation, so the best value can differ from the physical offset.',
      run: (signal) => delayScan(ctxFor(app, signal)),
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
        const m = latest('mid') ?? latest('full');
        if (!m) throw new Error('Measure the mid alone (or the whole speaker) first.');
        const s = baffleSuggestion(m.curve);
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
        return notchAndAir(t.curve, f.curve, app.target, tier, app.profile?.dsp_sample_rate ?? 96000);
      },
      describe: (r) => `${r.notch ? `Breakup peak at ${formatHz(r.notch.frequency)}Hz: notch ${r.notch.gainDb} dB, Q ${r.notch.q}. ` : 'No breakup peak found. '}Air shelf ${db(r.air)}.`,
    }),
  ] : [];

  return card('Tune', ready ? `Mic tier: ${tier}` : 'Set up a speaker first', [
    isCrossover ? h('p', { class: 'help' }, 'Work down the list. Each step measures, puts back what it changed for the test, and suggests values; nothing changes until you press Apply. Run them again in any order.') : null,
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
      h('button', { class: 'danger', disabled: !app.session || !!app.busy, onclick: () => revert(app) }, 'Revert to session start'),
      app.session ? h('span', { class: 'muted' }, `Session started ${new Date(app.session.started).toLocaleString()}`) : null,
      app.session ? h('button', { class: 'link', onclick: async () => {
        try {
          await app.confirm('End the session?', 'The current values become the new starting point for Revert, and the level is set again next time.', 'End session');
          app.session = null;
          app.persist();
          app.refresh();
        } catch {
          /* cancelled */
        }
      } }, 'End session') : null),
  ], ready);
}

/** @param {App} app @param {any[]} fulls @param {(app: App) => number} chartReference */
function peqBlock(app, fulls, chartReference) {
  const a = /** @type {any} */ (app);
  const baseId = a.fitBaseId && fulls.some((m) => m.id === a.fitBaseId) ? a.fitBaseId : fulls[fulls.length - 1]?.id ?? '';
  const base = fulls.find((m) => m.id === baseId);
  const rules = micRules(app.mic);
  const floor = boostFloor({ fb: app.results.lowEnd?.fb, subsonic: Number(app.writer?.value('subsonic_frequency') ?? 0) });

  const fit = () => {
    if (!base) return app.notify('Measure the whole speaker first.', 'warn');
    try {
      const w = /** @type {DspWriter} */ (app.writer);
      // take out the PEQ the speaker had when this measurement was made, not today's
      const plan = planPeqFit({
        profile: /** @type {any} */ (app.profile), values: { ...app.values(), ...(base.settings ?? {}) }, rangeOf: (r) => w.range(r),
        curve: base.curve, target: app.target, mic: app.mic, boostFloorHz: floor, mask: base.mask,
      });
      app.plan = plan;
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
    let first = true;
    const plan = (/** @type {{ freqs: number[], db: number[] }} */ curve) => {
      // the baseline may be an older measurement: use the settings it was made with; after
      // that each curve was just measured with the values the speaker holds now
      const values = first ? { ...app.values(), ...(base.settings ?? {}) } : app.values();
      first = false;
      return planPeqFit({ profile: /** @type {any} */ (app.profile), values, rangeOf: (r) => w.range(r), curve, target: app.target, mic: app.mic, boostFloorHz: floor });
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
    a.abB = w.snapshot(settingRoles(/** @type {any} */ (app.profile)));
    if (result.steps.every((s) => s.report.ok)) {
      app.notify(`RMS deviation ${result.startRms.toFixed(2)} → ${result.finalRms.toFixed(2)} dB after ${result.steps.length} pass${result.steps.length === 1 ? '' : 'es'} (${result.reason}). Values are saved on the device; wait a minute before power-cycling it.`, 'ok');
    }
    await checkHeadroom(app);
  });

  const plan = app.plan;
  const rr = a.refineResult;
  return h('div', { class: 'step' },
    h('div', { class: 'step-head' }, h('h4', null, 'PEQ fit')),
    h('p', { class: 'help' }, `Fits up to ${app.profile?.peq_banks.filter((b) => !b.mirror_of).map((b) => `${b.bands ?? b.frequencies?.length} ${b.name ?? b.id}`).join(' + ')} bands towards the target between ${formatHz(rules.fMin)}Hz and ${formatHz(rules.fMax)}Hz, gains ${rules.gainMin} to ${rules.gainMax} dB${rules.cutsOnly ? ' (cuts only)' : ''}. Narrow dips (room cancellations) are never boosted${floor ? `, nor anything below ${Math.round(floor)} Hz` : ''}. Use a ${app.settings.positions}-position measurement for this.`),
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
      h('p', null, `Predicted RMS deviation: ${plan.rmsBefore.toFixed(2)} → ${plan.rmsAfter.toFixed(2)} dB. Dotted line on the chart.`),
      plan.filters.length ? h('table', { class: 'small' },
        h('tr', null, h('th', null, 'Bank'), h('th', null, 'Frequency'), h('th', null, 'Gain'), h('th', null, 'Q')),
        plan.filters.map((/** @type {any} */ f) => h('tr', null, h('td', null, f.bank), h('td', null, `${f.f} Hz`), h('td', null, db(f.gain)), h('td', null, f.q.toFixed(2))))) : h('p', null, 'No filters needed within the rules.'),
      plan.rejected.length ? h('p', { class: 'muted' }, `Left alone (narrow nulls, probably the room): ${plan.rejected.map((/** @type {any} */ r) => `${Math.round(r.f)} Hz`).join(', ')}. Moving the speaker or the seat is the fix for those.`) : null,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: applyRefine, disabled: !!app.busy }, 'Apply and measure again'),
        h('span', { class: 'muted' }, 'Up to 3 passes; stops when a pass gains under 0.3 dB.'))) : null,
    rr ? h('p', null, `Last run: ${rr.steps.map((/** @type {any} */ s) => `pass ${s.iteration} ${s.rms !== null ? `${s.rms.toFixed(2)} dB` : 'not measured'}`).join(', ')} (from ${rr.startRms.toFixed(2)} dB).`) : null);
}

/** @param {App} app */
function revert(app) {
  return app.run('Reverting to the session start', async (signal) => {
    const s = app.session;
    if (!s) throw new Error('No session to revert to.');
    await app.confirm('Revert?', 'Writes back every DSP value captured when this session started.', 'Revert');
    const r = await /** @type {DspWriter} */ (app.writer).write(s.snapshot, { signal });
    if (s.volume !== null) await app.measurer().setVolume(s.volume).catch(() => {});
    reportWrite(app, r, s.snapshot);
    if (r.ok) app.notify('Reverted to the values at the start of the session.', 'ok');
  });
}

/** A/B listening between the session start and the tuned values. @param {App} app */
function abBlock(app) {
  const a = /** @type {any} */ (app);
  if (!app.session || !app.writer) return null;
  const tuned = a.abB;
  const gains = app.has('tweeter_gain') && app.has('mid_gain');
  // loudness difference between the first and the last whole-speaker measurement of the session
  const inSession = app.measurements.filter((m) => m.kind === 'full' && app.session && m.time >= app.session.started);
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
    a.abNow = which;
    reportWrite(app, r, values);
  });
  return h('div', { class: 'step' },
    h('div', { class: 'step-head' }, h('h4', null, 'Listen: A/B')),
    h('p', { class: 'help' }, 'Play your own music, then switch between A (session start) and B (the tuning). With level matching on, the louder one is turned down by the measured difference so it doesn\'t win just by being louder.'),
    !tuned ? h('p', { class: 'muted' }, 'Apply a PEQ fit first, or save the current values as B.') : null,
    h('div', { class: 'row' },
      h('button', { onclick: () => play('A'), disabled: !!app.busy, class: a.abNow === 'A' ? 'primary' : '' }, 'A: before'),
      h('button', { onclick: () => play('B'), disabled: !!app.busy || !tuned, class: a.abNow === 'B' ? 'primary' : '' }, 'B: tuned'),
      h('button', { class: 'link', onclick: () => {
        a.abB = /** @type {DspWriter} */ (app.writer).snapshot(settingRoles(/** @type {any} */ (app.profile)));
        app.refresh('tune');
      } }, 'Save current values as B'),
      gains ? h('label', { class: 'check' }, matched, ` Level match (${db(diff)})`) : h('span', { class: 'muted' }, 'Level matching needs the driver gain roles.')),
    a.abNow === 'A' && tuned ? h('p', { class: 'muted' }, 'The speaker is on A now. Press B to go back to the tuning.') : null);
}

/** Copy the tuning to another speaker with the same profile, then verify. @param {App} app */
function copyBlock(app) {
  const a = /** @type {any} */ (app);
  const others = app.mappings.filter((m) => m.id !== app.mapping?.id && m.profile === app.mapping?.profile);
  if (!others.length || !app.writer) return null;
  const targetId = a.copyTarget && others.some((m) => m.id === a.copyTarget) ? a.copyTarget : others[0].id;
  const copy = () => app.run('Copying the tuning', async (signal) => {
    const other = /** @type {any} */ (others.find((m) => m.id === targetId));
    await app.confirm('Copy the tuning?', `Writes every DSP value of ${app.mapping?.name} to ${other.name}.`, 'Copy');
    const values = /** @type {DspWriter} */ (app.writer).snapshot(settingRoles(/** @type {any} */ (app.profile)));
    const w2 = new DspWriter(/** @type {any} */ (app.api), /** @type {any} */ (app.profile), other.entities);
    await w2.start();
    try {
      const r = await w2.write(values, { signal });
      reportWrite(app, r, values);
    } finally {
      await w2.stop();
    }
  });
  const verify = () => app.run('Measuring the other speaker', async (signal) => {
    const other = /** @type {any} */ (others.find((m) => m.id === targetId));
    const mine = [...app.measurements].reverse().find((m) => m.kind === 'full');
    if (!mine) throw new Error(`Measure ${app.mapping?.name} first, with the mic where it will be for the other speaker.`);
    if (!app.recorder) throw new Error('Open the mic first.');
    await app.confirm('Verify', `Put the mic in the same place relative to ${other.name} as it was for ${app.mapping?.name}.`, 'Measure');
    const m = new MicMeasurer({ recorder: app.recorder, playback: new Playback(/** @type {any} */ (app.api), other.entities.media_player), mediaUrl: other.media_url, mic: app.mic });
    if (app.session?.levelVolume) await m.setVolume(app.session.levelVolume);
    const rec = await m.measure({ label: `${other.name} after copy`, kind: 'full', positions: mine.positions, signal, onPrompt: (i, n) => app.promptPosition(i, n), onStatus: (t) => app.status(t) });
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
  return h('div', { class: 'step' },
    h('div', { class: 'step-head' }, h('h4', null, 'Copy to another speaker')),
    h('p', { class: 'help' }, 'For a second cabinet of the same build: copy every setting, then measure it once to check it matches.'),
    h('div', { class: 'row' },
      select(others.map((m) => ({ value: m.id, label: m.name })), targetId, (v) => (a.copyTarget = v)),
      h('button', { onclick: copy, disabled: !!app.busy }, 'Copy settings'),
      h('button', { onclick: verify, disabled: !!app.busy || app.demo }, 'Measure to verify')));
}
