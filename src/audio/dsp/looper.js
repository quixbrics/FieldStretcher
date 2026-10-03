/*
 * The looper: one source buffer, three engines.
 *
 *  spectral — Paulstretch (after Paul Nasca). Each frame is a windowed slice
 *             of the source; its FFT magnitudes are kept and its phases thrown
 *             away and replaced with random ones, then frames are overlap-added
 *             one hop apart while the read head creeps forward by hop/stretch.
 *             The randomised phase is what turns 1000× into a smooth, endless
 *             wash instead of a stutter. Pitch moves the magnitudes up or down
 *             the bins, so it is fully independent of stretch.
 *  granular — many short windowed grains read around a slowly moving head.
 *             Each grain plays at the pitch ratio; the head moves at 1/stretch.
 *  tape     — varispeed: one read head, speed = pitch ratio ÷ stretch. Speed
 *             and pitch are tied together, like slowing a reel by hand.
 *
 * Large spectral frames (up to 32 768 points on phones) are computed as a generator, a
 * few slices per audio block, during the hop BEFORE they are needed, so the
 * audio thread never stalls on a single huge FFT.
 */

const NMAX = 32768;
const MAX_GRAINS = 96;
const HANN_TABLE = (() => {
  const t = new Float32Array(2049);
  for (let i = 0; i <= 2048; i++) t[i] = 0.5 - 0.5 * Math.cos((TAU * i) / 2048);
  return t;
})();

class FxmLooper extends FxBase {
  constructor(options) {
    super(options);
    const o = (options && options.processorOptions) || {};
    const chans = o.channels || [];
    this.L = chans[0] || new Float32Array(1024);
    this.R = chans[1] || this.L;
    this.len = this.L.length;
    this.silent = !chans[0];
    // spectral state
    this.re = new Float64Array(NMAX);
    this.im = new Float64Array(NMAX);
    this.mL = new Float64Array(NMAX / 2 + 1);
    this.mR = new Float64Array(NMAX / 2 + 1);
    this.accL = new Float32Array(NMAX * 2);
    this.accR = new Float32Array(NMAX * 2);
    this.frameL = new Float32Array(NMAX);
    this.frameR = new Float32Array(NMAX);
    // granular state
    this.lastEngine = this.p.engine;
    this.grains = [];
    for (let i = 0; i < MAX_GRAINS; i++) this.grains.push({ on: false, pos: 0, rate: 1, age: 0, len: 1, amp: 0, gl: 1, gr: 1 });
    this.reset();
  }

  static get defaults() {
    return {
      engine: 'spectral',
      stretch: 8,
      pitch: 0,
      reverse: 0,
      freeze: 0,
      start: 0,
      end: 1,
      window: 14,
      grain: 120,
      density: 24,
      jitter: 0.2,
      spray: 0,
      spread: 0.6,
      playing: 1,
    };
  }

  reset() {
    this.region();
    this.head = this.p.reverse ? this.s1 - 1 : this.s0;
    this.fadeIn = 0;
    // spectral
    this.accL.fill(0);
    this.accR.fill(0);
    this.outIdx = 0;
    this.hop = 0; // forces a synchronous first frame
    this.job = null;
    this.jobReady = false;
    this.yieldsPrev = 64;
    this.specPos = this.head;
    // granular
    for (const g of this.grains) g.on = false;
    this.spawnIn = 0;
    this.reportIn = 0;
  }

  onMessage(m) {
    if (m.type === 'play') {
      this.reset();
      this.p.playing = 1;
    } else if (m.type === 'buffer') {
      // a fresh recording (or a cleared track): swap the source and restart
      const ch = m.channels || [];
      this.L = ch[0] || new Float32Array(1024);
      this.R = ch[1] || this.L;
      this.len = this.L.length;
      this.silent = !ch[0];
      this.reset();
    }
  }

  onParams() {
    this.region();
    // switching engine mid-play: carry the read position across
    if (this.p.engine !== this.lastEngine) {
      if (this.lastEngine === 'spectral') this.head = this.wrap(this.specPos + this.dir() * (this.N || 0) * 0.5);
      else if (this.p.engine === 'spectral') this.specPos = this.head;
      this.lastEngine = this.p.engine;
    }
  }

  region() {
    const p = this.p;
    let a = clamp(Math.min(p.start, p.end), 0, 1);
    let b = clamp(Math.max(p.start, p.end), 0, 1);
    this.s0 = Math.floor(a * this.len);
    this.s1 = Math.max(this.s0 + 256, Math.floor(b * this.len));
    if (this.s1 > this.len) {
      this.s1 = this.len;
      this.s0 = Math.max(0, this.s1 - 256);
    }
    this.rl = this.s1 - this.s0;
  }

  wrap(x) {
    const r = this.rl;
    let y = (x - this.s0) % r;
    if (y < 0) y += r;
    return this.s0 + y;
  }

  /** Linear-interpolated read at a (wrapped) fractional position. */
  readAt(buf, pos) {
    const x = this.wrap(pos);
    const i = Math.floor(x);
    const f = x - i;
    const j = i + 1 >= this.s1 ? this.s0 : i + 1;
    return buf[i] + (buf[j] - buf[i]) * f;
  }

