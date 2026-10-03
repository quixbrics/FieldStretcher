import { render, noise, stats, peakFreq } from './harness';

const SR = 48000;
/** a noise burst then silence, stereo */
const burst = (burstSec: number, totalSec: number) => {
  const n = noise(burstSec, 0.5);
  const L = new Float32Array(Math.floor(totalSec * SR));
  L.set(n[0]);
  return [L, L.slice()];
};
const impulse = (totalSec: number) => {
  const L = new Float32Array(Math.floor(totalSec * SR));
  L[0] = 1;
  return [L, L.slice()];
};

describe('resonator', () => {
  it('rings at the note it is told (A3 = 220 Hz, single string)', () => {
    const { out } = render('fxm-reso', burst(0.3, 3), 3, { params: { note: 57, chord: 0, decay: 0.8 } });
    const f = peakFreq(out[0].subarray(SR), 190, 250, 0.5);
    expect(Math.abs(f - 220)).toBeLessThan(2.5);
  });
  it('follows a continuous MIDI pitch (A4 = 440 Hz)', () => {
    const { out } = render('fxm-reso', burst(0.3, 3), 3, { params: { note: 69, chord: 0, decay: 0.8 } });
    const f = peakFreq(out[0].subarray(SR), 400, 480, 0.5);
    expect(Math.abs(f - 440)).toBeLessThan(4);
  });
  it('a fifths chord rings the fifth as well as the root', () => {
    const { out } = render('fxm-reso', burst(0.3, 3), 3, { params: { note: 57, chord: 2, decay: 0.8 } });
    const f = peakFreq(out[0].subarray(SR), 320, 345, 0.5); // 220 × 1.5 = 330
    expect(Math.abs(f - 330)).toBeLessThan(4);
  });
  it('glides to a new note instead of jumping, then arrives', () => {
    // continuous noise in, note A3 → A4 at 1 s with a 0.6 s glide
    const inp = noise(6, 0.3);
    const { out } = render('fxm-reso', inp, 6, {
      params: { note: 57, chord: 0, decay: 0.6, glide: 0.6 },
      messages: [[1, { type: 'params', params: { note: 69 } }]],
    });
    const early = peakFreq(out[0].subarray(Math.floor(1.15 * SR), Math.floor(1.15 * SR) + 16384), 150, 500, 1);
    const late = peakFreq(out[0].subarray(Math.floor(5 * SR)), 400, 480, 0.5);
    expect(early).toBeGreaterThan(215);
    expect(early).toBeLessThan(380); // still on its way
    expect(Math.abs(late - 440)).toBeLessThan(5);
  });
  it('stays finite at the longest decay and brightest settings', () => {
    const { out } = render('fxm-reso', noise(4, 0.9), 4, { params: { note: 36, chord: 6, decay: 1, bright: 1, drive: 1 } });
    const s = stats(out);
    expect(s.finite).toBe(true);
    expect(s.peak).toBeLessThan(8);
  });
  it('custom offsets from a sequencer replace the chord shape', () => {
    const { out } = render('fxm-reso', burst(0.3, 3), 3, {
      params: { note: 57, chord: 0, decay: 0.8 },
      messages: [[0, { type: 'offsets', offsets: [0, 7] }]],
    });
    const f = peakFreq(out[0].subarray(SR), 320, 345, 0.5);
    expect(Math.abs(f - 330)).toBeLessThan(4);
  });
});

