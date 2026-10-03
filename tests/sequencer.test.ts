import { Sequencer, type SeqSettings } from '../src/music/sequencer';
import { MODES } from '../src/music/theory';

const base = (o: Partial<SeqSettings> = {}): SeqSettings => ({ scale: 'dorian', motion: 'drift', range: 2, chance: 1, chordSize: 0, seed: 5, ...o });
const run = (s: SeqSettings, n: number) => {
  const q = new Sequencer(s);
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) out.push(q.next()?.index ?? null);
  return out;
};

describe('sequencer', () => {
  it('is deterministic: same seed, same line; a different seed differs', () => {
    expect(run(base(), 60)).toEqual(run(base(), 60));
    expect(run(base({ seed: 6 }), 60)).not.toEqual(run(base(), 60));
  });
  for (const motion of ['drift', 'arp', 'markov', 'wander'] as const) {
    it(`${motion}: every note is in the scale and inside the range`, () => {
      for (const range of [1, 2, 3]) {
        const q = new Sequencer(base({ motion, range }));
        const steps = MODES.dorian.steps;
        for (let i = 0; i < 300; i++) {
          const st = q.next()!;
          expect(st.index).toBeGreaterThanOrEqual(0);
          expect(st.index).toBeLessThanOrEqual(steps.length * range);
          const pcs = steps.map((x) => x % 12);
          expect(pcs).toContain(st.semis % 12);
          expect(st.semis).toBeLessThanOrEqual(12 * range);
        }
      }
    });
  }
  it('chance 0 never plays; chance 1 always plays', () => {
    expect(run(base({ chance: 0 }), 50).every((x) => x === null)).toBe(true);
    expect(run(base({ chance: 1 }), 50).every((x) => x !== null)).toBe(true);
  });
  it('about half the ticks play at chance 0.5', () => {
    const played = run(base({ chance: 0.5 }), 600).filter((x) => x !== null).length;
    expect(played).toBeGreaterThan(240);
    expect(played).toBeLessThan(360);
  });
  it('a rest is a silent step: the arp keeps its place (chance only gates)', () => {
    const all = run(base({ chance: 1, motion: 'arp' }), 20);
    const gated = run(base({ chance: 0.5, motion: 'arp' }), 20);
    // when a gated tick plays, it plays the same note the ungated walk had at that tick
    gated.forEach((g, i) => g !== null && expect(g).toBe(all[i]));
  });
  it('arp climbs in thirds and bounces at the top and bottom', () => {
    const r = run(base({ motion: 'arp', range: 1 }), 14) as number[];
    expect(r.slice(0, 4)).toEqual([2, 4, 6, 7]);
    expect(Math.max(...r)).toBeLessThanOrEqual(7);
    expect(r.some((v, i) => i > 0 && v < r[i - 1])).toBe(true);
  });
  it('markov prefers the tonic and fifth to the tense degrees', () => {
    const q = new Sequencer(base({ motion: 'markov', range: 1 }));
    const hits = new Array(7).fill(0);
    for (let i = 0; i < 4000; i++) hits[q.next()!.degree]++;
    expect(hits[0] + hits[4]).toBeGreaterThan(hits[1] + hits[6]);
  });
  it('wander moves smoothly (no big leaps)', () => {
    const r = run(base({ motion: 'wander', range: 3 }), 200) as number[];
    const maxLeap = Math.max(...r.slice(1).map((v, i) => Math.abs(v - r[i])));
    expect(maxLeap).toBeLessThanOrEqual(3);
  });
  it('hold never steps; set() jumps to a tapped note', () => {
    const q = new Sequencer(base({ motion: 'hold' }));
    expect(q.next()).toBeNull();
    expect(q.set(4).index).toBe(4);
    expect(q.next()).toBeNull();
    expect(q.index).toBe(4);
  });
  it('stacks scale thirds when asked: dorian triad on the tonic = minor', () => {
    const q = new Sequencer(base({ chordSize: 3 }));
    expect(q.describe(0).offsets).toEqual([0, 3, 7]);
    expect(q.describe(4).offsets).toEqual([0, 3, 7]); // v in dorian = minor
    expect(q.describe(3).offsets).toEqual([0, 4, 7]); // IV in dorian = major
    expect(new Sequencer(base({ chordSize: 0 })).describe(0).offsets).toBeNull();
  });
  it('reseed restarts the line from the tonic', () => {
    const q = new Sequencer(base());
    for (let i = 0; i < 10; i++) q.next();
    q.reseed(5);
    const again = new Sequencer(base());
    expect(q.next()?.index).toBe(again.next()?.index);
  });
});
