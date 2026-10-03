import { planSequence, type SeqSettings } from '../src/music/sequencer';
import { SCENES } from '../src/io/scenes';
import { TRACKS, defaultSound, focusToContrast } from '../src/audio/engine';
import { deleteUserScene, loadUserScenes, saveUserScene } from '../src/io/userScenes';

// a minimal localStorage for Node
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const s = (o: Partial<SeqSettings> = {}): SeqSettings => ({ scale: 'dorian', motion: 'drift', range: 2, chance: 1, chordSize: 0, seed: 4, ...o });

describe('planSequence (the notes an offline render hands the resonator)', () => {
  it('starts with the tonic at 50 ms, then one tick per step, all inside the render', () => {
    const plan = planSequence(s(), 2, 10, 57, 48000);
    expect(plan[0].frame).toBe(Math.round(0.05 * 48000));
    expect(plan[0].note).toBe(57);
    expect(plan.length).toBe(5); // 0.05, 2.05, 4.05, 6.05, 8.05
    expect(plan.every((n, i) => i === 0 || n.frame - plan[i - 1].frame === 2 * 48000)).toBe(true);
    expect(plan.every((n) => n.frame < 10 * 48000)).toBe(true);
  });
  it('is the same every time, and a different seed gives a different line', () => {
    const a = planSequence(s(), 0.5, 30, 57, 48000).map((n) => n.note);
    expect(planSequence(s(), 0.5, 30, 57, 48000).map((n) => n.note)).toEqual(a);
    expect(planSequence(s({ seed: 5 }), 0.5, 30, 57, 48000).map((n) => n.note)).not.toEqual(a);
  });
  it('stays in the scale and range, and carries chord offsets when asked', () => {
    const plan = planSequence(s({ chordSize: 3 }), 0.4, 60, 57, 48000);
    const pcs = [0, 2, 3, 5, 7, 9, 10]; // dorian
    for (const n of plan) {
      expect(pcs).toContain((n.note - 57) % 12);
      expect(n.note - 57).toBeLessThanOrEqual(24);
      expect(n.offsets).toHaveLength(3);
    }
  });
  it('rests (chance < 1) leave gaps, not shifted times', () => {
    const plan = planSequence(s({ chance: 0.4 }), 1, 60, 57, 48000);
    expect(plan.length).toBeLessThan(40);
    expect(plan.every((n) => (n.frame - Math.round(0.05 * 48000)) % 48000 === 0)).toBe(true);
  });
});

describe('stock scenes', () => {
  it('have names, blurbs, at most one entry per track, and settings in range', () => {
    expect(new Set(SCENES.map((x) => x.name)).size).toBe(SCENES.length);
    for (const sc of SCENES) {
      expect(sc.blurb.length).toBeGreaterThan(10);
      expect(sc.tracks.length).toBeLessThanOrEqual(TRACKS);
      for (const t of sc.tracks) {
        if (t.stretch !== undefined) expect(t.stretch).toBeGreaterThanOrEqual(1);
        if (t.send !== undefined) expect(t.send).toBeLessThanOrEqual(1);
        const d = defaultSound();
        for (const kind of ['tape', 'spectral', 'granular'] as const)
          for (const k of Object.keys(t.sound?.[kind] ?? {})) expect(Object.keys(d[kind])).toContain(k);
      }
    }
  });
  it('Just Loops sends nothing to the FX and does not stretch', () => {
    const j = SCENES.find((x) => x.name === 'Just Loops')!;
    expect(j.tracks.every((t) => t.send === 0 && t.stretch === 1 && t.engine === 'tape')).toBe(true);
  });
  it('focus maps 0 → diffuse, 0.5 → unchanged, 1 → tonal', () => {
    expect(focusToContrast(0)).toBeCloseTo(0.5);
    expect(focusToContrast(0.5)).toBe(1);
    expect(focusToContrast(1)).toBeCloseTo(2.5);
  });
});

describe('your own scenes', () => {
  const mk = (name: string) => ({ name, blurb: 'x', tracks: [{ stretch: 3 }], fx: {} });
  beforeEach(() => store.clear());
  it('save, list, replace by name, delete', () => {
    expect(loadUserScenes()).toEqual([]);
    expect(saveUserScene(mk('One'))).toBe(true);
    expect(saveUserScene(mk('Two'))).toBe(true);
    expect(saveUserScene({ ...mk('One'), blurb: 'changed' })).toBe(true);
    const list = loadUserScenes();
    expect(list.map((x) => x.name)).toEqual(['Two', 'One']);
    expect(list.find((x) => x.name === 'One')!.blurb).toBe('changed');
    expect(list.every((x) => x.user)).toBe(true);
    deleteUserScene('Two');
    expect(loadUserScenes().map((x) => x.name)).toEqual(['One']);
  });
  it('refuses an empty name and survives damaged storage', () => {
    expect(saveUserScene(mk('   '))).toBe(false);
    store.set('fieldstretcher.scenes', '{not json');
    expect(loadUserScenes()).toEqual([]);
    store.set('fieldstretcher.scenes', JSON.stringify([{ nope: true }, mk('Ok')]));
    expect(loadUserScenes().map((x) => x.name)).toEqual(['Ok']);
  });
});