describe('resonator plucks', () => {
  const silent = () => [new Float32Array(SR * 3), new Float32Array(SR * 3)];
  const rms = (x: Float32Array, a: number, b: number) => stats([x.subarray(Math.floor(a * SR), Math.floor(b * SR))]).rms;

  it('decay goes down to a 20 ms pluck: a short decay dies away fast, a long one rings', () => {
    const run = (decay: number) =>
      render('fxm-reso', silent(), 3, { params: { note: 57, chord: 0, decay, pluck: 1, input: 0 }, messages: [[0.5, { type: 'params', params: { note: 60 } }]] }).out[0];
    const short = run(0.1);
    const long = run(0.9);
    expect(rms(short, 0.5, 0.56)).toBeGreaterThan(0.005); // there is a pluck…
    expect(rms(short, 1.5, 2)).toBeLessThan(rms(short, 0.5, 0.56) * 0.05); // …that is gone within a second
    expect(rms(long, 1.5, 2)).toBeGreaterThan(rms(short, 1.5, 2) * 20);
  });
  it('a note change plucks the strings with no audio coming in; a repeat of the same note does not', () => {
    const { out } = render('fxm-reso', silent(), 3, {
      params: { note: 57, chord: 0, decay: 0.45, pluck: 0.8, input: 0 },
      messages: [[0.5, { type: 'params', params: { note: 60 } }], [1.5, { type: 'params', params: { note: 60 } }], [2.0, { type: 'params', params: { note: 64 } }]],
    });
    expect(rms(out[0], 0.2, 0.45)).toBe(0);
    expect(rms(out[0], 0.5, 0.7)).toBeGreaterThan(0.005);
    expect(rms(out[0], 1.5, 1.52)).toBeLessThan(rms(out[0], 0.5, 0.52)); // not re-plucked at 1.5
    expect(rms(out[0], 2.0, 2.1)).toBeGreaterThan(rms(out[0], 1.9, 1.99) * 1.5); // plucked again at 2.0
  });
  it('Pluck at 0 leaves a note change silent when nothing is coming in', () => {
    const { out } = render('fxm-reso', silent(), 2, { params: { note: 57, chord: 0, pluck: 0, input: 0 }, messages: [[0.5, { type: 'params', params: { note: 62 } }]] });
    expect(stats(out).peak).toBe(0);
  });
  it('Onset plucks on hits in the input even with the input itself muted', () => {
    const x = silent();
    for (const t of [0.5, 1.2, 2.0]) for (let i = 0; i < 400; i++) (x[0][Math.floor(t * SR) + i] = 0.8 * Math.exp(-i / 60) * (i % 2 ? 1 : -1)), (x[1][Math.floor(t * SR) + i] = x[0][Math.floor(t * SR) + i]);
    const off = render('fxm-reso', x, 3, { params: { note: 57, chord: 0, decay: 0.4, onset: 0, pluck: 0.5, input: 0 } }).out[0];
    const on = render('fxm-reso', x, 3, { params: { note: 57, chord: 0, decay: 0.4, onset: 0.8, pluck: 0.5, input: 0 } }).out[0];
    expect(stats([off]).peak).toBe(0);
    for (const t of [0.5, 1.2, 2.0]) expect(rms(on, t + 0.01, t + 0.15)).toBeGreaterThan(0.003);
    expect(rms(on, 0.2, 0.45)).toBe(0);
  });
  it('Input scales how much audio rings the strings', () => {
    const run = (input: number) => rms(render('fxm-reso', noise(2, 0.3), 2, { params: { note: 57, chord: 0, decay: 0.5, input } }).out[0], 1, 2);
    expect(run(1)).toBeGreaterThan(run(0.25) * 2);
    expect(run(0)).toBe(0);
  });
  it('a queued note sounds at its frame, not before, at the right pitch', () => {
    const { out } = render('fxm-reso', silent(), 3, {
      params: { note: 57, chord: 0, decay: 0.8, pluck: 1, input: 0, glide: 0.01 },
      messages: [[0, { type: 'note', frame: Math.round(1.0 * SR), note: 69, offsets: null }]],
    });
    expect(rms(out[0], 0.2, 0.95)).toBe(0);
    expect(rms(out[0], 1.0, 1.3)).toBeGreaterThan(0.005);
    const f = peakFreq(out[0].subarray(Math.floor(1.1 * SR), Math.floor(2.1 * SR)), 400, 480, 0.5);
    expect(Math.abs(f - 440)).toBeLessThan(5);
  });
  it('clear drops queued notes', () => {
    const { out } = render('fxm-reso', silent(), 3, {
      params: { note: 57, chord: 0, pluck: 1, input: 0 },
      messages: [[0, { type: 'note', frame: Math.round(1.5 * SR), note: 69 }], [0.5, { type: 'clear' }]],
    });
    expect(stats(out).peak).toBe(0);
  });
  it('a queued note can carry its own chord offsets', () => {
    const { out } = render('fxm-reso', silent(), 3, {
      params: { note: 57, chord: 0, decay: 0.8, pluck: 1, input: 0, glide: 0.01 },
      messages: [[0, { type: 'note', frame: Math.round(0.5 * SR), note: 57, offsets: [0, 7] }], [0, { type: 'note', frame: Math.round(0.6 * SR), note: 58, offsets: [0, 7] }]],
    });
    const f = peakFreq(out[0].subarray(Math.floor(1.2 * SR), Math.floor(2.2 * SR)), 335, 360, 0.5); // 233.1 × 1.5 = 349.7
    expect(Math.abs(f - 349.7)).toBeLessThan(4);
  });
});

describe('delay', () => {
  it('first echo arrives at the delay time (100 ms), and nothing before it', () => {
    const { out } = render('fxm-delay', impulse(1), 1, { params: { timeL: 100, timeR: 100, feedback: 0, drive: 0, wobble: 0, lowcut: 10, highcut: 20000 } });
    const at = 0.1 * SR;
    const before = Math.max(...out[0].subarray(100, at - 50).map(Math.abs));
    const peak = Math.max(...out[0].subarray(at - 50, at + 50).map(Math.abs));
    expect(before).toBeLessThan(0.01);
    expect(peak).toBeGreaterThan(0.3);
  });
  it('feedback near the maximum stays bounded', () => {
    const { out } = render('fxm-delay', noise(3, 0.5), 6, { params: { feedback: 1.3, drive: 1 } });
    const s = stats(out);
    expect(s.finite).toBe(true);
    expect(s.peak).toBeLessThan(4);
  });
});

describe('reverb', () => {
  it('has a tail that decays, and stays finite', () => {
    const { out } = render('fxm-fdn', impulse(8), 8, { params: { size: 1, decay: 3, shimmer: 0 } });
    const rms = (a: number, b: number) => stats([out[0].subarray(a * SR, b * SR)]).rms;
    expect(stats(out).finite).toBe(true);
    expect(rms(0.2, 1)).toBeGreaterThan(rms(5, 6));
    expect(rms(0.2, 1)).toBeGreaterThan(0);
  });
  it('freeze holds the tail', () => {
    const x = burst(0.3, 8);
    const { out } = render('fxm-fdn', x, 8, {
      params: { size: 1, decay: 2, shimmer: 0 },
      messages: [[0.6, { type: 'params', params: { freeze: 1 } }]],
    });
    const rms = (a: number, b: number) => stats([out[0].subarray(a * SR, b * SR)]).rms;
    expect(rms(6, 7)).toBeGreaterThan(rms(1, 2) * 0.25);
  });
  it('shimmer at the maximum stays bounded', () => {
    const { out } = render('fxm-fdn', noise(2, 0.5), 8, { params: { decay: 30, shimmer: 1, size: 2 } });
    const s = stats(out);
    expect(s.finite).toBe(true);
    expect(s.peak).toBeLessThan(10);
  });
});
