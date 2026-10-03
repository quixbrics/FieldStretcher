# FieldStretcher

Record the world on an iPhone, stretch it into drones — the fourth companion to
ScapeMaker, ToneMaker and FXMaker. Four looping tracks, each with its own
stretch engine, fed into an FX bus of resonator, delay and reverb, with a
generative sequencer walking the resonator through a scale.

**Static PWA. No backend, no accounts, no running cost.** Open the site in
Safari, Share → Add to Home Screen, and it runs full-screen and offline.

## Status: Phase 2 (FX bus)

| Phase | Scope | State |
|---|---|---|
| 1 | Mic capture, 4 loop tracks, Spectral / Granular / Tape stretch, pitch, reverse, freeze, loop window, level/pan/mute, safety limiter, mobile UI, PWA shell | **built** |
| 2 | FX bus: resonator → delay → reverb, per-track sends, FX tab | **built** |
| 3 | Generative sequencer: scale, motion modes, glide, seed | |
| 4 | Project save, WAV export + iOS share sheet, presets, polish, Maker Suite card | |

## Develop

```bash
npm install
npm run dev        # Vite --host; open the Network URL on a phone (add ?debug to expose window.__fs)
npm run typecheck  # tsc --noEmit, strict
npm test           # vitest — the worklet processors rendered in Node
npm run build      # tsc + vite build → dist/
npm run icons      # regenerate public/icon-*.png
```

The mic needs HTTPS on a real phone (`localhost` is exempt on desktop). Easiest
ways to test on an iPhone: deploy to GitHub Pages, or tunnel the dev server
(e.g. `npx localtunnel --port 5173`).

## How it works

| Layer | Files | Notes |
|---|---|---|
| DSP | `src/audio/dsp/*.js` | Plain JS AudioWorklet processors, concatenated into ONE module by `src/audio/worklets.ts` and run in Node by `tests/harness.ts` — same code tested and shipped. `common.js`, `looper.js`, `safety.js` come from FXMaker (looper: FFT ceiling cut to 32 768 for phones, plus a live `buffer` message so a fresh recording swaps in without rebuilding the node). |
| Capture | `dsp/capture.js` | Raw Float32 PCM off the audio thread (no MediaRecorder, so no codec and sample-accurate starts), ~85 ms chunks, always-on input meter. Echo cancellation, noise suppression and AGC are all requested **off**. |
| Takes | `src/audio/loopfx.ts` | DC removed, 20 ms equal-power seam crossfade, normalised to −3 dBFS (gain capped +40 dB; a silent take is refused, not boosted), 0.25–30 s. |
| Engine | `src/audio/engine.ts` | One context created inside the first tap (mic request fired in the same tap). track: looper → level → pan → master → safety → out. Handles `audioSession`, wake lock, resume after interruption. |
| FX bus | `dsp/fx-bus.js`, `engine.ts` | reso → delay → reverb, each blended dry/wet (equal power) by gain nodes, then a return fader. Reverb (8-line FDN, optional shimmer and freeze) and tape delay are FXMaker's processors unchanged. The resonator is FXMaker's string bank cut down to one **continuous MIDI note** + chord shape (up to 8 strings), with a `glide` time and an `offsets` message so the Phase 3 sequencer can move it and stack scale-based chords. Sends are **pre-fader**: Level down + Send up = wet-only. |
| UI | `src/ui/*`, `src/styles/*` | Vanilla TS, portrait, 44 px targets, safe-area insets. `tokens.css` is shared verbatim with the other Maker apps. |

### Stretch engines

- **Spectral** — Paulstretch: magnitudes kept, phases randomised. Smooth endless drones, pitch independent of stretch. Quality (Settings) sets the FFT frame: Draft 4 096, Normal 8 192, High 16 384.
- **Granular** — up to 96 Hann grains around a head moving at 1/stretch.
- **Tape** — varispeed; pitch falls as stretch grows.
- Stretch 1×–1000× (log slider + quick chips), pitch ±24 st, reverse, freeze, loop window (drag the handles on the waveform).

### iOS notes

- Tap-to-start splash: the AudioContext and mic permission must come from a user gesture.
- `navigator.audioSession.type = 'play-and-record'` (iOS 16.4+) keeps sound audible with the silent switch on and out of the earpiece.
- Headphones recommended, otherwise the mic hears the speaker.
- Everything is held in memory in Phase 1: **recordings are lost on reload** until project save lands in Phase 4.
- Not verified on a physical iPhone yet — see "Needs a real-device check" below.

## Needs a real-device check

Built and tested in Node and a desktop browser pane (mic blocked there). Please try on an iPhone:

1. Mic permission prompt and first recording (level meter moves, take plays back).
2. Output route (speaker vs earpiece) and the silent switch.
3. CPU/battery with four Spectral tracks at High quality.
4. Home Screen install and offline relaunch.
