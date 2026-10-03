/*
 * Starting points. A scene sets the modes, their sound controls, stretch, FX and
 * sequencer; it never touches the recordings, so any scene can be tried on whatever
 * is on the tracks. Each scene lists the two tracks, then the FX. `wet` is the single
 * Wet/Dry control, and each effect is `on` or off.
 */
import type { Scene, SceneTrack } from '../audio/engine';

const loop: SceneTrack = { engine: 'tape', stretch: 1, glide: 0, pitch: 0, link: true, reverse: false, freeze: false, mute: false, level: 0.8, pan: 0, overdub: false };
const none = { tape: { wow: 0, flutter: 0, drive: 0, age: 0, hiss: 0 } };

export const SCENES: Scene[] = [
  {
    name: 'Just Loops',
    blurb: 'Plain looping at normal speed. Nothing wet.',
    tracks: [{ ...loop, sound: none }, { ...loop, sound: none }],
    fx: { wet: 0 },
    seqOn: false,
  },
  {
    name: 'Worn Cassette',
    blurb: 'Tape at normal speed, but wobbling, dull and hissy, like a tape left in a car.',
    tracks: [
      { ...loop, glide: 0.6, sound: { tape: { wow: 0.6, flutter: 0.35, drive: 0.4, age: 0.65, hiss: 0.3 } } },
      { ...loop, glide: 0.6, pan: 0.15, sound: { tape: { wow: 0.45, flutter: 0.5, drive: 0.3, age: 0.5, hiss: 0.25 } } },
    ],
    fx: { wet: 0.2, reso: { on: false }, delay: { on: false }, reverb: { on: true, size: 0.6, decay: 2, damping: 0.8, shimmer: 0, freeze: false } },
    seqOn: false,
  },
  {
    name: 'Glass Hour',
    blurb: 'Slow shimmering drones over a drifting Lydian resonator.',
    tracks: [
      { engine: 'spectral', link: false, stretch: 64, glide: 4, pitch: 0, level: 0.7, sound: { spectral: { window: 14, spread: 0.9, tilt: 0.4, focus: 0.7 } } },
      { engine: 'spectral', link: false, stretch: 16, glide: 4, pitch: 12, level: 0.5, pan: -0.3, sound: { spectral: { window: 13, spread: 0.8, tilt: 0.6, focus: 0.65 } } },
    ],
    fx: {
      wet: 0.6,
      reso: { on: true, chord: 2, decay: 0.8, pluck: 0, onset: 0, input: 1, bright: 0.6, glide: 1.5 },
      delay: { on: true, time: 620, feedback: 0.55, tone: 0.7, pingpong: true },
      reverb: { on: true, size: 1.4, decay: 14, damping: 0.35, shimmer: 0.35, freeze: false },
    },
    seq: { scale: 'lydian', motion: 'drift', range: 2, chance: 0.7, chordSize: 3, rate: 6 },
    seqOn: true,
  },
  {
    name: 'Underwater Street',
    blurb: 'Dark, heavy and far away: pitched-down washes and a slow minor resonance.',
    tracks: [
      { engine: 'spectral', link: false, stretch: 200, glide: 6, pitch: -12, level: 0.7, sound: { spectral: { window: 15, spread: 0.7, tilt: -0.7, focus: 0.55 } } },
      { engine: 'granular', link: false, stretch: 12, glide: 3, pitch: -5, level: 0.5, pan: -0.3, sound: { granular: { grain: 300, density: 14, jitter: 0.5, spray: 1, spread: 0.7, shape: 1, grev: 0 } } },
    ],
    fx: {
      wet: 0.65,
      reso: { on: true, chord: 3, decay: 0.75, pluck: 0, onset: 0, input: 1, bright: 0.3, glide: 2.5 },
      delay: { on: true, time: 880, feedback: 0.6, tone: 0.2, pingpong: false },
      reverb: { on: true, size: 1.9, decay: 22, damping: 0.7, shimmer: 0, freeze: false },
    },
    seq: { scale: 'aeolian', motion: 'wander', range: 1, chance: 0.8, chordSize: 0, rate: 9 },
    seqOn: true,
  },
  {
    name: 'Rain Harp',
    blurb: 'Your loops play normally and pluck a ticking harp from every hit.',
    tracks: [
      { ...loop, level: 0.6, pan: -0.5, sound: none },
      { ...loop, level: 0.6, pan: 0.5, sound: none },
    ],
    fx: {
      wet: 0.6,
      reso: { on: true, chord: 1, decay: 0.3, pluck: 0.8, onset: 0.6, input: 0.25, bright: 0.75, glide: 0.02 },
      delay: { on: true, time: 330, feedback: 0.45, tone: 0.55, pingpong: true },
      reverb: { on: true, size: 1.1, decay: 6, damping: 0.5, shimmer: 0, freeze: false },
    },
    seq: { scale: 'dorian', motion: 'arp', range: 2, chance: 0.8, chordSize: 0, rate: 0.4 },
    seqOn: true,
  },
];
