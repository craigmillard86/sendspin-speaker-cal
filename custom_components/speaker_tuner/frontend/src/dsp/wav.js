// @ts-check
// 16-bit PCM WAV encode/decode (mono or interleaved multichannel).

/**
 * @param {Float32Array} samples -1..1, mono
 * @param {number} fs
 * @returns {Uint8Array}
 */
export function encodeWav16(samples, fs) {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (/** @type {number} */ at, /** @type {string} */ s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return new Uint8Array(buf);
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ fs: number, channels: number, bits: number, samples: Float32Array }} first channel only
 */
export function decodeWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (/** @type {number} */ at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let at = 12;
  let fs = 0;
  let channels = 0;
  let bits = 0;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ') {
      if (v.getUint16(at + 8, true) !== 1) throw new Error('Only PCM WAV is supported');
      channels = v.getUint16(at + 10, true);
      fs = v.getUint32(at + 12, true);
      bits = v.getUint16(at + 22, true);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('Only 16-bit WAV is supported');
      const frames = Math.floor(size / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = v.getInt16(at + 8 + i * 2 * channels, true) / 32768;
      return { fs, channels, bits, samples };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error('WAV file has no data chunk');
}
