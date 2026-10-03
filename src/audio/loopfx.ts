/*
 * Turning a raw take into a loop that sounds right straight away:
 *  - DC removed (phone mics often carry an offset)
 *  - normalised to -3 dBFS, because a phone mic in a quiet field is very
 *    quiet and stretching does not make it louder (gain is capped at +40 dB,
 *    and a take that is effectively silence is refused rather than boosted)
 *  - a 20 ms equal-power crossfade of the tail into the head, so the loop
 *    seam is inaudible without needing a zero crossing
 */

export const TARGET_PEAK = Math.pow(10, -3 / 20);
const MAX_GAIN = 100; // +40 dB
const SILENCE = 0.002; // below this peak there is nothing to normalise
export const MIN_SECONDS = 0.25;
export const MAX_SECONDS = 30;

export type LoopResult =
  | { ok: true; data: Float32Array; gainDb: number }
  | { ok: false; reason: 'short' | 'quiet' };

export function prepareLoop(raw: Float32Array, sr: number): LoopResult {
  const n = raw.length;
  if (n < MIN_SECONDS * sr) return { ok: false, reason: 'short' };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += raw[i];
  mean /= n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(raw[i] - mean);
    if (a > peak) peak = a;
  }
  if (peak < SILENCE) return { ok: false, reason: 'quiet' };
  const f = Math.min(Math.round(0.02 * sr), n >> 2);
  const out = new Float32Array(n - f);
  for (let i = 0; i < out.length; i++) out[i] = raw[i] - mean;
  for (let i = 0; i < f; i++) {
    const w = (i / f) * (Math.PI / 2);
    out[i] = (raw[i] - mean) * Math.sin(w) + (raw[n - f + i] - mean) * Math.cos(w);
  }
  // normalise last: a crossfade of correlated (tonal) material can swell by up to 3 dB
  let outPeak = 0;
  for (let i = 0; i < out.length; i++) outPeak = Math.max(outPeak, Math.abs(out[i]));
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / outPeak);
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return { ok: true, data: out, gainDb: 20 * Math.log10(gain) };
}

/** Per-bin peak amplitude, for drawing a waveform. */
export function computePeaks(data: Float32Array, bins: number): Float32Array {
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
