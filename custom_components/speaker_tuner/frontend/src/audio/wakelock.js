// @ts-check
// Keep the screen on during a measurement, and notice if the page is hidden anyway
// (a locked phone stops the mic, and half a recording must never be analysed).

/**
 * Run `task` with a screen wake lock. If the page is hidden while it runs, `signal` aborts
 * with reason "hidden" so the task can throw away what it has.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} task
 * @param {AbortSignal} [outer] the user's Stop button
 * @returns {Promise<T>}
 */
export async function whileAwake(task, outer) {
  const controller = new AbortController();
  const onOuter = () => controller.abort(outer?.reason ?? 'stopped');
  outer?.addEventListener('abort', onOuter);
  if (outer?.aborted) controller.abort(outer.reason ?? 'stopped');
  /** @type {any} */
  let lock = null;
  const request = async () => {
    try {
      lock = await /** @type {any} */ (navigator).wakeLock?.request('screen');
    } catch {
      lock = null; // not supported or refused: carry on, the hidden check still protects us
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') controller.abort('hidden');
  };
  await request();
  document.addEventListener('visibilitychange', onVisibility);
  try {
    return await task(controller.signal);
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
    outer?.removeEventListener('abort', onOuter);
    await lock?.release?.().catch(() => {});
  }
}

/** Error text for an aborted measurement. @param {any} reason */
export function abortMessage(reason) {
  return reason === 'hidden'
    ? 'The page was hidden (screen locked or app switched), so that measurement was thrown away. Keep the screen on and try again.'
    : 'Stopped.';
}
