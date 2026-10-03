/*
 * FieldStretcher — mobile UI. Portrait, one hand: four track cards, a fixed
 * transport at the bottom, settings in a sheet.
 */
import { Engine, TRACKS, type EngineKind, type Quality } from '../audio/engine';
import { MAX_SECONDS } from '../audio/loopfx';
import { Wave } from './wave';
import { buildFxPanel } from './fxPanel';
import { buildSeqPanel } from './seqPanel';
import { fmtSemis, fmtStretch, fmtTime, h, posFromStretch, stretchFromPos } from './dom';

const ENGINES: { id: EngineKind; label: string; tip: string }[] = [
  { id: 'spectral', label: 'Spectral', tip: 'Smooth, endless drones (Paulstretch). Pitch stays put as you stretch.' },
  { id: 'granular', label: 'Granular', tip: 'A shimmering cloud of tiny grains. Great for rain, steps, rustle.' },
  { id: 'tape', label: 'Tape', tip: 'Slow it down like a reel: pitch falls as the stretch grows.' },
];
const CHIPS = [1, 4, 16, 64, 256, 1000];
const QUALITY_KEY = 'fieldstretcher.quality';

interface Card {
  root: HTMLElement;
  wave: Wave;
  rec: HTMLButtonElement;
  mute: HTMLButtonElement;
  stretchOut: HTMLElement;
  stretch: HTMLInputElement;
  pitch: HTMLInputElement;
  pitchOut: HTMLElement;
  engineBtns: HTMLButtonElement[];
  reverse: HTMLButtonElement;
  freeze: HTMLButtonElement;
  chips: HTMLButtonElement[];
}

