/*
 * The audio engine: one AudioContext, the microphone, three loop tracks (two
 * you record onto, plus the Bounce track that tracks are dubbed onto) and the
 * master chain. The graph itself is built in graph.ts (shared with offline render).
 *
 *   mic ─► fs-capture (raw PCM, meter) ─► [taken when a track is armed]
 *   master ─► fxm-safety ─► out ─► fs-tap (records the mix, or a dub onto Bounce)
 *
 * The context is created inside the first tap (iOS refuses otherwise), and the
 * mic request is fired in that same tap, in parallel with loading the DSP.
 */
import { ensureWorklets, workletNode } from './worklets';
import {
  MAX_BOUNCE_SECONDS,
  MAX_SECONDS,
  computePeaks,
  concat,
  layerInto,
  normalise,
  peakOf,
  prepareLoop,
  repairSpeed,
  resampleTo,
  toMono,
} from './loopfx';
import { buildGraph, dryWet, type GraphInit, type GraphNodes, type TrackNodes } from './graph';
import { Sequencer, planSequence, type SeqSettings, type Step } from '../music/sequencer';

/** Two tracks you record onto, and the Bounce track (index 2) that they are dubbed onto. */
export const TRACKS = 3;
export const MIC_TRACKS = 2;
export const BOUNCE = 2;
export type EngineKind = 'spectral' | 'granular' | 'tape';
/** A loop is one channel (a mic take) or two (the Bounce track keeps the stereo image). */
export type Loop = Float32Array[];

export const trackName = (i: number): string => (i === BOUNCE ? 'Bounce' : `Track ${i + 1}`);

/** Per-mode sound controls. Each mode keeps its own, so switching modes never loses a setting. */
export interface TapeSound {
  /** slow speed drift 0–1 */
  wow: number;
  /** fast speed wobble 0–1 */
  flutter: number;
  /** tape saturation 0–1 */
  drive: number;
  /** high-frequency loss 0–1 */
  age: number;
  /** tape noise 0–1 */
  hiss: number;
}
export interface SpectralSound {
  /** log2 of the FFT frame (11–15): small = soft and quick, large = fine detail and slow */
  window: number;
  /** stereo width of the random phases 0–1 */
  spread: number;
  /** −1 dark … +1 bright */
  tilt: number;
  /** 0 diffuse … 0.5 as the source … 1 tonal */
  focus: number;
}
export interface GranularSound {
  /** ms */
  grain: number;
  /** grains per second */
  density: number;
  /** position scatter 0–1 */
  jitter: number;
  /** pitch scatter, semitones */
  spray: number;
  spread: number;
  /** 0 percussive … 1 smooth */
  shape: number;
  /** chance a grain plays backwards 0–1 */
  grev: number;
}
export interface SoundState {
  tape: TapeSound;
  spectral: SpectralSound;
  granular: GranularSound;
}
export const defaultSound = (): SoundState => ({
  tape: { wow: 0, flutter: 0, drive: 0, age: 0, hiss: 0 },
  spectral: { window: 13, spread: 0.6, tilt: 0, focus: 0.5 },
  granular: { grain: 120, density: 24, jitter: 0.2, spray: 0, spread: 0.6, shape: 1, grev: 0 },
});
/** the Focus slider (0–1, middle = unchanged) → the spectrum power law the DSP uses */
export const focusToContrast = (f: number): number => (f < 0.5 ? 0.5 + f : 1 + (f - 0.5) * 3);

