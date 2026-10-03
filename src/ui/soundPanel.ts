/*
 * The "Sound" controls of a track: a different set for each stretch mode. Every
 * mode keeps its own values, so switching Tape → Granular → Tape loses nothing.
 */
import type { Engine, EngineKind } from '../audio/engine';
import { h } from './dom';
import { slider, type Controllable } from './fxPanel';

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** log slider: position 0–1 ⇄ a value between lo and hi */
const logFrom = (lo: number, hi: number) => (v: number) => lo * Math.pow(hi / lo, v);
const posOfLog = (lo: number, hi: number) => (x: number) => Math.log(x / lo) / Math.log(hi / lo);

export interface SoundPanel {
  el: HTMLElement;
  show(kind: EngineKind): void;
  /** push the engine's values back into the sliders (after a scene or project opens) */
  sync(): void;
}

export function buildSoundPanel(engine: Engine, i: number, onChange: () => void): SoundPanel {
  const t = () => engine.tracks[i].sound;
  const all: { set(): void }[] = [];
  /** a slider bound to a field of the track's sound; map/unmap convert for log scales */
  const bind = <K extends 'tape' | 'spectral' | 'granular'>(
    kind: K,
    key: keyof ReturnType<typeof t>[K] & string,
    label: string,
    lo: number,
    hi: number,
    step: number,
    fmt: (v: number) => string,
    tip: string,
    map: (v: number) => number = (v) => v,
    unmap: (v: number) => number = (v) => v,
  ): Controllable => {
    const row = slider(
      label,
      lo,
      hi,
      step,
      unmap((t()[kind] as unknown as Record<string, number>)[key]),
      (v) => fmt(map(v)),
      (v) => {
        engine.updateSound(i, kind, { [key]: map(v) } as never);
        onChange();
      },
      tip,
    );
    all.push({ set: () => row.set(unmap((t()[kind] as unknown as Record<string, number>)[key])) });
    return row;
  };

  const tape = h('div', { class: 'sound-group' },
    bind('tape', 'wow', 'Wow', 0, 1, 0.01, pct, 'Slow drift in the tape speed, like a warped reel'),
    bind('tape', 'flutter', 'Flutter', 0, 1, 0.01, pct, 'Fast wobble in the tape speed'),
    bind('tape', 'drive', 'Saturate', 0, 1, 0.01, pct, 'Pushes the tape into soft, warm distortion'),
    bind('tape', 'age', 'Wear', 0, 1, 0.01, (v) => (v === 0 ? 'new' : pct(v)), 'Worn tape loses its high frequencies'),
    bind('tape', 'hiss', 'Hiss', 0, 1, 0.01, (v) => (v === 0 ? 'off' : pct(v)), 'Tape noise'),
  );

  const sr = () => engine.sampleRate;
  const spectral = h('div', { class: 'sound-group' },
    bind('spectral', 'window', 'Smear', 11, 15, 1, (v) => `${Math.round((2 ** v / sr()) * 1000)} ms`, 'Small: soft and blurred, changes quickly. Large: fine detail, slow to evolve.'),
    bind('spectral', 'spread', 'Width', 0, 1, 0.01, pct, 'How different the left and right ears sound (0 = mono)'),
    bind('spectral', 'tilt', 'Tilt', -1, 1, 0.01, (v) => (Math.abs(v) < 0.03 ? 'flat' : v < 0 ? `dark ${Math.round(-v * 100)}` : `bright ${Math.round(v * 100)}`), 'Darken or brighten the whole sound'),
    bind('spectral', 'focus', 'Focus', 0, 1, 0.01, (v) => (Math.abs(v - 0.5) < 0.02 ? 'as is' : v < 0.5 ? 'diffuse' : 'tonal'), 'Left: spreads toward noise. Right: sharpens the strongest tones into a drone.'),
  );

  const granular = h('div', { class: 'sound-group' },
    bind('granular', 'grain', 'Grain', 0, 1, 0.005, (v) => `${Math.round(v)} ms`, 'How long each grain is', logFrom(10, 1000), posOfLog(10, 1000)),
    bind('granular', 'density', 'Density', 0, 1, 0.005, (v) => `${Math.round(v)}/s`, 'Grains per second', logFrom(1, 200), posOfLog(1, 200)),
    bind('granular', 'jitter', 'Scatter', 0, 1, 0.01, pct, 'How far from the playhead the grains are taken'),
    bind('granular', 'spray', 'Spray', 0, 12, 0.1, (v) => (v === 0 ? 'off' : `±${v.toFixed(1)} st`), 'Random pitch spread between grains'),
    bind('granular', 'spread', 'Width', 0, 1, 0.01, pct, 'How widely the grains are placed left to right'),
    bind('granular', 'shape', 'Shape', 0, 1, 0.01, (v) => (v < 0.15 ? 'sharp' : v > 0.85 ? 'smooth' : pct(v)), 'Sharp: each grain starts abruptly and dies away. Smooth: soft bell-shaped grains.'),
    bind('granular', 'grev', 'Backwards', 0, 1, 0.01, (v) => (v === 0 ? 'none' : pct(v)), 'The chance a grain plays in reverse'),
  );

  const groups: Record<EngineKind, HTMLElement> = { tape, spectral, granular };
  const el = h('div', { class: 'sound' }, tape, spectral, granular);
  const show = (kind: EngineKind) => {
    for (const [k, g] of Object.entries(groups)) g.hidden = k !== kind;
  };
  show(engine.tracks[i].engine);
  return { el, show, sync: () => all.forEach((a) => a.set()) };
}
