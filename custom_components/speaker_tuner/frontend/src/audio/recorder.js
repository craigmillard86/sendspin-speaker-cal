// @ts-check
// Records raw samples from a MediaStream with an AudioWorklet, and reports a live level.

// Mixes every channel the browser delivers: asking for mono is only a request, and on a
// multi-input interface the mic may be on input 2 while input 1 is silent.
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const n = input[0].length;
      const block = new Float32Array(n);
      for (const ch of input) for (let i = 0; i < n; i++) block[i] += ch[i] / input.length;
      this.port.postMessage({ block, channels: input.length });
    }
    return true;
  }
}
registerProcessor('speaker-tuner-capture', Capture);
`;

/**
 * @typedef {{ sampleRate: number, start: () => void, stop: () => Float32Array, peek: () => Float32Array,
 *   recording: boolean, level: () => { rmsDbfs: number, peakDbfs: number, silent: boolean }, channels: () => number,
 *   close: () => Promise<void> }} Recorder
 */

/**
 * @param {MediaStream} stream
 * @returns {Promise<Recorder>}
 */
export async function createRecorder(stream) {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'speaker-tuner-capture');
  // a silent sink keeps the graph running in every browser
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink).connect(ctx.destination);

  /** @type {Float32Array[]} */
  let chunks = [];
  let length = 0;
  let recording = false;
  let rms = -120;
  let peak = -120;
  let channels = 0;
  // samples since the last non-zero one: a long run of exact zeros is digital silence,
  // which a real mic never produces (it always has some noise)
  let zeroRun = 0;
  node.port.onmessage = (ev) => {
    /** @type {Float32Array} */
    const block = ev.data.block;
    channels = ev.data.channels;
    let s = 0;
    let p = 0;
    for (let i = 0; i < block.length; i++) {
      s += block[i] * block[i];
      p = Math.max(p, Math.abs(block[i]));
    }
    zeroRun = p === 0 ? zeroRun + block.length : 0;
    // fast attack, slow release, so the meter is readable
    const r = 10 * Math.log10(s / block.length + 1e-20);
    rms = r > rms ? r : rms * 0.97 + r * 0.03;
    const pk = 20 * Math.log10(p + 1e-10);
    peak = pk > peak ? pk : peak - 0.3;
    if (recording) {
      chunks.push(block);
      length += block.length;
    }
  };
  if (ctx.state === 'suspended') await ctx.resume();

  const join = () => {
    const out = new Float32Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };

  return {
    sampleRate: ctx.sampleRate,
    get recording() {
      return recording;
    },
    start() {
      chunks = [];
      length = 0;
      recording = true;
    },
    stop() {
      recording = false;
      return join();
    },
    peek: join,
    level: () => ({ rmsDbfs: rms, peakDbfs: peak, silent: zeroRun > ctx.sampleRate }),
    channels: () => channels,
    async close() {
      recording = false;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}
