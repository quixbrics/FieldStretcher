/*
 * Loads every FieldStretcher processor as ONE AudioWorklet module. The DSP
 * lives in plain JS files (src/audio/dsp/) imported as raw text and
 * concatenated — the same files, in the same order, that the tests run in Node.
 */
import common from './dsp/common.js?raw';
import looper from './dsp/looper.js?raw';
import safety from './dsp/safety.js?raw';
import capture from './dsp/capture.js?raw';
import fxBus from './dsp/fx-bus.js?raw';

// keep in step with DSP_FILES (src/audio/dspFiles.ts)
const SOURCE = [common, looper, safety, capture, fxBus].join('\n;\n');

let url: string | null = null;
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

export function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  const hit = loaded.get(ctx);
  if (hit) return hit;
  if (!url) url = URL.createObjectURL(new Blob([SOURCE], { type: 'application/javascript' }));
  // fall back to a data: URL where a strict page policy refuses blob: modules
  const p = ctx.audioWorklet
    .addModule(url)
    .catch(() => ctx.audioWorklet.addModule(`data:application/javascript;base64,${btoa(unescape(encodeURIComponent(SOURCE)))}`));
  loaded.set(ctx, p);
  return p;
}

export function workletNode(
  ctx: BaseAudioContext,
  name: string,
  processorOptions: Record<string, unknown>,
  inputs = 1,
  channels = 2,
): AudioWorkletNode {
  return new AudioWorkletNode(ctx, name, {
    numberOfInputs: inputs,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    channelCount: channels,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions,
  });
}
