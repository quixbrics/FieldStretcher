import { BANDS, bandCentres, bandSpectrum, shapeSpectrum } from '../src/audio/analysis';
import { sine } from './harness';

const SR = 48000;
const argmax = (a: Float32Array) => a.reduce((b, v, i) => (v > a[b] ? i : b), 0);

describe('band spectrum', () => {
  it('puts a tone in the band that holds its frequency', () => {
    const c = bandCentres(SR);
    for (const f of [200, 1000, 5000]) {
      const sp = bandSpectrum(sine(f, 1, 0.5)[0], SR);
      expect(sp.length).toBe(BANDS);
      const k = argmax(sp);
      expect(Math.abs(Math.log2(c[k] / f))).toBeLessThan(0.2);
      expect(sp[k]).toBe(1);
    }
  });
  it('returns zeros for silence and for material shorter than one frame', () => {
    expect(Math.max(...bandSpectrum(new Float32Array(SR), SR))).toBe(0);
    expect(Math.max(...bandSpectrum(sine(440, 0.01, 0.5)[0], SR))).toBe(0);
  });
  it('only looks inside the loop window', () => {
    const a = sine(300, 1, 0.5)[0];
    const b = sine(3000, 1, 0.5)[0];
    const both = new Float32Array(a.length * 2);
    both.set(a);
    both.set(b, a.length);
    const c = bandCentres(SR);
    expect(Math.abs(Math.log2(c[argmax(bandSpectrum(both, SR, 0, 0.45))] / 300))).toBeLessThan(0.2);
    expect(Math.abs(Math.log2(c[argmax(bandSpectrum(both, SR, 0.55, 1))] / 3000))).toBeLessThan(0.2);
  });
});

describe('shaping, as the display does it', () => {
  const c = bandCentres(SR);
  const flat = new Float32Array(BANDS).fill(0.5);
  it('tilt brightens or darkens', () => {
    const up = shapeSpectrum(flat, c, 1, 1, 15);
    const down = shapeSpectrum(flat, c, -1, 1, 15);
    expect(up[BANDS - 1] / up[0]).toBeGreaterThan(1);
    expect(down[BANDS - 1] / down[0]).toBeLessThan(1);
  });
  it('contrast sharpens peaks and keeps the energy', () => {
    const peaky = Float32Array.from({ length: BANDS }, (_, i) => (i === 10 ? 1 : 0.3));
    const sharp = shapeSpectrum(peaky, c, 0, 2.5, 15);
    expect(sharp[10] / sharp[20]).toBeGreaterThan(peaky[10] / peaky[20]);
    const e = (a: Float32Array) => a.reduce((s, v) => s + v * v, 0);
    expect(e(sharp)).toBeCloseTo(e(peaky), 3);
  });
  it('a small window blurs the peak, a large one keeps it', () => {
    const peaky = Float32Array.from({ length: BANDS }, (_, i) => (i === 10 ? 1 : 0));
    expect(shapeSpectrum(peaky, c, 0, 1, 11)[10]).toBeLessThan(shapeSpectrum(peaky, c, 0, 1, 15)[10]);
  });
});
