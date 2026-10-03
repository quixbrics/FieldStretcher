/*
 * One small square per track that changes with the stretch mode, drawn from what
 * the audio is really doing:
 *
 *   Tape      two reels and the tape between them. The reels turn at the real tape
 *             speed (reverse turns them back, freeze and inertia slow them), the
 *             tape pack moves from one reel to the other as the loop plays, and wow
 *             and flutter make the tape visibly wobble.
 *   Spectral  the loop's own spectrum as bars, reshaped live by Tilt, Focus and
 *             Smear with the same maths as the DSP; the bars shimmer like random
 *             phases do, faster when there is less stretch.
 *   Granular  every grain the audio thread spawns, as a dot: across = where in the
 *             loop, up = pitch. Short grains are small, backwards grains hollow.
 */
import { BANDS, bandCentres, bandSpectrum, shapeSpectrum } from '../audio/analysis';
import { focusToContrast, type Engine, type EngineKind } from '../audio/engine';
import { h } from './dom';

const SVG = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

const TWO_PI = Math.PI * 2;

/* ------------------------------------------------------------------ tape -- */

class TapeView {
  readonly el: SVGSVGElement;
  private packL = svg('circle', { class: 'pack' });
  private packR = svg('circle', { class: 'pack' });
  private spokesL = svg('g');
  private spokesR = svg('g');
  private tape = svg('polyline', { class: 'tape-line', fill: 'none' });
  private head = svg('rect', { class: 'tape-head', x: 45, y: 86, width: 10, height: 8, rx: 2 });
  private angle = 0;
  private cxL = 27;
  private cxR = 73;
  private cy = 38;
  private hub = 7;
  private maxR = 24;

  constructor() {
    this.el = svg('svg', { viewBox: '0 0 100 100', class: 'viz-svg', 'aria-hidden': 'true' });
    const flange = (cx: number) => svg('circle', { class: 'flange', cx, cy: this.cy, r: this.maxR + 2, fill: 'none' });
    const hubShape = (g: SVGGElement, cx: number) => {
      g.appendChild(svg('circle', { class: 'hub', cx, cy: this.cy, r: this.hub, fill: 'none' }));
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI * 2) / 3;
        g.appendChild(svg('line', { class: 'spoke', x1: cx, y1: this.cy, x2: cx + Math.cos(a) * (this.hub - 1), y2: this.cy + Math.sin(a) * (this.hub - 1) }));
      }
    };
    hubShape(this.spokesL, this.cxL);
    hubShape(this.spokesR, this.cxR);
    this.el.append(flange(this.cxL), flange(this.cxR), this.packL, this.packR, this.tape, this.spokesL, this.spokesR, this.head);
    this.draw(0.5, 0, 0);
  }

  /** `rate` is the signed tape speed (1 = normal); `wobble` 0–1 how much the tape moves about. */
  frame(dt: number, pos: number, rate: number, wobble: number, now: number) {
    // a normal-speed reel turns about once a second; very slow tape barely creeps
    this.angle += rate * TWO_PI * 0.9 * dt;
    this.draw(pos, wobble, now);
  }

  private draw(pos: number, wobble: number, now: number) {
    const p = Math.min(1, Math.max(0, pos));
    const rl = Math.sqrt(this.hub * this.hub + 14 + (1 - p) * (this.maxR * this.maxR - this.hub * this.hub - 14));
    const rr = Math.sqrt(this.hub * this.hub + 14 + p * (this.maxR * this.maxR - this.hub * this.hub - 14));
    for (const [c, cx, r] of [[this.packL, this.cxL, rl], [this.packR, this.cxR, rr]] as const) {
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(this.cy));
      c.setAttribute('r', r.toFixed(2));
    }
    const deg = (this.angle * 180) / Math.PI;
    this.spokesL.setAttribute('transform', `rotate(${deg.toFixed(1)} ${this.cxL} ${this.cy})`);
    this.spokesR.setAttribute('transform', `rotate(${deg.toFixed(1)} ${this.cxR} ${this.cy})`);
    // the tape runs from the bottom of one pack, down past the head, up to the other
    const w = wobble * 2.2 * Math.sin(now * 0.011) + wobble * 1.2 * Math.sin(now * 0.037 + 1);
    this.tape.setAttribute(
      'points',
      `${this.cxL},${this.cy + rl} ${this.cxL + 4},${70 + w} 40,${86 + w} 60,${86 + w} ${this.cxR - 4},${70 + w} ${this.cxR},${this.cy + rr}`,
    );
    this.head.setAttribute('y', String(86 + w * 0.4));
  }
}

/* -------------------------------------------------------------- spectrum -- */

class SpectrumView {
  readonly el: HTMLCanvasElement;
  private base: Float32Array = new Float32Array(BANDS);
  private shaped: Float32Array = new Float32Array(BANDS);
  private phases = Float32Array.from({ length: BANDS }, () => Math.random() * TWO_PI);
  private speeds = Float32Array.from({ length: BANDS }, () => 0.6 + Math.random() * 0.8);
  private centres: number[];
  private key = '';
  private lastCompute = 0;
  private color = 'currentColor';

  constructor(private engine: Engine, private track: number) {
    this.el = h('canvas', { class: 'viz-canvas', 'aria-hidden': 'true' });
    this.centres = bandCentres(engine.sampleRate);
  }

