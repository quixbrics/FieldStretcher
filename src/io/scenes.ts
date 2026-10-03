/*
 * Starting points. A scene sets the engines, stretch, FX and sequencer; it never
 * touches the recordings, so any scene can be tried on whatever is on the tracks.
 */
import type { Scene } from '../audio/engine';

const loop = { engine: 'tape' as const, stretch: 1, pitch: 0, reverse: false, freeze: false, mute: false, level: 0.8, pan: 0, send: 0 };

export const SCENES: Scene[] = [
  {
    name: 'Just Loops',
    blurb: 'Plain looping at normal speed. No stretch, no FX.',
    tracks: [0, 1, 2, 3].map(() => ({ ...loop })),
    fx: { reso: { mix: 0 }, delay: { mix: 0 }, reverb: { mix: 0 } },
    seqOn: false,
  },
  {
    name: 'Glass Hour',
    blurb: 'Slow shimmering drones over a drifting Lydian resonator.',
    tracks: [
      { engine: 'spectral', stretch: 64, pitch: 0, send: 0.55, level: 0.7 },
      { engine: 'spectral', stretch: 16, pitch: 12, send: 0.6, level: 0.5, pan: -0.4 },
      { engine: 'granular', stretch: 8, pitch: 7, send: 0.5, level: 0.5, pan: 0.4 },
      { engine: 'tape', stretch: 1, pitch: 0, send: 0.3, level: 0.4 },
    ],
    fx: {
      reso: { chord: 2, decay: 0.8, pluck: 0, onset: 0, input: 1, bright: 0.6, mix: 0.45, glide: 1.5 },
      delay: { time: 620, feedback: 0.55, tone: 0.7, pingpong: true, mix: 0.3 },
      reverb: { size: 1.4, decay: 14, damping: 0.35, shimmer: 0.35, freeze: false, mix: 0.5 },
      level: 0.85,
    },
    seq: { scale: 'lydian', motion: 'drift', range: 2, chance: 0.7, chordSize: 3, rate: 6 },
    seqOn: true,
  },
  {
    name: 'Underwater Street',
    blurb: 'Dark, heavy and far away: pitched-down washes and a slow minor resonance.',
    tracks: [
      { engine: 'spectral', stretch: 200, pitch: -12, send: 0.6, level: 0.7 },
      { engine: 'granular', stretch: 12, pitch: -5, send: 0.5, level: 0.5, pan: -0.3 },
      { engine: 'tape', stretch: 1, pitch: 0, send: 0.4, level: 0.5 },
      { engine: 'spectral', stretch: 32, pitch: -7, send: 0.5, level: 0.4, pan: 0.4 },
    ],
    fx: {
      reso: { chord: 3, decay: 0.75, pluck: 0, onset: 0, input: 1, bright: 0.3, mix: 0.4, glide: 2.5 },
      delay: { time: 880, feedback: 0.6, tone: 0.2, pingpong: false, mix: 0.3 },
      reverb: { size: 1.9, decay: 22, damping: 0.7, shimmer: 0, freeze: false, mix: 0.55 },
      level: 0.85,
    },
    seq: { scale: 'aeolian', motion: 'wander', range: 1, chance: 0.8, chordSize: 0, rate: 9 },
    seqOn: true,
  },
  {
    name: 'Rain Harp',
    blurb: 'Your loops play normally and pluck a ticking harp from every hit.',
    tracks: [0, 1, 2, 3].map((i) => ({ ...loop, send: 0.5, level: 0.6, pan: [-0.5, 0.5, -0.2, 0.2][i] })),
    fx: {
      reso: { chord: 1, decay: 0.3, pluck: 0.8, onset: 0.6, input: 0.25, bright: 0.75, mix: 0.7, glide: 0.02 },
      delay: { time: 330, feedback: 0.45, tone: 0.55, pingpong: true, mix: 0.3 },
      reverb: { size: 1.1, decay: 6, damping: 0.5, shimmer: 0, freeze: false, mix: 0.3 },
      level: 0.85,
    },
    seq: { scale: 'dorian', motion: 'arp', range: 2, chance: 0.8, chordSize: 0, rate: 0.4 },
    seqOn: true,
  },
];
