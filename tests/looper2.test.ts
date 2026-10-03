import { render, sine, noise, stats, peakFreq, bandPower } from './harness';

const SR = 48000;
const src = (f = 440, secs = 4, amp = 0.5) => [sine(f, secs, amp)[0]];
const seg = (x: Float32Array, a: number, b: number) => x.subarray(Math.floor(a * SR), Math.floor(b * SR));

describe('stretch glide', () => {
  it('tape: speed eases to the new stretch instead of jumping', () => {
    const { out } = render('fxm-looper', null, 5, {
      channels: src(440, 4),
      params: { engine: 'tape', stretch: 1, glide: 1 },
      messages: [[1, { type: 'params', params: { stretch: 2 } }]],
    });
    const early = peakFreq(out[0].subarray(Math.floor(1.02 * SR), Math.floor(1.02 * SR) + 8192), 380, 450, 1);
    const late = peakFreq(out[0].subarray(Math.floor(4.5 * SR) - 8192, Math.floor(4.5 * SR) + 8192), 200, 260, 0.5);
    expect(early).toBeGreaterThan(400); // still near 440, not already at 220
    expect(early).toBeLessThan(445);
    expect(late).toBeGreaterThan(215);
    expect(late).toBeLessThan(235);
  });
  it('tape: with no glide the change is immediate', () => {
    const { out } = render('fxm-looper', null, 3, {
      channels: src(440, 4),
      params: { engine: 'tape', stretch: 1, glide: 0 },
      messages: [[1, { type: 'params', params: { stretch: 2 } }]],
    });
    const f = peakFreq(out[0].subarray(Math.floor(1.2 * SR), Math.floor(1.2 * SR) + 16384), 200, 260, 0.5);
    expect(Math.abs(f - 220)).toBeLessThan(4);
  });
  it('spectral and granular glide run clean through a big change', () => {
    for (const engine of ['spectral', 'granular']) {
      const { out } = render('fxm-looper', null, 4, {
        channels: src(330, 3),
        params: { engine, stretch: 1, glide: 1.5 },
        messages: [[0.5, { type: 'params', params: { stretch: 1000 } }]],
      });
      const s = stats(out);
      expect(s.finite).toBe(true);
      expect(s.rms).toBeGreaterThan(0.02);
    }
  });
});

describe('tape controls', () => {
  const tape = (params: Record<string, number>, ch = src(440, 3), secs = 3) =>
    render('fxm-looper', null, secs, { channels: ch, params: { engine: 'tape', stretch: 1, ...params } }).out[0];

  it('wow moves the pitch around; without it the pitch is steady', () => {
    const spread = (x: Float32Array) => {
      const f = [0.5, 0.9, 1.3, 1.7, 2.1, 2.5].map((t) => peakFreq(x.subarray(Math.floor(t * SR), Math.floor(t * SR) + 8192), 420, 460, 0.25));
      return Math.max(...f) - Math.min(...f);
    };
    expect(spread(tape({ wow: 0 }))).toBeLessThan(1);
    expect(spread(tape({ wow: 1 }))).toBeGreaterThan(3);
  });
  it('flutter makes fast pitch wobble: it spreads energy around the tone', () => {
    const side = (x: Float32Array) => bandPower(seg(x, 0.5, 2.5), 440 + 22) + bandPower(seg(x, 0.5, 2.5), 440 - 22);
    expect(side(tape({ flutter: 1 }))).toBeGreaterThan(side(tape({ flutter: 0 })) * 5);
  });
  it('drive adds harmonics', () => {
    const h3 = (x: Float32Array) => bandPower(seg(x, 0.5, 2.5), 1320) / bandPower(seg(x, 0.5, 2.5), 440);
    expect(h3(tape({ drive: 1 }))).toBeGreaterThan(h3(tape({ drive: 0 })) * 20);
  });
  it('age rolls off the highs and leaves the lows', () => {
    const ch = [sine(8000, 3, 0.4)[0]];
    const hi = (age: number) => stats([seg(tape({ age }, ch), 0.5, 2.5)]).rms;
    expect(hi(1)).toBeLessThan(hi(0) * 0.15);
    const lo = (age: number) => stats([seg(tape({ age }), 0.5, 2.5)]).rms;
    expect(lo(1)).toBeGreaterThan(lo(0) * 0.9);
  });
  it('hiss is noise on top; zero is silent', () => {
    const z = [new Float32Array(SR)];
    expect(stats([tape({ hiss: 0 }, z, 1)]).peak).toBe(0);
    expect(stats([seg(tape({ hiss: 1 }, z, 1), 0.2, 1)]).rms).toBeGreaterThan(0.005);
  });
  it('freeze stops the motor with inertia: it winds down, then falls silent', () => {
    const x = render('fxm-looper', null, 4, {
      channels: src(440, 4),
      params: { engine: 'tape', stretch: 1, glide: 0.4 },
      messages: [[1, { type: 'params', params: { freeze: 1 } }]],
    }).out[0];
    expect(stats([seg(x, 0.5, 0.9)]).rms).toBeGreaterThan(0.2);
    expect(stats([seg(x, 3, 4)]).rms).toBeLessThan(0.01);
    expect(stats([x]).finite).toBe(true);
  });
  it('reports its real speed for the reel display', () => {
    const { messages } = render('fxm-looper', null, 1, { channels: src(440, 4), params: { engine: 'tape', stretch: 2 } });
    const pos = messages.filter((m) => (m as { type: string }).type === 'pos') as { r: number }[];
    expect(pos.length).toBeGreaterThan(5);
    expect(pos[pos.length - 1].r).toBeCloseTo(0.5, 2);
  });
});

