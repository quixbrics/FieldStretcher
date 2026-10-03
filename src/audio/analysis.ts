/*
 * A coarse spectrum of a loop, for the Spectral mode's display. Not part of
 * the sound: the display takes this real spectrum and reshapes it with the same
 * tilt / contrast maths the DSP uses, so what you see is what the controls do.
 */

const N = 2048;
export const BANDS = 32;
const F_LO = 60;

/** centre frequency of each display band (log-spaced from 60 Hz to just under Nyquist, capped at 12 kHz) */
export function bandCentres(sr: number, bands = BANDS): number[] {
  const hi = Math.min(12000, sr * 0.45);
  return Array.from({ length: bands }, (_, b) => F_LO * Math.pow(hi / F_LO, (b + 0.5) / bands));
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Average magnitude per band over the loop window (0–1 of the buffer), normalised so the loudest band is 1. */
export function bandSpectrum(data: Float32Array, sr: number, start = 0, end = 1, bands = BANDS): Float32Array {
  const out = new Float32Array(bands);
  const a = Math.floor(Math.min(start, end) * data.length);
  const b = Math.floor(Math.max(start, end) * data.length);
  if (b - a < N) return out;
  const frames = Math.min(12, Math.floor((b - a) / N));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const hi = Math.min(12000, sr * 0.45);
  const edge = (k: number) => F_LO * Math.pow(hi / F_LO, k / bands);
  const power = new Float64Array(bands);
  for (let f = 0; f < frames; f++) {
    const s = a + Math.floor((f * (b - a - N)) / Math.max(1, frames - 1));
    for (let i = 0; i < N; i++) {
      re[i] = data[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const hz = (k * sr) / N;
      if (hz < F_LO || hz >= hi) continue;
      const band = Math.min(bands - 1, Math.floor((Math.log(hz / F_LO) / Math.log(hi / F_LO)) * bands));
      power[band] += re[k] * re[k] + im[k] * im[k];
    }
  }
  // per-bin average, so a wide high band does not outweigh a narrow low one
  let max = 0;
  for (let k = 0; k < bands; k++) {
    const binsIn = Math.max(1, ((edge(k + 1) - edge(k)) * N) / sr);
    out[k] = Math.sqrt(power[k] / (frames * binsIn));
    if (out[k] > max) max = out[k];
  }
  if (max > 0) for (let k = 0; k < bands; k++) out[k] /= max;
  return out;
}

/**
 * What the Spectral controls do to a spectrum — the same as the DSP, in display terms:
 * tilt (±6 dB/octave about 1 kHz), contrast (power law, level restored) and smear
 * (a small window blurs the spectrum across neighbouring bands; a large one keeps it sharp).
 */
export function shapeSpectrum(base: Float32Array, centres: number[], tilt: number, contrast: number, windowLog2: number): Float32Array {
  const n = base.length;
  const out = new Float32Array(n);
  let e0 = 0;
  let e1 = 0;
  for (let k = 0; k < n; k++) {
    e0 += base[k] * base[k];
    const g = tilt === 0 ? 1 : Math.pow(2, tilt * Math.log2(centres[k] / 1000));
    out[k] = (contrast === 1 ? base[k] : Math.pow(base[k] + 1e-12, contrast)) * g;
    e1 += out[k] * out[k];
  }
  const sc = e1 > 1e-30 ? Math.sqrt(e0 / e1) : 1;
  const radius = Math.max(0, Math.round((15 - windowLog2) * 0.9));
  const blurred = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, k - radius); j <= Math.min(n - 1, k + radius); j++) {
      s += out[j] * sc;
      c++;
    }
    blurred[k] = s / c;
  }
  return blurred;
}
