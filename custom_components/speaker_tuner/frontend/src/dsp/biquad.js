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

/** @param {number} gainDb @param {boolean} invert @returns {Coefficients} */
export function gain(gainDb, invert = false) {
  const g = Math.pow(10, gainDb / 20) * (invert ? -1 : 1);
  return { b0: g, b1: 0, b2: 0, a1: 0, a2: 0 };
}

const SPEED_OF_SOUND_MM_PER_S = 343000;

/**
 * 1st order all-pass approximating a delay of delay_mm, as in the fork.
 * @param {number} delayMm @param {number} fs @returns {Coefficients}
 */
export function allpassDelay(delayMm, fs) {
  if (delayMm <= 0 || fs <= 0) return passthrough();
  const delayS = delayMm / SPEED_OF_SOUND_MM_PER_S;
  let fc = 1 / (Math.PI * delayS);
  if (fc >= fs / 2) fc = fs / 2 - 1;
  const t = Math.tan((Math.PI * fc) / fs);
  const c = (t - 1) / (t + 1);
  return { b0: c, b1: 1, b2: 0, a1: c, a2: 0 };
}

/**
 * Linkwitz transform from f0/q0 to fp/qp, as in the fork.
 * @param {number} f0 @param {number} q0 @param {number} fp @param {number} qp @param {number} fs
 */
export function linkwitzTransform(f0, q0, fp, qp, fs) {
  if (!(f0 > 0 && f0 < fs / 2) || !(fp > 0 && fp < fs / 2) || q0 <= 0 || qp <= 0) return passthrough();
  const w0 = 2 * Math.PI * f0;
  const wp = 2 * Math.PI * fp;
  const fc = (f0 + fp) / 2;
  const k = (2 * Math.PI * fc) / Math.tan((Math.PI * fc) / fs);
  const k2 = k * k;
  return normalise(
    w0 * w0 + (k * w0) / q0 + k2, 2 * (w0 * w0 - k2), w0 * w0 - (k * w0) / q0 + k2,
    wp * wp + (k * wp) / qp + k2, 2 * (wp * wp - k2), wp * wp - (k * wp) / qp + k2,
  );
}

/**
 * Complex response of a cascade at frequency f.
 * @param {Coefficients[]} cascade @param {number} f @param {number} fs
 * @returns {{ re: number, im: number }}
 */
export function cascadeResponse(cascade, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const z1r = Math.cos(w), z1i = -Math.sin(w);
  const z2r = Math.cos(2 * w), z2i = -Math.sin(2 * w);
  let re = 1, im = 0;
  for (const c of cascade) {
    const nr = c.b0 + c.b1 * z1r + c.b2 * z2r;
    const ni = c.b1 * z1i + c.b2 * z2i;
    const dr = 1 + c.a1 * z1r + c.a2 * z2r;
    const di = c.a1 * z1i + c.a2 * z2i;
    const den = dr * dr + di * di;
    const hr = (nr * dr + ni * di) / den;
    const hi = (ni * dr - nr * di) / den;
    const r = re * hr - im * hi;
    im = re * hi + im * hr;
    re = r;
  }
  return { re, im };
}
