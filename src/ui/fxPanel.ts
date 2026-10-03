/*
 * The FX tab: resonator, delay, reverb, return level. Every control is a
 * labelled slider/button sized for a thumb.
 */
import { Engine, NOTE_NAMES, RESO_CHORD_NAMES } from '../audio/engine';
import { h } from './dom';

type Fmt = (v: number) => string;
const pct: Fmt = (v) => `${Math.round(v * 100)}%`;

export type Controllable = HTMLElement & { set(v: number): void };

export function slider(label: string, min: number, max: number, step: number, value: number, fmt: Fmt, onInput: (v: number) => void, tip?: string): Controllable {
  const out = h('output', { class: 'mono val' }, fmt(value));
  const input = h('input', { class: 'range', type: 'range', min, max, step, value, 'aria-label': label });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  const row = h('div', { class: 'row', title: tip }, h('label', {}, label), input, out);
  // move the control from code (presets, a duplicate control elsewhere) without firing onInput
  return Object.assign(row, {
    set(v: number) {
      input.value = String(v);
      out.textContent = fmt(v);
    },
  });
}

export function pills<T extends number>(items: { label: string; value: T }[], current: T, onPick: (v: T) => void, cls = 'chips wrap'): Controllable {
  const btns = items.map((it) =>
    h('button', { class: 'chip', 'aria-pressed': it.value === current, onclick: () => {
      onPick(it.value);
      show(it.value);
    } }, it.label),
  );
  const show = (v: number) => btns.forEach((b, k) => b.setAttribute('aria-pressed', String(items[k].value === v)));
  return Object.assign(h('div', { class: cls, role: 'group' }, ...btns), { set: show });
}

/** The key and octave pickers, used on the FX tab and the Seq tab; they stay in step with each other. */
export function keyControls(engine: Engine): HTMLElement[] {
  const keys = pills(NOTE_NAMES.map((n, i) => ({ label: n, value: i })), engine.fx.reso.root, (v) => engine.updateFx('reso', { root: v }), 'chips keys');
  const oct = slider('Octave', 1, 5, 1, engine.fx.reso.octave, (v) => `Oct ${v}`, (v) => engine.updateFx('reso', { octave: v }), 'Octave of the lowest string (3 puts A at 220 Hz)');
  engine.onFxChange(() => {
    keys.set(engine.fx.reso.root);
    oct.set(engine.fx.reso.octave);
  });
  return [h('div', { class: 'label-row' }, 'Key'), keys, oct];
}

/** decay slider position (0–1) → seconds: 20 ms (a pluck) to 30 s (a drone) */
export const decaySeconds = (v: number): number => 0.02 * Math.pow(1500, v);
const fmtDecay: Fmt = (v) => {
  const t = decaySeconds(v);
  return t < 1 ? `${Math.round(t * 1000)} ms` : `${t.toFixed(1)} s`;
};

export function toggle(label: string, on: boolean, onChange: (v: boolean) => void) {
  const b = h('button', { class: 'tog', 'aria-pressed': on }, label);
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(v));
    onChange(v);
  });
  return b;
}

