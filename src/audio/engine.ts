/*
 * The audio engine: one AudioContext, the microphone, four loop tracks and
 * the master chain.
 *
 *   mic ─► fs-capture (raw PCM, meter) ─► [taken when a track is armed]
 *
 *   track 1..4:  fxm-looper ─► mute ─┬─► level ─► pan ──────────┐
 *                                    └─► send ─► FX BUS ─► return ┴─► master ─► fxm-safety ─► out
 *
 *   FX BUS:  reso ─► delay ─► reverb, each blended dry/wet (equal power)
 *
 * The send is taken BEFORE the level fader, so turning a track's level down
 * while its send is up gives a wet-only sound. Mute and recording silence both.
 *
 * The context is created inside the first tap (iOS refuses otherwise), and the
 * mic request is fired in that same tap, in parallel with loading the DSP.
 */
import { ensureWorklets, workletNode } from './worklets';
import { MAX_SECONDS, computePeaks, concat, prepareLoop, toMono } from './loopfx';
import { Sequencer, type SeqSettings, type Step } from '../music/sequencer';

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
  /** FX bus send, 0–1 (taken before the level fader) */
  send: number;
  /** length of the loop in seconds; 0 = empty */
  seconds: number;
}

export interface ResoState {
  /** pitch class 0–11 (C = 0) and octave; together they give the note when no sequencer is moving it */
  root: number;
  octave: number;
  chord: number;
  decay: number;
  bright: number;
  spread: number;
  glide: number;
  /** noise burst on every note change (0 = off) */
  pluck: number;
  /** pluck whenever the incoming audio has a hit in it: detector sensitivity (0 = off) */
  onset: number;
  /** how much of the incoming audio rings the strings */
  input: number;
  mix: number;
}
export interface DelayState {
  /** ms */
  time: number;
  feedback: number;
  tone: number;
  pingpong: boolean;
  mix: number;
}
export interface ReverbState {
  size: number;
  /** seconds (RT60) */
  decay: number;
  damping: number;
  shimmer: number;
  freeze: boolean;
  mix: number;
}
export interface FxState {
  reso: ResoState;
  delay: DelayState;
  reverb: ReverbState;
  /** FX bus return level 0–1 */
  level: number;
}

export const RESO_CHORD_NAMES = ['Single', 'Octaves', 'Fifths', 'Minor', 'Major', 'Sus4', 'Minor 9'];
export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
/** MIDI note of a root + octave (octave 3, A = 57 = A3 = 220 Hz) */
export const noteOf = (root: number, octave: number): number => 12 * (octave + 1) + root;

export interface SeqState {
  on: boolean;
  /** seconds per step */
  rate: number;
}
/** How far ahead notes are handed to the audio thread (so a throttled timer never drops a step). */
const LOOKAHEAD = 1.2;

const defaultFx = (): FxState => ({
  reso: { root: 9, octave: 3, chord: 2, decay: 0.7, bright: 0.5, spread: 0.3, glide: 0.4, pluck: 0, onset: 0, input: 1, mix: 0.5 },
  delay: { time: 420, feedback: 0.5, tone: 0.6, pingpong: true, mix: 0.3 },
  reverb: { size: 1, decay: 8, damping: 0.4, shimmer: 0, freeze: false, mix: 0.35 },
  level: 0.8,
});

/** equal-power dry/wet gains for a 0–1 mix */
const dryWet = (mix: number) => ({ dry: Math.cos((mix * Math.PI) / 2), wet: Math.sin((mix * Math.PI) / 2) });

