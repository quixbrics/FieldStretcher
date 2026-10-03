/*
 * One track's card: mode, the waveform with its loop window,
 * stretch / pitch (linked, like a tape reel) / glide, toggles, the mode's own Sound
 * controls, and a More section.
 */
import { Engine, trackName, type EngineKind } from '../audio/engine';
import { peakOf } from '../audio/loopfx';
import { Wave } from './wave';
import { buildSoundPanel, type SoundPanel } from './soundPanel';
import { fmtSemis, fmtStretch, fmtTime, h, posFromStretch, stretchFromPos } from './dom';

export const ENGINES: { id: EngineKind; label: string; tip: string }[] = [
  { id: 'spectral', label: 'Spectral', tip: 'Smooth, endless drones (Paulstretch). Unlink pitch from stretch to stretch without changing pitch.' },
  { id: 'granular', label: 'Granular', tip: 'A shimmering cloud of tiny grains. Great for rain, steps, rustle.' },
  { id: 'tape', label: 'Tape', tip: 'Slow it down like a reel: pitch falls as the stretch grows.' },
];
const CHIPS = [0.5, 1, 4, 16, 128, 1000];
const chipLabel = (c: number) => (c === 1000 ? '1k×' : c < 1 ? `${c}×` : `${c}×`);

/** glide slider position 0–1 ⇄ seconds: the first few percent is "off", then 0.1 s – 10 s on a log scale */
const glideFrom = (v: number) => (v < 0.03 ? 0 : 0.1 * Math.pow(100, (v - 0.03) / 0.97));
const posFromGlide = (g: number) => (g <= 0 ? 0 : 0.03 + (0.97 * Math.log(g / 0.1)) / Math.log(100));
const fmtGlide = (g: number) => (g <= 0 ? 'off' : g < 10 ? `${g.toFixed(1)} s` : '10 s');

export interface CardHooks {
  say(msg: string): void;
  rec(i: number): void;
}

export class TrackCard {
  readonly root: HTMLElement;
  readonly wave = new Wave();
  private rec: HTMLButtonElement;
  private peakText = h('p', { class: 'hint mono' });
  private normBtn: HTMLButtonElement;
  private sound: SoundPanel;
  private stretch: HTMLInputElement;
  private stretchOut = h('output', { class: 'mono val' });
  private pitch: HTMLInputElement;
  private pitchOut = h('output', { class: 'mono val' });
  private linkBtn: HTMLButtonElement;
  private linkNote = h('p', { class: 'hint link-note' });
  private chips: HTMLButtonElement[];
  private engineBtns: HTMLButtonElement[];

