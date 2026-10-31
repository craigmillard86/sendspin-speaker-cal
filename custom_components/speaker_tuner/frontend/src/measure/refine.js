// @ts-check
// Apply, re-measure, refine: write the fitted values, measure again the same way as the
// baseline, and repeat up to maxIterations while each pass still gains at least
// minImprovementDb of RMS deviation.

/**
 * @typedef {{ iteration: number, changes: Record<string, any>, report: import('../ha/dsp-writer.js').WriteReport,
 *   curve: { freqs: number[], db: number[] } | null, rms: number | null, predictedRms: number }} RefineStep
 */

/**
 * @param {{
 *   writer: import('../ha/dsp-writer.js').DspWriter,
 *   baseline: { freqs: number[], db: number[] },
 *   plan: (curve: { freqs: number[], db: number[] }) => { changes: Record<string, any>, rmsAfter: number },
 *   measure: (label: string) => Promise<{ freqs: number[], db: number[] }>,
 *   rmsOf: (curve: { freqs: number[], db: number[] }) => number,
 *   maxIterations?: number, minImprovementDb?: number, signal?: AbortSignal,
 *   onStep?: (step: RefineStep) => void, onStatus?: (text: string) => void,
 * }} p
 */
export async function applyAndRefine({ writer, baseline, plan, measure, rmsOf, maxIterations = 3, minImprovementDb = 0.3, signal, onStep, onStatus }) {
  /** @type {RefineStep[]} */
  const steps = [];
  let curve = baseline;
  let rms = rmsOf(baseline);
  const startRms = rms;
  let reason = 'max iterations';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const { changes, rmsAfter } = plan(curve);
    onStatus?.(`Pass ${iteration}: writing ${Object.keys(changes).length} values`);
    const report = await writer.write(changes, { signal });
    /** @type {RefineStep} */
    const step = { iteration, changes, report, curve: null, rms: null, predictedRms: rmsAfter };
    steps.push(step);
    if (!report.ok) {
      onStep?.(step);
      reason = report.stopped ? 'stopped' : 'write failed';
      break;
    }
    onStatus?.(`Pass ${iteration}: measuring`);
    const next = await measure(`After pass ${iteration}`);
    step.curve = next;
    step.rms = rmsOf(next);
    onStep?.(step);
    const improvement = rms - step.rms;
    curve = next;
    rms = step.rms;
    if (improvement < minImprovementDb) {
      reason = improvement < 0 ? 'got worse' : 'improvement under threshold';
      break;
    }
  }
  return { steps, startRms, finalRms: rms, reason };
}
