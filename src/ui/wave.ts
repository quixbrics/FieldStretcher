/*
 * A track's waveform: peaks on a canvas, two draggable loop-window handles,
 * a moving playhead and, while recording, the take's timer and level.
 */
import { h } from './dom';

export class Wave {
  readonly el: HTMLElement;
  private canvas = h('canvas', { class: 'wave-canvas', 'aria-hidden': 'true' });
  private empty = h('div', { class: 'wave-empty' }, 'Tap ● to record, or load a sound');
  private shadeL = h('div', { class: 'shade shade-l' });
  private shadeR = h('div', { class: 'shade shade-r' });
  private hStart = h('div', { class: 'handle handle-start', role: 'slider', 'aria-label': 'Loop start', tabindex: 0 });
  private hEnd = h('div', { class: 'handle handle-end', role: 'slider', 'aria-label': 'Loop end', tabindex: 0 });
  private head = h('div', { class: 'playhead' });
  private recInfo = h('div', { class: 'rec-info' });
  private recTime = h('span', { class: 'mono' }, '00:00');
  private recBar = h('i', { class: 'rec-bar' });
  private peaks: Float32Array | null = null;
  private start = 0;
  private end = 1;
  private dragging: 'start' | 'end' | null = null;
  onWindow: (start: number, end: number) => void = () => {};
  /** smallest window as a fraction of the loop (never below ~quarter second) */
  minSpan = 0.02;

  constructor() {
    const recDot = h('b', { class: 'rec-dot' });
    this.recInfo.append(recDot, this.recTime, h('span', { class: 'rec-meter' }, this.recBar));
    this.recInfo.hidden = true;
    this.el = h('div', { class: 'wave' }, this.canvas, this.empty, this.shadeL, this.shadeR, this.head, this.hStart, this.hEnd, this.recInfo);
    for (const [handle, which] of [[this.hStart, 'start'], [this.hEnd, 'end']] as const) {
      handle.addEventListener('pointerdown', (e) => {
        this.dragging = which;
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      handle.addEventListener('pointermove', (e) => {
        if (this.dragging !== which) return;
        const r = this.el.getBoundingClientRect();
        const v = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        this.setWindow(which === 'start' ? v : this.start, which === 'end' ? v : this.end, which);
        this.onWindow(this.start, this.end);
      });
      const up = () => {
        this.dragging = null;
      };
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      handle.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowLeft' ? -0.01 : e.key === 'ArrowRight' ? 0.01 : 0;
        if (!d) return;
        e.preventDefault();
        this.setWindow(which === 'start' ? this.start + d : this.start, which === 'end' ? this.end + d : this.end, which);
        this.onWindow(this.start, this.end);
      });
    }
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  setPeaks(p: Float32Array | null, seconds: number) {
    this.peaks = p;
    this.empty.hidden = !!p;
    this.el.classList.toggle('has-audio', !!p);
    this.minSpan = Math.min(0.5, 0.25 / Math.max(0.25, seconds));
    this.setWindow(0, 1);
    this.draw();
  }

  setWindow(start: number, end: number, moved?: 'start' | 'end') {
    const m = this.minSpan;
    start = Math.min(1, Math.max(0, start));
    end = Math.min(1, Math.max(0, end));
    if (end - start < m) {
      if (moved === 'end') end = Math.min(1, start + m), (start = end - m);
      else start = Math.max(0, end - m), (end = start + m);
    }
    this.start = start;
    this.end = end;
    this.shadeL.style.width = `${start * 100}%`;
    this.shadeR.style.width = `${(1 - end) * 100}%`;
    this.hStart.style.left = `${start * 100}%`;
    this.hEnd.style.left = `${end * 100}%`;
    this.hStart.setAttribute('aria-valuenow', String(Math.round(start * 100)));
    this.hEnd.setAttribute('aria-valuenow', String(Math.round(end * 100)));
  }

  setPos(v: number) {
    this.head.style.left = `${v * 100}%`;
  }

  setRecording(on: boolean) {
    this.recInfo.hidden = !on;
    this.el.classList.toggle('recording', on);
    this.empty.hidden = on || !!this.peaks;
    if (on) this.recTime.textContent = '00:00';
  }

  setRecLevel(peak: number, timeText?: string) {
    this.recBar.style.transform = `scaleX(${Math.min(1, Math.sqrt(peak))})`;
    if (timeText) this.recTime.textContent = timeText;
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.el.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(this.el.clientHeight * dpr));
    if (c.width !== w || c.height !== hgt) {
      c.width = w;
      c.height = hgt;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, hgt);
    const p = this.peaks;
    if (!p) return;
    g.fillStyle = getComputedStyle(c).color;
    const mid = hgt / 2;
    const bar = Math.max(1, Math.floor(2 * dpr));
    const step = bar + Math.max(1, Math.floor(dpr));
    for (let x = 0, i = 0; x < w; x += step, i++) {
      const v = p[Math.min(p.length - 1, Math.floor((x / w) * p.length))];
      const half = Math.max(1, Math.sqrt(v) * mid * 0.92);
      g.fillRect(x, mid - half, bar, half * 2);
    }
  }
}
