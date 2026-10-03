/*
 * The audio engine: one AudioContext, the microphone, four loop tracks and
 * the master chain.
 *
 *   mic ─► fs-capture (raw PCM, meter) ─► [taken when a track is armed]
 *
 *   track 1..4:  fxm-looper ─► level ─► pan ─┐
 *                                            ├─► master ─► fxm-safety ─► out
 *   (phase 2: post-fader sends ─► FX bus ────┘)
 *
 * The context is created inside the first tap (iOS refuses otherwise), and the
 * mic request is fired in that same tap, in parallel with loading the DSP.
 */
import { ensureWorklets, workletNode } from './worklets';
import { MAX_SECONDS, computePeaks, concat, prepareLoop, toMono } from './loopfx';

export const TRACKS = 4;
export type EngineKind = 'spectral' | 'granular' | 'tape';
export type Quality = 'draft' | 'normal' | 'high';
/** log2 of the FFT frame for Paulstretch: bigger = smoother, heavier. */
const WINDOW: Record<Quality, number> = { draft: 12, normal: 13, high: 14 };

export interface TrackState {
  engine: EngineKind;
  stretch: number;
  pitch: number;
  reverse: boolean;
  freeze: boolean;
  start: number;
  end: number;
  level: number;
  pan: number;
  mute: boolean;
  /** length of the loop in seconds; 0 = empty */
  seconds: number;
}

export interface EngineEvents {
  level(peak: number): void;
  pos(track: number, v: number): void;
  limiter(grDb: number, peakDb: number): void;
  ctxState(state: string): void;
  recTime(track: number, seconds: number): void;
  recAutoStop(track: number): void;
  blowup(): void;
  /** a track's audio was loaded, replaced or cleared */
  track(track: number): void;
}

export type RecResult = { ok: true } | { ok: false; reason: 'short' | 'quiet' | 'idle' };

const DEFAULTS: Pick<TrackState, 'engine' | 'stretch'>[] = [
  { engine: 'spectral', stretch: 8 },
  { engine: 'granular', stretch: 4 },
  { engine: 'tape', stretch: 2 },
  { engine: 'spectral', stretch: 64 },
];

interface TrackNodes {
  looper: AudioWorkletNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

type AudioSessionNav = Navigator & { audioSession?: { type: string } };

export class Engine {
  ctx: AudioContext | null = null;
  events: Partial<EngineEvents> = {};
  tracks: TrackState[] = DEFAULTS.map((d) => ({
    ...d,
    pitch: 0,
    reverse: false,
    freeze: false,
    start: 0,
    end: 1,
    level: 0.8,
    pan: 0,
    mute: false,
    seconds: 0,
  }));
  /** waveform peaks per track (null = empty) */
  peaks: (Float32Array | null)[] = Array(TRACKS).fill(null);
  /** the loop audio itself (mono), kept for export and redraw */
  audio: (Float32Array | null)[] = Array(TRACKS).fill(null);
  playing = true;
  quality: Quality = 'normal';
  masterLevel = 0.85;
  micError: string | null = null;
  recTrack = -1;

  private nodes: TrackNodes[] = [];
  private master!: GainNode;
  private safety!: AudioWorkletNode;
  private capture: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];
  private recSamples = 0;
  private recDone: (() => void) | null = null;
  private wake: { release(): Promise<void> } | null = null;
  private starting: Promise<void> | null = null;

