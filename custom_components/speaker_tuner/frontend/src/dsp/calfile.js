// @ts-check
// REW-style text files: mic calibration files and exported frequency responses.
// Two or three whitespace/comma separated columns (frequency, dB, optional phase).
// Lines starting with # or * are comments; other non-numeric lines (like the quoted
// "Sens Factor" header of UMIK-1 files) are skipped and reported.

import { interpLogF } from './smoothing.js';

/**
 * @typedef {{ freqs: number[], db: number[], comments: string[], skipped: string[], sensitivityDb?: number }} FrequencyText
 */

/**
 * @param {string} text
 * @returns {FrequencyText}
 */
export function parseFrequencyText(text) {
  /** @type {Array<[number, number]>} */
  const rows = [];
  const comments = [];
  const skipped = [];
  let sensitivityDb;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sens = line.match(/sens(?:itivity)?\s*factor\s*=\s*(-?[\d.]+)\s*db/i);
    if (sens) sensitivityDb = parseFloat(sens[1]);
    if (line.startsWith('#') || line.startsWith('*')) {
      comments.push(line.replace(/^[#*]\s?/, ''));
      continue;
    }
    const parts = line.split(/[\s,;]+/).filter(Boolean);
    const f = Number(parts[0]);
    const db = Number(parts[1]);
    if (parts.length >= 2 && Number.isFinite(f) && Number.isFinite(db) && f > 0) {
      rows.push([f, db]);
    } else {
      skipped.push(line);
    }
  }

  if (rows.length < 2) throw new Error('No frequency/dB data found. Expected two columns: frequency and dB.');
  rows.sort((a, b) => a[0] - b[0]);
  // drop duplicate frequencies, keep the first
  const freqs = [];
  const db = [];
  for (const [f, d] of rows) {
    if (freqs.length && f === freqs[freqs.length - 1]) continue;
    freqs.push(f);
    db.push(d);
  }
  return { freqs, db, comments, skipped, sensitivityDb };
}

/**
 * Subtract a mic calibration from a measured curve. The cal file holds the mic's own
 * deviation, so the true response is measured minus cal. Interpolated in log frequency,
 * end values held outside the cal file's range.
 * @param {ArrayLike<number>} freqs
 * @param {ArrayLike<number>} db
 * @param {{ freqs: ArrayLike<number>, db: ArrayLike<number> }} cal
 */
export function applyCalibration(freqs, db, cal) {
  const out = new Float64Array(db.length);
  for (let i = 0; i < db.length; i++) out[i] = db[i] - interpLogF(cal.freqs, cal.db, freqs[i]);
  return out;
}
