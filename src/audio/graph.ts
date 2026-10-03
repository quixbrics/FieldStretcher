/*
 * The signal graph, built in ONE place for both live playback and offline
 * render, so the two can never drift apart.
 *
 *   looper ─► mute ─► level ─► pan ─┬─► dry ─────────────────────────────┐
 *                                   └─► FX CHAIN ─► wet ─────────────────┴─► master ─► fxm-safety ─► out
 *
 *   FX CHAIN:  reso ─► delay ─► reverb. Each effect passes ONLY its processed
 *              sound (no dry inside the chain); switching one off routes the
 *              signal around it.
 *
 * There is one Wet/Dry control. It cross-fades the `dry` and `wet` gains
 * (equal power); at 100% wet the dry gain is exactly zero, so the wet sound
 * is clean. If every effect is off there is no wet sound at all.
 */
import { workletNode } from './worklets';

type Params = Record<string, number | string>;

export interface Stage {
  input: GainNode;
  output: GainNode;
  /** gain on the processed path (1 = effect on, 0 = bypassed) */
  proc: GainNode;
  /** gain on the route around the effect (the opposite) */
  around: GainNode;
  node: AudioWorkletNode;
}

export interface TrackNodes {
  looper: AudioWorkletNode;
  mute: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

export interface GraphNodes {
  master: GainNode;
  safety: AudioWorkletNode;
  /** the tracks' direct sound, on its way to the master */
  dry: GainNode;
  /** the FX chain's output, on its way to the master */
  wet: GainNode;
  busIn: GainNode;
  stages: { reso: Stage; delay: Stage; reverb: Stage };
  tracks: TrackNodes[];
}

/** Everything the graph needs at the moment it is built. Gains are final linear values. */
export interface GraphInit {
  tracks: { params: Params; audio: Float32Array[] | null; seed: number; mute: number; gain: number; pan: number }[];
  fx: { reso: Params; delay: Params; reverb: Params; on: { reso: boolean; delay: boolean; reverb: boolean } };
  /** Wet/Dry, 0 (all dry) – 1 (all wet) */
  wet: number;
  master: number;
  /** notes for the resonator as absolute frames (offline render hands the whole sequence over up front) */
  resoQueue?: unknown[];
  /** processors report positions / meters back (live only) */
  report?: boolean;
}

export interface GraphHooks {
  safety?(m: { type: string; gr?: number; peak?: number }): void;
  looper?(track: number, m: { type: string; v?: number; r?: number; g?: number[][] }): void;
  blowup?(): void;
}

/**
 * Equal-power cross-fade for a 0–1 Wet/Dry. At the ends one side is EXACTLY zero
 * (cos(π/2) is not), so "all wet" really has no dry in it and vice versa.
 */
export function wetDryGains(wet: number): { dry: number; wet: number } {
  const w = Math.min(1, Math.max(0, wet));
  if (w <= 0) return { dry: 1, wet: 0 };
  if (w >= 1) return { dry: 0, wet: 1 };
  return { dry: Math.cos((w * Math.PI) / 2), wet: Math.sin((w * Math.PI) / 2) };
}

/** The gain on the wet path: the cross-fade, but silent if no effect is on (there is no wet sound to hear). */
export const wetPathGain = (wet: number, on: { reso: boolean; delay: boolean; reverb: boolean }): number => (on.reso || on.delay || on.reverb ? wetDryGains(wet).wet : 0);

export function buildGraph(ctx: BaseAudioContext, init: GraphInit, hooks: GraphHooks = {}): GraphNodes {
  const report = !!init.report;
  const master = ctx.createGain();
  master.gain.value = init.master;
  const safety = workletNode(ctx, 'fxm-safety', { params: { ceiling: -1 }, report });
  safety.port.onmessage = (e) => {
    if (e.data.type === 'blowup') hooks.blowup?.();
    else hooks.safety?.(e.data);
  };
  master.connect(safety).connect(ctx.destination);

  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = wetDryGains(init.wet).dry;
  wet.gain.value = wetPathGain(init.wet, init.fx.on);
  dry.connect(master);
  wet.connect(master);

  const busIn = ctx.createGain();
  const stage = (name: string, params: Params, on: boolean, extra: Record<string, unknown> = {}): Stage => {
    const node = workletNode(ctx, name, { params, report, ...extra }, 1);
    node.port.onmessage = (e) => {
      if (e.data.type === 'blowup') hooks.blowup?.();
    };
    const input = ctx.createGain();
    const output = ctx.createGain();
    const proc = ctx.createGain();
    const around = ctx.createGain();
    proc.gain.value = on ? 1 : 0;
    around.gain.value = on ? 0 : 1;
    input.connect(node).connect(proc).connect(output);
    input.connect(around).connect(output);
    return { input, output, proc, around, node };
  };
  const reso = stage('fxm-reso', init.fx.reso, init.fx.on.reso, init.resoQueue ? { queue: init.resoQueue } : {});
  const delay = stage('fxm-delay', init.fx.delay, init.fx.on.delay);
  const reverb = stage('fxm-fdn', init.fx.reverb, init.fx.on.reverb);
  busIn.connect(reso.input);
  reso.output.connect(delay.input);
  delay.output.connect(reverb.input);
  reverb.output.connect(wet);

  const tracks = init.tracks.map((t, i): TrackNodes => {
    const looper = workletNode(ctx, 'fxm-looper', { params: t.params, seed: t.seed, report, channels: t.audio ?? undefined }, 0);
    looper.port.onmessage = (e) => {
      if (e.data.type === 'blowup') hooks.blowup?.();
      else hooks.looper?.(i, e.data);
    };
    const mute = ctx.createGain();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    mute.gain.value = t.mute;
    gain.gain.value = t.gain;
    pan.pan.value = t.pan;
    // the track's level and pan apply to BOTH the dry sound and what feeds the effects
    looper.connect(mute).connect(gain).connect(pan);
    pan.connect(dry);
    pan.connect(busIn);
    return { looper, mute, gain, pan };
  });

  return { master, safety, dry, wet, busIn, stages: { reso, delay, reverb }, tracks };
}
