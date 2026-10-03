/*
 * FXMaker DSP — shared helpers.
 *
 * Every file in src/audio/dsp/ is plain JavaScript with NO imports or exports.
 * They are concatenated (common.js first) into one AudioWorklet module at
 * runtime (src/audio/worklets.ts), and evaluated the same way in Node by the
 * tests (tests/harness.ts). Keep them self-contained.
 *
 * Safety rules every processor follows:
 *   1. Anything with feedback soft-clips inside the loop, so it can scream but
 *      never run away to infinity.
 *   2. guard() runs on every output block. A NaN or Infinity anywhere zeroes
 *      the block, resets the processor's state and reports it — one bad value
 *      would otherwise kill all audio until the page is reloaded.
 *   3. All randomness is seeded, so an export renders the same way every time.
 */

const TAU = Math.PI * 2;
const ZERO_BLOCK = new Float32Array(128);

function mulberry32(seed) {
  let a = seed >>> 0 || 1;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** tanh-like soft clip, exact ±1 beyond ±3. */
function softclip(x) {
  if (x <= -3) return -1;
  if (x >= 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function dbToLin(db) {
  return db <= -96 ? 0 : Math.pow(10, db / 20);
}

/** One-pole coefficient for a time constant in ms. */
function coefMs(ms, sr) {
  return 1 - Math.exp(-1 / Math.max(1, (ms * sr) / 1000));
}

/** Input channel c of the first input, or a block of zeros if unconnected. */
function inCh(inputs, c) {
  const inp = inputs[0];
  if (!inp || inp.length === 0) return ZERO_BLOCK;
  return inp[Math.min(c, inp.length - 1)];
}

/* ---------------------------------------------------------------- FFT --- */

/**
 * Iterative radix-2 complex FFT. steps() is a generator so very large
 * transforms (the 65 536-point Paulstretch frames) can be spread across many
 * audio blocks instead of stalling one; transform() runs it to completion.
 */
class FFT {
  constructor(n) {
    this.n = n;
    let levels = 0;
    while (1 << levels < n) levels++;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((TAU * i) / n);
      this.sin[i] = Math.sin((TAU * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      let x = i;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.rev[i] = r;
    }
  }
  *steps(re, im, inverse, chunk) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    const cs = this.cos;
    const sn = this.sin;
    let count = 0;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cs[k];
          const s = sgn * sn[k];
          const tre = re[l] * c - im[l] * s;
          const tim = re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
        count += half;
        if (count >= chunk) {
          count = 0;
          yield 0;
        }
      }
    }
    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= inv;
        im[i] *= inv;
      }
    }
  }
  transform(re, im, inverse) {
    const it = this.steps(re, im, inverse, 1e15);
    while (!it.next().done);
  }
}

const fftCache = new Map();
function getFFT(n) {
  let f = fftCache.get(n);
  if (!f) {
    f = new FFT(n);
    fftCache.set(n, f);
  }
  return f;
}

const hannCache = new Map();
/** Periodic Hann window of length n. */
function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((TAU * i) / n);
    hannCache.set(n, w);
  }
  return w;
}

/* --------------------------------------------------------- delay line --- */

