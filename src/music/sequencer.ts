/*
 * The generative sequencer: a seeded walk through a scale that decides which
 * note the resonator rings next. Pure and deterministic — the same seed and
 * settings always give the same line — so it is unit-tested and the engine
 * only has to ask for the next step and schedule it.
 *
 * Position is a scale-degree INDEX counted up from the tonic (0 = tonic in the
 * base octave, scale.length = the tonic an octave up …), limited to `range`
 * octaves.
 */
import { MODES, scaleNote, stackChord, type ModeId } from './theory';
import { hashSeed, mulberry32, weighted, clamp, type Rng } from './rng';

export type Motion = 'drift' | 'arp' | 'markov' | 'wander' | 'hold';
export const MOTIONS: { id: Motion; label: string; tip: string }[] = [
  { id: 'drift', label: 'Drift', tip: 'A gentle random walk — mostly small steps, drawn back toward the middle.' },
  { id: 'arp', label: 'Arp', tip: 'Climbs and falls through the scale in thirds, bouncing at the ends.' },
  { id: 'markov', label: 'Markov', tip: 'Jumps that favour stable notes (tonic, fifth, third) over tense ones.' },
  { id: 'wander', label: 'Wander', tip: 'A slow, smooth curve snapped to the nearest scale note.' },
  { id: 'hold', label: 'Hold', tip: 'Stays put. Tap a note below to play it.' },
];

export interface SeqSettings {
  scale: ModeId;
  motion: Motion;
  /** 1–3 octaves above the tonic */
  range: number;
  /** probability a tick plays a note (otherwise a rest) */
  chance: number;
  /** 0 = use the resonator's chord shape; 3/4/5 = stack that many scale thirds */
  chordSize: 0 | 3 | 4 | 5;
  seed: number;
}

export interface Step {
  /** scale-degree index (0 = tonic, base octave) */
  index: number;
  /** semitones above the tonic */
  semis: number;
  /** degree within the scale, 0-based */
  degree: number;
  /** resonator string offsets when chordSize > 0 */
  offsets: number[] | null;
}

/** how settled each scale degree sounds (0-based degree → weight), for Markov */
const STABILITY = [1, 0.3, 0.7, 0.5, 0.9, 0.35, 0.3, 0.3];

export class Sequencer {
  index = 0;
  private rng: Rng;
  private n = 0;
  private dir = 1;
  private wp: [number, number, number, number];

  constructor(public s: SeqSettings) {
    this.rng = mulberry32(hashSeed(s.seed));
    this.wp = this.wanderPhases();
  }

  private get steps(): number[] {
    return MODES[this.s.scale].steps;
  }
  get len(): number {
    return this.steps.length;
  }
  /** highest index (the tonic `range` octaves up) */
  get max(): number {
    return this.len * clamp(Math.round(this.s.range), 1, 3);
  }

  reseed(seed: number) {
    this.s.seed = seed;
    this.rng = mulberry32(hashSeed(seed));
    this.wp = this.wanderPhases();
    this.n = 0;
    this.index = 0;
    this.dir = 1;
  }

  private wanderPhases(): [number, number, number, number] {
    const r = mulberry32(hashSeed(this.s.seed, 77));
    return [r() * 6.28, r() * 6.28, 0.21 + r() * 0.17, 0.53 + r() * 0.29];
  }

  describe(index: number): Step {
    const steps = this.steps;
    const i = clamp(Math.round(index), 0, this.max);
    const size = this.s.chordSize;
    const degree = i % this.len;
    return {
      index: i,
      semis: scaleNote(steps, i),
      degree,
      offsets: size ? stackChord(steps, i, size).tones : null,
    };
  }

  /** Jump to a position (a tapped note). */
  set(index: number): Step {
    this.index = clamp(Math.round(index), 0, this.max);
    return this.describe(this.index);
  }

  /** The next step, or null for a rest. */
  next(): Step | null {
    const s = this.s;
    if (s.motion === 'hold') return null;
    this.index = clamp(this.index, 0, this.max);
    const play = this.rng() < clamp(s.chance, 0, 1);
    // the walk advances on every tick, played or not: a rest is a silent step in the pattern
    this.index = this.advance();
    this.n++;
    return play ? this.describe(this.index) : null;
  }

  private advance(): number {
    const max = this.max;
    const cur = this.index;
    const rng = this.rng;
    switch (this.s.motion) {
      case 'drift': {
        // small steps, with a pull back toward the middle of the range
        const mid = max / 2;
        const pull = clamp((mid - cur) / Math.max(1, mid), -1, 1);
        const w = [-2, -1, 0, 1, 2].map((d) => (d === 0 ? 0.15 : Math.abs(d) === 1 ? 0.8 : 0.2) * (1 + pull * Math.sign(d) * 0.8));
        return clamp(cur + weighted(rng, [-2, -1, 0, 1, 2], w), 0, max);
      }
      case 'arp': {
        let next = cur + 2 * this.dir;
        // overshooting an end lands on the end itself; only from the end does it turn round
        if (next > max || next < 0) {
          const end = this.dir > 0 ? max : 0;
          if (cur !== end) next = end;
          else {
            this.dir = -this.dir;
            next = clamp(cur + 2 * this.dir, 0, max);
          }
        }
        return next;
      }
      case 'markov': {
        const cands: number[] = [];
        const w: number[] = [];
        for (let d = -4; d <= 4; d++) {
          const t = cur + d;
          if (t < 0 || t > max || d === 0) continue;
          cands.push(t);
          w.push((STABILITY[t % this.len] ?? 0.3) / (1 + 0.35 * Math.abs(d)));
        }
        return weighted(rng, cands, w);
      }
      case 'wander': {
        const [p1, p2, f1, f2] = this.wp;
        const v = 0.5 + 0.5 * (0.6 * Math.sin(p1 + this.n * f1 * 0.35) + 0.4 * Math.sin(p2 + this.n * f2 * 0.35));
        return clamp(Math.round(v * max), 0, max);
      }
      default:
        return cur;
    }
  }
}

export interface PlannedNote {
  type: 'note';
  frame: number;
  note: number;
  offsets: number[] | null;
  pluck: number;
}

/**
 * The whole note list for an offline render: a fresh walk from this seed,
 * one tick every `rate` seconds, as absolute frames the resonator can queue.
 */
export function planSequence(s: SeqSettings, rate: number, seconds: number, tonic: number, sr: number): PlannedNote[] {
  const q = new Sequencer({ ...s });
  q.reseed(s.seed);
  const out: PlannedNote[] = [];
  const note = (at: number, st: Step) => out.push({ type: 'note', frame: Math.round(at * sr), note: tonic + st.semis, offsets: st.offsets, pluck: 0 });
  let at = 0.05;
  note(at, q.describe(q.index));
  for (at += rate; at < seconds; at += rate) {
    const st = q.next();
    if (st) note(at, st);
  }
  return out;
}
