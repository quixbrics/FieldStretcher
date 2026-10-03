import { TARGET_PEAK, computePeaks, concat, layerInto, normalise, peakOf, prepareLoop, toMono } from '../src/audio/loopfx';

const SR = 48000;
const tone = (secs: number, amp: number, dc = 0, f = 220) => {
  const a = new Float32Array(Math.floor(secs * SR));
  for (let i = 0; i < a.length; i++) a[i] = dc + amp * Math.sin((2 * Math.PI * f * i) / SR);
  return a;
};
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('prepareLoop (a take, as recorded — the level is NOT changed)', () => {
  it('rejects takes under a quarter second', () => {
    expect(prepareLoop([tone(0.1, 0.5)], SR)).toEqual({ ok: false, reason: 'short' });
  });
  it('refuses a silent take', () => {
    expect(prepareLoop([tone(2, 0.0004)], SR)).toEqual({ ok: false, reason: 'quiet' });
  });
  it('does not normalise: a quiet take stays quiet', () => {
    const r = prepareLoop([tone(2, 0.02)], SR);
    if (!r.ok) throw new Error('rejected');
    expect(peak(r.chans[0])).toBeGreaterThan(0.015);
    expect(peak(r.chans[0])).toBeLessThan(0.025);
  });
  it('does not turn a loud take down either', () => {
    const r = prepareLoop([tone(2, 0.95)], SR);
    if (!r.ok) throw new Error('rejected');
    expect(peak(r.chans[0])).toBeGreaterThan(0.9);
  });
  it('removes DC offset', () => {
    const r = prepareLoop([tone(2, 0.3, 0.2)], SR);
    if (!r.ok) throw new Error('rejected');
    const mean = r.chans[0].reduce((s, v) => s + v, 0) / r.chans[0].length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
  });
  it('crossfades the seam: no click where the loop wraps', () => {
    const raw = tone(1.013, 0.4);
    const r = prepareLoop([raw], SR);
    if (!r.ok) throw new Error('rejected');
    const d = r.chans[0];
    expect(d.length).toBeLessThan(raw.length);
    expect(Math.abs(d[0] - d[d.length - 1])).toBeLessThan(0.08);
  });
  it('keeps a stereo take stereo, each channel with its own seam', () => {
    const r = prepareLoop([tone(1, 0.4, 0, 220), tone(1, 0.2, 0, 330)], SR);
    if (!r.ok) throw new Error('rejected');
    expect(r.chans.length).toBe(2);
    expect(r.chans[0].length).toBe(r.chans[1].length);
    expect(peak(r.chans[0])).toBeGreaterThan(peak(r.chans[1]) * 1.5);
  });
});

describe('normalise (only when asked)', () => {
  it('brings a quiet take to −3 dBFS', () => {
    const r = normalise([tone(1, 0.02)]);
    if (!r.ok) throw new Error('refused');
    expect(peak(r.chans[0])).toBeCloseTo(TARGET_PEAK, 3);
    expect(r.gainDb).toBeCloseTo(20 * Math.log10(TARGET_PEAK / 0.02), 1);
  });
  it('uses one gain for both channels, so the stereo balance is kept', () => {
    const r = normalise([tone(1, 0.04), tone(1, 0.01, 0, 330)]);
    if (!r.ok) throw new Error('refused');
    expect(peak(r.chans[0]) / peak(r.chans[1])).toBeCloseTo(4, 1);
    expect(peakOf(r.chans)).toBeCloseTo(TARGET_PEAK, 3);
  });
  it('caps the boost at +40 dB and refuses silence', () => {
    const r = normalise([tone(1, 0.003)]);
    if (!r.ok) throw new Error('refused');
    expect(r.gainDb).toBeLessThanOrEqual(40.01);
    expect(normalise([tone(1, 0.0005)]).ok).toBe(false);
  });
  it('does not change the original', () => {
    const a = tone(0.5, 0.02);
    const before = peak(a);
    normalise([a]);
    expect(peak(a)).toBe(before);
  });
});

describe('layerInto (overdub and dub)', () => {
  it('adds the new audio at the offset, leaving the rest untouched', () => {
    const dst = Float32Array.of(1, 1, 1, 1, 1, 1);
    layerInto(dst, Float32Array.of(0.5, 0.5), 2, 1);
    expect(Array.from(dst)).toEqual([1, 1, 1.5, 1.5, 1, 1]);
  });
  it('wraps round the end of the loop', () => {
    const dst = new Float32Array(4);
    layerInto(dst, Float32Array.of(1, 2, 3), 3, 1);
    expect(Array.from(dst)).toEqual([2, 3, 0, 1]);
  });
  it('keep < 1 fades the old audio under the layer, and only there', () => {
    const dst = Float32Array.of(1, 1, 1, 1);
    layerInto(dst, Float32Array.of(0, 0), 1, 0.5);
    expect(Array.from(dst)).toEqual([1, 0.5, 0.5, 1]);
  });
  it('a layer longer than the loop passes over it twice, the old audio decaying each time', () => {
    const dst = Float32Array.of(1, 1);
    layerInto(dst, new Float32Array(4), 0, 0.5);
    expect(Array.from(dst)).toEqual([0.25, 0.25]);
  });
  it('keep 0 replaces, 1 sums', () => {
    const a = Float32Array.of(1, 1);
    layerInto(a, Float32Array.of(2, 2), 0, 0);
    expect(Array.from(a)).toEqual([2, 2]);
    const b = Float32Array.of(1, 1);
    layerInto(b, Float32Array.of(2, 2), 0, 1);
    expect(Array.from(b)).toEqual([3, 3]);
  });
});

describe('helpers', () => {
  it('computePeaks bins the maximum, and takes the louder channel of a stereo loop', () => {
    const p = computePeaks([Float32Array.from([0, 0.5, -0.9, 0.1, 0, 0, 0.2, 0])], 4);
    expect(Array.from(p).map((v) => +v.toFixed(2))).toEqual([0.5, 0.9, 0, 0.2]);
    const st = computePeaks([Float32Array.from([0.1, 0.1, 0.1, 0.1]), Float32Array.from([0, 0.8, 0, 0])], 2);
    expect(Array.from(st).map((v) => +v.toFixed(2))).toEqual([0.1, 0.1].map((_, i) => (i === 0 ? 0.8 : 0.1)));
  });
  it('concat and toMono', () => {
    expect(Array.from(concat([Float32Array.of(1, 2), Float32Array.of(3)]))).toEqual([1, 2, 3]);
    expect(Array.from(toMono([Float32Array.of(1, 1), Float32Array.of(0, -1)]))).toEqual([0.5, 0]);
  });
});