class DelayLine {
  constructor(maxSamples) {
    let n = 1;
    while (n < maxSamples + 4) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
    this.w = 0;
    this.max = n - 4;
  }
  clear() {
    this.buf.fill(0);
  }
  write(x) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  /** Read d samples behind the most recent write (d = 0 is that sample), linear. */
  read(d) {
    if (d < 0) d = 0;
    else if (d > this.max) d = this.max;
    const p = this.w - 1 - d;
    const i = Math.floor(p);
    const f = p - i;
    const b = this.buf;
    const m = this.mask;
    const a = b[i & m];
    const c = b[(i + 1) & m];
    return a + (c - a) * f;
  }
  /** 4-point cubic Hermite read — for modulated delays and pitch shifting. */
  readH(d) {
    if (d < 2) d = 2;
    else if (d > this.max) d = this.max;
    const p = this.w - 1 - d;
    const i = Math.floor(p);
    const f = p - i;
    const b = this.buf;
    const m = this.mask;
    const xm1 = b[(i - 1) & m];
    const x0 = b[i & m];
    const x1 = b[(i + 1) & m];
    const x2 = b[(i + 2) & m];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
}

/* ------------------------------------------------------------ filters --- */

/** Topology-preserving state-variable filter (Cytomic). Stable under fast modulation. */
class SVF {
  constructor() {
    this.ic1 = 0;
    this.ic2 = 0;
    this.lp = 0;
    this.bp = 0;
    this.hp = 0;
    this.g = 0.1;
    this.k = 1.4;
  }
  set(fc, q, sr) {
    const f = clamp(fc, 10, sr * 0.49);
    this.g = Math.tan((Math.PI * f) / sr);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
  reset() {
    this.ic1 = this.ic2 = 0;
  }
}

class DCBlock {
  constructor() {
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x) {
    const y = x - this.x1 + 0.995 * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
  reset() {
    this.x1 = this.y1 = 0;
  }
}

/** Per-sample one-pole smoother. */
class Smooth {
  constructor(v, ms, sr) {
    this.v = v;
    this.t = v;
    this.a = coefMs(ms, sr);
  }
  next() {
    this.v += (this.t - this.v) * this.a;
    return this.v;
  }
}

/**
 * Delay-line pitch shifter: two read taps sweep across a window, half a
 * window apart, crossfaded with a sine window. Cheap, robust, and grainy at
 * extreme settings — which is the point here.
 */
class Shifter {
  constructor(sr, maxWindowMs) {
    this.sr = sr;
    this.line = new DelayLine(Math.ceil((sr * (maxWindowMs || 250)) / 1000) + 8);
    this.phase = 0;
    this.win = Math.round(sr * 0.08);
  }
  setWindowMs(ms) {
    this.win = Math.max(64, Math.min(this.line.max - 8, Math.round((this.sr * ms) / 1000)));
  }
  clear() {
    this.line.clear();
    this.phase = 0;
  }
  process(x, ratio) {
    this.line.write(x);
    // phase runs 0..1; delay shrinks for pitch up, grows for pitch down
    this.phase += (1 - ratio) / this.win;
    this.phase -= Math.floor(this.phase);
    const p2 = (this.phase + 0.5) % 1;
    const d1 = 3 + this.phase * this.win;
    const d2 = 3 + p2 * this.win;
    const g1 = Math.sin(Math.PI * this.phase);
    const g2 = Math.sin(Math.PI * p2);
    return this.line.readH(d1) * g1 + this.line.readH(d2) * g2;
  }
}

/* ------------------------------------------------------- base class ---- */

class FxBase extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.p = Object.assign({}, this.constructor.defaults || {}, o.params || {});
    this.seed = o.seed || 1;
    this.rand = mulberry32(this.seed);
    this.sr = sampleRate;
    this.report = !!o.report;
    this.lastBlowup = -1e9;
    this.frame = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'params') {
        Object.assign(this.p, m.params);
        this.onParams();
      } else if (m.type === 'reset') {
        this.reset();
      } else this.onMessage(m);
    };
  }
  onParams() {}
  onMessage() {}
  reset() {}
  /** Zero any block containing NaN/Infinity, reset, and report (rate-limited). */
  guard(outputs) {
    const out = outputs[0];
    let bad = false;
    for (let c = 0; c < out.length; c++) {
      const ch = out[c];
      let s = 0;
      for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
      if (!Number.isFinite(s)) bad = true;
    }
    this.frame += 128;
    if (bad) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      this.reset();
      if (this.frame - this.lastBlowup > this.sr) {
        this.lastBlowup = this.frame;
        this.port.postMessage({ type: 'blowup' });
      }
    }
    return true;
  }
}
