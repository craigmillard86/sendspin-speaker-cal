// @ts-check
// In-place radix-2 complex FFT. Plain arrays of doubles, no dependencies.

/**
 * @param {Float64Array} re real part, length a power of two, overwritten
 * @param {Float64Array} im imaginary part, same length, overwritten
 * @param {boolean} [inverse] inverse transform, scaled by 1/n
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n !== im.length) throw new Error('fft: re and im lengths differ');
  if (n & (n - 1)) throw new Error('fft: length must be a power of two');

  // bit reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (sign * 2 * Math.PI) / size;
    const wr = Math.cos(step);
    const wi = Math.sin(step);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** @param {number} n */
export function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