  get started(): boolean {
    return this.nodes.length > 0;
  }
  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }
  get hasMic(): boolean {
    return this.capture !== null;
  }

  /** Must be called from a tap. Safe to call again (e.g. to resume). */
  start(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume();
    if (!this.starting) this.starting = this.boot();
    return this.starting;
  }

  private async boot(): Promise<void> {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    ctx.onstatechange = () => this.events.ctxState?.(ctx.state);
    void ctx.resume();
    // fire the mic request now, inside the tap, in parallel with DSP loading
    const micP = this.askMic();
    await ensureWorklets(ctx);

    this.master = ctx.createGain();
    this.master.gain.value = this.masterLevel ** 2;
    this.safety = workletNode(ctx, 'fxm-safety', { params: { ceiling: -1 }, report: true });
    this.safety.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'meter') this.events.limiter?.(m.gr, m.peak);
      else if (m.type === 'blowup') this.events.blowup?.();
    };
    this.master.connect(this.safety).connect(ctx.destination);

    for (let i = 0; i < TRACKS; i++) {
      const t = this.tracks[i];
      const looper = workletNode(ctx, 'fxm-looper', { params: this.looperParams(t), seed: 1000 + i, report: true }, 0);
      looper.port.onmessage = (e) => {
        if (e.data.type === 'pos') this.events.pos?.(i, e.data.v);
        else if (e.data.type === 'blowup') this.events.blowup?.();
      };
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      looper.connect(gain).connect(pan).connect(this.master);
      this.nodes.push({ looper, gain, pan });
      this.applyMix(i);
    }

    const stream = await micP;
    if (stream) this.attachMic(stream, ctx);
    this.events.ctxState?.(ctx.state);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.state !== 'running') void ctx.resume();
    });
  }

  private async askMic(): Promise<MediaStream | null> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot reach the microphone.');
      // all three processors OFF: on iOS they make the mic behave like a phone call
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      const err = e as DOMException;
      this.micError =
        err.name === 'NotAllowedError'
          ? 'Microphone access was declined. You can still load sounds from your files.'
          : err.message || 'No microphone available.';
      return null;
    }
  }

  private attachMic(stream: MediaStream, ctx: AudioContext) {
    this.stream = stream;
    const src = ctx.createMediaStreamSource(stream);
    const cap = workletNode(ctx, 'fs-capture', {}, 1, 1);
    cap.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'level') this.events.level?.(m.peak);
      else if (m.type === 'chunk') this.onChunk(m.data as Float32Array);
      else if (m.type === 'recStopped') this.recDone?.();
    };
    // the capture node outputs silence; it is wired to the destination only so it keeps running
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(cap).connect(mute).connect(ctx.destination);
    this.capture = cap;
    // Keep the speaker (not the earpiece) and the silent switch out of the way. iOS 16.4+.
    const nav = navigator as AudioSessionNav;
    if (nav.audioSession) nav.audioSession.type = 'play-and-record';
    // if iOS or the user ends the mic stream, say so instead of recording silence
    for (const tr of stream.getAudioTracks())
      tr.addEventListener('ended', () => {
        this.capture = null;
        this.micError = 'The microphone was disconnected.';
      });
  }

  /* ------------------------------------------------------------ record -- */

  startRecording(track: number): boolean {
    if (!this.capture || this.recTrack >= 0) return false;
    this.chunks = [];
    this.recSamples = 0;
    this.recTrack = track;
    this.applyMix(track); // a track that is being re-recorded goes quiet
    this.capture.port.postMessage({ type: 'rec', on: true });
    if (!this.playing) this.setPlaying(true);
    return true;
  }

  private onChunk(data: Float32Array) {
    if (this.recTrack < 0) return;
    this.chunks.push(data);
    this.recSamples += data.length;
    const sr = this.sampleRate;
    this.events.recTime?.(this.recTrack, this.recSamples / sr);
    if (this.recSamples >= MAX_SECONDS * sr) this.events.recAutoStop?.(this.recTrack);
  }

  async stopRecording(): Promise<RecResult> {
    const t = this.recTrack;
    if (t < 0 || !this.capture) return { ok: false, reason: 'idle' };
    const done = new Promise<void>((res) => {
      this.recDone = res;
      setTimeout(res, 600); // never hang if the context was suspended
    });
    this.capture.port.postMessage({ type: 'rec', on: false });
    await done;
    this.recDone = null;
    this.recTrack = -1;
    let raw = concat(this.chunks);
    this.chunks = [];
    const max = Math.floor(MAX_SECONDS * this.sampleRate);
    if (raw.length > max) raw = raw.subarray(0, max);
    const res = prepareLoop(raw, this.sampleRate);
    if (res.ok) this.setBuffer(t, res.data);
    this.applyMix(t);
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }

  /** Put audio on a track. Resets the loop window; keeps stretch/pitch/etc. */
  setBuffer(track: number, data: Float32Array) {
    const t = this.tracks[track];
    this.audio[track] = data;
    this.peaks[track] = computePeaks(data, 320);
    t.seconds = data.length / this.sampleRate;
    t.start = 0;
    t.end = 1;
    const copy = data.slice();
    this.nodes[track].looper.port.postMessage({ type: 'buffer', channels: [copy] }, [copy.buffer]);
    this.update(track, { start: 0, end: 1 });
    this.events.track?.(track);
  }

  clearTrack(track: number) {
    this.audio[track] = null;
    this.peaks[track] = null;
    this.tracks[track].seconds = 0;
    this.nodes[track]?.looper.port.postMessage({ type: 'buffer', channels: [] });
    this.events.track?.(track);
  }

  async importFile(track: number, file: File): Promise<RecResult> {
    if (!this.ctx) return { ok: false, reason: 'idle' };
    const decoded = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const chans = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    let mono = toMono(chans);
    const max = Math.floor(MAX_SECONDS * decoded.sampleRate);
    if (mono.length > max) mono = mono.slice(0, max);
    const res = prepareLoop(mono, decoded.sampleRate);
    if (!res.ok) return { ok: false, reason: res.reason };
    this.setBuffer(track, res.data);
    if (!this.playing) this.setPlaying(true);
    return { ok: true };
  }

  /* ------------------------------------------------------------- params -- */

  private looperParams(t: TrackState) {
    return {
      engine: t.engine,
      stretch: t.stretch,
      pitch: t.pitch,
      reverse: t.reverse ? 1 : 0,
      freeze: t.freeze ? 1 : 0,
      start: t.start,
      end: t.end,
      window: WINDOW[this.quality],
      playing: this.playing && t.seconds > 0 ? 1 : 0,
    };
  }

  update(track: number, patch: Partial<TrackState>) {
    const t = this.tracks[track];
    Object.assign(t, patch);
    const n = this.nodes[track];
    if (!n) return;
    n.looper.port.postMessage({ type: 'params', params: this.looperParams(t) });
    if ('level' in patch || 'mute' in patch) this.applyMix(track);
    if ('pan' in patch) n.pan.pan.setTargetAtTime(t.pan, this.ctx!.currentTime, 0.02);
  }

  private applyMix(track: number) {
    const t = this.tracks[track];
    const n = this.nodes[track];
    if (!n || !this.ctx) return;
    const target = t.mute || this.recTrack === track ? 0 : t.level * t.level;
    n.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  setMaster(v: number) {
    this.masterLevel = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02);
  }

  setQuality(q: Quality) {
    this.quality = q;
    for (let i = 0; i < TRACKS; i++) this.update(i, {});
  }

  setPlaying(on: boolean) {
    this.playing = on;
    for (let i = 0; i < TRACKS; i++) {
      this.update(i, {});
      if (on && this.tracks[i].seconds > 0) this.nodes[i]?.looper.port.postMessage({ type: 'play' });
    }
    void this.holdScreen(on);
  }

  /** Reset every processor (the "panic" button). */
  panic() {
    for (const n of this.nodes) n.looper.port.postMessage({ type: 'reset' });
    this.safety?.port.postMessage({ type: 'reset' });
  }

  /** Keep the screen (and so the audio) awake while playing. */
  private async holdScreen(on: boolean) {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (on && wl && !this.wake) this.wake = await wl.request('screen');
      else if (!on && this.wake) {
        await this.wake.release();
        this.wake = null;
      }
    } catch {
      this.wake = null; // not allowed (low power mode, hidden tab) — harmless
    }
  }

  /** Release the mic and context. */
  dispose() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
  }
}
