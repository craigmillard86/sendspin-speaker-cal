// @ts-check
// Frequency response chart on a canvas: log frequency 20 Hz to 20 kHz, dB on one axis,
// thin lines, recessive grid, crosshair tooltip, legend kept outside (in the page).
// Colors come from CSS custom properties so light and dark themes are both selected
// values, not a flip.

const F_MIN = 20;
const F_MAX = 20000;
const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const MINOR_F = [30, 40, 60, 70, 80, 90, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000];

/**
 * @typedef {{ id: string, label: string, freqs: number[], db: number[], slot?: number, role?: 'target' | 'predicted' | 'series',
 *   mask?: boolean[] }} Series
 */

/** @param {number} f */
export function formatHz(f) {
  return f >= 1000 ? `${Math.round(f / 100) / 10}k` : `${Math.round(f)}`;
}

export class ResponseChart {
  /** @param {HTMLCanvasElement} canvas @param {HTMLElement} tooltip */
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    /** @type {Series[]} */
    this.series = [];
    /** @type {{ lo: number, hi: number } | null} */
    this.fixedRange = null;
    this.hoverX = /** @type {number | null} */ (null);
    const ro = new ResizeObserver(() => this.draw());
    ro.observe(canvas);
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.tooltip.hidden = true;
      this.draw();
    });
    // redraw when the theme changes
    globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.draw());
  }

  /** @param {Series[]} series */
  set(series) {
    this.series = series;
    this.draw();
  }

  /** @param {string} name */
  css(name) {
    return getComputedStyle(this.canvas).getPropertyValue(name).trim();
  }

  /** dB range: covers the visible data, at least 30 dB tall, on 5 dB lines. */
  range() {
    if (this.fixedRange) return this.fixedRange;
    const values = [];
    for (const s of this.series) {
      s.freqs.forEach((f, i) => {
        if (f >= F_MIN && f <= F_MAX && Number.isFinite(s.db[i])) values.push(s.db[i]);
      });
    }
    if (!values.length) return { lo: -15, hi: 15 };
    values.sort((a, b) => a - b);
    // ignore the extreme 1% so a deep null doesn't squash everything
    let lo = values[Math.floor(values.length * 0.01)];
    let hi = values[Math.ceil(values.length * 0.99) - 1];
    const mid = (lo + hi) / 2;
    if (hi - lo < 30) {
      lo = mid - 15;
      hi = mid + 15;
    }
    return { lo: Math.floor((lo - 3) / 5) * 5, hi: Math.ceil((hi + 3) / 5) * 5 };
  }

  draw() {
    const c = this.canvas;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (!w || !hgt) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);

    const pad = { l: 36, r: 10, t: 10, b: 22 };
    const pw = w - pad.l - pad.r;
    const ph = hgt - pad.t - pad.b;
    const { lo, hi } = this.range();
    const x = (/** @type {number} */ f) => pad.l + (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * pw;
    const y = (/** @type {number} */ d) => pad.t + ((hi - d) / (hi - lo)) * ph;
    const fAt = (/** @type {number} */ px) => F_MIN * Math.pow(F_MAX / F_MIN, (px - pad.l) / pw);

    const grid = this.css('--chart-grid') || '#e4e3df';
    const axis = this.css('--text-muted') || '#7a7974';
    const font = `11px ${this.css('--chart-font') || 'system-ui, sans-serif'}`;
    g.font = font;
    g.lineWidth = 1;

    // low-confidence bands of the first series that has a mask: hatched, not colored
    const masked = this.series.find((s) => s.mask?.some(Boolean));
    if (masked) {
      g.save();
      g.beginPath();
      g.rect(pad.l, pad.t, pw, ph);
      g.clip();
      g.strokeStyle = this.css('--chart-hatch') || 'rgba(120,120,120,0.25)';
      let start = -1;
      const flush = (/** @type {number} */ end) => {
        const x0 = x(masked.freqs[start]);
        const x1 = x(masked.freqs[end]);
        for (let px = x0 - ph; px < x1; px += 6) {
          g.beginPath();
          g.moveTo(Math.max(px, x0), pad.t + ph - Math.max(0, x0 - px));
          g.lineTo(Math.min(px + ph, x1), pad.t + ph - Math.min(ph, x1 - px));
          g.stroke();
        }
      };
      masked.mask?.forEach((m, i) => {
        if (m && start < 0) start = i;
        if (!m && start >= 0) {
          flush(i - 1);
          start = -1;
        }
      });
      if (start >= 0) flush(masked.freqs.length - 1);
      g.restore();
    }

    // grid
    g.strokeStyle = grid;
    g.fillStyle = axis;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const f of MINOR_F) {
      g.globalAlpha = 0.45;
      g.beginPath();
      g.moveTo(x(f), pad.t);
      g.lineTo(x(f), pad.t + ph);
      g.stroke();
    }
    g.globalAlpha = 1;
    for (const f of GRID_F) {
      g.beginPath();
      g.moveTo(x(f), pad.t);
      g.lineTo(x(f), pad.t + ph);
      g.stroke();
      if (w > 360 || [20, 100, 1000, 10000].includes(f)) g.fillText(formatHz(f), x(f), pad.t + ph + 5);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const stepDb = hi - lo > 40 ? 10 : 5;
    for (let d = Math.ceil(lo / stepDb) * stepDb; d <= hi; d += stepDb) {
      g.beginPath();
      g.moveTo(pad.l, y(d));
      g.lineTo(pad.l + pw, y(d));
      g.stroke();
      g.fillText(`${d}`, pad.l - 5, y(d));
    }

    // series
    g.save();
    g.beginPath();
    g.rect(pad.l, pad.t, pw, ph);
    g.clip();
    for (const s of this.series) {
      const color = s.role === 'target' ? this.css('--text-secondary') : this.css(`--series-${((s.slot ?? 0) % 8) + 1}`);
      g.strokeStyle = color || '#2a78d6';
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.setLineDash(s.role === 'target' ? [6, 4] : s.role === 'predicted' ? [2, 3] : []);
      g.beginPath();
      let started = false;
      s.freqs.forEach((f, i) => {
        if (f < F_MIN * 0.99 || f > F_MAX * 1.01 || !Number.isFinite(s.db[i])) return;
        if (!started) g.moveTo(x(f), y(s.db[i]));
        else g.lineTo(x(f), y(s.db[i]));
        started = true;
      });
      g.stroke();
    }
    g.restore();
    g.setLineDash([]);

    // crosshair + tooltip
    if (this.hoverX !== null && this.hoverX >= pad.l && this.hoverX <= pad.l + pw && this.series.length) {
      const f = fAt(this.hoverX);
      g.strokeStyle = axis;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(this.hoverX, pad.t);
      g.lineTo(this.hoverX, pad.t + ph);
      g.stroke();
      const rows = this.series.map((s) => {
        const v = valueAt(s, f);
        if (v !== null) {
          g.fillStyle = this.css('--surface-1') || '#fff';
          g.beginPath();
          g.arc(this.hoverX ?? 0, y(v), 5, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = s.role === 'target' ? this.css('--text-secondary') : this.css(`--series-${((s.slot ?? 0) % 8) + 1}`);
          g.lineWidth = 2;
          g.stroke();
        }
        return { s, v };
      });
      this.showTooltip(f, rows, this.hoverX, w);
    }
  }

  /**
   * @param {number} f @param {Array<{ s: Series, v: number | null }>} rows @param {number} px @param {number} w
   */
  showTooltip(f, rows, px, w) {
    const t = this.tooltip;
    t.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tt-head';
    head.textContent = `${f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : f.toFixed(0) + ' Hz'}`;
    t.append(head);
    for (const { s, v } of rows) {
      if (v === null) continue;
      const row = document.createElement('div');
      row.className = 'tt-row';
      const sw = document.createElement('span');
      sw.className = `swatch ${s.role === 'target' ? 'swatch-target' : ''}`;
      if (s.role !== 'target') sw.style.background = `var(--series-${((s.slot ?? 0) % 8) + 1})`;
      const label = document.createElement('span');
      label.className = 'tt-label';
      label.textContent = s.label;
      const val = document.createElement('span');
      val.className = 'tt-value';
      val.textContent = `${v.toFixed(1)} dB`;
      row.append(sw, label, val);
      t.append(row);
    }
    t.hidden = false;
    const left = px > w / 2 ? px - t.offsetWidth - 12 : px + 12;
    t.style.left = `${Math.max(0, left)}px`;
  }
}

/** @param {Series} s @param {number} f */
function valueAt(s, f) {
  const xs = s.freqs;
  if (!xs.length || f < xs[0] || f > xs[xs.length - 1]) return null;
  let i = 1;
  while (i < xs.length - 1 && xs[i] < f) i++;
  const t = Math.log(f / xs[i - 1]) / Math.log(xs[i] / xs[i - 1]);
  const v = s.db[i - 1] + t * (s.db[i] - s.db[i - 1]);
  return Number.isFinite(v) ? v : null;
}
