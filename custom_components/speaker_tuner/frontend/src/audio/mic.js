// @ts-check
// Microphone access with every browser "voice" feature turned off, so the measurement sees
// what the mic hears.

export const RAW_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

/** Is mic capture possible here? Browsers only allow it on https:// or localhost. */
export function micSupport() {
  if (!globalThis.isSecureContext) {
    return { ok: false, reason: 'The microphone only works on an https:// page or on localhost. Open the tool from Home Assistant\'s sidebar, or serve it over https.' };
  }
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'This browser cannot record audio.' };
  return { ok: true, reason: '' };
}

/**
 * Input devices. Labels are only filled in after the user has allowed mic access once.
 * @returns {Promise<Array<{ deviceId: string, label: string }>>}
 */
export async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

/**
 * @param {string} [deviceId]
 * @returns {Promise<MediaStream>}
 */
export async function openMic(deviceId) {
  const audio = { ...RAW_AUDIO, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (e) {
    const err = /** @type {Error} */ (e);
    if (err.name === 'NotAllowedError') throw new Error('Microphone access was blocked. Allow it in the browser\'s site settings and try again.');
    if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') throw new Error('That microphone is not available. Plug it in or pick another one.');
    throw err;
  }
}

/**
 * Settings the browser actually applied; some phones keep processing on regardless.
 * @param {MediaStream} stream
 */
export function appliedSettings(stream) {
  const track = stream.getAudioTracks()[0];
  const s = /** @type {any} */ (track?.getSettings?.() ?? {});
  const processing = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter((k) => s[k] === true);
  return { sampleRate: s.sampleRate, processing };
}
