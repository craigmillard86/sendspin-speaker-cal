// @ts-check
// Biquad maths matching the tas58xx fork (components/tas58xx/tas58xx_biquad.cpp):
// RBJ cookbook filters with a0 normalised to 1, evaluated at the DSP sample rate.

/** @typedef {{ b0: number, b1: number, b2: number, a1: number, a2: number }} Coefficients */
/** @typedef {'peaking' | 'low_shelf' | 'high_shelf'} PeqType */
/** @typedef {{ type?: PeqType, f: number, gain: number, q: number }} Peq */

const GAIN_EPSILON_DB = 1e-3;

/** @returns {Coefficients} */
export function passthrough() {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
}

/**
 * @param {number} b0 @param {number} b1 @param {number} b2
 * @param {number} a0 @param {number} a1 @param {number} a2
 * @returns {Coefficients}
 */
function normalise(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** @param {number} fc @param {number} fs */
function validFrequency(fc, fs) {
  return fc > 0 && fc < fs / 2;
}

/** @param {number} fc @param {number} gainDb @param {number} q @param {number} fs */
export function peaking(fc, gainDb, q, fs) {
  if (!validFrequency(fc, fs) || q <= 0 || Math.abs(gainDb) < GAIN_EPSILON_DB) return passthrough();
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalise(1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a);
}

/** @param {number} fc @param {number} gainDb @param {number} q @param {number} fs */
export function lowShelf(fc, gainDb, q, fs) {
  if (!validFrequency(fc, fs) || q <= 0 || Math.abs(gainDb) < GAIN_EPSILON_DB) return passthrough();
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const k = (2 * Math.sqrt(a) * Math.sin(w0)) / (2 * q);
  return normalise(
    a * (a + 1 - (a - 1) * cos + k),
    2 * a * (a - 1 - (a + 1) * cos),
    a * (a + 1 - (a - 1) * cos - k),
    a + 1 + (a - 1) * cos + k,
    -2 * (a - 1 + (a + 1) * cos),
    a + 1 + (a - 1) * cos - k,
  );
}

/** @param {number} fc @param {number} gainDb @param {number} q @param {number} fs */
export function highShelf(fc, gainDb, q, fs) {
  if (!validFrequency(fc, fs) || q <= 0 || Math.abs(gainDb) < GAIN_EPSILON_DB) return passthrough();
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const k = (2 * Math.sqrt(a) * Math.sin(w0)) / (2 * q);
  return normalise(
    a * (a + 1 + (a - 1) * cos + k),
    -2 * a * (a - 1 + (a + 1) * cos),
    a * (a + 1 + (a - 1) * cos - k),
    a + 1 - (a - 1) * cos + k,
    2 * (a - 1 - (a + 1) * cos),
    a + 1 - (a - 1) * cos - k,
  );
}

/** @param {number} fc @param {number} q @param {number} fs */
export function highpass(fc, q, fs) {
  if (!validFrequency(fc, fs) || q <= 0) return passthrough();
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalise((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

/** @param {number} fc @param {number} q @param {number} fs */
export function lowpass(fc, q, fs) {
  if (!validFrequency(fc, fs) || q <= 0) return passthrough();
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalise((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

/**
 * Magnitude in dB of one biquad at frequency f.
 * @param {Coefficients} c @param {number} f @param {number} fs
 */
export function magnitudeDb(c, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const ni = -(c.b1 * sin1 + c.b2 * sin2);
  const dr = 1 + c.a1 * cos1 + c.a2 * cos2;
  const di = -(c.a1 * sin1 + c.a2 * sin2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** @param {Peq} p @param {number} fs @returns {Coefficients} */
export function peqCoefficients(p, fs) {
  switch (p.type ?? 'peaking') {
    case 'low_shelf':
      return lowShelf(p.f, p.gain, p.q, fs);
    case 'high_shelf':
      return highShelf(p.f, p.gain, p.q, fs);
    default:
      return peaking(p.f, p.gain, p.q, fs);
  }
}

/**
 * Sum of the dB responses of several filters on a frequency grid.
 * @param {Peq[]} filters
 * @param {ArrayLike<number>} freqs
 * @param {number} fs
 */
export function responseDb(filters, freqs, fs) {
  const out = new Float64Array(freqs.length);
  for (const p of filters) {
    const c = peqCoefficients(p, fs);
    for (let i = 0; i < freqs.length; i++) out[i] += magnitudeDb(c, freqs[i], fs);
  }
  return out;
}

/**
 * Run samples through a cascade of biquads (direct form I). Returns a new array.
 * @param {Coefficients[]} cascade
 * @param {ArrayLike<number>} input
 */
export function filterSamples(cascade, input) {
  let x = Float64Array.from(input);
  for (const c of cascade) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x[i];
      y2 = y1; y1 = v;
      y[i] = v;
    }
    x = y;
  }
  return x;
}
