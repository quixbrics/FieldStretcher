/*
 * Offline render: the mix (and, if asked, each track on its own as a stem)
 * rendered faster than real time with an OfflineAudioContext. It uses the SAME
 * graph builder as live playback (graph.ts), so it cannot sound different.
 *
 * What the render does:
 *  - every loop starts from the top, together
 *  - the sequencer is replayed from its seed, so the line is the one you would hear
 *    pressing play at the start; every note is handed to the resonator up front
 *  - a stem is that track on its own, with its own FX send and the FX tails
 *  - 20 ms fade-in, and a fade-out at the end so the cut is never abrupt
 */
import { ensureWorklets } from './worklets';
import { buildGraph } from './graph';
import { encodeWav } from './wav';
import type { Engine } from './engine';
import { TRACKS, trackName } from './engine';

export const RENDER_LENGTHS = [15, 30, 60, 120, 300];

export interface RenderProgress {
  /** 1-based pass number out of `total` */
  pass: number;
  total: number;
  label: string;
}

export interface RenderResult {
  mix: Blob;
  stems: { name: string; blob: Blob }[];
  sampleRate: number;
}

function fades(l: Float32Array, r: Float32Array, sr: number) {
  const n = l.length;
  const fin = Math.min(n, Math.round(0.02 * sr));
  const fout = Math.min(n, Math.round(Math.min(1.5, n / sr / 4) * sr));
  for (let i = 0; i < fin; i++) {
    const g = i / fin;
    l[i] *= g;
    r[i] *= g;
  }
  for (let i = 0; i < fout; i++) {
    const g = i / fout;
    l[n - 1 - i] *= g;
    r[n - 1 - i] *= g;
  }
}

async function pass(engine: Engine, seconds: number, solo: number | null): Promise<Blob> {
  const sr = engine.sampleRate;
  const OAC = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.round(seconds * sr), sr);
  await ensureWorklets(ctx);
  buildGraph(ctx, engine.renderInit(seconds, solo));
  const buf = await ctx.startRendering();
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  fades(l, r, sr);
  return encodeWav([l, r], sr, 24);
}

export async function renderOffline(engine: Engine, o: { seconds: number; stems: boolean; onProgress?: (p: RenderProgress) => void }): Promise<RenderResult> {
  const withAudio = Array.from({ length: TRACKS }, (_, i) => i).filter((i) => engine.loops[i]);
  const passes: { solo: number | null; label: string }[] = [{ solo: null, label: 'mix' }];
  if (o.stems) for (const i of withAudio) passes.push({ solo: i, label: trackName(i) });
  const blobs: Blob[] = [];
  for (let k = 0; k < passes.length; k++) {
    o.onProgress?.({ pass: k + 1, total: passes.length, label: passes[k].label });
    // let the page paint the progress before the render takes the thread's attention
    await new Promise((r) => setTimeout(r, 30));
    blobs.push(await pass(engine, o.seconds, passes[k].solo));
  }
  return {
    mix: blobs[0],
    stems: passes.slice(1).map((p, k) => ({ name: `${(p.label as string).toLowerCase().replace(/\s+/g, '')}.wav`, blob: blobs[k + 1] })),
    sampleRate: engine.sampleRate,
  };
}
