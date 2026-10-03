/*
 * The FX bus: resonator → delay → reverb, in series (wired in engine.ts).
 *
 * The reverb (8-line FDN) and the tape-style delay are FXMaker's processors,
 * unchanged. The resonator is FXMaker's string bank reduced to what this app
 * needs: ONE note (continuous MIDI pitch, so a sequencer can move it) played as
 * a chord of up to 8 tuned strings, excited by whatever the tracks send in.
 * Pitch changes glide over `glide` seconds.
 *
 * Every processor outputs only its wet signal; the dry/wet blend is done with
 * gain nodes in the graph.
 */

const FDN_MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1];
const DIFF_MS = [4.7, 3.6, 12.7, 9.3];

class FxmFdn extends FxBase {
  static get defaults() {
    return { size: 1, decay: 6, damping: 0.4, mod: 0.3, shimmer: 0.5, interval: 12, freeze: 0, predelay: 20 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    const sr = this.sr;
    this.lines = FDN_MS.map((ms) => new DelayLine(Math.ceil((ms * 2.2 * sr) / 1000) + 200));
    this.lp = new Float64Array(8);
    this.vals = new Float64Array(8);
    this.diff = DIFF_MS.map((ms) => ({ line: new DelayLine(Math.ceil((ms * sr) / 1000) + 4), d: (ms * sr) / 1000 }));
    this.pre = new DelayLine(sr * 0.6);
    this.shift = new Shifter(sr, 200);
    this.shift.setWindowMs(110);
    this.ph = 0;
    this.lastMono = 0;
    this.inG = 1;
    this.dcL = new DCBlock();
    this.dcR = new DCBlock();
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const sr = this.sr;
    const frozen = p.freeze >= 0.5;
    const size = clamp(p.size, 0.15, 2.2);
    const T60 = clamp(p.decay, 0.2, 120);
    const lens = FDN_MS.map((ms) => (ms * size * sr) / 1000);
    const gains = lens.map((l) => (frozen ? 1 : Math.pow(10, (-3 * (l / sr)) / T60)));
    const damp = frozen ? 0 : clamp(p.damping, 0, 0.98);
    const modD = (clamp(p.mod, 0, 1) * 1.2 * sr) / 1000;
    const shim = clamp(p.shimmer, 0, 1);
    const ratio = Math.pow(2, clamp(p.interval, -24, 24) / 12);
    const pd = clamp((p.predelay * sr) / 1000, 1, sr * 0.5);
    const lines = this.lines;
    const v = this.vals;
    for (let i = 0; i < oL.length; i++) {
      this.inG += ((frozen ? 0 : 1) - this.inG) * 0.003;
      this.pre.write(0.5 * (xL[i] + xR[i]) * this.inG);
      let u = this.pre.read(pd);
      // shimmer: the tail, pitch-shifted, fed back into the tank
      if (shim > 0) u += softclip(this.shift.process(this.lastMono, ratio) * shim * 0.6);
      // input diffusion (Schroeder allpasses)
      for (let k = 0; k < 4; k++) {
        const dfu = this.diff[k];
        const dd = dfu.line.read(dfu.d - 1);
        const w = u + 0.6 * dd;
        dfu.line.write(w);
        u = dd - 0.6 * w;
      }
      this.ph += 0.37 / sr;
      if (this.ph >= 1) this.ph -= 1;
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        const m = modD * Math.sin(TAU * (this.ph + k * 0.125));
        let y = lines[k].read(lens[k] + m + modD);
        this.lp[k] += (y - this.lp[k]) * (1 - damp);
        y = this.lp[k] * gains[k];
        v[k] = y;
        sum += y;
      }
      const hh = (2 / 8) * sum;
      for (let k = 0; k < 8; k++) lines[k].write(softclip(v[k] - hh + u * 0.35));
      const l = v[0] - v[2] + v[4] - v[6] + 0.5 * (v[1] + v[5]);
      const r = v[1] - v[3] + v[5] - v[7] + 0.5 * (v[2] + v[6]);
      this.lastMono = 0.5 * (l + r);
      oL[i] = this.dcL.process(l * 0.6);
      oR[i] = this.dcR.process(r * 0.6);
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-fdn', FxmFdn);

class FxmDelay extends FxBase {
  static get defaults() {
    return { timeL: 380, timeR: 520, feedback: 0.55, pingpong: 0, lowcut: 120, highcut: 6000, drive: 0.2, wobble: 0.15, freeze: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.lines = [new DelayLine(this.sr * 4.2), new DelayLine(this.sr * 4.2)];
    this.hp = [new SVF(), new SVF()];
    this.lp = [new SVF(), new SVF()];
    this.dS = null;
    this.ph = 0;
    this.inG = 1;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const sr = this.sr;
    const frozen = p.freeze >= 0.5;
    const fb = frozen ? 1 : clamp(p.feedback, 0, 1.3);
    const tL = clamp((p.timeL * sr) / 1000, 16, sr * 4);
    const tR = clamp((p.timeR * sr) / 1000, 16, sr * 4);
    if (!this.dS) this.dS = [tL, tR];
    const drive = frozen ? 0 : clamp(p.drive, 0, 1);
    const dg = 1 + drive * 4;
    const dn = 1 / Math.sqrt(dg);
    const wob = (clamp(p.wobble, 0, 1) * 6 * sr) / 1000;
    for (let c = 0; c < 2; c++) {
      this.hp[c].set(frozen ? 10 : clamp(p.lowcut, 10, 5000), 0.6, sr);
      this.lp[c].set(frozen ? sr * 0.45 : clamp(p.highcut, 300, 20000), 0.6, sr);
    }
    const ping = p.pingpong >= 0.5;
    const L0 = this.lines[0];
    const L1 = this.lines[1];
    for (let i = 0; i < oL.length; i++) {
      // tape-style glide when the time changes (pitch bends, no clicks)
      this.dS[0] += (tL - this.dS[0]) * 0.00025;
      this.dS[1] += (tR - this.dS[1]) * 0.00025;
      this.ph += 0.7 / sr;
      if (this.ph >= 1) this.ph -= 1;
      const m = wob * (1 + Math.sin(TAU * this.ph)) + wob * 0.3 * (1 + Math.sin(TAU * this.ph * 7.3));
      const dl = L0.readH(this.dS[0] + m);
      const dr = L1.readH(this.dS[1] + m * 0.9);
      // in-loop tone + saturation: it can scream, it cannot blow up
      this.hp[0].process(dl);
      this.hp[1].process(dr);
      const fl = softclip(this.lp[0].process(this.hp[0].hp) * fb * dg) * dn;
      const fr = softclip(this.lp[1].process(this.hp[1].hp) * fb * dg) * dn;
      this.inG += ((frozen ? 0 : 1) - this.inG) * 0.002;
      if (ping) {
        L0.write(0.5 * (xL[i] + xR[i]) * this.inG + fr);
        L1.write(fl);
      } else {
        L0.write(xL[i] * this.inG + fl);
        L1.write(xR[i] * this.inG + fr);
      }
      oL[i] = dl;
      oR[i] = dr;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-delay', FxmDelay);

/* Chord shapes: semitone offsets above the note (max 8 strings). */
const RESO_CHORDS = [
  [0], // single
  [0, 12, 24], // octaves
  [0, 7, 12, 19], // fifths
  [0, 3, 7, 12], // minor
  [0, 4, 7, 12], // major
  [0, 5, 7, 12], // sus4
  [0, 3, 7, 10, 14], // minor 9
];

class FxmReso extends FxBase {
  static get defaults() {
    return { note: 57, chord: 2, decay: 0.6, bright: 0.5, spread: 0.3, drive: 0.2, glide: 0.4 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    const maxD = Math.ceil(this.sr / 25) + 8;
    this.lines = [[], []];
    this.lp = [new Float64Array(8), new Float64Array(8)];
    for (let c = 0; c < 2; c++) for (let v = 0; v < 8; v++) this.lines[c].push(new DelayLine(maxD));
    this.dc = [new DCBlock(), new DCBlock()];
    this.freq = new Float64Array(8);
  }
  onMessage(m) {
    // a sequencer can set a custom set of offsets (e.g. stacked scale thirds)
    if (m.type === 'offsets' && Array.isArray(m.offsets)) this.p.offsets = m.offsets.slice(0, 8);
    else if (m.type === 'chord') this.p.offsets = null;
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const sr = this.sr;
    const T60 = 0.15 * Math.pow(200, clamp(p.decay, 0, 1)); // 0.15 s .. 30 s
    const lpa = 0.15 + 0.85 * clamp(p.bright, 0, 1);
    const drv = 1 + clamp(p.drive, 0, 1) * 3;
    const spread = clamp(p.spread, 0, 1);
    const lpDelay = (1 - lpa) / lpa;
    const offs = p.offsets && p.offsets.length ? p.offsets : RESO_CHORDS[Math.round(clamp(p.chord, 0, RESO_CHORDS.length - 1))];
    const nv = Math.min(8, offs.length);
    const base = 440 * Math.pow(2, (clamp(p.note, 12, 108) - 69) / 12);
    // glide: the per-block smoothing coefficient for a time constant of `glide` seconds
    const gl = 1 - Math.exp(-out[0].length / (sr * Math.max(0.004, p.glide)));
    for (let v = 0; v < nv; v++) {
      const tf = base * Math.pow(2, offs[v] / 12);
      this.freq[v] = this.freq[v] > 0 ? this.freq[v] + (tf - this.freq[v]) * gl : tf;
    }
    const norm = (0.25 / Math.sqrt(Math.max(1, nv))) * 4;
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const lines = this.lines[c];
      const lps = this.lp[c];
      const det = c ? Math.pow(2, (spread * 18) / 1200) : 1;
      const ds = [];
      const fbs = [];
      for (let v = 0; v < nv; v++) {
        const f = clamp(this.freq[v] * det, 25, sr / 6);
        ds.push(Math.max(2, sr / f - 1 - lpDelay)); // minus the in-loop low-pass's own delay, so the string is in tune
        fbs.push(Math.pow(10, -3 / (f * T60)));
      }
      for (let i = 0; i < x.length; i++) {
        let s = 0;
        for (let v = 0; v < nv; v++) {
          const line = lines[v];
          const r = line.read(ds[v]);
          lps[v] += (r - lps[v]) * lpa;
          const w = softclip((x[i] * 0.3 + lps[v] * fbs[v]) * drv) / drv;
          line.write(w);
          s += w;
        }
        y[i] = this.dc[c].process(s * norm);
      }
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-reso', FxmReso);
