/*
 * One track's card: mode, a picture of what the mode is doing beside the waveform,
 * stretch and glide, FX send, toggles, the mode's own Sound controls, and a More
 * section. Track 1 and 2 record from the mic; the Bounce track is filled by dubbing.
 */
import { BOUNCE, Engine, MIC_TRACKS, trackName, type EngineKind } from '../audio/engine';
import { peakOf } from '../audio/loopfx';
import { Wave } from './wave';
import { ModeViz } from './viz';
import { buildSoundPanel } from './soundPanel';
import { fmtSemis, fmtStretch, fmtTime, h, posFromStretch, stretchFromPos } from './dom';

export const ENGINES: { id: EngineKind; label: string; tip: string }[] = [
  { id: 'spectral', label: 'Spectral', tip: 'Smooth, endless drones (Paulstretch). Pitch stays put as you stretch.' },
  { id: 'granular', label: 'Granular', tip: 'A shimmering cloud of tiny grains. Great for rain, steps, rustle.' },
  { id: 'tape', label: 'Tape', tip: 'Slow it down like a reel: pitch falls as the stretch grows.' },
];
const CHIPS = [1, 4, 16, 64, 256, 1000];

/** glide slider position 0–1 ⇄ seconds: the first few percent is "off", then 0.1 s – 10 s on a log scale */
const glideFrom = (v: number) => (v < 0.03 ? 0 : 0.1 * Math.pow(100, (v - 0.03) / 0.97));
const posFromGlide = (g: number) => (g <= 0 ? 0 : 0.03 + (0.97 * Math.log(g / 0.1)) / Math.log(100));
const fmtGlide = (g: number) => (g <= 0 ? 'off' : g < 10 ? `${g.toFixed(1)} s` : '10 s');

export interface CardHooks {
  say(msg: string): void;
  rec(i: number): void;
  dub(i: number): void;
}

export class TrackCard {
  readonly root: HTMLElement;
  readonly wave = new Wave();
  readonly viz: ModeViz;
  private rec: HTMLButtonElement | null = null;
  private dubBtn: HTMLButtonElement | null = null;
  private peakText = h('p', { class: 'hint mono' });
  private normBtn: HTMLButtonElement;

