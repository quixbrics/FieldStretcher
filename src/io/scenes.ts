/*
 * Starting points. A scene sets the engines, their sound controls, stretch, FX and
 * sequencer; it never touches the recordings, so any scene can be tried on whatever
 * is on the tracks. The third entry in each list is the Bounce track.
 */
import type { Scene, SceneTrack } from '../audio/engine';

const loop: SceneTrack = { engine: 'tape', stretch: 1, glide: 0, pitch: 0, reverse: false, freeze: false, mute: false, level: 0.8, pan: 0, send: 0, overdub: false };

export const SCENES: Scene[] = [
  {
    name: 'Just Loops',
    blurb: 'Plain looping at normal speed. No stretch, no FX.',
    tracks: [loop, loop, loop].map((t) => ({ ...t, sound: { tape: { wow: 0, flutter: 0, drive: 0, age: 0, hiss: 0 } } })),
    fx: { reso: { mix: 0 }, delay: { mix: 0 }, reverb: { mix: 0 } },
    seqOn: false,
  },
  {
    name: 'Worn Cassette',
    blurb: 'Tape at normal speed, but wobbling, dull and hissy, like a tape left in a car.',
    tracks: [
      { ...loop, glide: 0.6, sound: { tape: { wow: 0.6, flutter: 0.35, drive: 0.4, age: 0.65, hiss: 0.3 } } },
      { ...loop, glide: 0.6, pan: 0.15, sound: { tape: { wow: 0.45, flutter: 0.5, drive: 0.3, age: 0.5, hiss: 0.25 } } },
      { ...loop, glide: 0.6, sound: { tape: { wow: 0.4, flutter: 0.3, drive: 0.35, age: 0.55, hiss: 0.2 } } },
    ],
    fx: { reso: { mix: 0 }, delay: { mix: 0 }, reverb: { size: 0.6, decay: 2, damping: 0.8, shimmer: 0, freeze: false, mix: 0.15 } },
    seqOn: false,
  },
  {
    name: 'Glass Hour',
    blurb: 'Slow shimmering drones over a drifting Lydian resonator.',
    tracks: [
      { engine: 'spectral', stretch: 64, glide: 4, pitch: 0, send: 0.55, level: 0.7, sound: { spectral: { window: 14, spread: 0.9, tilt: 0.4, focus: 0.7 } } },
      { engine: 'spectral', stretch: 16, glide: 4, pitch: 12, send: 0.6, level: 0.5, pan: -0.4, sound: { spectral: { window: 13, spread: 0.8, tilt: 0.6, focus: 0.65 } } },
      { engine: 'granular', stretch: 8, glide: 2, pitch: 7, send: 0.5, level: 0.5, pan: 0.4, sound: { granular: { grain: 220, density: 18, jitter: 0.35, spray: 2, spread: 0.9, shape: 1, grev: 0.2 } } },
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
      { engine: 'spectral', stretch: 200, glide: 6, pitch: -12, send: 0.6, level: 0.7, sound: { spectral: { window: 15, spread: 0.7, tilt: -0.7, focus: 0.55 } } },
      { engine: 'granular', stretch: 12, glide: 3, pitch: -5, send: 0.5, level: 0.5, pan: -0.3, sound: { granular: { grain: 300, density: 14, jitter: 0.5, spray: 1, spread: 0.7, shape: 1, grev: 0 } } },
      { engine: 'tape', stretch: 1, glide: 1, pitch: 0, send: 0.4, level: 0.5, sound: { tape: { wow: 0.3, flutter: 0, drive: 0.2, age: 0.7, hiss: 0.1 } } },
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
    tracks: [
      { ...loop, send: 0.5, level: 0.6, pan: -0.5 },
      { ...loop, send: 0.5, level: 0.6, pan: 0.5 },
      { ...loop, send: 0.5, level: 0.6, pan: 0 },
    ],
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
