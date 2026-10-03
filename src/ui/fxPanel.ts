/*
 * The FX tab: resonator, delay, reverb, return level. Every control is a
 * labelled slider/button sized for a thumb.
 */
import { Engine, NOTE_NAMES, RESO_CHORD_NAMES } from '../audio/engine';
import { h } from './dom';

type Fmt = (v: number) => string;
const pct: Fmt = (v) => `${Math.round(v * 100)}%`;

function slider(label: string, min: number, max: number, step: number, value: number, fmt: Fmt, onInput: (v: number) => void, tip?: string) {
  const out = h('output', { class: 'mono val' }, fmt(value));
  const input = h('input', { class: 'range', type: 'range', min, max, step, value, 'aria-label': label });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  return h('div', { class: 'row', title: tip }, h('label', {}, label), input, out);
}

function pills<T extends number>(items: { label: string; value: T }[], current: T, onPick: (v: T) => void, cls = 'chips wrap') {
  const btns = items.map((it) =>
    h('button', { class: 'chip', 'aria-pressed': it.value === current, onclick: () => {
      onPick(it.value);
      btns.forEach((b, k) => b.setAttribute('aria-pressed', String(items[k].value === it.value)));
    } }, it.label),
  );
  return h('div', { class: cls, role: 'group' }, ...btns);
}

function toggle(label: string, on: boolean, onChange: (v: boolean) => void) {
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

  const resonator = section('Resonator', 'tuned strings, rung by your tracks',
    h('div', { class: 'label-row' }, 'Key'),
    pills(NOTE_NAMES.map((n, i) => ({ label: n, value: i })), fx.reso.root, (v) => engine.updateFx('reso', { root: v }), 'chips keys'),
    slider('Octave', 1, 5, 1, fx.reso.octave, (v) => `Oct ${v}`, (v) => engine.updateFx('reso', { octave: v }), 'Octave of the lowest string (3 puts A at 220 Hz)'),
    h('div', { class: 'label-row' }, 'Chord'),
    pills(RESO_CHORD_NAMES.map((n, i) => ({ label: n, value: i })), fx.reso.chord, (v) => engine.updateFx('reso', { chord: v })),
    slider('Decay', 0, 1, 0.01, fx.reso.decay, (v) => `${(0.15 * Math.pow(200, v)).toFixed(1)} s`, (v) => engine.updateFx('reso', { decay: v }), 'How long the strings ring'),
    slider('Bright', 0, 1, 0.01, fx.reso.bright, pct, (v) => engine.updateFx('reso', { bright: v })),
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
