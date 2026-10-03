import { wetDryGains, wetPathGain } from '../src/audio/graph';
import { MAX_STRETCH, MIN_STRETCH, effectivePitch, pitchOfStretch, stretchOfPitch } from '../src/audio/engine';
import { fmtSemis, fmtStretch, posFromStretch, stretchFromPos } from '../src/ui/dom';

describe('Wet / Dry', () => {
  it('all dry has no wet in it, and ALL WET HAS EXACTLY NO DRY', () => {
    expect(wetDryGains(0)).toEqual({ dry: 1, wet: 0 });
    expect(wetDryGains(1)).toEqual({ dry: 0, wet: 1 });
  });
  it('goes through equal power in the middle (−3 dB each, constant loudness)', () => {
    const m = wetDryGains(0.5);
    expect(m.dry).toBeCloseTo(Math.SQRT1_2, 5);
    expect(m.wet).toBeCloseTo(Math.SQRT1_2, 5);
    for (const w of [0.1, 0.3, 0.7, 0.9]) {
      const g = wetDryGains(w);
      expect(g.dry ** 2 + g.wet ** 2).toBeCloseTo(1, 6);
    }
  });
  it('is monotonic: more wet is never less wet, never more dry', () => {
    let prev = wetDryGains(0);
    for (let i = 1; i <= 100; i++) {
      const g = wetDryGains(i / 100);
      expect(g.wet).toBeGreaterThanOrEqual(prev.wet);
      expect(g.dry).toBeLessThanOrEqual(prev.dry);
      prev = g;
    }
  });
  it('clamps out-of-range values', () => {
    expect(wetDryGains(-3)).toEqual({ dry: 1, wet: 0 });
    expect(wetDryGains(7)).toEqual({ dry: 0, wet: 1 });
  });
  it('with every effect off there is no wet sound to hear, whatever the control says', () => {
    const off = { reso: false, delay: false, reverb: false };
    expect(wetPathGain(1, off)).toBe(0);
    expect(wetPathGain(0.5, off)).toBe(0);
    expect(wetPathGain(1, { ...off, reverb: true })).toBe(1);
    expect(wetPathGain(0, { ...off, delay: true })).toBe(0);
  });
});

describe('pitch and stretch are linked, as on a tape reel', () => {
  it('each doubling of the stretch is an octave down, and back', () => {
    expect(pitchOfStretch(1)).toBeCloseTo(0);
    expect(pitchOfStretch(2)).toBeCloseTo(-12);
    expect(pitchOfStretch(0.5)).toBeCloseTo(12);
    expect(pitchOfStretch(4)).toBeCloseTo(-24);
    for (const p of [-24, -12, -5, 0, 7, 12, 24]) expect(pitchOfStretch(stretchOfPitch(p))).toBeCloseTo(p, 6);
  });
  it('the pitch shown stays within ±24 however far the stretch goes', () => {
    expect(pitchOfStretch(1000)).toBe(-24);
    expect(pitchOfStretch(0.01)).toBe(24);
  });
  it('the stretch a pitch asks for stays inside the slider’s range', () => {
    expect(stretchOfPitch(-24)).toBeCloseTo(4);
    expect(stretchOfPitch(24)).toBeCloseTo(MIN_STRETCH);
    expect(stretchOfPitch(24)).toBeGreaterThanOrEqual(MIN_STRETCH);
    expect(stretchOfPitch(-100)).toBeLessThanOrEqual(MAX_STRETCH);
  });
  it('tape, linked: the speed is just 1 ÷ stretch (the pitch is NOT added on top)', () => {
    expect(effectivePitch({ engine: 'tape', link: true, stretch: 2, pitch: -12 })).toBe(0);
    expect(effectivePitch({ engine: 'tape', link: true, stretch: 1, pitch: 0 })).toBe(0);
  });
  it('spectral and granular, linked: the pitch follows the stretch like tape; unlinked: the pitch is its own', () => {
    expect(effectivePitch({ engine: 'spectral', link: true, stretch: 2, pitch: 5 })).toBeCloseTo(-12);
    expect(effectivePitch({ engine: 'granular', link: true, stretch: 0.5, pitch: 0 })).toBeCloseTo(12);
    expect(effectivePitch({ engine: 'spectral', link: false, stretch: 64, pitch: 3 })).toBe(3);
    expect(effectivePitch({ engine: 'tape', link: false, stretch: 4, pitch: -7 })).toBe(-7);
  });
});

describe('the stretch slider covers 0.25× to 1000×', () => {
  it('maps both ways, with 1× roughly a sixth of the way along a log scale', () => {
    expect(stretchFromPos(0)).toBeCloseTo(0.25);
    expect(stretchFromPos(1)).toBeCloseTo(1000);
    for (const s of [0.25, 0.5, 1, 4, 64, 1000]) expect(stretchFromPos(posFromStretch(s))).toBeCloseTo(s, 6);
    expect(posFromStretch(1)).toBeGreaterThan(0.1);
    expect(posFromStretch(1)).toBeLessThan(0.2);
  });
  it('reads sensibly', () => {
    expect(fmtStretch(0.5)).toBe('0.50×');
    expect(fmtStretch(1)).toBe('1.0×');
    expect(fmtStretch(64)).toBe('64×');
    expect(fmtSemis(-12)).toBe('−12 st');
    expect(fmtSemis(0)).toBe('0 st');
    expect(fmtSemis(7.4)).toBe('+7.4 st');
  });
});