  constructor(private engine: Engine, private i: number, hooks: CardHooks) {
    const t = engine.tracks[i];

    const range = (cls: string, min: number, max: number, step: number, value: number, label: string, onInput: (v: number) => void) => {
      const el = h('input', { class: `range ${cls}`, type: 'range', min, max, step, value, 'aria-label': `${trackName(i)} ${label}` });
      el.addEventListener('input', () => onInput(Number(el.value)));
      return el;
    };

    /* ---- stretch, pitch (linked), glide ---- */
    this.stretch = range('stretch-range', 0, 1, 0.001, posFromStretch(t.stretch), 'stretch', (v) => engine.setStretch(i, stretchFromPos(v)));
    this.chips = CHIPS.map((c) => h('button', { class: 'chip mono', onclick: () => engine.setStretch(i, c) }, chipLabel(c)));
    this.pitch = range('', -24, 24, 0.1, t.pitch, 'pitch', (v) => engine.setPitch(i, v));
    this.linkBtn = h('button', {
      class: 'linkbtn',
      'aria-pressed': t.link,
      'aria-label': `${trackName(i)}: link pitch and stretch`,
      title: 'Linked: pitch and stretch move together, like a tape reel (slower = lower). Unlinked: they are independent.',
      onclick: () => engine.setLink(i, !engine.tracks[i].link),
    }, 'Link');

    const glideOut = h('output', { class: 'mono val' }, fmtGlide(t.glide));
    const glide = range('', 0, 1, 0.005, posFromGlide(t.glide), 'glide', (v) => {
      const g = glideFrom(v);
      engine.update(i, { glide: g });
      glideOut.textContent = fmtGlide(g);
    });
    const glideRow = h('div', { class: 'row', title: 'How long a change of stretch takes to arrive. On tape it is the motor’s inertia: also how long it takes to wind down when frozen.' }, h('label', {}, 'Glide'), glide, glideOut);

    /* ---- mode ---- */
    this.sound = buildSoundPanel(engine, i, () => {});
    this.engineBtns = ENGINES.map((e) =>
      h('button', { class: 'seg-btn', title: e.tip, 'aria-pressed': e.id === t.engine, onclick: () => {
        engine.setEngine(i, e.id);
        this.sound.show(e.id);
        this.syncControls();
      } }, e.label),
    );

    /* ---- toggles ---- */
    const toggle = (label: string, key: 'reverse' | 'freeze' | 'overdub', tip: string) => {
      const b = h('button', { class: 'tog', title: tip, 'aria-pressed': t[key] }, label);
      b.addEventListener('click', () => {
        engine.update(i, { [key]: !engine.tracks[i][key] });
        b.setAttribute('aria-pressed', String(engine.tracks[i][key]));
      });
      return b;
    };
    const toggles = h('div', { class: 'toggles' },
      toggle('Reverse', 'reverse', 'Play the loop backwards'),
      toggle('Freeze', 'freeze', 'Hold this moment (on tape, the reel winds down and stops)'),
      toggle('Overdub', 'overdub', 'Record layers over the loop at the playhead instead of replacing it'),
    );

    /* ---- header ---- */
    const mute = h('button', { class: 'mute', 'aria-label': `Mute ${trackName(i)}`, 'aria-pressed': t.mute, onclick: () => {
      engine.update(i, { mute: !engine.tracks[i].mute });
      mute.setAttribute('aria-pressed', String(engine.tracks[i].mute));
    } }, 'M');
    this.rec = h('button', { class: 'rec', 'aria-label': `Record track ${i + 1}`, 'aria-pressed': false, onclick: () => hooks.rec(i) }, h('i', {}));
    const header = h('header', {}, h('span', { class: 'num mono' }, String(i + 1)), h('div', { class: 'seg', role: 'group', 'aria-label': 'Stretch mode' }, ...this.engineBtns), mute, this.rec);

    /* ---- More ---- */
    const file = h('input', { type: 'file', accept: 'audio/*', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      if (!engine.started) await engine.start();
      try {
        const r = await engine.importFile(i, f);
        if (!r.ok) hooks.say(r.reason === 'quiet' ? 'That file is silent.' : 'That sound is too short (min ¼ s).');
      } catch {
        hooks.say('Could not read that audio file.');
      }
    });
    this.normBtn = h('button', { class: 'btn', title: 'Bring a quiet recording up to −3 dBFS (never done automatically)', onclick: () => {
      const r = engine.normaliseTrack(i);
      if (r.ok) hooks.say(`Normalised: ${r.gainDb >= 0 ? '+' : ''}${r.gainDb.toFixed(1)} dB`);
      else hooks.say(r.reason === 'empty' ? 'Nothing recorded yet.' : 'That is silent — nothing to normalise.');
    } }, 'Normalise');
    const lvlOut = h('output', { class: 'mono val' }, `${Math.round(t.level * 100)}%`);
    const keepOut = h('output', { class: 'mono val' }, `${Math.round(t.keep * 100)}%`);
    const more = h('details', { class: 'more' },
      h('summary', {}, 'More'),
      h('div', { class: 'row' }, h('label', {}, 'Level'), range('', 0, 1, 0.01, t.level, 'level', (v) => {
        engine.update(i, { level: v });
        lvlOut.textContent = `${Math.round(v * 100)}%`;
      }), lvlOut),
      h('div', { class: 'row' }, h('label', {}, 'Pan'), range('', -1, 1, 0.01, t.pan, 'pan', (v) => engine.update(i, { pan: v })), h('span', {})),
      h('div', { class: 'row', title: 'How much of the old loop survives when you overdub' },
        h('label', {}, 'Keep'),
        range('', 0, 1, 0.01, t.keep, 'keep', (v) => {
          engine.update(i, { keep: v });
          keepOut.textContent = `${Math.round(v * 100)}%`;
        }),
        keepOut,
      ),
      this.peakText,
      h('div', { class: 'row actions' },
        this.normBtn,
        h('button', { class: 'btn', onclick: () => file.click() }, 'Load sound…'),
        h('button', { class: 'btn danger', onclick: () => engine.clearTrack(i) }, 'Clear'),
        file,
      ),
    );

    this.wave.onWindow = (s, e) => engine.update(i, { start: s, end: e });

    this.root = h('section', { class: 'track', style: `--c:var(--track-${i + 1});--cl:var(--track-${i + 1}-label)`, 'aria-label': trackName(i) },
      header,
      this.wave.el,
      h('div', { class: 'stretch' },
        h('div', { class: 'row' }, h('label', {}, 'Stretch'), this.stretchOut),
        this.stretch,
        h('div', { class: 'chips' }, ...this.chips),
        h('div', { class: 'row pitch' }, h('label', {}, 'Pitch'), this.pitch, this.pitchOut, this.linkBtn),
        this.linkNote,
        glideRow,
      ),
      toggles,
      h('details', { class: 'sound-sec', open: true }, h('summary', {}, 'Sound'), this.sound.el),
      more,
    );
    this.syncControls();
    this.refresh();
  }

