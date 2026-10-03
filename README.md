# FieldStretcher

Record the world on an iPhone, stretch it into drones — the fourth companion to
ScapeMaker, ToneMaker and FXMaker. Two looping tracks you record onto, plus a
Bounce track you dub them onto, each with its own stretch mode, fed into an FX
bus of resonator, delay and reverb, with a generative sequencer walking the
resonator through a scale.

**Static PWA. No backend, no accounts, no running cost.** Open the site in
Safari, Share → Add to Home Screen, and it runs full-screen and offline.

## Status: v2 (two tracks + Bounce)

| Phase | Scope | State |
|---|---|---|
| 1 | Mic capture, loop tracks, Spectral / Granular / Tape stretch, loop window, safety limiter, mobile UI, PWA | built |
| 2 | FX bus: resonator → delay → reverb, per-track sends | built |
| 3 | Generative sequencer, resonator plucks | built |
| 4 | Autosave, project files, mix recording, scenes | built |
| v2 | **Two mic tracks + a Bounce track** you dub onto; per-mode sound controls and pictures; stretch glide; overdub; Normalise button (no auto-normalise); offline render with stems; saveable scenes; sends default to 0 | **built** |

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
| Takes | `src/audio/loopfx.ts` | DC removed and a 20 ms equal-power seam crossfade; the level is left alone. A silent take is refused. **Normalise** (per track, under More) brings a quiet one to −3 dBFS on request, one gain for both channels. 0.25–30 s (Bounce: up to 60 s). |
| Engine | `src/audio/engine.ts` | One context created inside the first tap (mic request fired in the same tap). track: looper → level → pan → master → safety → out. Handles `audioSession`, wake lock, resume after interruption. |
| FX bus | `dsp/fx-bus.js`, `engine.ts` | reso → delay → reverb, each blended dry/wet (equal power) by gain nodes, then a return fader. Reverb (8-line FDN, optional shimmer and freeze) and tape delay are FXMaker's processors unchanged. The resonator is FXMaker's string bank cut down to one **continuous MIDI note** + chord shape (up to 8 strings), with a `glide` time and an `offsets` message so the Phase 3 sequencer can move it and stack scale-based chords. Sends are **pre-fader**: Level down + Send up = wet-only. |
| Resonator plucks | `dsp/fx-bus.js` | Decay runs 20 ms → 30 s. **Pluck** puts a 4 ms noise burst into the strings on every note *change*; **Onset** plucks whenever the audio sent in has a hit (fast/slow envelope detector, 80 ms refractory); **Input** sets how much audio rings the strings (0 = pluck-only). Presets: Drone / Pluck / Tick. |
| Sequencer | `src/music/sequencer.ts`, `engine.ts`, `src/ui/seqPanel.ts` | A seeded, pure walk through a scale (ToneMaker's 8 modes, `src/music/theory.ts`): **Drift**, **Arp** (in thirds, bouncing), **Markov** (favours tonic/fifth/third), **Wander** (smooth curve), **Hold** (tap a note). Step 0.15–30 s, glide, chance, 1–3 octave range, optional chord stacked from scale thirds, dice for a new seed. The engine hands notes to the resonator ~1.2 s ahead as **timed messages** (absolute audio frame), so a throttled timer or a busy main thread never drops or jitters a step. |
| Speed check | `engine.ts`, `loopfx.ts` | **Self-calibrating:** a take is timed against the wall clock; if the samples that arrived disagree with the real duration by more than 12% (frames dropped, or a mic/context sample-rate mismatch, which would play back too fast and too high) it is resampled to real length. Frames the input skips count as silence. The last take's numbers and the audio/mic rates are shown in Settings. |
| Persistence | `src/io/autosave.ts`, `project.ts`, `zip.ts` | IndexedDB autosave (settings debounced, audio only when it changed, flushed when the page is hidden). `.fieldstretcher` = store-only ZIP of `project.json` + `loops/track1.wav`, `track2.wav`, `bounce.wav` (24-bit; four-track files still open), tolerant on open: missing or out-of-range fields fall back to defaults, and the sequencer always opens off. |
| Mix out | `dsp/capture.js` (`fs-tap`), `engine.ts` | Records the final stereo output (after the limiter) in real time, up to 3 minutes, to a 24-bit WAV. The file is offered with a Share / Save button so the browser's share sheet gets a real tap. |
| Tracks | `engine.ts` | `TRACKS = 3`: tracks 1–2 record from the mic, track 3 is **Bounce**. A loop is one channel (mic) or two (Bounce keeps the stereo image of what was dubbed). Takes are stored exactly as recorded (DC removed, seam crossfaded); **Normalise** is a button, never automatic. |
| Overdub | `loopfx.ts` `layerInto`, `engine.ts` | With Overdub on, REC layers the mic over the playing loop from the playhead, wrapping round; the old audio under the new is scaled by **Keep**. The audio is swapped under the looper with a `keep` flag, so the loop does not restart. |
| Dub → Bounce | `engine.ts` | Solos the source track (stretched, pitched, its FX send and the FX tails) and records the limiter output through `fs-tap`. First dub sets the Bounce loop (≤ 60 s); later dubs layer in from the Bounce playhead. |
| Mode controls | `dsp/looper.js`, `soundPanel.ts` | **Tape**: wow, flutter, saturate, wear, hiss, motor inertia (Glide), stopping fades out. **Spectral**: smear (FFT size), width, tilt, focus (tonal ↔ diffuse). **Granular**: grain, density, scatter, spray, width, shape (sharp ↔ smooth), backwards chance. Each mode keeps its own values. |
| Glide | `looper.js` | The stretch ratio eases to its target (log domain) over `glide` seconds in every mode; on tape it is the motor's inertia. |
| Mode pictures | `src/ui/viz.ts`, `analysis.ts` | Drawn from what the audio is really doing: tape reels turn at the real speed (reported by the worklet), the pack moves with the playhead and wow/flutter shake the tape; the spectrum is the loop's own, reshaped by tilt/focus/smear with the DSP's maths; the grain cloud plots every grain the audio thread spawns. |
| Graph | `graph.ts` | One builder for live playback and offline render. |
| Offline render | `render.ts` | `OfflineAudioContext`: the mix and optionally each track as a stem, 15 s – 5 min, loops from the top, sequencer replayed from its seed with every note queued up front (bit-for-bit repeatable), 20 ms fade-in and a fade-out at the end. Mix + stems arrive as one zip. |
| Scenes | `scenes.ts`, `userScenes.ts` | Five built in; **Save current as scene** keeps your own in localStorage (settings only). |
| UI | `src/ui/*`, `src/styles/*` | Vanilla TS, portrait, 44 px targets, safe-area insets. `tokens.css` is shared verbatim with the other Maker apps. |

### Stretch engines

- **Spectral** — Paulstretch: magnitudes kept, phases randomised. Smooth endless drones, pitch independent of stretch. **Smear** sets the FFT frame per track: 2 048 – 32 768 points (43 – 680 ms); **Tilt**, **Focus** and **Width** shape the spectrum and stereo image.
- **Granular** — up to 96 Hann grains around a head moving at 1/stretch.
- **Tape** — varispeed; pitch falls as stretch grows.
- Stretch 1×–1000× (log slider + quick chips), pitch ±24 st, reverse, freeze, loop window (drag the handles on the waveform).

### iOS notes

- Tap-to-start splash: the AudioContext and mic permission must come from a user gesture.
- `navigator.audioSession.type = 'play-and-record'` (iOS 16.4+) keeps sound audible with the silent switch on and out of the earpiece.
- Headphones recommended, otherwise the mic hears the speaker.
- The session (settings and all three loops) is autosaved to IndexedDB and restored on the next launch. If iOS clears site data after a long idle period it will be gone — **Save project** (Settings) makes a file backup.
- Not verified on a physical iPhone yet — see "Needs a real-device check" below.

## Needs a real-device check

Built and tested in Node and a desktop browser pane (mic blocked there). Please try on an iPhone:

1. Mic permission prompt and first recording (level meter moves, take plays back).
2. Output route (speaker vs earpiece) and the silent switch.
3. CPU/battery with three Spectral tracks at a large Smear.
4. Home Screen install and offline relaunch.