interface Stage {
  input: GainNode;
  output: GainNode;
  dry: GainNode;
  wet: GainNode;
  node: AudioWorkletNode;
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
  /** mute / recording silence — before both the dry path and the send */
  mute: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
  send: GainNode;
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
    send: 0.3,
    seconds: 0,
  }));
  fx: FxState = defaultFx();
  seq: SeqState = { on: false, rate: 3 };
  sequencer = new Sequencer({ scale: 'dorian', motion: 'drift', range: 2, chance: 0.85, chordSize: 0, seed: 1 });
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
  private busIn!: GainNode;
  private busOut!: GainNode;
  private stages!: { reso: Stage; delay: Stage; reverb: Stage };
  private safety!: AudioWorkletNode;
  private capture: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];
  private recSamples = 0;
  private recDone: (() => void) | null = null;
  private wake: { release(): Promise<void> } | null = null;
  private starting: Promise<void> | null = null;
  private seqTimer = 0;
  private seqNext = 0;
  private seqLast = 0;
  /** a tapped note is holding the resonator off the Key setting */
  private manualNote = false;
  private seqLog: { at: number; step: Step }[] = [];
  private fxListeners = new Set<() => void>();

  get started(): boolean {
    return this.nodes.length > 0;
  }
  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }
  /** a tapped note is holding the resonator (the sequencer is off) */
  get holding(): boolean {
    return this.manualNote;
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

    this.buildBus(ctx);

    for (let i = 0; i < TRACKS; i++) {
      const t = this.tracks[i];
      const looper = workletNode(ctx, 'fxm-looper', { params: this.looperParams(t), seed: 1000 + i, report: true }, 0);
      looper.port.onmessage = (e) => {
        if (e.data.type === 'pos') this.events.pos?.(i, e.data.v);
        else if (e.data.type === 'blowup') this.events.blowup?.();
      };
      const mute = ctx.createGain();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const send = ctx.createGain();
      looper.connect(mute);
      mute.connect(gain).connect(pan).connect(this.master);
      mute.connect(send).connect(this.busIn);
      this.nodes.push({ looper, mute, gain, pan, send });
      this.applyMix(i);
    }

    const stream = await micP;
    if (stream) this.attachMic(stream, ctx);
    this.events.ctxState?.(ctx.state);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.state !== 'running') void ctx.resume();
    });
  }

  /** reso → delay → reverb, each stage blended dry/wet, into the return */
  private buildBus(ctx: AudioContext) {
    const fx = this.fx;
    this.busIn = ctx.createGain();
    this.busOut = ctx.createGain();
    this.busOut.gain.value = fx.level ** 2;
    const stage = (name: string, params: Record<string, number>, mix: number): Stage => {
      const node = workletNode(ctx, name, { params, report: true }, 1);
      node.port.onmessage = (e) => {
        if (e.data.type === 'blowup') this.events.blowup?.();
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
    const reso = stage('fxm-reso', this.resoParams(), fx.reso.mix);
    const delay = stage('fxm-delay', this.delayParams(), fx.delay.mix);
    const reverb = stage('fxm-fdn', this.reverbParams(), fx.reverb.mix);
    this.busIn.connect(reso.input);
    reso.output.connect(delay.input);
    delay.output.connect(reverb.input);
    reverb.output.connect(this.busOut).connect(this.master);
    this.stages = { reso, delay, reverb };
  }

  private resoParams() {
    const r = this.fx.reso;
    const p: Record<string, number> = { chord: r.chord, decay: r.decay, bright: r.bright, spread: r.spread, glide: r.glide, pluck: r.pluck, onset: r.onset, input: r.input };
    // while the sequencer (or a tapped note) owns the pitch, the Key setting must not overwrite it
    if (!this.seq.on && !this.manualNote) p.note = this.tonic();
    return p;
  }
  private tonic(): number {
    return noteOf(this.fx.reso.root, this.fx.reso.octave);
  }
  private delayParams() {
    const d = this.fx.delay;
    return {
      timeL: d.time,
      // ping-pong alternates evenly; otherwise the right side sits a dotted-feel behind
      timeR: d.pingpong ? d.time : d.time * 1.5,
      feedback: d.feedback,
      pingpong: d.pingpong ? 1 : 0,
      highcut: 1500 * Math.pow(8, d.tone),
    };
  }
  private reverbParams() {
    const r = this.fx.reverb;
    return { size: r.size, decay: r.decay, damping: r.damping, shimmer: r.shimmer, freeze: r.freeze ? 1 : 0 };
  }

  updateFx<K extends 'reso' | 'delay' | 'reverb'>(section: K, patch: Partial<FxState[K]>) {
    Object.assign(this.fx[section], patch);
    for (const l of this.fxListeners) l();
    if (section === 'reso' && ('root' in patch || 'octave' in patch)) {
      this.manualNote = false;
      if (this.seq.on) this.seqReschedule(true);
    }
    if (!this.ctx || !this.stages) return;
    const st = this.stages[section];
    const params = section === 'reso' ? this.resoParams() : section === 'delay' ? this.delayParams() : this.reverbParams();
    st.node.port.postMessage({ type: 'params', params });
    if ('mix' in patch) {
      const g = dryWet(this.fx[section].mix);
      st.dry.gain.setTargetAtTime(g.dry, this.ctx.currentTime, 0.03);
      st.wet.gain.setTargetAtTime(g.wet, this.ctx.currentTime, 0.03);
    }
  }

  setFxLevel(v: number) {
    this.fx.level = v;
    if (this.ctx) this.busOut.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02);
  }

  /* ---------------------------------------------------------- sequencer -- */

  /** UI hook: runs whenever any FX/sequencer value changes (to keep duplicate controls in step). */
  onFxChange(fn: () => void): void {
    this.fxListeners.add(fn);
  }

  setSeqOn(on: boolean) {
    this.seq.on = on;
    this.manualNote = false;
    if (!this.ctx || !this.stages) return;
    window.clearInterval(this.seqTimer);
    this.stages.reso.node.port.postMessage({ type: 'clear' });
    this.seqLog = [];
    if (on) {
      // sound the current note first, then step on from there
      const at = this.ctx.currentTime + 0.05;
      this.sendStep(this.sequencer.describe(this.sequencer.index), at, 0);
      this.seqLast = at;
      this.seqNext = at + this.seq.rate;
      this.seqTimer = window.setInterval(() => this.seqTick(), 120);
      this.seqTick();
    } else {
      // back to the Key setting (and the chord shape), gliding there
      this.stages.reso.node.port.postMessage({ type: 'chord' });
      this.stages.reso.node.port.postMessage({ type: 'params', params: this.resoParams() });
    }
    for (const l of this.fxListeners) l();
  }

  updateSeq(patch: Partial<SeqSettings> & { rate?: number }) {
    const { rate, ...settings } = patch;
    if (rate !== undefined) this.seq.rate = rate;
    Object.assign(this.sequencer.s, settings);
    if (patch.range !== undefined || patch.scale !== undefined) this.sequencer.set(Math.min(this.sequencer.index, this.sequencer.max));
    for (const l of this.fxListeners) l();
    if (this.seq.on) this.seqReschedule(patch.scale !== undefined || patch.chordSize !== undefined || patch.range !== undefined);
    else if (patch.chordSize !== undefined && this.stages && this.manualNote) this.seqSet(this.sequencer.index);
  }

  /** a new seed: a new line, from the tonic */
  reseed(seed = Math.floor(Math.random() * 1e6)) {
    this.sequencer.reseed(seed);
    for (const l of this.fxListeners) l();
    if (this.seq.on) this.seqReschedule(true);
  }

  /** Play a scale note now (a tapped note); it holds until the sequencer moves on. */
  seqSet(index: number) {
    if (!this.ctx || !this.stages) return;
    const step = this.sequencer.set(index);
    if (!this.seq.on) {
      this.manualNote = true;
      this.stages.reso.node.port.postMessage({ type: 'params', params: this.resoParams() });
    } else this.seqReschedule(false);
    this.sendStep(step, this.ctx.currentTime + 0.02, 0);
    for (const l of this.fxListeners) l();
  }

  /** Drop what is queued and re-plan from the current settings. `replay` re-sounds the current note. */
  private seqReschedule(replay: boolean) {
    if (!this.ctx || !this.stages) return;
    const now = this.ctx.currentTime;
    this.stages.reso.node.port.postMessage({ type: 'clear' });
    this.seqLog = this.seqLog.filter((e) => e.at <= now);
    this.seqNext = Math.max(now + 0.05, this.seqLast + this.seq.rate);
    if (replay) {
      const at = now + 0.03;
      this.sendStep(this.sequencer.describe(this.sequencer.index), at, 0);
      this.seqNext = Math.max(this.seqNext, at + this.seq.rate);
      this.seqLast = at;
    }
  }

  private seqTick() {
    if (!this.seq.on || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.seqNext < now) this.seqNext = now + 0.05;
    while (this.seqNext < now + LOOKAHEAD) {
      const step = this.sequencer.next();
      if (step) this.sendStep(step, this.seqNext, 0);
      this.seqLast = this.seqNext;
      this.seqNext += this.seq.rate;
    }
    this.seqLog = this.seqLog.filter((e) => e.at > now - 10);
  }

  private sendStep(step: Step, at: number, pluck: number) {
    if (!this.ctx || !this.stages) return;
    this.stages.reso.node.port.postMessage({
      type: 'note',
      frame: Math.round(at * this.ctx.sampleRate),
      note: this.tonic() + step.semis,
      offsets: step.offsets,
      pluck,
    });
    this.seqLog.push({ at, step });
  }

  /** The step that is sounding right now (for the display). */
  currentStep(): Step | null {
    if (!this.ctx) return null;
    const now = this.ctx.currentTime;
    let cur: Step | null = null;
    for (const e of this.seqLog) if (e.at <= now) cur = e.step;
    return cur;
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
    if ('level' in patch || 'mute' in patch || 'send' in patch) this.applyMix(track);
    if ('pan' in patch) n.pan.pan.setTargetAtTime(t.pan, this.ctx!.currentTime, 0.02);
  }

  private applyMix(track: number) {
    const t = this.tracks[track];
    const n = this.nodes[track];
    if (!n || !this.ctx) return;
    const now = this.ctx.currentTime;
    n.mute.gain.setTargetAtTime(t.mute || this.recTrack === track ? 0 : 1, now, 0.02);
    n.gain.gain.setTargetAtTime(t.level * t.level, now, 0.02);
    n.send.gain.setTargetAtTime(t.send * t.send, now, 0.02);
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
    if (this.stages) for (const st of Object.values(this.stages)) st.node.port.postMessage({ type: 'reset' });
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
