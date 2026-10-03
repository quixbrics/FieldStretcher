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
 *               smear    the frame size (window): small = soft, blurred, quick;
 *                        large = fine frequency detail, slow to evolve
 *               spread   how different the two ears' random phases are (width)
 *               tilt     −1…+1: darker … brighter (±6 dB per octave about 1 kHz)
 *               contrast <1 flattens the spectrum toward noise, >1 sharpens
 *                        its peaks toward tones (level is kept)
 *  granular — many short windowed grains read around a slowly moving head.
 *             Each grain plays at the pitch ratio; the head moves at 1/stretch.
 *               grain/density/jitter/spray/spread as before, plus
 *               shape    0 = percussive (instant attack, falling tail) … 1 = smooth
 *               grev     the chance each grain plays backwards
 *  tape     — varispeed: one read head, speed = pitch ratio ÷ stretch. Speed
 *             and pitch are tied together, like slowing a reel by hand.
 *               glide    motor inertia: speed changes (and stopping) take this long
 *               wow      slow speed drift   flutter  fast speed wobble
 *               drive    tape saturation    age      high-frequency loss
 *               hiss     tape noise
 *
 * `glide` also smooths the stretch ratio for the spectral and granular engines,
 * so a stretch change is a slow glide instead of a jump.
 *
 * Large spectral frames (up to 32 768 points on phones) are computed as a
 * generator, a few slices per audio block, during the hop BEFORE they are
 * needed, so the audio thread never stalls on a single huge FFT.
 */