export interface TrackState {
  engine: EngineKind;
  stretch: number;
  /** seconds a stretch change takes to arrive (0 = instant); on tape it is the motor's inertia */
  glide: number;
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
  /** recording layers over the loop instead of replacing it */
  overdub: boolean;
  /** how much of the old loop survives an overdub / dub (1 = all of it) */
  keep: number;
  sound: SoundState;
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

/** What a saved project holds (the audio is stored beside it). */
export interface ProjectData {
  app: 'FieldStretcher';
  /** 1 = the four-track version */
  v: 1 | 2;
  sampleRate: number;
  masterLevel: number;
  tracks: Omit<TrackState, 'seconds'>[];
  fx: FxState;
  seq: SeqSettings & { rate: number };
}

/** What happened to the most recent take (shown in Settings, to diagnose a wrong-speed recording). */
export interface TakeInfo {
  heardSeconds: number;
  realSeconds: number;
  /** 1 = fine; otherwise the speed error that was repaired */
  repaired: number;
}

/** longest mix recording (stereo float in memory) */
export const MAX_MIX_SECONDS = 180;

const num = (v: unknown, lo: number, hi: number, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

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


export interface EngineEvents {
  level(peak: number): void;
  /** playhead (0–1 of the loop) and the real speed it is moving at (1 = normal, negative = reverse) */
  pos(track: number, v: number, rate: number): void;
  limiter(grDb: number, peakDb: number): void;
  ctxState(state: string): void;
  recTime(track: number, seconds: number): void;
  recAutoStop(track: number): void;
  blowup(): void;
  /** a track's audio was loaded, replaced or cleared */
  track(track: number): void;
  /** the whole state was replaced (project opened, scene applied, new project): rebuild the UI */
  project(): void;
  /** mix recording progress, seconds */
  bounceTime(seconds: number): void;
  /** mix recording hit its length limit */
  bounceAutoStop(): void;
  /** dub progress, seconds */
  dubTime(seconds: number): void;
  /** a dub hit the Bounce track's length limit */
  dubAutoStop(): void;
  /** granular grains just spawned: [position 0–1, length 0–1, pan, semitones, direction ±1] */
  grains(track: number, grains: number[][]): void;
}

type SceneSound = { tape?: Partial<TapeSound>; spectral?: Partial<SpectralSound>; granular?: Partial<GranularSound> };
export type SceneTrack = Partial<Omit<TrackState, 'seconds' | 'start' | 'end' | 'sound'>> & { sound?: SceneSound };

/** A starting point: settings only, applied over the current tracks (the recordings stay). */
export interface Scene {
  name: string;
  blurb: string;
  tracks: SceneTrack[];
  fx: { reso?: Partial<ResoState>; delay?: Partial<DelayState>; reverb?: Partial<ReverbState>; level?: number };
  seq?: Partial<SeqSettings & { rate: number }>;
  seqOn?: boolean;
  /** saved by the user (can be deleted) */
  user?: boolean;
}

export type RecResult = { ok: true } | { ok: false; reason: 'short' | 'quiet' | 'idle' | 'busy' };

/** Every track starts as a plain loop at normal speed (tape at 1×), with nothing sent to the FX. */
const defaultTrack = (): TrackState => ({
  engine: 'tape',
  stretch: 1,
  glide: 0,
  pitch: 0,
  reverse: false,
  freeze: false,
  start: 0,
  end: 1,
  level: 0.8,
  pan: 0,
  mute: false,
  send: 0,
  overdub: false,
  keep: 1,
  sound: defaultSound(),
  seconds: 0,
});

const mergeSound = (base: SoundState, patch: SceneSound | undefined): SoundState => ({
  tape: { ...base.tape, ...patch?.tape },
  spectral: { ...base.spectral, ...patch?.spectral },
  granular: { ...base.granular, ...patch?.granular },
});

/** Read a sound block from a saved file: anything missing or out of range falls back to the default. */
function readSound(src: unknown): SoundState {
  const d = defaultSound();
  const s = (src ?? {}) as { tape?: Partial<TapeSound>; spectral?: Partial<SpectralSound>; granular?: Partial<GranularSound> };
  const t = s.tape ?? {};
  const sp = s.spectral ?? {};
  const g = s.granular ?? {};
  return {
    tape: { wow: num(t.wow, 0, 1, d.tape.wow), flutter: num(t.flutter, 0, 1, d.tape.flutter), drive: num(t.drive, 0, 1, d.tape.drive), age: num(t.age, 0, 1, d.tape.age), hiss: num(t.hiss, 0, 1, d.tape.hiss) },
    spectral: { window: Math.round(num(sp.window, 11, 15, d.spectral.window)), spread: num(sp.spread, 0, 1, d.spectral.spread), tilt: num(sp.tilt, -1, 1, d.spectral.tilt), focus: num(sp.focus, 0, 1, d.spectral.focus) },
    granular: {
      grain: num(g.grain, 10, 1000, d.granular.grain),
      density: num(g.density, 1, 200, d.granular.density),
      jitter: num(g.jitter, 0, 1, d.granular.jitter),
      spray: num(g.spray, 0, 12, d.granular.spray),
      spread: num(g.spread, 0, 1, d.granular.spread),
      shape: num(g.shape, 0, 1, d.granular.shape),
      grev: num(g.grev, 0, 1, d.granular.grev),
    },
  };
}

type AudioSessionNav = Navigator & { audioSession?: { type: string } };
type Wake = { release(): Promise<void> };

export class Engine {
  ctx: AudioContext | null = null;
  events: Partial<EngineEvents> = {};
  tracks: TrackState[] = Array.from({ length: TRACKS }, defaultTrack);
  fx: FxState = defaultFx();
  seq: SeqState = { on: false, rate: 3 };
  sequencer = new Sequencer({ scale: 'dorian', motion: 'drift', range: 2, chance: 0.85, chordSize: 0, seed: 1 });
  /** waveform peaks per track (null = empty) */
  peaks: (Float32Array | null)[] = Array(TRACKS).fill(null);
  /** the loop audio itself (1 channel, or 2 on the Bounce track), kept for export, redraw and layering */
  loops: (Loop | null)[] = Array(TRACKS).fill(null);
  /** last reported playhead per track, 0–1 (where an overdub or a dub lands) */
  lastPos: number[] = Array(TRACKS).fill(0);
  playing = true;
  masterLevel = 0.85;
  micError: string | null = null;
  recTrack = -1;
  /** the track being dubbed onto Bounce, or -1 */
  dubSource = -1;
  bouncing = false;
  /** audio-path facts for the Settings sheet */
  diag: { ctxRate: number; micRate: number | null; take: TakeInfo | null } = { ctxRate: 0, micRate: null, take: null };

  private g: GraphNodes | null = null;
  private capture: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];
  private recSamples = 0;
  private recDone: (() => void) | null = null;
  private recOverdub = false;
  private recOffset = 0;
  private recWall0 = 0;
  private wake: Wake | null = null;
  private starting: Promise<void> | null = null;
  private seqTimer = 0;
  private seqNext = 0;
  private seqLast = 0;
  /** a tapped note is holding the resonator off the Key setting */
  private manualNote = false;
  private seqLog: { at: number; step: Step }[] = [];
  private fxListeners = new Set<() => void>();
  private changeListeners = new Set<(audioTrack?: number) => void>();
  private tap: AudioWorkletNode | null = null;
  private tapChunks: { l: Float32Array; r: Float32Array }[] = [];
  private tapSamples = 0;
  private tapDone: (() => void) | null = null;
  private dubOffset = 0;

  /** Subscribe to any state change (autosave). `audioTrack` is set when that track's audio changed. */
  onChange(fn: (audioTrack?: number) => void): void {
    this.changeListeners.add(fn);
  }
  private touch(audioTrack?: number) {
    for (const l of this.changeListeners) l(audioTrack);
  }
  /** Drop UI subscriptions before the UI is rebuilt. */
  clearUiListeners() {
    this.fxListeners.clear();
  }
  /** UI hook: runs whenever any FX/sequencer value changes (to keep duplicate controls in step). */
  onFxChange(fn: () => void): void {
    this.fxListeners.add(fn);
  }
  private fxChanged() {
    for (const l of this.fxListeners) l();
  }

  get started(): boolean {
    return this.g !== null;
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
  get dubbing(): boolean {
    return this.dubSource >= 0;
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
    this.diag.ctxRate = ctx.sampleRate;
    ctx.onstatechange = () => this.events.ctxState?.(ctx.state);
    void ctx.resume();
    // fire the mic request now, inside the tap, in parallel with DSP loading
    const micP = this.askMic();
    await ensureWorklets(ctx);

    this.g = buildGraph(ctx, this.graphInit({ live: true }), {
      safety: (m) => {
        if (m.type === 'meter') this.events.limiter?.(m.gr ?? 0, m.peak ?? 0);
      },
      looper: (i, m) => {
        if (m.type === 'pos') {
          this.lastPos[i] = m.v ?? 0;
          this.events.pos?.(i, m.v ?? 0, m.r ?? 0);
        } else if (m.type === 'grains') this.events.grains?.(i, m.g ?? []);
      },
      blowup: () => this.events.blowup?.(),
    });

    const stream = await micP;
    if (stream) this.attachMic(stream, ctx);
    this.events.ctxState?.(ctx.state);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.state !== 'running') void ctx.resume();
    });
  }

  /* ------------------------------------------------------- graph state -- */

  private muteGain(i: number): number {
    const t = this.tracks[i];
    if (this.dubSource >= 0) return i === this.dubSource ? 1 : 0; // a dub hears the source on its own
    if (this.recTrack === i && !this.recOverdub) return 0; // a track being re-recorded goes quiet
    return t.mute ? 0 : 1;
  }

  /**
   * Everything the graph is built from. `live` = the playing graph; otherwise an
   * offline render, in which every loop plays from the top and, if `solo` is set,
   * only that track is heard (a stem).
   */
  private graphInit(o: { live: boolean; solo?: number | null; seconds?: number }): GraphInit {
    const fx = this.fx;
    const tonic = this.tonic();
    const base = this.resoParams();
    const reso: Record<string, number> = { ...base, note: base.note ?? tonic };
    let resoQueue: unknown[] | undefined;
    if (!o.live) {
      if (this.seq.on) resoQueue = planSequence(this.sequencer.s, this.seq.rate, o.seconds ?? 30, tonic, this.sampleRate);
      else if (this.manualNote) reso.note = tonic + this.sequencer.describe(this.sequencer.index).semis;
    }
    return {
      tracks: this.tracks.map((t, i) => ({
        params: this.looperParams(t, !o.live, o.live ? t.seconds > 0 : !!this.loops[i]),
        audio: o.live ? null : this.loops[i],
        seed: 1000 + i,
        mute: o.live ? this.muteGain(i) : o.solo === undefined || o.solo === null ? (t.mute ? 0 : 1) : i === o.solo ? 1 : 0,
        gain: t.level ** 2,
        pan: t.pan,
        send: t.send ** 2,
      })),
      fx: {
        reso,
        delay: this.delayParams(),
        reverb: this.reverbParams(),
        mix: { reso: fx.reso.mix, delay: fx.delay.mix, reverb: fx.reverb.mix },
        level: fx.level ** 2,
      },
      master: this.masterLevel ** 2,
      resoQueue,
      report: o.live,
    };
  }

  /** The graph for an offline render: everything as it is now, loops starting from the top. */
  renderInit(seconds: number, solo: number | null): GraphInit {
    return this.graphInit({ live: false, solo, seconds });
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

  private looperParams(t: TrackState, forcePlaying = false, hasAudio = t.seconds > 0): Record<string, number | string> {
    const s = t.sound;
    return {
      engine: t.engine,
      stretch: t.stretch,
      glide: t.glide,
      pitch: t.pitch,
      reverse: t.reverse ? 1 : 0,
      freeze: t.freeze ? 1 : 0,
      start: t.start,
      end: t.end,
      playing: (forcePlaying || this.playing) && hasAudio ? 1 : 0,
      // tape
      wow: s.tape.wow,
      flutter: s.tape.flutter,
      drive: s.tape.drive,
      age: s.tape.age,
      hiss: s.tape.hiss,
      // spectral and granular both use `spread`; send the one for the mode in use
      window: s.spectral.window,
      tilt: s.spectral.tilt,
      contrast: focusToContrast(s.spectral.focus),
      spread: t.engine === 'granular' ? s.granular.spread : s.spectral.spread,
      // granular
      grain: s.granular.grain,
      density: s.granular.density,
      jitter: s.granular.jitter,
      spray: s.granular.spray,
      shape: s.granular.shape,
      grev: s.granular.grev,
    };
  }

  updateFx<K extends 'reso' | 'delay' | 'reverb'>(section: K, patch: Partial<FxState[K]>) {
    Object.assign(this.fx[section], patch);
    this.touch();
    this.fxChanged();
    if (section === 'reso' && ('root' in patch || 'octave' in patch)) {
      this.manualNote = false;
      if (this.seq.on) this.seqReschedule(true);
    }
    if (!this.ctx || !this.g) return;
    const st = this.g.stages[section];
    const params = section === 'reso' ? this.resoParams() : section === 'delay' ? this.delayParams() : this.reverbParams();
    st.node.port.postMessage({ type: 'params', params });
    if ('mix' in patch) {
      const w = dryWet(this.fx[section].mix);
      st.dry.gain.setTargetAtTime(w.dry, this.ctx.currentTime, 0.03);
      st.wet.gain.setTargetAtTime(w.wet, this.ctx.currentTime, 0.03);
    }
  }

  setFxLevel(v: number) {
    this.fx.level = v;
    this.touch();
    if (this.ctx && this.g) this.g.busOut.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02);
  }

  /* ---------------------------------------------------------- sequencer -- */

  private resoNode(): AudioWorkletNode | null {
    return this.g?.stages.reso.node ?? null;
  }

  setSeqOn(on: boolean) {
    this.seq.on = on;
    this.manualNote = false;
    const reso = this.resoNode();
    if (!this.ctx || !reso) return;
    window.clearInterval(this.seqTimer);
    reso.port.postMessage({ type: 'clear' });
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
      reso.port.postMessage({ type: 'chord' });
      reso.port.postMessage({ type: 'params', params: this.resoParams() });
    }
    this.fxChanged();
  }

  updateSeq(patch: Partial<SeqSettings> & { rate?: number }) {
    const { rate, ...settings } = patch;
    if (rate !== undefined) this.seq.rate = rate;
    Object.assign(this.sequencer.s, settings);
    this.touch();
    if (patch.range !== undefined || patch.scale !== undefined) this.sequencer.set(Math.min(this.sequencer.index, this.sequencer.max));
    this.fxChanged();
    if (this.seq.on) this.seqReschedule(patch.scale !== undefined || patch.chordSize !== undefined || patch.range !== undefined);
    else if (patch.chordSize !== undefined && this.g && this.manualNote) this.seqSet(this.sequencer.index);
  }

  /** a new seed: a new line, from the tonic */
  reseed(seed = Math.floor(Math.random() * 1e6)) {
    this.sequencer.reseed(seed);
    this.touch();
    this.fxChanged();
    if (this.seq.on) this.seqReschedule(true);
  }

  /** Play a scale note now (a tapped note); it holds until the sequencer moves on. */
  seqSet(index: number) {
    const reso = this.resoNode();
    if (!this.ctx || !reso) return;
    const step = this.sequencer.set(index);
    if (!this.seq.on) {
      this.manualNote = true;
      reso.port.postMessage({ type: 'params', params: this.resoParams() });
    } else this.seqReschedule(false);
    this.sendStep(step, this.ctx.currentTime + 0.02, 0);
    this.fxChanged();
  }

  /** Drop what is queued and re-plan from the current settings. `replay` re-sounds the current note. */
  private seqReschedule(replay: boolean) {
    const reso = this.resoNode();
    if (!this.ctx || !reso) return;
    const now = this.ctx.currentTime;
    reso.port.postMessage({ type: 'clear' });
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
    const reso = this.resoNode();
    if (!this.ctx || !reso) return;
    reso.port.postMessage({
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

  /* --------------------------------------------------------------- mic -- */

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
    this.diag.micRate = stream.getAudioTracks()[0]?.getSettings().sampleRate ?? null;
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

  /** Record the mic onto a track. With Overdub on (and something already there) it layers over the loop instead of replacing it. */
  startRecording(track: number): boolean {
    if (!this.capture || this.recTrack >= 0 || this.dubSource >= 0 || track >= MIC_TRACKS) return false;
    this.chunks = [];
    this.recSamples = 0;
    this.recTrack = track;
    this.recWall0 = performance.now();
    const loop = this.loops[track];
    this.recOverdub = this.tracks[track].overdub && !!loop;
    // an overdub lands where the loop is now; the loop keeps playing underneath
    this.recOffset = loop ? Math.floor(this.lastPos[track] * loop[0].length) : 0;
    this.applyMix(track);
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
    const wall = (performance.now() - this.recWall0) / 1000;
    const done = new Promise<void>((res) => {
      this.recDone = res;
      setTimeout(res, 600); // never hang if the context was suspended
    });
    this.capture.port.postMessage({ type: 'rec', on: false });
    await done;
    this.recDone = null;
    const overdub = this.recOverdub;
    this.recTrack = -1;
    this.recOverdub = false;
    let raw = concat(this.chunks);
    this.chunks = [];
    const sr = this.sampleRate;
    // a take must be as long as the time that really passed; if not, the speed was wrong
    const fixed = repairSpeed(raw, sr, wall);
    raw = fixed.data;
    this.diag.take = { heardSeconds: this.recSamples / sr, realSeconds: wall, repaired: fixed.ratio };
    const max = Math.floor(MAX_SECONDS * sr);
    if (raw.length > max) raw = raw.subarray(0, max);
    let result: RecResult;
    const old = this.loops[t];
    if (overdub && old) {
      // layer the take over the loop at the playhead it started on
      let mean = 0;
      for (let i = 0; i < raw.length; i++) mean += raw[i];
      mean /= Math.max(1, raw.length);
      const layer = raw.map((v) => v - mean);
      if (raw.length < 0.1 * sr) result = { ok: false, reason: 'short' };
      else if (peakOf([layer]) < 0.001) result = { ok: false, reason: 'quiet' };
      else {
        const dst = old[0].slice();
        layerInto(dst, layer, this.recOffset, this.tracks[t].keep);
        this.setBuffer(t, [dst], true);
        result = { ok: true };
      }
    } else {
      const res = prepareLoop([raw], sr);
      if (res.ok) {
        this.setBuffer(t, res.chans);
        result = { ok: true };
      } else result = { ok: false, reason: res.reason };
    }
    this.applyMix(t);
    return result;
  }

  /**
   * Put audio on a track. A new loop resets the loop window and restarts; `keep`
   * swaps audio of the same length under the playing loop without restarting it
   * (an overdub, a dub layered onto Bounce, a normalise).
   */
  setBuffer(track: number, chans: Loop, keep = false) {
    const t = this.tracks[track];
    const same = keep && this.loops[track] && this.loops[track]![0].length === chans[0].length;
    this.loops[track] = chans;
    this.peaks[track] = computePeaks(chans, 320);
    t.seconds = chans[0].length / this.sampleRate;
    if (!same) {
      t.start = 0;
      t.end = 1;
    }
    const copies = chans.map((c) => c.slice());
    this.g?.tracks[track].looper.port.postMessage({ type: 'buffer', channels: copies, keep: !!same }, copies.map((c) => c.buffer));
    this.update(track, same ? {} : { start: 0, end: 1 });
    this.events.track?.(track);
    this.touch(track);
  }

  clearTrack(track: number) {
    this.loops[track] = null;
    this.peaks[track] = null;
    this.tracks[track].seconds = 0;
    this.g?.tracks[track]?.looper.port.postMessage({ type: 'buffer', channels: [] });
    this.events.track?.(track);
    this.touch(track);
  }

  /** Bring a quiet recording up to −3 dBFS. Never done automatically. */
  normaliseTrack(track: number): { ok: true; gainDb: number } | { ok: false; reason: 'empty' | 'quiet' } {
    const loop = this.loops[track];
    if (!loop) return { ok: false, reason: 'empty' };
    const r = normalise(loop);
    if (!r.ok) return { ok: false, reason: 'quiet' };
    this.setBuffer(track, r.chans, true);
    return { ok: true, gainDb: r.gainDb };
  }

  async importFile(track: number, file: File): Promise<RecResult> {
    if (!this.ctx) return { ok: false, reason: 'idle' };
    const decoded = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const all = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    // the Bounce track keeps a stereo image; the mic tracks are mono
    let chans: Loop = track === BOUNCE && all.length >= 2 ? [all[0], all[1]] : [toMono(all)];
    const max = Math.floor((track === BOUNCE ? MAX_BOUNCE_SECONDS : MAX_SECONDS) * decoded.sampleRate);
    if (chans[0].length > max) chans = chans.map((c) => c.slice(0, max));
    if (decoded.sampleRate !== this.sampleRate) chans = chans.map((c) => resampleTo(c, Math.round((c.length * this.sampleRate) / decoded.sampleRate)));
    const res = prepareLoop(chans, this.sampleRate);
    if (!res.ok) return { ok: false, reason: res.reason };
    this.setBuffer(track, res.chans);
    if (!this.playing) this.setPlaying(true);
    return { ok: true };
  }

  /* ------------------------------------------------------------- params -- */

  update(track: number, patch: Partial<Omit<TrackState, 'sound'>>) {
    const t = this.tracks[track];
    Object.assign(t, patch);
    this.touch();
    const n = this.g?.tracks[track];
    if (!n) return;
    n.looper.port.postMessage({ type: 'params', params: this.looperParams(t) });
    if ('level' in patch || 'mute' in patch || 'send' in patch) this.applyMix(track);
    if ('pan' in patch) n.pan.pan.setTargetAtTime(t.pan, this.ctx!.currentTime, 0.02);
  }

  /** A mode's own controls (the track keeps one set per mode). */
  updateSound<K extends keyof SoundState>(track: number, kind: K, patch: Partial<SoundState[K]>) {
    const t = this.tracks[track];
    Object.assign(t.sound[kind], patch);
    this.touch();
    this.g?.tracks[track]?.looper.port.postMessage({ type: 'params', params: this.looperParams(t) });
  }

  private applyMix(track: number) {
    const t = this.tracks[track];
    const n: TrackNodes | undefined = this.g?.tracks[track];
    if (!n || !this.ctx) return;
    const now = this.ctx.currentTime;
    n.mute.gain.setTargetAtTime(this.muteGain(track), now, 0.02);
    n.gain.gain.setTargetAtTime(t.level * t.level, now, 0.02);
    n.send.gain.setTargetAtTime(t.send * t.send, now, 0.02);
  }

  private applyAllMix() {
    for (let i = 0; i < TRACKS; i++) this.applyMix(i);
  }

  setMaster(v: number) {
    this.masterLevel = v;
    this.touch();
    if (this.ctx && this.g) this.g.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02);
  }

  setPlaying(on: boolean) {
    this.playing = on;
    for (let i = 0; i < TRACKS; i++) {
      this.update(i, {});
      if (on && this.tracks[i].seconds > 0) this.g?.tracks[i].looper.port.postMessage({ type: 'play' });
    }
    void this.holdScreen(on);
  }

  /** Reset every processor (the "panic" button). */
  panic() {
    if (!this.g) return;
    for (const n of this.g.tracks) n.looper.port.postMessage({ type: 'reset' });
    this.g.safety.port.postMessage({ type: 'reset' });
    for (const st of Object.values(this.g.stages)) st.node.port.postMessage({ type: 'reset' });
  }

  /** Keep the screen (and so the audio) awake while playing. */
  private async holdScreen(on: boolean) {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Wake> } }).wakeLock;
      if (on && wl && !this.wake) this.wake = await wl.request('screen');
      else if (!on && this.wake) {
        await this.wake.release();
        this.wake = null;
      }
    } catch {
      this.wake = null; // not allowed (low power mode, hidden tab) — harmless
    }
  }

  /* ------------------------------------------- the output tap: mix, dub -- */

  private ensureTap(): AudioWorkletNode | null {
    if (!this.ctx || !this.g) return null;
    if (!this.tap) {
      this.tap = workletNode(this.ctx, 'fs-tap', {}, 1);
      this.tap.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'chunk') {
          this.tapChunks.push({ l: m.l, r: m.r });
          this.tapSamples += m.l.length;
          const sec = this.tapSamples / this.sampleRate;
          if (this.dubSource >= 0) {
            this.events.dubTime?.(sec);
            if (sec >= MAX_BOUNCE_SECONDS) this.events.dubAutoStop?.();
          } else {
            this.events.bounceTime?.(sec);
            if (sec >= MAX_MIX_SECONDS) this.events.bounceAutoStop?.();
          }
        } else if (m.type === 'recStopped') this.tapDone?.();
      };
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      this.g.safety.connect(this.tap).connect(silent).connect(this.ctx.destination);
    }
    return this.tap;
  }

  private tapStart(): boolean {
    const tap = this.ensureTap();
    if (!tap) return false;
    this.tapChunks = [];
    this.tapSamples = 0;
    tap.port.postMessage({ type: 'rec', on: true });
    return true;
  }

  private async tapStop(): Promise<{ l: Float32Array; r: Float32Array } | null> {
    if (!this.tap) return null;
    const done = new Promise<void>((res) => {
      this.tapDone = res;
      setTimeout(res, 600);
    });
    this.tap.port.postMessage({ type: 'rec', on: false });
    await done;
    this.tapDone = null;
    const l = concat(this.tapChunks.map((c) => c.l));
    const r = concat(this.tapChunks.map((c) => c.r));
    this.tapChunks = [];
    return l.length ? { l, r } : null;
  }

  /** Start recording what comes out of the speakers (after the limiter). */
  startBounce(): boolean {
    if (!this.started || this.bouncing || this.dubSource >= 0) return false;
    if (!this.tapStart()) return false;
    this.bouncing = true;
    return true;
  }

  async stopBounce(): Promise<{ l: Float32Array; r: Float32Array; sampleRate: number } | null> {
    if (!this.bouncing) return null;
    const out = await this.tapStop();
    this.bouncing = false;
    return out ? { ...out, sampleRate: this.sampleRate } : null;
  }

  /**
   * Dub a track onto the Bounce track. The source plays on its own (stretch, pitch,
   * its FX send and the tails of the FX bus) and what comes out is recorded. The first
   * dub becomes the Bounce loop; later dubs are layered onto it from the loop position
   * where they began, the old audio kept by the Bounce track's "keep" amount.
   */
  startDub(source: number): boolean {
    if (!this.started || source >= MIC_TRACKS || !this.loops[source] || this.dubSource >= 0 || this.bouncing || this.recTrack >= 0) return false;
    const old = this.loops[BOUNCE];
    this.dubOffset = old ? Math.floor(this.lastPos[BOUNCE] * old[0].length) : 0;
    this.dubSource = source;
    this.applyAllMix();
    if (!this.playing) this.setPlaying(true);
    if (!this.tapStart()) {
      this.dubSource = -1;
      this.applyAllMix();
      return false;
    }
    return true;
  }

  async stopDub(): Promise<RecResult> {
    if (this.dubSource < 0) return { ok: false, reason: 'idle' };
    const out = await this.tapStop();
    this.dubSource = -1;
    this.applyAllMix();
    if (!out) return { ok: false, reason: 'short' };
    const sr = this.sampleRate;
    const max = Math.floor(MAX_BOUNCE_SECONDS * sr);
    const l = out.l.length > max ? out.l.subarray(0, max) : out.l;
    const r = out.r.length > max ? out.r.subarray(0, max) : out.r;
    const old = this.loops[BOUNCE];
    if (!old) {
      const res = prepareLoop([l, r], sr);
      if (!res.ok) return { ok: false, reason: res.reason };
      this.setBuffer(BOUNCE, res.chans);
    } else {
      if (l.length < 0.1 * sr) return { ok: false, reason: 'short' };
      if (peakOf([l, r]) < 0.001) return { ok: false, reason: 'quiet' };
      const dl = old[0].slice();
      const dr = (old[1] ?? old[0]).slice();
      const keep = this.tracks[BOUNCE].keep;
      layerInto(dl, l, this.dubOffset, keep);
      layerInto(dr, r, this.dubOffset, keep);
      this.setBuffer(BOUNCE, [dl, dr], true);
    }
    if (!this.playing) this.setPlaying(true);
    return { ok: true };
  }

  /* ----------------------------------------------------------- projects -- */

  getProject(): ProjectData {
    return {
      app: 'FieldStretcher',
      v: 2,
      sampleRate: this.sampleRate,
      masterLevel: this.masterLevel,
      tracks: this.tracks.map(({ seconds: _s, ...t }) => JSON.parse(JSON.stringify(t)) as Omit<TrackState, 'seconds'>),
      fx: JSON.parse(JSON.stringify(this.fx)) as FxState,
      seq: { ...this.sequencer.s, rate: this.seq.rate },
    };
  }

  /**
   * Replace the whole state. Tolerant of old or hand-edited files: anything
   * missing or out of range falls back to the default. The sequencer is left
   * off — a project should never start making sound by itself. A version-1
   * project (four tracks) brings its first two tracks; the Bounce track starts empty.
   */
  applyProject(d: Partial<ProjectData>, loops: (Loop | null)[], audioRate: number) {
    const def = defaultFx();
    const f = (d.fx ?? {}) as Partial<FxState>;
    const r = (f.reso ?? {}) as Partial<ResoState>;
    const dl = (f.delay ?? {}) as Partial<DelayState>;
    const rv = (f.reverb ?? {}) as Partial<ReverbState>;
    this.fx = {
      reso: {
        root: Math.round(num(r.root, 0, 11, def.reso.root)),
        octave: Math.round(num(r.octave, 1, 5, def.reso.octave)),
        chord: Math.round(num(r.chord, 0, RESO_CHORD_NAMES.length - 1, def.reso.chord)),
        decay: num(r.decay, 0, 1, def.reso.decay),
        bright: num(r.bright, 0, 1, def.reso.bright),
        spread: num(r.spread, 0, 1, def.reso.spread),
        glide: num(r.glide, 0.004, 4, def.reso.glide),
        pluck: num(r.pluck, 0, 1, def.reso.pluck),
        onset: num(r.onset, 0, 1, def.reso.onset),
        input: num(r.input, 0, 1, def.reso.input),
        mix: num(r.mix, 0, 1, def.reso.mix),
      },
      delay: {
        time: num(dl.time, 50, 1500, def.delay.time),
        feedback: num(dl.feedback, 0, 0.95, def.delay.feedback),
        tone: num(dl.tone, 0, 1, def.delay.tone),
        pingpong: bool(dl.pingpong, def.delay.pingpong),
        mix: num(dl.mix, 0, 1, def.delay.mix),
      },
      reverb: {
        size: num(rv.size, 0.3, 2, def.reverb.size),
        decay: num(rv.decay, 1, 30, def.reverb.decay),
        damping: num(rv.damping, 0, 0.95, def.reverb.damping),
        shimmer: num(rv.shimmer, 0, 1, def.reverb.shimmer),
        freeze: bool(rv.freeze, def.reverb.freeze),
        mix: num(rv.mix, 0, 1, def.reverb.mix),
      },
      level: num(f.level, 0, 1, def.level),
    };
    const kinds: EngineKind[] = ['spectral', 'granular', 'tape'];
    const fresh = defaultTrack();
    for (let i = 0; i < TRACKS; i++) {
      const src = (d.tracks?.[i] ?? {}) as Partial<TrackState>;
      const tr = this.tracks[i];
      tr.engine = kinds.includes(src.engine as EngineKind) ? (src.engine as EngineKind) : fresh.engine;
      tr.stretch = num(src.stretch, 1, 1000, fresh.stretch);
      tr.glide = num(src.glide, 0, 10, fresh.glide);
      tr.pitch = Math.round(num(src.pitch, -24, 24, 0));
      tr.reverse = bool(src.reverse, false);
      tr.freeze = bool(src.freeze, false);
      tr.level = num(src.level, 0, 1, fresh.level);
      tr.pan = num(src.pan, -1, 1, 0);
      tr.mute = bool(src.mute, false);
      tr.send = num(src.send, 0, 1, fresh.send);
      tr.overdub = bool(src.overdub, false);
      tr.keep = num(src.keep, 0, 1, fresh.keep);
      tr.sound = readSound(src.sound);
      const a = loops[i];
      if (a && a[0].length >= 256) {
        const chans = audioRate === this.sampleRate ? a : a.map((c) => resampleTo(c, Math.round((c.length * this.sampleRate) / audioRate)));
        this.setBuffer(i, chans);
        // setBuffer resets the loop window; put the saved one back
        tr.start = num(src.start, 0, 1, 0);
        tr.end = num(src.end, 0, 1, 1);
        if (tr.end - tr.start < 0.01) (tr.start = 0), (tr.end = 1);
      } else this.clearTrack(i);
      this.update(i, {});
    }
    this.masterLevel = num(d.masterLevel, 0, 1, 0.85);
    const sq = (d.seq ?? {}) as Partial<SeqSettings & { rate: number }>;
    this.seq.rate = num(sq.rate, 0.15, 30, 3);
    this.setSeqOn(false);
    const modes = ['lydian', 'ionian', 'mixolydian', 'dorian', 'aeolian', 'harmonicMinor', 'phrygian', 'octatonic'];
    const motions = ['drift', 'arp', 'markov', 'wander', 'hold'];
    Object.assign(this.sequencer.s, {
      scale: modes.includes(sq.scale as string) ? sq.scale : 'dorian',
      motion: motions.includes(sq.motion as string) ? sq.motion : 'drift',
      range: Math.round(num(sq.range, 1, 3, 2)),
      chance: num(sq.chance, 0, 1, 0.85),
      chordSize: [0, 3, 4, 5].includes(sq.chordSize as number) ? sq.chordSize : 0,
    });
    this.sequencer.reseed(Math.round(num(sq.seed, 0, 1e9, 1)));
    // push everything to the audio side
    if (this.ctx && this.g) {
      this.setMaster(this.masterLevel);
      this.setFxLevel(this.fx.level);
      for (const sec of ['reso', 'delay', 'reverb'] as const) this.updateFx(sec, { mix: this.fx[sec].mix });
      this.g.stages.reso.node.port.postMessage({ type: 'chord' });
      this.applyAllMix();
    }
    this.manualNote = false;
    this.touch();
    this.events.project?.();
  }

  /** A blank slate: empty tracks, default settings. */
  newProject() {
    this.applyProject({}, Array(TRACKS).fill(null), this.sampleRate);
  }

  /** Apply a scene (settings only — the recordings and their loop windows stay). */
  applyScene(scene: Scene) {
    const cur = this.getProject();
    const merged: Partial<ProjectData> = {
      ...cur,
      tracks: cur.tracks.map((t, i) => {
        const s = scene.tracks[i] ?? {};
        return { ...t, ...s, sound: mergeSound(t.sound, s.sound), start: t.start, end: t.end };
      }),
      fx: {
        reso: { ...cur.fx.reso, ...scene.fx.reso },
        delay: { ...cur.fx.delay, ...scene.fx.delay },
        reverb: { ...cur.fx.reverb, ...scene.fx.reverb },
        level: scene.fx.level ?? cur.fx.level,
      },
      seq: { ...cur.seq, ...scene.seq },
    };
    this.applyProject(merged, this.loops.map((a) => a), this.sampleRate);
    if (scene.seqOn) this.setSeqOn(true);
  }

  /** The current settings as a scene (no audio, no loop windows). */
  captureScene(name: string, blurb = 'Saved from your settings.'): Scene {
    const p = this.getProject();
    return {
      name,
      blurb,
      user: true,
      tracks: p.tracks.map(({ start: _a, end: _b, ...t }) => t),
      fx: p.fx,
      seq: p.seq,
      seqOn: this.seq.on,
    };
  }

  /** Release the mic and context. */
  dispose() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
  }
}
