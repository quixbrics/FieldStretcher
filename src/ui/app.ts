/*
 * FieldStretcher — mobile UI. Portrait, one hand: two track cards, an FX tab, a
 * Seq tab, a fixed transport at the bottom and settings in a sheet.
 */
import { Engine, MAX_MIX_SECONDS, TRACKS } from '../audio/engine';
import { MAX_SECONDS } from '../audio/loopfx';
import { encodeWav } from '../audio/wav';
import { stamp } from '../io/project';
import { loadSaved } from '../io/autosave';
import { buildFxPanel, wetDryRow } from './fxPanel';
import { buildSeqPanel } from './seqPanel';
import { buildSheet } from './settings';
import { TrackCard } from './trackCard';
import { fmtTime, h } from './dom';

/** survives a rebuild of the UI (a project opening or a scene applying re-creates every control) */
let activeTab = 0;
let pendingMessage = '';
let uiLife: AbortController | null = null;

export function mountApp(root: HTMLElement, engine: Engine) {
  uiLife?.abort();
  uiLife = new AbortController();
  const life = uiLife.signal;
  engine.clearUiListeners();

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
  const busy = () => {
    if (engine.recTrack >= 0) {
      say('Stop recording first.');
      return true;
    }
    return false;
  };

  /* ------------------------------------------------------------ cards -- */

  const showMicNote = () => {
    micNote.textContent = engine.micError ? `${engine.micError} Tap the red button to try again.` : '';
    micNote.hidden = !engine.micError;
  };
  const cards: TrackCard[] = [];
  const syncAll = () => {
    cards.forEach((c) => c.syncState());
    playBtn.disabled = engine.recTrack >= 0;
  };

  async function onRec(i: number) {
    if (!engine.started) await engine.start();
    if (engine.recTrack === i) return stopRec();
    if (engine.recTrack >= 0) return;
    // the track is claimed at once; the mic may take a moment to open on a phone
    const started = engine.startRecording(i);
    cards[i].wave.setRecLevel(0, '00:00');
    syncAll();
    if (!(await started)) {
      syncAll();
      say(engine.micError ?? 'Could not start the microphone.');
      showMicNote();
    } else {
      micNote.hidden = true;
    }
  }

  async function stopRec() {
    const i = engine.recTrack;
    if (i < 0) return;
    const r = await engine.stopRecording();
    syncAll();
    if (r.ok) return;
    if (r.reason === 'quiet') say('No signal heard — check the microphone.');
    else if (r.reason === 'short') say('Too short — hold on for at least ¼ second.');
  }

  for (let i = 0; i < TRACKS; i++) cards.push(new TrackCard(engine, i, { say, rec: (k) => void onRec(k) }));

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

  const sheet = buildSheet(engine, { say, busy, after: (m) => (pendingMessage = m) });

  /* ---- mix recording ---- */
  const mixBtn = h('button', { class: 'mixrec', 'aria-pressed': false, 'aria-label': 'Record the mix', onclick: () => void toggleMix() }, '● Mix');
  if (engine.bouncing) {
    mixBtn.setAttribute('aria-pressed', 'true');
    mixBtn.textContent = '■ …';
  }
  async function toggleMix() {
    if (!engine.started) return say('Tap to start first.');
    if (!engine.bouncing) {
      if (engine.startBounce()) {
        mixBtn.setAttribute('aria-pressed', 'true');
        mixBtn.textContent = '■ 00:00';
      }
      return;
    }
    mixBtn.disabled = true;
    const out = await engine.stopBounce();
    mixBtn.disabled = false;
    mixBtn.setAttribute('aria-pressed', 'false');
    mixBtn.textContent = '● Mix';
    syncAll();
    if (!out) return say('Nothing was recorded.');
    sheet.offerFile(encodeWav([out.l, out.r], out.sampleRate, 24), `FieldStretcher-mix-${stamp()}.wav`, `Mix ${fmtTime(out.l.length / out.sampleRate)}`);
  }

  /* ------------------------------------------------------------- layout -- */

  const header = h('header', { class: 'top' },
    h('h1', {}, 'Field', h('b', {}, 'Stretcher')),
    h('div', { class: 'in-meter', title: 'Microphone level' }, inputBar),
    limiter,
    h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => sheet.open() }, '⚙'),
  );
  const transport = h('footer', { class: 'transport' }, playBtn, mixBtn, h('label', { class: 'master' }, h('span', {}, 'Vol'), master));

  const wetBar = h('div', { class: 'wetbar' }, wetDryRow(engine));
  const trackList = h('main', { class: 'tracks', id: 'tab-tracks' }, micNote, wetBar, ...cards.map((c) => c.root));
  const fxList = h('main', { class: 'tracks', id: 'tab-fx', hidden: true }, buildFxPanel(engine));
  const seqList = h('main', { class: 'tracks', id: 'tab-seq', hidden: true }, buildSeqPanel(engine, life));
  const panels = [trackList, fxList, seqList];
  const tabBtns = ['Tracks', 'FX', 'Seq'].map((label, k) =>
    h('button', { class: 'tab', role: 'tab', 'aria-selected': k === activeTab, onclick: () => {
      activeTab = k;
      tabBtns.forEach((b, j) => b.setAttribute('aria-selected', String(j === k)));
      panels.forEach((p, j) => (p.hidden = j !== k));
    } }, label),
  );
  panels.forEach((p, j) => (p.hidden = j !== activeTab));
  const tabs = h('nav', { class: 'tabs', role: 'tablist' }, ...tabBtns);
  const shell = h('div', { class: 'shell' }, header, tabs, banner, trackList, fxList, seqList, transport, sheet.el, toast);

  /* ------------------------------------------------------------- splash -- */

  const splash = h('div', { class: 'splash' },
    h('div', { class: 'splash-card' },
      h('img', { class: 'splash-icon', src: `${import.meta.env.BASE_URL}icon-192.png`, alt: '', width: 72, height: 72 }),
      h('h1', {}, 'Field', h('b', {}, 'Stretcher')),
      h('p', {}, 'Record the world onto two loops, stretch each one into a drone, and wash it through resonance, delay and reverb.'),
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
        // bring back the last session, if there is one
        const saved = await loadSaved();
        if (saved && saved.loops.some(Boolean)) {
          pendingMessage = 'Restored your last session';
          engine.applyProject(saved.project, saved.loops, saved.sampleRate);
        }
        splash.remove();
        syncPlay();
        showMicNote();
      } }, 'Tap to start'),
    ),
  );

  root.replaceChildren(...(engine.started ? [shell] : [shell, splash]));
  root.removeAttribute('aria-busy');
  showMicNote();
  if (pendingMessage) {
    say(pendingMessage);
    pendingMessage = '';
  }
  syncPlay();
  syncAll();

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
    track(i) {
      cards[i]?.refresh();
      syncAll();
    },
    trackParams(i) {
      cards[i]?.syncControls();
    },
    // a project, scene or new-project replaced the state: rebuild every control from it
    project() {
      mountApp(root, engine);
    },
    bounceTime(sec) {
      mixBtn.textContent = `■ ${fmtTime(sec)}`;
    },
    bounceAutoStop() {
      void toggleMix();
      say(`Reached ${MAX_MIX_SECONDS / 60} minutes.`);
    },
  };
}
