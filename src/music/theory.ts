/*
 * Scales and chord stacking, from ToneMaker (src/music/theory.ts) — the same
 * eight modes, so a key and scale mean the same thing across the Maker apps.
 * Pitch classes are 0–11 (C = 0); "semis" are semitones above the key root.
 */

export type ModeId =
  | 'lydian'
  | 'ionian'
  | 'mixolydian'
  | 'dorian'
  | 'aeolian'
  | 'harmonicMinor'
  | 'phrygian'
  | 'octatonic';

export interface ModeDef {
  id: ModeId;
  name: string;
  /** semitone offsets from the root, ascending */
  steps: number[];
  /** short plain-language character, shown to students */
  feel: string;
}

export const MODES: Record<ModeId, ModeDef> = {
  lydian: { id: 'lydian', name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11], feel: 'major with a raised 4th — dreamy, floating, wonder' },
  ionian: { id: 'ionian', name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11], feel: 'the familiar major scale — bright, settled, resolved' },
  mixolydian: { id: 'mixolydian', name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10], feel: 'major with a flat 7th — warm, earthy, open-ended' },
  dorian: { id: 'dorian', name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10], feel: 'minor with a raised 6th — reflective, bittersweet' },
  aeolian: { id: 'aeolian', name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10], feel: 'natural minor — sad, sombre, heavy' },
  harmonicMinor: { id: 'harmonicMinor', name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11], feel: 'minor with a leading tone — dramatic, gothic, insistent' },
  phrygian: { id: 'phrygian', name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10], feel: 'minor with a flat 2nd — dark, threatening, claustrophobic' },
  octatonic: { id: 'octatonic', name: 'Octatonic', steps: [0, 1, 3, 4, 6, 7, 9, 10], feel: 'symmetrical half-whole scale — unstable, alarming, horror' },
};

/** Ordered dark → bright, used for display. */
export const MODE_ORDER: ModeId[] = ['octatonic', 'phrygian', 'harmonicMinor', 'aeolian', 'dorian', 'mixolydian', 'ionian', 'lydian'];

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export const pc = (n: number): number => ((n % 12) + 12) % 12;
export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** A chord relative to the key: its root (semis above key root) and its tones
 *  as intervals above the chord root (0 first, ascending, may exceed 12). */
export interface ChordSpec {
  root: number;
  tones: number[];
  /** scale degree (0-based) the chord was built on, or -1 for chromatic */
  degree: number;
}

/** Scale as semitone offsets, extended across octaves so index arithmetic works. */
export function scaleNote(steps: number[], index: number): number {
  const n = steps.length;
  const oct = Math.floor(index / n);
  const i = ((index % n) + n) % n;
  return steps[i] + 12 * oct;
}

/**
 * Build a chord on a scale degree by stacking every other scale tone
 * (tertian harmony). `size` 3 = triad, 4 = 7th, 5 = 9th.
 * For the 8-note octatonic scale this naturally yields diminished sonorities.
 */
export function stackChord(steps: number[], degree: number, size = 3): ChordSpec {
  const root = scaleNote(steps, degree);
  const tones: number[] = [];
  for (let k = 0; k < size; k++) tones.push(scaleNote(steps, degree + 2 * k) - root);
  return { root: pc(root), tones, degree };
}

