import { TARGET_PEAK, computePeaks, concat, prepareLoop, toMono } from '../src/audio/loopfx';

const SR = 48000;
const tone = (secs: number, amp: number, dc = 0) => {
  const a = new Float32Array(Math.floor(secs * SR));
  for (let i = 0; i < a.length; i++) a[i] = dc + amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return a;
};
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('prepareLoop', () => {
  it('rejects takes under a quarter second', () => {
    expect(prepareLoop(tone(0.1, 0.5), SR)).toEqual({ ok: false, reason: 'short' });
  });
  it('refuses a silent take instead of boosting the noise floor', () => {
    expect(prepareLoop(tone(2, 0.0005), SR)).toEqual({ ok: false, reason: 'quiet' });
  });
  it('normalises a quiet phone take to −3 dBFS', () => {
    const r = prepareLoop(tone(2, 0.02), SR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(peak(r.data)).toBeLessThan(TARGET_PEAK * 1.001);
    if (r.ok) expect(peak(r.data)).toBeGreaterThan(TARGET_PEAK * 0.9);
  });
  it('stays at or under −3 dBFS even when the crossfade sums correlated tones', () => {
    const r = prepareLoop(tone(1.013, 0.05), SR);
    if (!r.ok) throw new Error('rejected');
    expect(peak(r.data)).toBeLessThanOrEqual(TARGET_PEAK * 1.0001);
  });
  it('removes DC offset', () => {
    const r = prepareLoop(tone(2, 0.3, 0.2), SR);
    if (!r.ok) throw new Error('rejected');
    const mean = r.data.reduce((s, v) => s + v, 0) / r.data.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
  });
  it('crossfades the seam: no click where the loop wraps', () => {
    // a take that ends mid-cycle, with a hard jump if looped naively
    const raw = tone(1.013, 0.4);
    const r = prepareLoop(raw, SR);
    if (!r.ok) throw new Error('rejected');
    const jump = Math.abs(r.data[0] - r.data[r.data.length - 1]);
    const naive = Math.abs(raw[0] - raw[raw.length - 1]);
    expect(r.data.length).toBeLessThan(raw.length);
    expect(jump).toBeLessThan(0.08);
    expect(jump).toBeLessThan(naive + 0.08);
  });
});

describe('helpers', () => {
  it('computePeaks bins the maximum', () => {
    const p = computePeaks(Float32Array.from([0, 0.5, -0.9, 0.1, 0, 0, 0.2, 0]), 4);
    expect(Array.from(p).map((v) => +v.toFixed(2))).toEqual([0.5, 0.9, 0, 0.2]);
  });
  it('concat and toMono', () => {
    expect(Array.from(concat([Float32Array.of(1, 2), Float32Array.of(3)]))).toEqual([1, 2, 3]);
    expect(Array.from(toMono([Float32Array.of(1, 1), Float32Array.of(0, -1)]))).toEqual([0.5, 0]);
  });
});
