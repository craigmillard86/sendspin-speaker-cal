// @ts-check
// Records raw samples from a MediaStream with an AudioWorklet, and reports a live level.

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('speaker-tuner-capture', Capture);
`;

/**
 * @typedef {{ sampleRate: number, start: () => void, stop: () => Float32Array, peek: () => Float32Array,
 *   recording: boolean, level: () => { rmsDbfs: number, peakDbfs: number }, close: () => Promise<void> }} Recorder
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
  node.port.onmessage = (ev) => {
    /** @type {Float32Array} */
    const block = ev.data;
    let s = 0;
    let p = 0;
    for (let i = 0; i < block.length; i++) {
      s += block[i] * block[i];
      p = Math.max(p, Math.abs(block[i]));
    }
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
    level: () => ({ rmsDbfs: rms, peakDbfs: peak }),
    async close() {
      recording = false;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}
