/*
 * The signal graph, built in ONE place for both live playback and offline
 * render, so the two can never drift apart.
 *
 *   looper ─► mute ─┬─► level ─► pan ───────────────┐
 *                   └─► send ─► FX BUS ─► return ───┴─► master ─► fxm-safety ─► out
 *
 *   FX BUS:  reso ─► delay ─► reverb, each blended dry/wet (equal power)
 *
 * The send is taken BEFORE the level fader, so turning a track's level down
 * while its send is up gives a wet-only sound. Mute silences both.
 */
import { workletNode } from './worklets';

type Params = Record<string, number | string>;

export interface Stage {
  input: GainNode;
  output: GainNode;
  dry: GainNode;
  wet: GainNode;
  node: AudioWorkletNode;
}

export interface TrackNodes {
  looper: AudioWorkletNode;
  mute: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
}

export interface GraphNodes {
  master: GainNode;
  safety: AudioWorkletNode;
  busIn: GainNode;
  busOut: GainNode;
  stages: { reso: Stage; delay: Stage; reverb: Stage };
  tracks: TrackNodes[];
}

/** Everything the graph needs at the moment it is built. Gains are final linear values. */
export interface GraphInit {
  tracks: { params: Params; audio: Float32Array[] | null; seed: number; mute: number; gain: number; pan: number; send: number }[];
  fx: { reso: Params; delay: Params; reverb: Params; mix: { reso: number; delay: number; reverb: number }; level: number };
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

/** equal-power dry/wet gains for a 0–1 mix */
export const dryWet = (mix: number) => ({ dry: Math.cos((mix * Math.PI) / 2), wet: Math.sin((mix * Math.PI) / 2) });

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

  const busIn = ctx.createGain();
  const busOut = ctx.createGain();
  busOut.gain.value = init.fx.level;
  const stage = (name: string, params: Params, mix: number, extra: Record<string, unknown> = {}): Stage => {
    const node = workletNode(ctx, name, { params, report, ...extra }, 1);
    node.port.onmessage = (e) => {
      if (e.data.type === 'blowup') hooks.blowup?.();
    };
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const g = dryWet(mix);
    dry.gain.value = g.dry;
    wet.gain.value = g.wet;
    input.connect(node).connect(wet).connect(output);
    input.connect(dry).connect(output);
    return { input, output, dry, wet, node };
  };
  const reso = stage('fxm-reso', init.fx.reso, init.fx.mix.reso, init.resoQueue ? { queue: init.resoQueue } : {});
  const delay = stage('fxm-delay', init.fx.delay, init.fx.mix.delay);
  const reverb = stage('fxm-fdn', init.fx.reverb, init.fx.mix.reverb);
  busIn.connect(reso.input);
  reso.output.connect(delay.input);
  delay.output.connect(reverb.input);
  reverb.output.connect(busOut).connect(master);

  const tracks = init.tracks.map((t, i): TrackNodes => {
    const looper = workletNode(ctx, 'fxm-looper', { params: t.params, seed: t.seed, report, channels: t.audio ?? undefined }, 0);
    looper.port.onmessage = (e) => {
      if (e.data.type === 'blowup') hooks.blowup?.();
      else hooks.looper?.(i, e.data);
    };
    const mute = ctx.createGain();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const send = ctx.createGain();
    mute.gain.value = t.mute;
    gain.gain.value = t.gain;
    pan.pan.value = t.pan;
    send.gain.value = t.send;
    looper.connect(mute);
    mute.connect(gain).connect(pan).connect(master);
    mute.connect(send).connect(busIn);
    return { looper, mute, gain, pan, send };
  });

  return { master, safety, busIn, busOut, stages: { reso, delay, reverb }, tracks };
}