  constructor(private engine: Engine, private i: number, hooks: CardHooks) {
    const t = engine.tracks[i];
    const isBounce = i === BOUNCE;
    this.viz = new ModeViz(engine, i);

    const range = (cls: string, min: number, max: number, step: number, value: number, label: string, onInput: (v: number) => void) => {
      const el = h('input', { class: `range ${cls}`, type: 'range', min, max, step, value, 'aria-label': `${trackName(i)} ${label}` });
      el.addEventListener('input', () => onInput(Number(el.value)));
      return el;
    };

    /* ---- stretch, glide, send ---- */
    const stretchOut = h('output', { class: 'mono val' }, fmtStretch(t.stretch));
    const stretch = range('stretch-range', 0, 1, 0.001, posFromStretch(t.stretch), 'stretch', (v) => {
      const s = stretchFromPos(v);
      engine.update(i, { stretch: s });
      stretchOut.textContent = fmtStretch(s);
      syncChips();
    });
    const chips = CHIPS.map((c) =>
      h('button', { class: 'chip mono', onclick: () => {
        stretch.value = String(posFromStretch(c));
        engine.update(i, { stretch: c });
        stretchOut.textContent = fmtStretch(c);
        syncChips();
      } }, c === 1000 ? '1k×' : `${c}×`),
    );
    const syncChips = () => chips.forEach((b, k) => b.classList.toggle('on', Math.abs(Math.log(engine.tracks[i].stretch / CHIPS[k])) < 0.03));
    syncChips();

    const glideOut = h('output', { class: 'mono val' }, fmtGlide(t.glide));
    const glide = range('', 0, 1, 0.005, posFromGlide(t.glide), 'glide', (v) => {
      const g = glideFrom(v);
      engine.update(i, { glide: g });
      glideOut.textContent = fmtGlide(g);
    });
    const glideRow = h('div', { class: 'row', title: 'How long a change of stretch takes to arrive. On tape it is the motor’s inertia: also how long it takes to wind down when frozen.' }, h('label', {}, 'Glide'), glide, glideOut);

    const sendOut = h('output', { class: 'mono val' }, `${Math.round(t.send * 100)}%`);
    const sendRow = h('div', { class: 'row send' }, h('label', {}, 'Send'), range('', 0, 1, 0.01, t.send, 'FX send', (v) => {
      engine.update(i, { send: v });
      sendOut.textContent = `${Math.round(v * 100)}%`;
    }), sendOut);

    /* ---- mode ---- */
    const sound = buildSoundPanel(engine, i, () => {});
    const engineBtns = ENGINES.map((e) =>
      h('button', { class: 'seg-btn', title: e.tip, 'aria-pressed': e.id === t.engine, onclick: () => {
        engine.update(i, { engine: e.id });
        engineBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(ENGINES[k].id === e.id)));
        sound.show(e.id);
        this.viz.setEngine(e.id);
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
    );
    if (!isBounce) {
      toggles.append(toggle('Overdub', 'overdub', 'Record layers over the loop at the playhead instead of replacing it'));
      this.dubBtn = h('button', { class: 'tog dub', title: 'Record this track — stretched, with its FX — onto the Bounce track. It plays on its own while you do.', onclick: () => hooks.dub(i) }, 'Dub → B');
      toggles.append(this.dubBtn);
    }

    /* ---- header ---- */
    const mute = h('button', { class: 'mute', 'aria-label': `Mute ${trackName(i)}`, 'aria-pressed': t.mute, onclick: () => {
      engine.update(i, { mute: !engine.tracks[i].mute });
      mute.setAttribute('aria-pressed', String(engine.tracks[i].mute));
    } }, 'M');
    const header = h('header', {}, h('span', { class: 'num mono' }, isBounce ? 'B' : String(i + 1)), h('div', { class: 'seg', role: 'group', 'aria-label': 'Stretch mode' }, ...engineBtns), mute);
    if (!isBounce) {
      this.rec = h('button', { class: 'rec', 'aria-label': `Record track ${i + 1}`, 'aria-pressed': false, onclick: () => hooks.rec(i) }, h('i', {}));
      header.append(this.rec);
    }

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
    const pitchOut = h('output', { class: 'mono val' }, fmtSemis(t.pitch));
    const more = h('details', { class: 'more' },
      h('summary', {}, 'More'),
      h('div', { class: 'row' }, h('label', {}, 'Pitch'), range('', -24, 24, 1, t.pitch, 'pitch', (v) => {
        engine.update(i, { pitch: v });
        pitchOut.textContent = fmtSemis(v);
      }), pitchOut),
      h('div', { class: 'row' }, h('label', {}, 'Level'), range('', 0, 1, 0.01, t.level, 'level', (v) => {
        engine.update(i, { level: v });
        lvlOut.textContent = `${Math.round(v * 100)}%`;
      }), lvlOut),
      h('div', { class: 'row' }, h('label', {}, 'Pan'), range('', -1, 1, 0.01, t.pan, 'pan', (v) => engine.update(i, { pan: v })), h('span', {})),
      h('div', { class: 'row', title: isBounce ? 'How much of what is on the Bounce track survives when you dub onto it again' : 'How much of the old loop survives when you overdub' },
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

    this.wave.setEmptyText(isBounce ? 'Nothing here yet. Use “Dub → B” on a track.' : 'Tap ● to record, or load a sound');
    this.wave.onWindow = (s, e) => engine.update(i, { start: s, end: e });

    this.root = h('section', { class: `track${isBounce ? ' bounce' : ''}`, style: `--c:var(--track-${i + 1});--cl:var(--track-${i + 1}-label)`, 'aria-label': trackName(i) },
      header,
      h('div', { class: 'viewrow' }, this.viz.el, this.wave.el),
      h('div', { class: 'stretch' },
        h('div', { class: 'row' }, h('label', {}, 'Stretch'), stretchOut),
        stretch,
        h('div', { class: 'chips' }, ...chips),
        glideRow,
      ),
      sendRow,
      toggles,
      h('details', { class: 'sound-sec', open: true }, h('summary', {}, 'Sound'), sound.el),
      more,
    );
    this.refresh();
  }

  /** Redraw from the engine: waveform, loop window, level readout, peak. */
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

  /** Recording / dubbing look and which buttons are available right now. */
  syncState() {
    const e = this.engine;
    const i = this.i;
    const recording = e.recTrack === i;
    this.rec?.setAttribute('aria-pressed', String(recording));
    if (this.rec) this.rec.disabled = e.dubbing || (e.recTrack >= 0 && !recording);
    this.root.classList.toggle('is-recording', recording);
    if (i < MIC_TRACKS) this.wave.setRecording(recording);
    if (i === BOUNCE) this.wave.setRecording(e.dubbing);
    if (this.dubBtn) {
      const mine = e.dubSource === i;
      this.dubBtn.setAttribute('aria-pressed', String(mine));
      if (!mine) this.dubBtn.textContent = 'Dub → B';
      this.dubBtn.disabled = !e.loops[i] || e.recTrack >= 0 || e.bouncing || (e.dubbing && !mine);
    }
  }

  setDubTime(sec: number) {
    if (this.dubBtn && this.engine.dubSource === this.i) this.dubBtn.textContent = `■ ${fmtTime(sec)}`;
  }
}