  frame(dt: number, now: number) {
    const e = this.engine;
    const t = e.tracks[this.track];
    const loop = e.loops[this.track];
    // the real spectrum is only recomputed when the loop or its window changes (and not faster than 5×/s while dragging)
    const key = `${loop ? loop[0].length : 0}|${loop ? loop[0][loop[0].length >> 1] : 0}|${t.start.toFixed(2)}|${t.end.toFixed(2)}`;
    if (key !== this.key && now - this.lastCompute > 200) {
      this.key = key;
      this.lastCompute = now;
      this.centres = bandCentres(e.sampleRate);
      this.base = loop ? bandSpectrum(loop[0], e.sampleRate, t.start, t.end) : new Float32Array(BANDS);
    }
    const s = t.sound.spectral;
    this.shaped = shapeSpectrum(this.base, this.centres, s.tilt, focusToContrast(s.focus), s.window);
    let max = 0;
    for (const v of this.shaped) if (v > max) max = v;
    // random-phase shimmer: quicker when there is less stretch
    const speed = 0.5 + 5 / Math.sqrt(Math.max(1, t.stretch));
    const c = this.el;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
      this.color = getComputedStyle(c).color;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    g.fillStyle = this.color;
    const bw = W / BANDS;
    for (let k = 0; k < BANDS; k++) {
      this.phases[k] += this.speeds[k] * speed * dt;
      const v = max > 0 ? this.shaped[k] / max : 0;
      const sh = 0.78 + 0.22 * Math.sin(this.phases[k]);
      const hgt = Math.max(2 * dpr, Math.sqrt(v) * sh * (H - 4 * dpr));
      g.globalAlpha = v > 0 ? 0.35 + 0.65 * Math.sqrt(v) : 0.25;
      g.fillRect(k * bw + bw * 0.12, H - hgt, bw * 0.76, hgt);
    }
    g.globalAlpha = 1;
  }
}

/* -------------------------------------------------------------- granular -- */

interface Dot {
  x: number;
  y: number;
  w: number;
  back: boolean;
  born: number;
}

class GrainView {
  readonly el: HTMLCanvasElement;
  private dots: Dot[] = [];
  private head = 0;
  private color = 'currentColor';

  constructor() {
    this.el = h('canvas', { class: 'viz-canvas', 'aria-hidden': 'true' });
  }

  add(list: number[][], now: number) {
    for (const [pos, len, , semis, back] of list) {
      // across: where in the loop; up: pitch (±24 semitones)
      this.dots.push({ x: pos, y: 0.5 - Math.max(-1, Math.min(1, semis / 24)) * 0.45, w: len, back: back < 0, born: now });
    }
    if (this.dots.length > 160) this.dots.splice(0, this.dots.length - 160);
  }

  setHead(v: number) {
    this.head = v;
  }

  frame(now: number) {
    const c = this.el;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
      this.color = getComputedStyle(c).color;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = this.color;
    g.fillStyle = this.color;
    g.globalAlpha = 0.18;
    g.beginPath();
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
    g.globalAlpha = 0.5;
    g.beginPath();
    g.moveTo(this.head * W, 0);
    g.lineTo(this.head * W, H);
    g.stroke();
    this.dots = this.dots.filter((d) => now - d.born < 900);
    for (const d of this.dots) {
      const age = (now - d.born) / 900;
      g.globalAlpha = 1 - age;
      const w = Math.max(3 * dpr, d.w * W * 1.6);
      const x = d.x * W - w / 2;
      const y = d.y * H - 2 * dpr;
      if (d.back) {
        g.lineWidth = dpr;
        g.strokeRect(x, y, w, 4 * dpr);
      } else g.fillRect(x, y, w, 4 * dpr);
    }
    g.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------ the square -- */

export class ModeViz {
  readonly el: HTMLElement;
  private tape = new TapeView();
  private spectrum: SpectrumView;
  private grain = new GrainView();
  private kind: EngineKind;
  private posV = 0;
  private rate = 0;

  constructor(private engine: Engine, private track: number) {
    this.spectrum = new SpectrumView(engine, track);
    this.kind = engine.tracks[track].engine;
    this.el = h('div', { class: 'viz', 'aria-hidden': 'true' });
    this.el.append(this.tape.el as unknown as Node, this.spectrum.el, this.grain.el);
    this.setEngine(this.kind);
  }

  setEngine(kind: EngineKind) {
    this.kind = kind;
    this.tape.el.style.display = kind === 'tape' ? '' : 'none';
    this.spectrum.el.style.display = kind === 'spectral' ? '' : 'none';
    this.grain.el.style.display = kind === 'granular' ? '' : 'none';
  }

  pos(v: number, rate: number) {
    this.posV = v;
    this.rate = rate;
    this.grain.setHead(v);
  }

  grains(list: number[][], now: number) {
    this.grain.add(list, now);
  }

  frame(dt: number, now: number) {
    const t = this.engine.tracks[this.track];
    if (this.kind === 'tape') {
      const playing = this.engine.playing && t.seconds > 0;
      this.tape.frame(dt, this.posV, playing ? this.rate : 0, Math.max(t.sound.tape.wow, t.sound.tape.flutter) * (playing ? 1 : 0), now);
    } else if (this.kind === 'spectral') this.spectrum.frame(dt, now);
    else this.grain.frame(now);
  }
}

/** One animation loop for all the squares; it stops when the UI that owns them is rebuilt. */
export function runViz(vizzes: ModeViz[], life: AbortSignal) {
  let last = performance.now();
  const loop = (now: number) => {
    if (life.aborted) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // nothing to animate while the tab is hidden
    if (document.visibilityState === 'visible') for (const v of vizzes) v.frame(dt, now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
