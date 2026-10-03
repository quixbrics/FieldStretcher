/*
 * Turning a raw take into a loop that is ready to play, WITHOUT changing its level:
 *  - DC removed (phone mics often carry an offset)
 *  - a 20 ms equal-power crossfade of the tail into the head, so the loop seam
 *    is inaudible without needing a zero crossing
 * A take that is effectively silence is refused (the mic is probably not working).
 * Making a quiet recording louder is a separate, deliberate step: normalise().
 */

export const TARGET_PEAK = Math.pow(10, -3 / 20);
const MAX_GAIN = 100; // +40 dB
const SILENCE = 0.001; // below this peak there is nothing there
export const MIN_SECONDS = 0.25;
export const MAX_SECONDS = 30;
/** the bounce track holds up to a minute */
export const MAX_BOUNCE_SECONDS = 60;

export type LoopResult = { ok: true; chans: Float32Array[] } | { ok: false; reason: 'short' | 'quiet' };

export function peakOf(chans: Float32Array[]): number {
  let peak = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  return peak;
}

/** Mono or stereo in, the same number of channels out. */
export function prepareLoop(raw: Float32Array[], sr: number): LoopResult {
  const n = raw[0].length;
  if (n < MIN_SECONDS * sr) return { ok: false, reason: 'short' };
  const means = raw.map((c) => c.reduce((s, v) => s + v, 0) / n);
  let peak = 0;
  raw.forEach((c, k) => {
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i] - means[k]));
  });
  if (peak < SILENCE) return { ok: false, reason: 'quiet' };
  const f = Math.min(Math.round(0.02 * sr), n >> 2);
  const chans = raw.map((c, k) => {
    const out = new Float32Array(n - f);
    for (let i = 0; i < out.length; i++) out[i] = c[i] - means[k];
    for (let i = 0; i < f; i++) {
      const w = (i / f) * (Math.PI / 2);
      out[i] = (c[i] - means[k]) * Math.sin(w) + (c[n - f + i] - means[k]) * Math.cos(w);
    }
    return out;
  });
  return { ok: true, chans };
}

/** Scale to −3 dBFS peak (one gain for every channel, so the stereo image is untouched). Gain is capped at +40 dB. */
export function normalise(chans: Float32Array[]): { ok: true; chans: Float32Array[]; gainDb: number } | { ok: false } {
  const peak = peakOf(chans);
  if (peak < SILENCE) return { ok: false };
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / peak);
  return { ok: true, chans: chans.map((c) => c.map((v) => v * gain)), gainDb: 20 * Math.log10(gain) };
}

/**
 * Layer new audio onto a loop, in place: the old audio under it is multiplied by
 * `keep` (1 = untouched, 0 = replaced) and the new audio added, starting at
 * `offset` and wrapping round the loop. A layer longer than the loop wraps more
 * than once, and the old material decays by `keep` on each pass.
 */
export function layerInto(dst: Float32Array, src: Float32Array, offset: number, keep: number): void {
  const n = dst.length;
  let idx = ((Math.floor(offset) % n) + n) % n;
  for (let i = 0; i < src.length; i++) {
    dst[idx] = dst[idx] * keep + src[i];
    if (++idx === n) idx = 0;
  }
}

/** Per-bin peak amplitude, for drawing a waveform (the louder of the channels). */
export function computePeaks(chans: Float32Array[], bins: number): Float32Array {
  const [data] = chans;
  const out0 = computePeaksOne(data, bins);
  if (chans.length < 2) return out0;
  const out1 = computePeaksOne(chans[1], bins);
  return out0.map((v, i) => Math.max(v, out1[i]));
}

function computePeaksOne(data: Float32Array, bins: number): Float32Array {
  const out = new Float32Array(bins);
  const per = data.length / bins;
  for (let b = 0; b < bins; b++) {
    const a = Math.floor(b * per);
    const z = Math.min(data.length, Math.max(a + 1, Math.floor((b + 1) * per)));
    let m = 0;
    for (let i = a; i < z; i++) {
      const v = Math.abs(data[i]);
      if (v > m) m = v;
    }
    out[b] = m;
  }
  return out;
}

export function concat(chunks: Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Mix any number of channels down to mono. */
export function toMono(chans: Float32Array[]): Float32Array {
  if (chans.length === 1) return chans[0].slice();
  const out = new Float32Array(chans[0].length);
  for (const c of chans) for (let i = 0; i < out.length; i++) out[i] += c[i] / chans.length;
  return out;
}

/** Linear resample to a new length (used to repair a take whose speed was wrong, and to move audio between sample rates). */
export function resampleTo(data: Float32Array, newLen: number): Float32Array {
  const out = new Float32Array(newLen);
  if (newLen <= 1 || data.length <= 1) return out;
  const k = (data.length - 1) / (newLen - 1);
  for (let i = 0; i < newLen; i++) {
    const x = i * k;
    const a = Math.floor(x);
    const b = Math.min(data.length - 1, a + 1);
    out[i] = data[a] + (data[b] - data[a]) * (x - a);
  }
  return out;
}

/**
 * A take recorded at the wrong speed — frames dropped, or a microphone and
 * context at different sample rates — is shorter or longer than the time that
 * really passed. If the two disagree by more than 12% on a take of 2 s or more,
 * stretch the take to the real duration. Returns the ratio it corrected (1 = left alone).
 */
export function repairSpeed(raw: Float32Array, sr: number, wallSeconds: number): { data: Float32Array; ratio: number } {
  const got = raw.length / sr;
  const ratio = got / wallSeconds;
  if (wallSeconds < 2 || Math.abs(ratio - 1) <= 0.12) return { data: raw, ratio: 1 };
  return { data: resampleTo(raw, Math.round(wallSeconds * sr)), ratio };
}
