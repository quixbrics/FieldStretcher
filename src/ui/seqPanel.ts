/*
 * The Seq tab: a generative sequencer that walks the resonator through a scale.
 */
import { Engine, NOTE_NAMES } from '../audio/engine';
import { MODES, MODE_ORDER } from '../music/theory';
import { MOTIONS, type Motion } from '../music/sequencer';
import { h } from './dom';
import { keyControls, pills, slider } from './fxPanel';

/** step length slider position (0–1) ⇄ seconds, 0.15 s – 30 s */
const rateFrom = (v: number) => 0.15 * Math.pow(200, v);
const posFromRate = (r: number) => Math.log(r / 0.15) / Math.log(200);
/** glide slider position ⇄ seconds, 5 ms – 4 s */
const glideFrom = (v: number) => 0.005 * Math.pow(800, v);
const posFromGlide = (g: number) => Math.log(g / 0.005) / Math.log(800);

const fmtSec = (t: number) => (t < 1 ? `${Math.round(t * 1000)} ms` : `${t.toFixed(t < 10 ? 1 : 0)} s`);

export function buildSeqPanel(engine: Engine): HTMLElement {
  const q = engine.sequencer;

  /* ---- on/off + now playing ---- */
  const nowName = h('b', { class: 'now-note mono' }, '–');
  const nowSub = h('span', { class: 'sub' }, 'stopped');
  const onBtn = h('button', { class: 'big-toggle', 'aria-pressed': engine.seq.on, onclick: () => engine.setSeqOn(!engine.seq.on) }, 'Sequencer');
  const head = h('section', { class: 'fx-card' },
    h('div', { class: 'seq-head' }, onBtn, h('div', { class: 'now' }, nowName, nowSub)),
    h('p', { class: 'hint' }, 'Moves the resonator through the scale. Set the Resonator’s Decay short and turn Pluck up to hear each step as a plucked note.'),
  );

  /* ---- the note strip ---- */
  const strip = h('div', { class: 'note-strip', role: 'group', 'aria-label': 'Scale notes — tap to play' });
  let stripBtns: HTMLButtonElement[] = [];
  const buildStrip = () => {
    const steps = MODES[q.s.scale].steps;
    stripBtns = [];
    for (let i = 0; i <= q.max; i++) {
      const semis = steps[i % steps.length] + 12 * Math.floor(i / steps.length);
      const name = NOTE_NAMES[(engine.fx.reso.root + semis) % 12];
      const b = h('button', { class: `note${i % steps.length === 0 ? ' tonic' : ''}`, 'aria-label': `${name}, play`, onclick: () => engine.seqSet(i) }, name);
      stripBtns.push(b);
    }
    strip.replaceChildren(...stripBtns);
  };

  /* ---- settings ---- */
  const scaleFeel = h('p', { class: 'hint' }, MODES[q.s.scale].feel);
  const motionTip = h('p', { class: 'hint' }, MOTIONS.find((m) => m.id === q.s.motion)?.tip ?? '');
  const scaleIds = MODE_ORDER;
  const scalePills = pills(scaleIds.map((id, i) => ({ label: MODES[id].name, value: i })), scaleIds.indexOf(q.s.scale), (i) => {
    engine.updateSeq({ scale: scaleIds[i] });
    scaleFeel.textContent = MODES[scaleIds[i]].feel;
  });
  const motionPills = pills(MOTIONS.map((m, i) => ({ label: m.label, value: i })), MOTIONS.findIndex((m) => m.id === q.s.motion), (i) => {
    engine.updateSeq({ motion: MOTIONS[i].id as Motion });
    motionTip.textContent = MOTIONS[i].tip;
  });
  const chordPills = pills([{ label: 'Resonator chord', value: 0 }, { label: 'Triad', value: 3 }, { label: '7th', value: 4 }, { label: '9th', value: 5 }], q.s.chordSize, (v) => engine.updateSeq({ chordSize: v as 0 | 3 | 4 | 5 }));
  const seedOut = h('span', { class: 'mono seed' }, String(q.s.seed));

  const settings = h('section', { class: 'fx-card' },
    ...keyControls(engine),
    h('div', { class: 'label-row' }, 'Scale'),
    scalePills,
    scaleFeel,
    h('div', { class: 'label-row' }, 'Motion'),
    motionPills,
    motionTip,
    slider('Step', 0, 1, 0.005, posFromRate(engine.seq.rate), (v) => fmtSec(rateFrom(v)), (v) => engine.updateSeq({ rate: rateFrom(v) }), 'Time between notes'),
    slider('Glide', 0, 1, 0.005, posFromGlide(engine.fx.reso.glide), (v) => (v < 0.05 ? 'hop' : fmtSec(glideFrom(v))), (v) => engine.updateFx('reso', { glide: glideFrom(v) }), 'How the resonator slides between notes. “hop” jumps.'),
    slider('Chance', 0, 1, 0.01, q.s.chance, (v) => `${Math.round(v * 100)}%`, (v) => engine.updateSeq({ chance: v }), 'Chance each step plays; otherwise it rests'),
    h('div', { class: 'label-row' }, 'Range'),
    pills([{ label: '1 octave', value: 1 }, { label: '2 octaves', value: 2 }, { label: '3 octaves', value: 3 }], q.s.range, (v) => engine.updateSeq({ range: v })),
    h('div', { class: 'label-row' }, 'Chord'),
    chordPills,
    h('div', { class: 'seed-row' }, h('button', { class: 'btn', onclick: () => engine.reseed() }, '🎲  New line'), h('span', { class: 'hint' }, 'seed'), seedOut),
  );

  const stripCard = h('section', { class: 'fx-card' },
    h('header', {}, h('h2', {}, 'Notes'), h('span', { class: 'sub' }, 'tap a note to play it')),
    strip,
  );

  // keep the visible state in step with the engine
  let lastKey = '';
  engine.onFxChange(() => {
    onBtn.setAttribute('aria-pressed', String(engine.seq.on));
    seedOut.textContent = String(q.s.seed);
    const key = `${q.s.scale}|${q.s.range}|${engine.fx.reso.root}`;
    if (key !== lastKey) {
      lastKey = key;
      buildStrip();
    }
    nowSub.textContent = engine.seq.on ? `${NOTE_NAMES[engine.fx.reso.root]} ${MODES[q.s.scale].name}` : stripActive() ? 'holding' : 'stopped';
  });
  const stripActive = () => engine.holding;
  buildStrip();
  lastKey = `${q.s.scale}|${q.s.range}|${engine.fx.reso.root}`;

  // the LED: light whichever note is sounding
  let shown = -2;
  const tick = () => {
    const st = engine.seq.on || stripActive() ? engine.currentStep() : null;
    const idx = st ? st.index : -1;
    if (idx !== shown) {
      shown = idx;
      stripBtns.forEach((b, i) => b.classList.toggle('lit', i === idx));
      nowName.textContent = st ? NOTE_NAMES[(engine.fx.reso.root + st.semis) % 12] : '–';
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return h('div', { class: 'fx-panel' }, head, stripCard, settings);
}