describe('spectral controls', () => {
  const spec = (params: Record<string, number>, ch: Float32Array[], secs = 5) => render('fxm-looper', null, secs, { channels: ch, params: { engine: 'spectral', stretch: 6, window: 13, ...params } }).out[0];
  const two = [(() => { const a = sine(200, 4, 0.3)[0]; const b = sine(4000, 4, 0.3)[0]; return a.map((v, i) => v + b[i]); })()];

  it('tilt: positive brightens, negative darkens', () => {
    const ratio = (tilt: number) => {
      const x = seg(spec({ tilt }, two), 2, 5);
      return bandPower(x, 4000) / bandPower(x, 200);
    };
    const flat = ratio(0);
    expect(ratio(1)).toBeGreaterThan(flat * 3);
    expect(ratio(-1)).toBeLessThan(flat / 3);
  });
  it('contrast: sharpens a tone out of noise, and keeps the level', () => {
    const n = noise(4, 0.05)[0];
    const ch = [sine(1000, 4, 0.4)[0].map((v, i) => v + n[i])];
    const tonal = (c: number) => {
      const x = seg(spec({ contrast: c }, ch), 2, 5);
      const tone = bandPower(x, 1000);
      return tone / (stats([x]).rms ** 2);
    };
    expect(tonal(2.5)).toBeGreaterThan(tonal(1));
    expect(tonal(0.5)).toBeLessThan(tonal(1));
    const rms = (c: number) => stats([seg(spec({ contrast: c }, ch), 2, 5)]).rms;
    expect(rms(2.5)).toBeGreaterThan(rms(1) * 0.5);
    expect(rms(2.5)).toBeLessThan(rms(1) * 2);
  });
  it('smear (window) runs at every size without trouble', () => {
    for (const window of [11, 12, 13, 14, 15]) {
      const s = stats([spec({ window }, [noise(3, 0.3)[0]], 4)]);
      expect(s.finite).toBe(true);
      expect(s.rms).toBeGreaterThan(0.03);
    }
  });
  it('spread 0 makes the two ears identical (mono source)', () => {
    const o = render('fxm-looper', null, 3, { channels: [noise(3, 0.3)[0]], params: { engine: 'spectral', stretch: 4, spread: 0, window: 12 } }).out;
    let diff = 0;
    for (let i = SR; i < 2 * SR; i++) diff += Math.abs(o[0][i] - o[1][i]);
    expect(diff / SR).toBeLessThan(1e-4);
  });
});

describe('granular controls', () => {
  const gran = (params: Record<string, number>, secs = 3) => render('fxm-looper', null, secs, { channels: [noise(3, 0.3)[0]], params: { engine: 'granular', stretch: 4, ...params } });

  it('shape runs from percussive to smooth, both audible and finite', () => {
    for (const shape of [0, 0.5, 1]) {
      const s = stats(gran({ shape }).out);
      expect(s.finite).toBe(true);
      expect(s.rms).toBeGreaterThan(0.03);
    }
  });
  it('a percussive shape is spikier (higher crest factor) than a smooth one on steady noise', () => {
    const crest = (shape: number) => {
      const x = gran({ shape, grain: 200, density: 6 }).out[0].subarray(SR);
      const s = stats([x]);
      return s.peak / s.rms;
    };
    expect(crest(0)).toBeGreaterThan(crest(1));
  });
});

describe('keeping the playhead when audio is swapped', () => {
  it('a same-length swap with keep continues; without keep it restarts', () => {
    const n = 2 * SR;
    const ramp = new Float32Array(n).map((_, i) => i / n);
    const half = ramp.map((v) => v * 0.5);
    const run = (keep: boolean) =>
      render('fxm-looper', null, 1.5, {
        channels: [ramp],
        params: { engine: 'tape', stretch: 1 },
        messages: [[1, { type: 'buffer', channels: [half], keep }]],
      }).out[0];
    const kept = run(true)[Math.floor(1.02 * SR)];
    const restarted = run(false)[Math.floor(1.02 * SR)];
    expect(kept).toBeGreaterThan(0.2);
    expect(kept).toBeLessThan(0.3);
    expect(restarted).toBeLessThan(0.05);
  });
});
