/*
 * Runs the AudioWorklet processors in Node: the same source files the browser
 * loads, concatenated in the same order, with a minimal AudioWorkletProcessor
 * stand-in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DSP_FILES } from '../src/audio/dspFiles';

type Ctor = new (opts: unknown) => {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
  port: { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null };
};

const cache = new Map<number, Map<string, Ctor>>();

export function processors(sr = 48000): Map<string, Ctor> {
  const hit = cache.get(sr);
  if (hit) return hit;
  const dir = join(__dirname, '../src/audio/dsp');
  const src = DSP_FILES.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const reg = new Map<string, Ctor>();
  class AudioWorkletProcessor {
    messages: unknown[] = [];
    port = {
      postMessage: (m: unknown) => {
        this.messages.push(m);
      },
      onmessage: null as ((e: { data: unknown }) => void) | null,
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('sampleRate', 'registerProcessor', 'AudioWorkletProcessor', src)(sr, (n: string, c: Ctor) => reg.set(n, c), AudioWorkletProcessor);
  cache.set(sr, reg);
  return reg;
}

export interface RenderOpts {
  params?: Record<string, number | string>;
  seed?: number;
  channels?: Float32Array[];
  sr?: number;
  /** raw port messages to send part-way through: [atSeconds, message] */
  messages?: [number, Record<string, unknown>][];
}

export function render(name: string, input: Float32Array[] | null, seconds: number, o: RenderOpts = {}) {
  const sr = o.sr ?? 48000;
  const C = processors(sr).get(name);
  if (!C) throw new Error(`no processor ${name}`);
  const node = new C({ processorOptions: { params: o.params ?? {}, seed: o.seed ?? 7, channels: o.channels, report: true } }) as InstanceType<Ctor> & { messages: unknown[] };
  const len = Math.floor(seconds * sr);
  const out = [new Float32Array(len), new Float32Array(len)];
  const messages = [...(o.messages ?? [])];
  for (let s = 0; s < len; s += 128) {
    while (messages.length && messages[0][0] * sr <= s) node.port.onmessage?.({ data: messages.shift()![1] });
    const n = Math.min(128, len - s);
    const ins: Float32Array[][] = input
      ? [input.map((c) => { const z = new Float32Array(128); z.set(c.subarray(s, s + 128)); return z; })]
      : [[]];
    const blk = [[new Float32Array(128), new Float32Array(128)]];
    node.process(ins, blk, {});
    out[0].set(blk[0][0].subarray(0, n), s);
    out[1].set(blk[0][1].subarray(0, n), s);
  }
  return { out, messages: node.messages, node };
}

export function sine(freq: number, seconds: number, amp = 0.5, sr = 48000): Float32Array[] {
  const n = Math.floor(seconds * sr);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return [a, a.slice()];
}

export function noise(seconds: number, amp = 0.3, sr = 48000, seed = 3): Float32Array[] {
  const n = Math.floor(seconds * sr);
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = r() * amp;
  return [L, L.slice()];
}

export function stats(ch: Float32Array[]) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  let finite = true;
  for (const c of ch)
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      if (!Number.isFinite(v)) finite = false;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      n++;
    }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)), finite };
}

/** Peak frequency via a direct DFT scan (slow but exact enough for tests). */
export function peakFreq(x: Float32Array, lo: number, hi: number, step: number, sr = 48000): number {
  let best = lo;
  let bestP = -1;
  const n = Math.min(x.length, 16384);
  const off = Math.floor((x.length - n) / 2);
  for (let f = lo; f <= hi; f += step) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / sr;
    for (let i = 0; i < n; i++) {
      const hw = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      re += x[off + i] * hw * Math.cos(w * i);
      im += x[off + i] * hw * Math.sin(w * i);
    }
    const p = re * re + im * im;
    if (p > bestP) {
      bestP = p;
      best = f;
    }
  }
  return best;
}