  /** Move the stretch / pitch / link controls to the engine's values (they change each other). */
  syncControls() {
    const t = this.engine.tracks[this.i];
    this.stretch.value = String(posFromStretch(t.stretch));
    this.stretchOut.textContent = fmtStretch(t.stretch);
    this.pitch.value = String(t.pitch);
    this.pitchOut.textContent = fmtSemis(t.pitch);
    this.linkBtn.setAttribute('aria-pressed', String(t.link));
    this.root.classList.toggle('linked', t.link);
    this.chips.forEach((b, k) => b.classList.toggle('on', Math.abs(Math.log(t.stretch / CHIPS[k])) < 0.03));
    this.engineBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(ENGINES[k].id === t.engine)));
    this.sound.show(t.engine);
    this.linkNote.textContent = t.link
      ? t.engine === 'tape'
        ? 'Linked, like a tape reel: slower is lower, faster is higher.'
        : 'Linked: the pitch drops as you stretch, like tape.'
      : 'Unlinked: pitch and stretch are independent.';
  }

  /** Redraw from the engine: waveform, loop window, peak. */
  refresh() {
    const e = this.engine;
    const t = e.tracks[this.i];
    this.wave.setPeaks(e.peaks[this.i], t.seconds, t.start, t.end);
    this.root.classList.toggle('empty', !e.peaks[this.i]);
    const loop = e.loops[this.i];
    if (loop) {
      const pk = peakOf(loop);
      this.peakText.textContent = `${fmtTime(t.seconds)} · peak ${pk > 0 ? (20 * Math.log10(pk)).toFixed(1) : '−∞'} dBFS`;
    } else this.peakText.textContent = 'Empty';
    this.normBtn.disabled = !loop;
    this.syncState();
  }

  /** Recording look and which buttons are available right now. */
  syncState() {
    const e = this.engine;
    const recording = e.recTrack === this.i;
    this.rec.setAttribute('aria-pressed', String(recording));
    this.rec.disabled = e.recTrack >= 0 && !recording;
    this.root.classList.toggle('is-recording', recording);
    this.wave.setRecording(recording);
  }
}
