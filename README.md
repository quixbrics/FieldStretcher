# FieldStretcher

Record the world on an iPhone, stretch it into drones — the fourth companion to
ScapeMaker, ToneMaker and FXMaker. Two looping tracks, each with its own stretch mode, fed
through a chain of resonator, delay and reverb with one Wet/Dry control, and a
generative sequencer walking the resonator through a scale.

**Static PWA. No backend, no accounts, no running cost.** Open the site in
Safari, Share → Add to Home Screen, and it runs full-screen and offline.

## Status: v3.1

| Phase | Scope | State |
|---|---|---|
| 1 | Mic capture, loop tracks, Spectral / Granular / Tape stretch, loop window, safety limiter, mobile UI, PWA | built |
| 2 | FX chain: resonator → delay → reverb | built |
| 3 | Generative sequencer, resonator plucks | built |
| 4 | Autosave, project files, mix recording, scenes | built |
| v2 | Per-mode sound controls and pictures; stretch glide; overdub; Normalise button (no auto-normalise); offline render with stems; saveable scenes | built |
| v3 | Bounce track and dubbing removed (two tracks). One Wet/Dry control replaces sends and per-effect mixes (each effect has an on/off switch). Pitch and stretch linked, like a tape reel | built |
| v3.1 | **Animated mode pictures removed.** **Light / dark switch** in Settings (dark by default). **Mic opened only while recording**, so playback uses the speaker | **built** |

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
| Takes | `src/audio/loopfx.ts` | DC removed and a 20 ms equal-power seam crossfade; the level is left alone. A silent take is refused. **Normalise** (per track, under More) brings a quiet one to −3 dBFS on request, one gain for both channels. 0.25–30 s. |
| Engine | `src/audio/engine.ts` | One context created inside the first tap (mic request fired in the same tap). track: looper → level → pan → master → safety → out. Handles `audioSession`, wake lock, resume after interruption. |
| FX chain & Wet/Dry | `graph.ts`, `dsp/fx-bus.js`, `engine.ts` | Tracks (after their level and pan) split into a **dry** path and the **FX chain** (resonator → delay → reverb). Each effect outputs only its processed sound; switching one off routes the signal around it. One **Wet/Dry** control cross-fades the two paths with an equal-power law, and at 100% wet the dry gain is exactly zero, so the wet sound is clean (with every effect off there is no wet sound at all). Reverb (8-line FDN, shimmer, freeze) and tape delay are FXMaker's. The resonator is cut down to one continuous MIDI note + chord shape with a `glide` time, so the sequencer can move it. |
| Resonator plucks | `dsp/fx-bus.js` | Decay runs 20 ms → 30 s. **Pluck** puts a 4 ms noise burst into the strings on every note *change*; **Onset** plucks whenever the audio sent in has a hit (fast/slow envelope detector, 80 ms refractory); **Input** sets how much audio rings the strings (0 = pluck-only). Presets: Drone / Pluck / Tick. |
| Sequencer | `src/music/sequencer.ts`, `engine.ts`, `src/ui/seqPanel.ts` | A seeded, pure walk through a scale (ToneMaker's 8 modes, `src/music/theory.ts`): **Drift**, **Arp** (in thirds, bouncing), **Markov** (favours tonic/fifth/third), **Wander** (smooth curve), **Hold** (tap a note). Step 0.15–30 s, glide, chance, 1–3 octave range, optional chord stacked from scale thirds, dice for a new seed. The engine hands notes to the resonator ~1.2 s ahead as **timed messages** (absolute audio frame), so a throttled timer or a busy main thread never drops or jitters a step. |
| Speed check | `engine.ts`, `loopfx.ts` | **Self-calibrating:** a take is timed against the wall clock; if the samples that arrived disagree with the real duration by more than 12% (frames dropped, or a mic/context sample-rate mismatch, which would play back too fast and too high) it is resampled to real length. Frames the input skips count as silence. The last take's numbers and the audio/mic rates are shown in Settings. |
| Persistence | `src/io/autosave.ts`, `project.ts`, `zip.ts` | IndexedDB autosave (settings debounced, audio only when it changed, flushed when the page is hidden). `.fieldstretcher` = store-only ZIP of `project.json` + `loops/track1.wav`, `track2.wav` (24-bit; four-track and Bounce-era files still open, and their sends and mixes become the Wet/Dry and on/off switches), tolerant on open: missing or out-of-range fields fall back to defaults, and the sequencer always opens off. |
| Mix out | `dsp/capture.js` (`fs-tap`), `engine.ts` | Records the final stereo output (after the limiter) in real time, up to 3 minutes, to a 24-bit WAV. The file is offered with a Share / Save button so the browser's share sheet gets a real tap. |
| Tracks | `engine.ts` | `TRACKS = 2`, both recorded from the mic. Takes are stored exactly as recorded (DC removed, seam crossfaded); **Normalise** is a button, never automatic. |
| Overdub | `loopfx.ts` `layerInto`, `engine.ts` | With Overdub on, REC layers the mic over the playing loop from the playhead, wrapping round; the old audio under the new is scaled by **Keep**. The audio is swapped under the looper with a `keep` flag, so the loop does not restart. |
| Pitch ⇄ stretch | `engine.ts` (`setStretch`, `setPitch`, `setLink`, `effectivePitch`) | On tape, speed = 2^(pitch/12) ÷ stretch, so the two controls fight. **Link** (on by default for tape) makes them one: the stretch slider moves the pitch slider (−12 st per doubling, shown within ±24) and the pitch slider moves the stretch. Linked on tape the engine just plays at 1 ÷ stretch. Spectral and Granular start unlinked (stretch without changing pitch — their point) and can be linked to drop the pitch as they stretch. Switching modes and toggling Link keep the sound you were hearing where possible. Stretch is 0.25× – 1000× (below 1× is faster). |
| Mode controls | `dsp/looper.js`, `soundPanel.ts` | **Tape**: wow, flutter, saturate, wear, hiss, motor inertia (Glide), stopping fades out. **Spectral**: smear (FFT size), width, tilt, focus (tonal ↔ diffuse). **Granular**: grain, density, scatter, spray, width, shape (sharp ↔ smooth), backwards chance. Each mode keeps its own values. |
| Glide | `looper.js` | The stretch ratio eases to its target (log domain) over `glide` seconds in every mode; on tape it is the motor's inertia. |
| Audio session | `engine.ts`, `io/audioPrefs.ts` | The microphone is opened **only while recording** (and released after), so the rest of the time iOS plays through the main speaker (`navigator.audioSession` = `playback`). An open mic makes an iPhone treat the page like a call and use the earpiece. While the mic is open the session follows Settings → Audio (`play-and-record` by default, which is known to record; `playback` or `auto` to try). Permission is asked once, in the first tap. "Keep the microphone open" restores the always-on input meter. |
| Theme | `ui/theme.ts` | Dark by default; light is a choice in Settings. It does **not** follow the phone's own light/dark setting. Stored under `scapemaker.theme`, shared with the other Maker apps. |
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
