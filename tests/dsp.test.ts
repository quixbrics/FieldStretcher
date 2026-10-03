import { render, sine, noise, stats, peakFreq } from './harness';

describe('looper engines (mono source, as recorded on a phone)', () => {
  const src = [sine(440, 4, 0.5)[0]];
  for (const engine of ['spectral', 'granular', 'tape']) {
    it(`${engine}: finite, audible, not crazy loud`, () => {
      const { out } = render('fxm-looper', null, 6, { channels: src, params: { engine, stretch: 50, window: 13 } });
      const s = stats(out);
      expect(s.finite).toBe(true);
      expect(s.rms).toBeGreaterThan(0.05);
      expect(s.peak).toBeLessThan(3);
    });
  }
  it('spectral pitch +12 doubles the frequency, independent of stretch', () => {
    const { out } = render('fxm-looper', null, 5, { channels: src, params: { engine: 'spectral', stretch: 200, pitch: 12, window: 13 } });
    const f = peakFreq(out[0].subarray(48000 * 2), 600, 1100, 5);
    expect(Math.abs(f - 880)).toBeLessThan(22);
  });
  it('tape: stretch 2 halves the pitch', () => {
    const { out } = render('fxm-looper', null, 2, { channels: src, params: { engine: 'tape', stretch: 2 } });
    const f = peakFreq(out[0].subarray(24000), 150, 300, 1);
    expect(Math.abs(f - 220)).toBeLessThan(4);
  });
  it('spectral 1000x at the heaviest quality keeps level close to the source', () => {
    const { out } = render('fxm-looper', null, 8, { channels: [noise(3, 0.3)[0]], params: { engine: 'spectral', stretch: 1000, window: 15 } });
    const s = stats([out[0].subarray(48000 * 3), out[1].subarray(48000 * 3)]);
    expect(s.rms).toBeGreaterThan(0.3 * 0.5);
    expect(s.rms).toBeLessThan(0.3 * 2);
  });
  it('a loop window and reverse run clean', () => {
    const { out } = render('fxm-looper', null, 3, { channels: [noise(3)[0]], params: { engine: 'granular', reverse: 1, start: 0.3, end: 0.5 } });
    expect(stats(out).finite).toBe(true);
  });
});

describe('live buffer swap', () => {
  it('is silent while empty, then plays the recording sent to it', () => {
    const rec = sine(330, 2, 0.5)[0];
    const { out } = render('fxm-looper', null, 3, {
      params: { engine: 'tape', stretch: 1 },
      messages: [[1, { type: 'buffer', channels: [rec] }]],
    });
    expect(stats([out[0].subarray(0, 40000)]).peak).toBe(0);
    expect(stats([out[0].subarray(48000 + 4800)]).rms).toBeGreaterThan(0.2);
  });
  it('goes silent again when cleared', () => {
    const rec = sine(330, 2, 0.5)[0];
    const { out } = render('fxm-looper', null, 3, {
      channels: [rec],
      params: { engine: 'tape', stretch: 1 },
      messages: [[1, { type: 'buffer', channels: [] }]],
    });
    expect(stats([out[0].subarray(48000 + 128)]).peak).toBe(0);
  });
  it('survives a new buffer shorter than the old read position', () => {
    const { out } = render('fxm-looper', null, 6, {
      channels: [sine(220, 10, 0.5)[0]],
      params: { engine: 'spectral', stretch: 5, window: 12 },
      messages: [[4, { type: 'buffer', channels: [sine(330, 0.3, 0.5)[0]] }]],
    });
    expect(stats(out).finite).toBe(true);
  });
});

describe('capture', () => {
  it('collects only what is between rec on and rec off, bit-exact', () => {
    const x = sine(200, 1, 0.4);
    const { messages } = render('fs-capture', [x[0]], 1, {
      messages: [
        [0.2, { type: 'rec', on: true }],
        [0.7, { type: 'rec', on: false }],
      ],
    });
    const chunks = messages.filter((m) => (m as { type: string }).type === 'chunk') as { data: Float32Array }[];
    const got = new Float32Array(chunks.reduce((n, c) => n + c.data.length, 0));
    let o = 0;
    for (const c of chunks) (got.set(c.data, o), (o += c.data.length));
    // block-aligned start, so allow one block either way
    expect(Math.abs(got.length - 0.5 * 48000)).toBeLessThanOrEqual(256);
    const start = Math.round(0.2 * 48000 / 128) * 128;
    for (let i = 0; i < 500; i++) expect(got[i]).toBeCloseTo(x[0][start + i], 5);
    expect(messages.some((m) => (m as { type: string }).type === 'recStopped')).toBe(true);
  });
  it('reports input level, and turns NaN from the mic into silence', () => {
    const x = sine(200, 1, 0.5)[0];
    x[3000] = NaN;
    const { messages } = render('fs-capture', [x], 0.5, { messages: [[0, { type: 'rec', on: true }], [0.45, { type: 'rec', on: false }]] });
    const levels = messages.filter((m) => (m as { type: string }).type === 'level') as { peak: number }[];
    expect(levels.length).toBeGreaterThan(10);
    expect(Math.max(...levels.map((l) => l.peak))).toBeCloseTo(0.5, 1);
    const chunks = messages.filter((m) => (m as { type: string }).type === 'chunk') as { data: Float32Array }[];
    for (const c of chunks) for (const v of c.data) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('safety limiter', () => {
  it('never exceeds the ceiling, even at +30 dB', () => {
    const { out } = render('fxm-safety', sine(100, 2, 30), 2);
    expect(stats(out).peak).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
  });
  it('swallows NaN and reports it', () => {
    const x = sine(100, 1, 0.5);
    x[0][1000] = NaN;
    const { out, messages } = render('fxm-safety', x, 1);
    expect(stats(out).finite).toBe(true);
    expect(messages.some((m) => (m as { type: string }).type === 'blowup')).toBe(true);
  });
});