  dir() {
    return this.p.reverse ? -1 : 1;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    if (this.silent || !this.p.playing) {
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      return true;
    }
    const e = this.p.engine;
    if (e === 'granular') this.granular(oL, oR, n);
    else if (e === 'tape') this.tape(oL, oR, n);
    else this.spectral(oL, oR, n);
    // 40 ms fade-in after every (re)start, so loading or playing never clicks
    if (this.fadeIn < 1) {
      const step = 1 / (0.04 * this.sr);
      for (let i = 0; i < n; i++) {
        this.fadeIn = Math.min(1, this.fadeIn + step);
        oL[i] *= this.fadeIn;
        if (oR !== oL) oR[i] *= this.fadeIn;
      }
    }
    if (this.report) {
      this.reportIn -= n;
      if (this.reportIn <= 0) {
        this.reportIn = 2048;
        const pos = e === 'spectral' ? this.wrap(this.specPos + this.dir() * (this.N || 0) * 0.5) : this.head;
        this.port.postMessage({ type: 'pos', v: pos / this.len });
      }
    }
    return this.guard(outputs);
  }

  /* -------------------------------------------------------------- tape -- */
  tape(oL, oR, n) {
    const p = this.p;
    const rate = p.freeze ? 0 : (Math.pow(2, p.pitch / 12) / Math.max(0.01, p.stretch)) * this.dir();
    const fade = Math.max(32, Math.min(this.rl / 4, 0.006 * this.sr));
    for (let i = 0; i < n; i++) {
      const x = this.wrap(this.head);
      // short dip at the loop seam, so a region that does not start on a zero crossing never clicks
      const d = Math.min(x - this.s0, this.s1 - x);
      const g = d < fade ? d / fade : 1;
      oL[i] = this.readAt(this.L, x) * g;
      oR[i] = this.readAt(this.R, x) * g;
      this.head = x + rate;
    }
  }

  /* ---------------------------------------------------------- granular -- */
  granular(oL, oR, n) {
    const p = this.p;
    const sr = this.sr;
    const glen = Math.max(32, Math.round((clamp(p.grain, 5, 4000) * sr) / 1000));
    const density = clamp(p.density, 0.5, 400);
    const interval = sr / density;
    const overlap = Math.max(1, (density * glen) / sr);
    const amp = 1 / Math.sqrt(overlap);
    const step = p.freeze ? 0 : this.dir() / Math.max(0.01, p.stretch);
    const scatter = p.jitter * p.jitter * this.rl * 0.5 + p.jitter * glen;
    oL.fill(0);
    oR.fill(0);
    for (let i = 0; i < n; i++) {
      this.spawnIn -= 1;
      if (this.spawnIn <= 0) {
        this.spawnIn += interval * (1 + (this.rand() - 0.5) * p.jitter);
        this.spawn(glen, amp, scatter);
      }
      this.head = this.wrap(this.head + step);
    }
    // render grains block-wise (cheaper than per-sample spawning loop above)
    for (const g of this.grains) {
      if (!g.on) continue;
      let pos = g.pos;
      let age = g.age;
      const start = g.delay;
      g.delay = 0;
      for (let i = start; i < n; i++) {
        if (age >= g.len) {
          g.on = false;
          break;
        }
        const w = HANN_TABLE[((age / g.len) * 2048) | 0] * g.amp;
        oL[i] += this.readAt(this.L, pos) * w * g.gl;
        oR[i] += this.readAt(this.R, pos) * w * g.gr;
        pos += g.rate;
        age++;
      }
      g.pos = pos;
      g.age = age;
    }
  }

  spawn(glen, amp, scatter) {
    const p = this.p;
    let g = null;
    for (const c of this.grains) if (!c.on) { g = c; break; }
    if (!g) return;
    const gauss = (this.rand() + this.rand() + this.rand() - 1.5) * 1.15;
    const semis = p.pitch + p.spray * gauss;
    const ratio = Math.pow(2, semis / 12);
    g.on = true;
    g.age = 0;
    g.len = glen;
    g.rate = ratio * this.dir();
    // centre the grain on the head, scattered
    g.pos = this.wrap(this.head + (this.rand() * 2 - 1) * scatter - (g.rate * glen) / 2);
    g.amp = amp;
    const pan = (this.rand() * 2 - 1) * clamp(p.spread, 0, 1);
    const th = ((pan + 1) * Math.PI) / 4;
    g.gl = Math.cos(th) * Math.SQRT2;
    g.gr = Math.sin(th) * Math.SQRT2;
    // grains spawned mid-block start at the block's next render pass
    g.delay = 0;
  }

  /* ---------------------------------------------------------- spectral -- */
  spectral(oL, oR, n) {
    for (let i = 0; i < n; i++) {
      if (this.outIdx >= this.hop) this.commit();
      oL[i] = this.accL[this.outIdx];
      oR[i] = this.accR[this.outIdx];
      this.outIdx++;
    }
    // advance the next frame's computation by a slice
    if (this.job && !this.jobReady) {
      const blocksPerHop = Math.max(1, this.hop / 128);
      const per = Math.ceil(this.yieldsPrev / (blocksPerHop * 0.5)) + 1;
      for (let k = 0; k < per; k++) {
        this.jobYields++;
        if (this.job.next().done) {
          this.jobReady = true;
          this.yieldsPrev = this.jobYields;
          break;
        }
      }
    }
  }

