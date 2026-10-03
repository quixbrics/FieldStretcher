/*
 * Seeded randomness. Every generative decision in ToneMaker draws from a
 * stream seeded by (global seed, track, cycle, bar …), so the same settings
 * always produce the same music — a student can get back the take they liked,
 * and the offline export is note-for-note what was heard live.
 */

export type Rng = () => number;

/** mulberry32 — small, fast, good enough for musical decisions. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Combine integers into one 32-bit seed (FNV-1a style). */
export function hashSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    let v = Math.floor(p) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  }
  return h >>> 0;
}

export function rngFor(...parts: number[]): Rng {
  return mulberry32(hashSeed(...parts));
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Weighted choice. Weights need not sum to 1. */
export function weighted<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
