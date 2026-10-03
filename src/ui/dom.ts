type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Tiny element builder: h('button', { class: 'x', onclick: fn }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('aria-') && typeof v === 'boolean') el.setAttribute(k, String(v));
    else if (v === undefined || v === false) continue;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
}

/** Stretch slider position (0–1) ⇄ ratio (1–1000), logarithmic. */
export const stretchFromPos = (v: number): number => Math.pow(1000, v);
export const posFromStretch = (s: number): number => Math.log(Math.max(1, s)) / Math.log(1000);

export function fmtStretch(s: number): string {
  if (s < 10) return `${s.toFixed(1)}×`;
  return `${Math.round(s)}×`;
}

export function fmtTime(sec: number): string {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtSemis(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} st`;
}