export function buildFxPanel(engine: Engine): HTMLElement {
  const fx = engine.fx;
  const section = (title: string, sub: string, ...kids: Node[]) =>
    h('section', { class: 'fx-card' }, h('header', {}, h('h2', {}, title), h('span', { class: 'sub' }, sub)), ...kids);

  const decay = slider('Decay', 0, 1, 0.005, fx.reso.decay, fmtDecay, (v) => engine.updateFx('reso', { decay: v }), 'How long a string rings. Short (under ~100 ms) makes plucks and ticks; long makes a drone.');
  const pluck = slider('Pluck', 0, 1, 0.01, fx.reso.pluck, pct, (v) => engine.updateFx('reso', { pluck: v }), 'A snap on every note change — set Decay short and each sequencer step becomes a plucked note');
  const onset = slider('Onset', 0, 1, 0.01, fx.reso.onset, (v) => (v === 0 ? 'off' : pct(v)), (v) => engine.updateFx('reso', { onset: v }), 'Plucks the strings whenever the sound being sent in has a hit in it. Higher = more sensitive.');
  const input = slider('Input', 0, 1, 0.01, fx.reso.input, pct, (v) => engine.updateFx('reso', { input: v }), 'How much of the sent audio rings the strings. Turn down for pluck-only.');
  const bright = slider('Bright', 0, 1, 0.01, fx.reso.bright, pct, (v) => engine.updateFx('reso', { bright: v }));
  const presets: { label: string; tip: string; v: Partial<typeof fx.reso> }[] = [
    { label: 'Drone', tip: 'Long ring, driven by the audio', v: { decay: 0.7, pluck: 0, onset: 0, input: 1, bright: 0.5 } },
    { label: 'Pluck', tip: 'Short ring, snaps on each note and on hits', v: { decay: 0.35, pluck: 0.8, onset: 0.5, input: 0.3, bright: 0.7 } },
    { label: 'Tick', tip: 'Very short: percussive ticks on notes and hits', v: { decay: 0.12, pluck: 1, onset: 0.7, input: 0, bright: 0.85 } },
  ];
  const sliders = { decay, pluck, onset, input, bright };
  const presetRow = h('div', { class: 'chips' }, ...presets.map((p) => h('button', { class: 'chip', title: p.tip, onclick: () => {
    engine.updateFx('reso', p.v);
    for (const [k, el] of Object.entries(sliders)) if (k in p.v) el.set(p.v[k as keyof typeof p.v] as number);
  } }, p.label)));

  const resonator = section('Resonator', 'tuned strings: drone or pluck',
    ...keyControls(engine),
    h('div', { class: 'label-row' }, 'Chord'),
    pills(RESO_CHORD_NAMES.map((n, i) => ({ label: n, value: i })), fx.reso.chord, (v) => engine.updateFx('reso', { chord: v })),
    h('div', { class: 'label-row' }, 'Character'),
    presetRow,
    decay,
    pluck,
    onset,
    input,
    bright,
    slider('Spread', 0, 1, 0.01, fx.reso.spread, pct, (v) => engine.updateFx('reso', { spread: v }), 'Stereo width (slight detune between ears)'),
    slider('Mix', 0, 1, 0.01, fx.reso.mix, pct, (v) => engine.updateFx('reso', { mix: v })),
  );

  const delay = section('Delay', 'tape-style echoes',
    slider('Time', 50, 1500, 1, fx.delay.time, (v) => `${Math.round(v)} ms`, (v) => engine.updateFx('delay', { time: v })),
    slider('Feedback', 0, 0.95, 0.01, fx.delay.feedback, pct, (v) => engine.updateFx('delay', { feedback: v })),
    slider('Tone', 0, 1, 0.01, fx.delay.tone, (v) => (v < 0.34 ? 'dark' : v < 0.67 ? 'warm' : 'bright'), (v) => engine.updateFx('delay', { tone: v }), 'Each repeat gets darker the lower this is'),
    slider('Mix', 0, 1, 0.01, fx.delay.mix, pct, (v) => engine.updateFx('delay', { mix: v })),
    h('div', { class: 'toggles' }, toggle('Ping-pong', fx.delay.pingpong, (v) => engine.updateFx('delay', { pingpong: v }))),
  );

  const reverb = section('Reverb', 'long, dense, endless',
    slider('Size', 0.3, 2, 0.01, fx.reverb.size, (v) => v.toFixed(2), (v) => engine.updateFx('reverb', { size: v })),
    slider('Decay', 1, 30, 0.1, fx.reverb.decay, (v) => `${v.toFixed(1)} s`, (v) => engine.updateFx('reverb', { decay: v })),
    slider('Damping', 0, 0.95, 0.01, fx.reverb.damping, pct, (v) => engine.updateFx('reverb', { damping: v })),
    slider('Shimmer', 0, 1, 0.01, fx.reverb.shimmer, pct, (v) => engine.updateFx('reverb', { shimmer: v }), 'Feeds an octave-up copy of the tail back into the reverb'),
    slider('Mix', 0, 1, 0.01, fx.reverb.mix, pct, (v) => engine.updateFx('reverb', { mix: v })),
    h('div', { class: 'toggles' }, toggle('Freeze tail', fx.reverb.freeze, (v) => engine.updateFx('reverb', { freeze: v }))),
  );

  const ret = h('section', { class: 'fx-card' },
    slider('FX return', 0, 1, 0.01, fx.level, pct, (v) => engine.setFxLevel(v), 'Level of the whole FX bus'),
    h('p', { class: 'hint' }, 'Tracks feed the bus with their Send slider. Sends are taken before the level fader — turn a track’s Level down and its Send up for a wet-only sound.'),
  );

  return h('div', { class: 'fx-panel' }, resonator, delay, reverb, ret);
}
