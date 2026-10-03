/*
 * Master safety limiter. Not optional, not bypassable, not adjustable from
 * the UI: everything the students make passes through it.
 *
 *  - DC blocker (fold/rectify/bias effects can leave a large offset)
 *  - 5 ms look-ahead peak limiter, fast attack, 120 ms release
 *  - a hard clamp at the ceiling after it, as the final guarantee
 *  - non-finite input is replaced by silence and reported
 *
 * It reports gain reduction and peak level to the UI ~20 times a second, so
 * the app can show when the limiter is working hard.
 */

class FxmSafety extends FxBase {
  constructor(options) {
    super(options);
    this.la = Math.max(16, Math.round(0.005 * this.sr));
    this.dl = [new Float32Array(this.la), new Float32Array(this.la)];
    this.di = 0;
    this.dc = [new DCBlock(), new DCBlock()];
    this.held = 0;
    this.hold = 0;
    this.gain = 1;
    this.att = 1 - Math.exp(-5 / this.la);
    this.rel = 1 - Math.exp(-1 / (0.12 * this.sr));
    this.repIn = 0;
    this.maxGr = 0;
    this.peak = 0;
    this.limitedSamples = 0;
    this.bad = false;
  }
  static get defaults() {
    return { ceiling: -1 };
  }
  reset() {
    this.dl[0].fill(0);
    this.dl[1].fill(0);
    this.dc[0].reset();
    this.dc[1].reset();
    this.held = 0;
    this.hold = 0;
    this.gain = 1;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const oL = out[0];
    const oR = out[1] || out[0];
    const ceil = dbToLin(Math.min(-0.1, this.p.ceiling));
    const la = this.la;
    let bad = false;
    for (let i = 0; i < oL.length; i++) {
      let l = xL[i];
      let r = xR[i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) {
        l = 0;
        r = 0;
        bad = true;
      }
      l = this.dc[0].process(l);
      r = this.dc[1].process(r);
      const pk = Math.max(Math.abs(l), Math.abs(r));
      if (pk >= this.held) {
        this.held = pk;
        this.hold = la;
      } else if (this.hold > 0) this.hold--;
      else this.held += (pk - this.held) * this.rel;
      const target = this.held > ceil ? ceil / this.held : 1;
      this.gain += (target - this.gain) * (target < this.gain ? this.att : this.rel);
      // delayed signal × gain, then the brick wall
      const dL = this.dl[0][this.di];
      const dR = this.dl[1][this.di];
      this.dl[0][this.di] = l;
      this.dl[1][this.di] = r;
      this.di = (this.di + 1) % la;
      let yl = dL * this.gain;
      let yr = dR * this.gain;
      if (yl > ceil) yl = ceil;
      else if (yl < -ceil) yl = -ceil;
      if (yr > ceil) yr = ceil;
      else if (yr < -ceil) yr = -ceil;
      oL[i] = yl;
      if (oR !== oL) oR[i] = yr;
      const a = Math.max(Math.abs(yl), Math.abs(yr));
      if (a > this.peak) this.peak = a;
      if (this.gain < this.maxGr || this.maxGr === 0) this.maxGr = this.gain;
      if (this.gain < 0.7) this.limitedSamples++;
    }
    if (bad) this.reset();
    if (bad && this.frame - this.lastBlowup > this.sr) {
      this.lastBlowup = this.frame;
      this.port.postMessage({ type: 'blowup' });
    }
    this.frame += oL.length;
    this.repIn -= oL.length;
    if (this.repIn <= 0) {
      this.repIn = Math.round(this.sr / 20);
      this.port.postMessage({
        type: 'meter',
        gr: 20 * Math.log10(Math.max(1e-6, this.maxGr || 1)),
        peak: 20 * Math.log10(Math.max(1e-6, this.peak)),
        limited: this.limitedSamples,
      });
      this.maxGr = 0;
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('fxm-safety', FxmSafety);