export function mountApp(root: HTMLElement, engine: Engine) {
  const cards: Card[] = [];
  let toastTimer = 0;
  const toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  const banner = h('button', { class: 'banner', hidden: true, onclick: () => void engine.start() }, 'Audio paused — tap to resume');
  const micNote = h('p', { class: 'mic-note', hidden: true });
  const inputBar = h('i', { class: 'in-bar' });
  const limiter = h('span', { class: 'led', title: 'Safety limiter', 'aria-label': 'Safety limiter' });
  let inputHold = 0;

  const say = (msg: string) => {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3200);
  };

  /* ------------------------------------------------------------ cards -- */

  function buildCard(i: number): Card {
    const t = engine.tracks[i];
    const wave = new Wave();
    const input = (cls: string, min: number, max: number, step: number, value: number, label: string, onInput: (v: number) => void) => {
      const el = h('input', { class: `range ${cls}`, type: 'range', min, max, step, value, 'aria-label': `Track ${i + 1} ${label}` });
      el.addEventListener('input', () => onInput(Number(el.value)));
      return el;
    };
    const stretchOut = h('output', { class: 'mono val' }, fmtStretch(t.stretch));
    const stretch = input('stretch-range', 0, 1, 0.001, posFromStretch(t.stretch), 'stretch', (v) => {
      const s = stretchFromPos(v);
      engine.update(i, { stretch: s });
      stretchOut.textContent = fmtStretch(s);
      syncChips();
    });
    const sendOut = h('output', { class: 'mono val' }, `${Math.round(t.send * 100)}%`);
    const pitchOut = h('output', { class: 'mono val' }, fmtSemis(t.pitch));
    const pitch = input('', -24, 24, 1, t.pitch, 'pitch', (v) => {
      engine.update(i, { pitch: v });
      pitchOut.textContent = fmtSemis(v);
    });

    const engineBtns = ENGINES.map((e) =>
      h('button', {
        class: 'seg-btn',
        title: e.tip,
        'aria-pressed': e.id === t.engine,
        onclick: () => {
          engine.update(i, { engine: e.id });
          syncEngine();
        },
      }, e.label),
    );
    const syncEngine = () => engineBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(ENGINES[k].id === engine.tracks[i].engine)));

    const chips = CHIPS.map((c) =>
      h('button', {
        class: 'chip mono',
        onclick: () => {
          stretch.value = String(posFromStretch(c));
          engine.update(i, { stretch: c });
          stretchOut.textContent = fmtStretch(c);
          syncChips();
        },
      }, c === 1000 ? '1k×' : `${c}×`),
    );
    const syncChips = () => chips.forEach((b, k) => b.classList.toggle('on', Math.abs(Math.log(engine.tracks[i].stretch / CHIPS[k])) < 0.03));
    syncChips();

    const toggle = (label: string, key: 'reverse' | 'freeze', tip: string) => {
      const b = h('button', { class: 'tog', title: tip, 'aria-pressed': t[key] }, label);
      b.addEventListener('click', () => {
        engine.update(i, { [key]: !engine.tracks[i][key] });
        b.setAttribute('aria-pressed', String(engine.tracks[i][key]));
      });
      return b;
    };
    const reverse = toggle('Reverse', 'reverse', 'Play the loop backwards');
    const freeze = toggle('Freeze', 'freeze', 'Hold this moment as a drone');

    const rec = h('button', { class: 'rec', 'aria-label': `Record track ${i + 1}`, 'aria-pressed': false, onclick: () => void onRec(i) }, h('i', {}));
    const mute = h('button', { class: 'mute', 'aria-label': `Mute track ${i + 1}`, 'aria-pressed': t.mute, onclick: () => {
      engine.update(i, { mute: !engine.tracks[i].mute });
      mute.setAttribute('aria-pressed', String(engine.tracks[i].mute));
    } }, 'M');

    const file = h('input', { type: 'file', accept: 'audio/*', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      if (!engine.started) await engine.start();
      try {
        const r = await engine.importFile(i, f);
        if (!r.ok) say(r.reason === 'quiet' ? 'That file is silent.' : 'That sound is too short (min ¼ s).');
      } catch {
        say('Could not read that audio file.');
      }
    });
    const more = h('details', { class: 'more' },
      h('summary', {}, 'More'),
      h('div', { class: 'row' }, h('label', {}, 'Pitch'), pitch, pitchOut),
      h('div', { class: 'row' }, h('label', {}, 'Level'), input('', 0, 1, 0.01, t.level, 'level', (v) => engine.update(i, { level: v })), h('span', {})),
      h('div', { class: 'row' }, h('label', {}, 'Pan'), input('', -1, 1, 0.01, t.pan, 'pan', (v) => engine.update(i, { pan: v })), h('span', {})),
      h('div', { class: 'row actions' },
        h('button', { class: 'btn', onclick: () => file.click() }, 'Load sound…'),
        h('button', { class: 'btn danger', onclick: () => { engine.clearTrack(i); } }, 'Clear'),
        file,
      ),
    );

    const rootEl = h('section', { class: 'track', style: `--c:var(--track-${i + 1});--cl:var(--track-${i + 1}-label)`, 'aria-label': `Track ${i + 1}` },
      h('header', {}, h('span', { class: 'num mono' }, String(i + 1)), h('div', { class: 'seg', role: 'group', 'aria-label': 'Stretch engine' }, ...engineBtns), mute, rec),
      wave.el,
      h('div', { class: 'stretch' },
        h('div', { class: 'row' }, h('label', {}, 'Stretch'), stretchOut),
        stretch,
        h('div', { class: 'chips' }, ...chips),
      ),
      h('div', { class: 'row send' }, h('label', {}, 'Send'), input('', 0, 1, 0.01, t.send, 'FX send', (v) => { engine.update(i, { send: v }); sendOut.textContent = `${Math.round(v * 100)}%`; }), sendOut),
      h('div', { class: 'toggles' }, reverse, freeze),
      more,
    );
    wave.onWindow = (s, e) => engine.update(i, { start: s, end: e });
    return { root: rootEl, wave, rec, mute, stretchOut, stretch, pitch, pitchOut, engineBtns, reverse, freeze, chips };
  }

  function refreshTrack(i: number) {
    const c = cards[i];
    c.wave.setPeaks(engine.peaks[i], engine.tracks[i].seconds);
    c.root.classList.toggle('empty', !engine.peaks[i]);
  }

  async function onRec(i: number) {
    if (!engine.started) await engine.start();
    const c = cards[i];
    if (engine.recTrack === i) return stopRec();
    if (engine.recTrack >= 0) return;
    if (!engine.hasMic) {
      say(engine.micError ?? 'No microphone available.');
      return;
    }
    if (engine.startRecording(i)) setRecUi(i, true);
    c.rec.focus({ preventScroll: true });
  }

  async function stopRec() {
    const i = engine.recTrack;
    if (i < 0) return;
    setRecUi(i, false);
    const r = await engine.stopRecording();
    if (r.ok) return;
    if (r.reason === 'quiet') say('No signal heard — check the microphone.');
    else if (r.reason === 'short') say('Too short — hold on for at least ¼ second.');
  }

  function setRecUi(i: number, on: boolean) {
    cards.forEach((c, k) => {
      c.rec.setAttribute('aria-pressed', String(on && k === i));
      c.rec.disabled = on && k !== i;
      c.root.classList.toggle('is-recording', on && k === i);
    });
    cards[i].wave.setRecording(on);
    playBtn.disabled = on;
  }

  /* ---------------------------------------------------------- transport -- */

  const playBtn = h('button', { class: 'play', onclick: () => {
    engine.setPlaying(!engine.playing);
    syncPlay();
  } });
  const syncPlay = () => {
    playBtn.textContent = engine.playing ? '■  Stop' : '▶  Play';
    playBtn.setAttribute('aria-pressed', String(engine.playing));
  };
  const master = h('input', { class: 'range', type: 'range', min: 0, max: 1, step: 0.01, value: engine.masterLevel, 'aria-label': 'Master level' });
  master.addEventListener('input', () => engine.setMaster(Number(master.value)));

  /* ----------------------------------------------------------- settings -- */

  const sheet = h('div', { class: 'sheet', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' });
  const closeSheet = () => (sheet.hidden = true);
  const qualityBtns = (['draft', 'normal', 'high'] as Quality[]).map((q) =>
    h('button', { class: 'seg-btn', 'aria-pressed': engine.quality === q, onclick: () => {
      engine.setQuality(q);
      try { localStorage.setItem(QUALITY_KEY, q); } catch { /* private mode */ }
      qualityBtns.forEach((b, k) => b.setAttribute('aria-pressed', String((['draft', 'normal', 'high'] as Quality[])[k] === q)));
    } }, q[0].toUpperCase() + q.slice(1)),
  );
  sheet.append(
    h('div', { class: 'sheet-body' },
      h('h2', {}, 'Settings'),
      h('h3', {}, 'Spectral quality'),
      h('div', { class: 'seg' }, ...qualityBtns),
      h('p', { class: 'hint' }, 'Higher is smoother at big stretches but uses more battery. Normal suits most phones.'),
      h('h3', {}, 'Recording tips'),
      h('p', { class: 'hint' }, `Use headphones so the mic does not hear the speaker. Takes run up to ${MAX_SECONDS} seconds. Phone mics are quiet, so every take is levelled for you.`),
      h('h3', {}, 'If something goes wrong'),
      h('button', { class: 'btn', onclick: () => { engine.panic(); closeSheet(); say('Reset.'); } }, 'Reset audio engine'),
      h('button', { class: 'btn primary', onclick: closeSheet }, 'Done'),
    ),
  );
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

  /* ------------------------------------------------------------- layout -- */

  for (let i = 0; i < TRACKS; i++) cards.push(buildCard(i));

  const header = h('header', { class: 'top' },
    h('h1', {}, 'Field', h('b', {}, 'Stretcher')),
    h('div', { class: 'in-meter', title: 'Microphone level' }, inputBar),
    limiter,
    h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => (sheet.hidden = false) }, '⚙'),
  );
  const transport = h('footer', { class: 'transport' }, playBtn, h('label', { class: 'master' }, h('span', {}, 'Master'), master));

  const trackList = h('main', { class: 'tracks', id: 'tab-tracks' }, micNote, ...cards.map((c) => c.root));
  const fxList = h('main', { class: 'tracks', id: 'tab-fx', hidden: true }, buildFxPanel(engine));
  const seqList = h('main', { class: 'tracks', id: 'tab-seq', hidden: true }, buildSeqPanel(engine));
  const panels = [trackList, fxList, seqList];
  const tabBtns = ['Tracks', 'FX', 'Seq'].map((label, k) =>
    h('button', { class: 'tab', role: 'tab', 'aria-selected': k === 0, onclick: () => {
      tabBtns.forEach((b, j) => b.setAttribute('aria-selected', String(j === k)));
      panels.forEach((p, j) => (p.hidden = j !== k));
    } }, label),
  );
  const tabs = h('nav', { class: 'tabs', role: 'tablist' }, ...tabBtns);
  const shell = h('div', { class: 'shell' }, header, tabs, banner, trackList, fxList, seqList, transport, sheet, toast);

  /* ------------------------------------------------------------- splash -- */

  const splash = h('div', { class: 'splash' },
    h('div', { class: 'splash-card' },
      h('img', { class: 'splash-icon', src: `${import.meta.env.BASE_URL}icon-192.png`, alt: '', width: 72, height: 72 }),
      h('h1', {}, 'Field', h('b', {}, 'Stretcher')),
      h('p', {}, 'Record the world on four loops, stretch each one into a drone, then wash it through resonance, delay and reverb.'),
      h('p', { class: 'hint' }, 'Headphones recommended. FieldStretcher needs your microphone to record — nothing leaves your phone.'),
      h('button', { class: 'btn primary big', onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        b.textContent = 'Starting…';
        try {
          await engine.start();
        } catch (err) {
          b.disabled = false;
          b.textContent = 'Try again';
          say(`Could not start audio: ${(err as Error).message}`);
          return;
        }
        if (engine.micError) {
          micNote.textContent = engine.micError;
          micNote.hidden = false;
        }
        splash.remove();
        syncPlay();
      } }, 'Tap to start'),
    ),
  );

  root.replaceChildren(shell, splash);
  root.removeAttribute('aria-busy');
  cards.forEach((_, i) => refreshTrack(i));
  syncPlay();

  /* ------------------------------------------------------------- events -- */

  engine.events = {
    level(peak) {
      // fast rise, slow fall
      inputHold = Math.max(peak, inputHold * 0.85);
      inputBar.style.transform = `scaleX(${Math.min(1, Math.sqrt(inputHold))})`;
      inputBar.classList.toggle('hot', peak > 0.9);
      if (engine.recTrack >= 0) cards[engine.recTrack].wave.setRecLevel(peak);
    },
    pos(track, v) {
      cards[track]?.wave.setPos(v);
    },
    limiter(gr) {
      limiter.classList.toggle('on', gr < -1);
    },
    ctxState(state) {
      banner.hidden = state === 'running';
    },
    recTime(track, sec) {
      cards[track].wave.setRecLevel(0, `${fmtTime(sec)} / ${fmtTime(MAX_SECONDS)}`);
    },
    recAutoStop() {
      void stopRec();
      say(`Reached ${MAX_SECONDS} seconds.`);
    },
    blowup() {
      say('Audio glitch caught and reset.');
    },
    track: refreshTrack,
  };
}

export function restoreQuality(engine: Engine) {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    if (q === 'draft' || q === 'normal' || q === 'high') engine.quality = q;
  } catch { /* private mode */ }
}