const NMAX = 32768;
const MAX_GRAINS = 96;
const HANN_TABLE = (() => {
  const t = new Float32Array(2049);
  for (let i = 0; i <= 2048; i++) t[i] = 0.5 - 0.5 * Math.cos((TAU * i) / 2048);
  return t;
})();
/** percussive grain window: fast attack, exponential fall */
const PERC_TABLE = (() => {
  const t = new Float32Array(2049);
  for (let i = 0; i <= 2048; i++) {
    const x = i / 2048;
    t[i] = x < 0.04 ? x / 0.04 : Math.exp(-(x - 0.04) * 6);
  }
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
    this.oL = new Float64Array(NMAX / 2 + 1);
    this.oR = new Float64Array(NMAX / 2 + 1);
    this.accL = new Float32Array(NMAX * 2);
    this.accR = new Float32Array(NMAX * 2);
    this.frameL = new Float32Array(NMAX);
    this.frameR = new Float32Array(NMAX);
    // granular state
    this.lastEngine = this.p.engine;
    this.grains = [];
    for (let i = 0; i < MAX_GRAINS; i++) this.grains.push({ on: false, pos: 0, rate: 1, age: 0, len: 1, amp: 0, gl: 1, gr: 1, delay: 0 });
    this.evt = [];
    this.evtIn = 0;
    // glide / tape state
    this.curSt = Math.max(0.01, this.p.stretch);
    this.rateS = null;
    this.stopG = 1;
    this.pw = 0;
    this.pf = 0;
    this.nz = 0;
    this.ageL = 0;
    this.ageR = 0;
    this.rep = 0;
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
      glide: 0,
      playing: 1,
      // spectral
      window: 13,
      spread: 0.6,
      tilt: 0,
      contrast: 1,
      // granular
      grain: 120,
      density: 24,
      jitter: 0.2,
      spray: 0,
      shape: 1,
      grev: 0,
      // tape
      wow: 0,
      flutter: 0,
      drive: 0,
      age: 0,
      hiss: 0,
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
    // tape
    this.rateS = null;
    this.stopG = 1;
    this.ageL = 0;
    this.ageR = 0;
  }

  onMessage(m) {
    if (m.type === 'play') {
      this.reset();
      this.p.playing = 1;
    } else if (m.type === 'buffer') {
      // a fresh recording (or a cleared track): swap the source and restart.
      // keep=true swaps audio of the SAME length without restarting (an overdub, a normalise).
      const ch = m.channels || [];
      const same = m.keep && ch[0] && ch[0].length === this.len;
      this.L = ch[0] || new Float32Array(1024);
      this.R = ch[1] || this.L;
      this.len = this.L.length;
      this.silent = !ch[0];
      if (!same) this.reset();
    }
  }

  onParams() {
    this.region();
    // switching engine mid-play: carry the read position across
    if (this.p.engine !== this.lastEngine) {
      if (this.lastEngine === 'spectral') this.head = this.wrap(this.specPos + this.dir() * (this.N || 0) * 0.5);
      else if (this.p.engine === 'spectral') this.specPos = this.head;
      this.lastEngine = this.p.engine;
      this.rateS = null;
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
    // glide: the stretch ratio eases toward its target (in the log domain, so 1×→1000× is even)
    const target = Math.max(0.01, this.p.stretch);
    const g = this.p.glide;
    if (g > 0.001) this.curSt = Math.exp(Math.log(this.curSt) + (Math.log(target) - Math.log(this.curSt)) * (1 - Math.exp(-n / (this.sr * g))));
    else this.curSt = target;
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
        const rate = e === 'tape' ? this.rep : this.p.freeze ? 0 : this.dir() / this.curSt;
        this.port.postMessage({ type: 'pos', v: pos / this.len, r: rate });
      }
      this.evtIn -= n;
      if (this.evt.length && this.evtIn <= 0) {
        this.evtIn = 1024;
        this.port.postMessage({ type: 'grains', g: this.evt.splice(0, 24) });
        this.evt.length = 0;
      }
    }
    return this.guard(outputs);
  }

  /* -------------------------------------------------------------- tape -- */
  tape(oL, oR, n) {
    const p = this.p;
    const sr = this.sr;
    const dir = this.dir();
    const target = p.freeze ? 0 : Math.pow(2, p.pitch / 12) / Math.max(0.01, p.stretch);
    if (this.rateS === null) this.rateS = target;
    // motor inertia: speed (and stopping) take `glide` seconds
    const sl = p.glide > 0.001 ? 1 - Math.exp(-1 / (sr * p.glide)) : 1;
    const wow = clamp(p.wow, 0, 1);
    const fl = clamp(p.flutter, 0, 1);
    const drive = clamp(p.drive, 0, 1);
    const dg = 1 + drive * 5;
    const dn = drive > 0 ? 1 / softclip(dg) : 1;
    const age = clamp(p.age, 0, 1);
    const ageA = age > 0 ? 1 - Math.exp((-TAU * 20000 * Math.pow(0.05, age)) / sr) : 1;
    const hiss = clamp(p.hiss, 0, 1) * 0.03;
    const fade = Math.max(32, Math.min(this.rl / 4, 0.006 * sr));
    // a stopped reel fades out as it winds down, instead of holding one sample (a DC thump)
    const sg = 1 - Math.exp(-1 / (sr * Math.max(0.08, p.glide * 0.6)));
    const sgTarget = p.freeze ? 0 : 1;
    for (let i = 0; i < n; i++) {
      this.rateS += (target - this.rateS) * sl;
      this.stopG += (sgTarget - this.stopG) * sg;
      this.pw += 0.7 / sr;
      this.pf += 11 / sr;
      if (wow > 0 || fl > 0) {
        this.nz += (this.rand() * 2 - 1 - this.nz) * 0.002;
        this.rep = this.rateS * (1 + wow * (0.02 * Math.sin(TAU * this.pw) + 0.008 * Math.sin(TAU * this.pw * 0.37 + 1.3)) + fl * (0.004 * Math.sin(TAU * this.pf) + 0.01 * this.nz));
      } else this.rep = this.rateS;
      const x = this.wrap(this.head);
      // short dip at the loop seam, so a region that does not start on a zero crossing never clicks
      const d = Math.min(x - this.s0, this.s1 - x);
      let gn = d < fade ? d / fade : 1;
      gn *= this.stopG;
      let l = this.readAt(this.L, x) * gn;
      let r = this.readAt(this.R, x) * gn;
      if (drive > 0) {
        l = softclip(l * dg) * dn;
        r = softclip(r * dg) * dn;
      }
      if (age > 0) {
        this.ageL += (l - this.ageL) * ageA;
        this.ageR += (r - this.ageR) * ageA;
        l = this.ageL;
        r = this.ageR;
      }
      if (hiss > 0) {
        l += (this.rand() * 2 - 1) * hiss;
        r += (this.rand() * 2 - 1) * hiss;
      }
      oL[i] = l;
      oR[i] = r;
      this.head = x + this.rep * dir;
    }
    this.rep *= dir;
  }

  /* ---------------------------------------------------------- granular -- */
  granular(oL, oR, n) {
    const p = this.p;
    const sr = this.sr;
    const glen = Math.max(32, Math.round((clamp(p.grain, 5, 4000) * sr) / 1000));
    const density = clamp(p.density, 0.5, 400);
    const interval = sr / density;
    const overlap = Math.max(1, (density * glen) / sr);
    const sh = clamp(p.shape, 0, 1);
    // percussive windows carry less energy than a smooth one: make some of it back
    const amp = (1 / Math.sqrt(overlap)) * (1 + (1 - sh) * 0.8);
    const step = p.freeze ? 0 : this.dir() / this.curSt;
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
        const ix = ((age / g.len) * 2048) | 0;
        const w = (HANN_TABLE[ix] * sh + PERC_TABLE[ix] * (1 - sh)) * g.amp;
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
    // some grains play backwards: the chance is `grev`
    const back = p.grev > 0 && this.rand() < p.grev ? -1 : 1;
    g.rate = ratio * this.dir() * back;
    // centre the grain on the head, scattered
    g.pos = this.wrap(this.head + (this.rand() * 2 - 1) * scatter - (g.rate * glen) / 2);
    g.amp = amp;
    const pan = (this.rand() * 2 - 1) * clamp(p.spread, 0, 1);
    const th = ((pan + 1) * Math.PI) / 4;
    g.gl = Math.cos(th) * Math.SQRT2;
    g.gr = Math.sin(th) * Math.SQRT2;
    // grains spawned mid-block start at the block's next render pass
    g.delay = 0;
    if (this.report && this.evt.length < 48) this.evt.push([g.pos / this.len, glen / this.len, pan, semis, back]);
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
    if (!p.freeze) this.specPos = this.wrap(this.specPos + (this.dir() * hop) / this.curSt);
    this.startJob();
  }

  startJob() {
    const p = this.p;
    const N = 1 << clamp(Math.round(p.window), 10, 15);
    this.jobN = N;
    this.jobYields = 0;
    this.jobReady = false;
    this.job = this.frameJob(N, this.specPos, this.dir(), Math.pow(2, p.pitch / 12), clamp(p.spread, 0, 1), clamp(p.tilt, -1, 1), clamp(p.contrast, 0.3, 3));
  }

  *frameJob(N, pos, dir, ratio, spread, tilt, contrast) {
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
    // output magnitudes: shifted for pitch
    const oL = this.oL;
    const oR = this.oR;
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
      oL[k] = aL;
      oR[k] = aR;
      if ((k & (CH - 1)) === CH - 1) yield 0;
    }
    // tilt and contrast: reshape the spectrum, then put the level back
    if (tilt !== 0 || contrast !== 1) {
      const binHz = this.sr / N;
      let e0 = 0;
      let e1 = 0;
      for (let k = 1; k < half; k++) {
        e0 += oL[k] * oL[k] + oR[k] * oR[k];
        const gt = tilt === 0 ? 1 : Math.pow(2, tilt * Math.log2(Math.max(30, k * binHz) / 1000));
        const l = (contrast === 1 ? oL[k] : Math.pow(oL[k] + 1e-12, contrast)) * gt;
        const r = (contrast === 1 ? oR[k] : Math.pow(oR[k] + 1e-12, contrast)) * gt;
        oL[k] = l;
        oR[k] = r;
        e1 += l * l + r * r;
        if ((k & (CH - 1)) === CH - 1) yield 0;
      }
      const sc = e1 > 1e-30 ? Math.sqrt(e0 / e1) : 1;
      for (let k = 1; k < half; k++) {
        oL[k] *= sc;
        oR[k] *= sc;
        if ((k & (CH - 1)) === CH - 1) yield 0;
      }
    }
    // build the output spectrum: those magnitudes, random phases
    re.fill(0, 0, N);
    im.fill(0, 0, N);
    const rnd = this.rand;
    for (let k = 1; k < half; k++) {
      const phL = rnd() * TAU;
      const phR = phL + (rnd() - 0.5) * TAU * spread;
      const ar = oL[k] * Math.cos(phL);
      const ai = oL[k] * Math.sin(phL);
      const br = oR[k] * Math.cos(phR);
      const bi = oR[k] * Math.sin(phR);
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