  /** Hop boundary: overlap-add the finished frame and start the next one. */
  commit() {
    if (!this.job) this.startJob();
    if (!this.jobReady) {
      while (!this.job.next().done) this.jobYields++;
      this.yieldsPrev = this.jobYields;
    }
    const N = this.jobN;
    const hop = N >> 2;
    const prevHop = this.hop;
    // shift the accumulator left by the hop that just finished playing
    if (prevHop > 0) {
      this.accL.copyWithin(0, prevHop);
      this.accR.copyWithin(0, prevHop);
      this.accL.fill(0, this.accL.length - prevHop);
      this.accR.fill(0, this.accR.length - prevHop);
    }
    const w = hann(N);
    // random-phase frames add incoherently: Hann² at 75 % overlap → ×4/3 restores level
    const g = 4 / 3;
    const fL = this.frameL;
    const fR = this.frameR;
    for (let i = 0; i < N; i++) {
      this.accL[i] += fL[i] * w[i] * g;
      this.accR[i] += fR[i] * w[i] * g;
    }
    this.hop = hop;
    this.N = N;
    this.outIdx = 0;
    // move the read head for the next frame
    const p = this.p;
    if (!p.freeze) this.specPos = this.wrap(this.specPos + (this.dir() * hop) / Math.max(0.01, p.stretch));
    this.startJob();
  }

  startJob() {
    const p = this.p;
    const N = 1 << clamp(Math.round(p.window), 10, 15);
    this.jobN = N;
    this.jobYields = 0;
    this.jobReady = false;
    this.job = this.frameJob(N, this.specPos, this.dir(), Math.pow(2, p.pitch / 12), clamp(p.spread, 0, 1));
  }

  *frameJob(N, pos, dir, ratio, spread) {
    const fft = getFFT(N);
    const re = this.re;
    const im = this.im;
    const w = hann(N);
    const L = this.L;
    const R = this.R;
    const CH = 4096;
    for (let i = 0; i < N; i++) {
      const x = this.wrap(pos + dir * i);
      const k = Math.floor(x);
      re[i] = L[k] * w[i];
      im[i] = R[k] * w[i];
      if ((i & (CH - 1)) === CH - 1) yield 0;
    }
    yield* fft.steps(re, im, false, CH);
    const half = N >> 1;
    const mL = this.mL;
    const mR = this.mR;
    // separate the two real spectra packed into one complex FFT
    for (let k = 0; k <= half; k++) {
      const a = re[k];
      const b = im[k];
      const j = (N - k) & (N - 1);
      const c = re[j];
      const d = im[j];
      mL[k] = 0.5 * Math.hypot(a + c, b - d);
      mR[k] = 0.5 * Math.hypot(a - c, b + d);
      if ((k & (CH - 1)) === CH - 1) yield 0;
    }
    // build the output spectrum: shifted magnitudes, random phases
    re.fill(0, 0, N);
    im.fill(0, 0, N);
    const rnd = this.rand;
    const up = ratio >= 1;
    const norm = up ? 1 / Math.sqrt(ratio) : 1;
    for (let k = 1; k < half; k++) {
      let aL = 0;
      let aR = 0;
      if (up) {
        // pitch up: each source bin is spread over `ratio` output bins
        const src = k / ratio;
        const s = Math.floor(src);
        const f = src - s;
        aL = (mL[s] + (mL[s + 1] - mL[s]) * f) * norm;
        aR = (mR[s] + (mR[s + 1] - mR[s]) * f) * norm;
      } else {
        // pitch down: several source bins fold into one — sum their power,
        // so a narrow peak can never fall between the samples and vanish
        const a = Math.floor(k / ratio);
        const b = Math.min(half, Math.floor((k + 1) / ratio));
        if (a < half) {
          let pl = 0;
          let pr = 0;
          for (let s = a; s < Math.max(a + 1, b); s++) {
            pl += mL[s] * mL[s];
            pr += mR[s] * mR[s];
          }
          aL = Math.sqrt(pl);
          aR = Math.sqrt(pr);
        }
      }
      const phL = rnd() * TAU;
      const phR = phL + (rnd() - 0.5) * TAU * spread;
      const ar = aL * Math.cos(phL);
      const ai = aL * Math.sin(phL);
      const br = aR * Math.cos(phR);
      const bi = aR * Math.sin(phR);
      re[k] = ar - bi;
      im[k] = ai + br;
      re[N - k] = ar + bi;
      im[N - k] = br - ai;
      if ((k & (CH - 1)) === CH - 1) yield 0;
    }
    yield* fft.steps(re, im, true, CH);
    const fL = this.frameL;
    const fR = this.frameR;
    for (let i = 0; i < N; i++) {
      fL[i] = re[i];
      fR[i] = im[i];
    }
  }
}

registerProcessor('fxm-looper', FxmLooper);
