/*
 * The Settings sheet: scenes (stock and your own), project files, offline
 * render, and the audio facts. It also hosts the "your file is ready" card, so
 * the Share / Save tap is a real tap (the share sheet needs one).
 */
import { Engine, MAX_MIX_SECONDS, type Scene } from '../audio/engine';
import { MAX_SECONDS } from '../audio/loopfx';
import { RENDER_LENGTHS, renderOffline } from '../audio/render';
import { clearSaved } from '../io/autosave';
import { packProject, shareOrDownload, stamp, unpackProject } from '../io/project';
import { SCENES } from '../io/scenes';
import { deleteUserScene, loadUserScenes, saveUserScene } from '../io/userScenes';
import { makeZip } from '../io/zip';
import { getTheme, setTheme, type Theme } from './theme';
import { fmtTime, h } from './dom';

export interface SheetHelpers {
  say(msg: string): void;
  /** true (and says so) if something is recording */
  busy(): boolean;
  /** a message to show once the UI has been rebuilt from new state */
  after(msg: string): void;
}

export interface Sheet {
  el: HTMLElement;
  open(): void;
  close(): void;
  offerFile(blob: Blob, name: string, what: string): void;
}

const fmtLen = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);

export function buildSheet(engine: Engine, hp: SheetHelpers): Sheet {
  const el = h('div', { class: 'sheet', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' });
  const close = () => (el.hidden = true);

  /* ---- a finished file, waiting for a tap ---- */
  const fileSlot = h('div', { class: 'file-ready', hidden: true });
  const offerFile = (blob: Blob, name: string, what: string) => {
    const mb = (blob.size / 1048576).toFixed(1);
    const go = h('button', { class: 'btn primary', onclick: async () => {
      const r = await shareOrDownload(blob, name);
      if (r !== 'cancelled') {
        fileSlot.hidden = true;
        hp.say(r === 'shared' ? 'Shared.' : 'Saved to your downloads.');
      }
    } }, 'Share / Save');
    fileSlot.replaceChildren(h('p', {}, h('b', {}, what), ` · ${mb} MB`), h('p', { class: 'hint mono' }, name), h('div', { class: 'row actions' }, go, h('button', { class: 'btn', onclick: () => (fileSlot.hidden = true) }, 'Discard')));
    fileSlot.hidden = false;
    el.hidden = false;
    fileSlot.scrollIntoView({ block: 'nearest' });
  };

  /* ---- scenes ---- */
  const grid = h('div', { class: 'scenes' });
  const apply = (sc: Scene) => {
    if (hp.busy()) return;
    hp.after(`Scene: ${sc.name}`);
    engine.applyScene(sc);
  };
  const renderScenes = () => {
    const cell = (sc: Scene) => {
      const b = h('button', { class: 'scene', onclick: () => apply(sc) }, h('b', {}, sc.name), h('span', {}, sc.blurb));
      if (!sc.user) return b;
      let armed = 0;
      const del = h('button', { class: 'scene-del', 'aria-label': `Delete scene ${sc.name}`, onclick: () => {
        if (!armed) {
          del.textContent = 'Delete?';
          armed = window.setTimeout(() => { armed = 0; del.textContent = '✕'; }, 3000);
          return;
        }
        window.clearTimeout(armed);
        deleteUserScene(sc.name);
        renderScenes();
      } }, '✕');
      return h('div', { class: 'scene-wrap' }, b, del);
    };
    grid.replaceChildren(...SCENES.map(cell), ...loadUserScenes().map(cell));
  };
  renderScenes();
  const nameBox = h('input', { class: 'text', type: 'text', maxlength: 40, placeholder: 'Name this scene', 'aria-label': 'Scene name', autocomplete: 'off' });
  const saveScene = () => {
    const name = nameBox.value.trim();
    if (!name) return hp.say('Give the scene a name first.');
    if (SCENES.some((s) => s.name === name)) return hp.say('That name is used by a built-in scene.');
    if (!saveUserScene(engine.captureScene(name))) return hp.say('Could not save (is storage full or blocked?).');
    nameBox.value = '';
    renderScenes();
    hp.say(`Saved scene “${name}”.`);
  };

  /* ---- project ---- */
  const openFile = h('input', { type: 'file', accept: '.fieldstretcher,.zip,application/zip', hidden: true });
  openFile.addEventListener('change', async () => {
    const f = openFile.files?.[0];
    openFile.value = '';
    if (!f || hp.busy()) return;
    try {
      const { project, loops, sampleRate } = unpackProject(await f.arrayBuffer());
      hp.after(`Opened ${f.name}`);
      engine.applyProject(project, loops, sampleRate);
    } catch (e) {
      hp.say((e as Error).message || 'Could not open that file.');
    }
  });
  let eraseArmed = 0;
  const eraseBtn = h('button', { class: 'btn danger', onclick: async () => {
    if (hp.busy()) return;
    if (!eraseArmed) {
      eraseBtn.textContent = 'Tap again to erase everything';
      eraseArmed = window.setTimeout(() => { eraseArmed = 0; eraseBtn.textContent = 'New project'; }, 3500);
      return;
    }
    window.clearTimeout(eraseArmed);
    eraseArmed = 0;
    eraseBtn.textContent = 'New project';
    await clearSaved();
    hp.after('New project');
    engine.newProject();
  } }, 'New project');

  /* ---- offline render ---- */
  let renderLen = 60;
  let stems = true;
  const status = h('p', { class: 'hint mono' });
  const lenBtns = RENDER_LENGTHS.map((s) =>
    h('button', { class: 'chip', 'aria-pressed': s === renderLen, onclick: () => {
      renderLen = s;
      lenBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(RENDER_LENGTHS[k] === s)));
    } }, fmtLen(s)),
  );
  const stemBtn = h('button', { class: 'tog', 'aria-pressed': stems, onclick: () => {
    stems = !stems;
    stemBtn.setAttribute('aria-pressed', String(stems));
  } }, 'Include each track as a stem');
  const renderBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (hp.busy()) return;
    if (engine.bouncing) return hp.say('Finish recording the mix first.');
    if (!engine.started) return hp.say('Tap to start first.');
    if (!engine.loops.some(Boolean)) return hp.say('Record or load a sound first.');
    const wasPlaying = engine.playing;
    // the render takes the processor's full attention: pause playback while it runs
    if (wasPlaying) engine.setPlaying(false);
    renderBtn.disabled = true;
    status.textContent = 'Starting…';
    try {
      const res = await renderOffline(engine, { seconds: renderLen, stems, onProgress: (p) => (status.textContent = `Rendering ${p.label} (${p.pass} of ${p.total})…`) });
      status.textContent = 'Packing…';
      if (res.stems.length) {
        const zip = await makeZip([{ name: 'mix.wav', data: res.mix }, ...res.stems.map((s) => ({ name: `stems/${s.name}`, data: s.blob }))]);
        offerFile(zip, `FieldStretcher-render-${stamp()}.zip`, `Render ${fmtLen(renderLen)} + ${res.stems.length} stem${res.stems.length > 1 ? 's' : ''}`);
      } else offerFile(res.mix, `FieldStretcher-render-${stamp()}.wav`, `Render ${fmtLen(renderLen)}`);
      status.textContent = '';
    } catch (e) {
      status.textContent = '';
      hp.say(`Render failed: ${(e as Error).message}`);
    } finally {
      renderBtn.disabled = false;
      if (wasPlaying) engine.setPlaying(true);
    }
  } }, 'Render');

  /* ---- appearance and audio ---- */
  const themeBtns = (['dark', 'light'] as Theme[]).map((t) =>
    h('button', { class: 'seg-btn', 'aria-pressed': getTheme() === t, onclick: () => {
      setTheme(t);
      themeBtns.forEach((b, k) => b.setAttribute('aria-pressed', String((['dark', 'light'] as Theme[])[k] === t)));
    } }, t === 'dark' ? 'Dark' : 'Light'),
  );
  const info = h('p', { class: 'hint mono' });
  const refreshInfo = () => {
    const d = engine.diag;
    const t = d.take;
    info.textContent =
      `Audio ${d.ctxRate || '–'} Hz · mic ${d.micRate ?? 'n/a'} Hz · session ${d.session} · mic ${engine.micOpen ? 'open' : 'closed'}` +
      (t ? ` · last take ${t.heardSeconds.toFixed(1)} s heard / ${t.realSeconds.toFixed(1)} s real${t.repaired !== 1 ? ` — speed corrected ×${(1 / t.repaired).toFixed(2)}` : ''}` : '');
  };

  el.append(
    h('div', { class: 'sheet-body' },
      h('h2', {}, 'Settings'),
      fileSlot,
      h('h3', {}, 'Scenes'),
      h('p', { class: 'hint' }, 'Starting points for the modes, FX and sequencer. Your recordings stay. Save your own below.'),
      grid,
      h('div', { class: 'save-row' }, nameBox, h('button', { class: 'btn', onclick: saveScene }, 'Save current as scene')),
      h('h3', {}, 'Project'),
      h('p', { class: 'hint' }, 'Your session is kept on this phone automatically. Save a project file to back it up or move it: it is a zip with the loops as WAVs inside.'),
      h('div', { class: 'row actions' },
        h('button', { class: 'btn', onclick: async () => {
          if (hp.busy()) return;
          if (!engine.loops.some(Boolean)) return hp.say('Record or load a sound first.');
          offerFile(await packProject(engine.getProject(), engine.loops), `FieldStretcher-${stamp()}.fieldstretcher`, 'Project');
        } }, 'Save project'),
        h('button', { class: 'btn', onclick: () => openFile.click() }, 'Open project…'),
        openFile,
      ),
      eraseBtn,
      h('h3', {}, 'Render'),
      h('p', { class: 'hint' }, 'Renders the mix faster than real time: every loop from the top, the sequencer replayed from its seed. Stems are each track on its own with its FX. Long renders with stems take a while on a phone, and playback pauses meanwhile.'),
      h('div', { class: 'chips wrap' }, ...lenBtns),
      h('div', { class: 'toggles' }, stemBtn),
      renderBtn,
      status,
      h('h3', {}, 'Appearance'),
      h('div', { class: 'seg' }, ...themeBtns),
      h('h3', {}, 'Recording'),
      h('p', { class: 'hint' }, `Use headphones so the mic does not hear the speaker. Takes run up to ${MAX_SECONDS} seconds and are recorded as they are: use Normalise (under More) to bring a quiet one up. ● Mix next to Play records everything you hear (up to ${fmtTime(MAX_MIX_SECONDS)}).`),
      info,
      h('h3', {}, 'If something goes wrong'),
      h('button', { class: 'btn', onclick: () => { engine.panic(); close(); hp.say('Reset.'); } }, 'Reset audio engine'),
      h('button', { class: 'btn primary', onclick: close }, 'Done'),
    ),
  );
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
  return {
    el,
    open: () => {
      refreshInfo();
      renderScenes();
      el.hidden = false;
    },
    close,
    offerFile,
  };
}
