/*
 * Microphone capture. Raw Float32 PCM straight off the audio thread — no
 * MediaRecorder, so there is no codec and the take starts on an exact sample.
 *
 * Always running while the mic is open so the input meter works. Only blocks
 * between a {type:'rec', on:true} and {type:'rec', on:false} message are
 * collected, and they are posted in ~85 ms chunks. After the last chunk it
 * posts {type:'recStopped'}, so the main thread knows nothing is still in
 * flight. Output is silence (the node is only wired to the destination so
 * the browser keeps pulling it).
 */

const CAP_CHUNK = 4096;

class FsCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false;
    this.chunk = new Float32Array(CAP_CHUNK);
    this.n = 0;
    this.peak = 0;
    this.sinceLevel = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || m.type !== 'rec') return;
      if (m.on && !this.rec) this.n = 0;
      if (!m.on && this.rec) {
        this.flush();
        this.port.postMessage({ type: 'recStopped' });
      }
      this.rec = !!m.on;
    };
  }
  flush() {
    if (this.n > 0) {
      const out = this.chunk.slice(0, this.n);
      this.port.postMessage({ type: 'chunk', data: out }, [out.buffer]);
      this.n = 0;
    }
  }
  process(inputs) {
    // No input this quantum (iOS can deliver none while a route is changing)? Count it as silence,
    // so a take stays the length of real time instead of silently losing frames and playing back fast.
    const x = inCh(inputs, 0);
    for (let i = 0; i < x.length; i++) {
      let v = x[i];
      if (!Number.isFinite(v)) v = 0;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (this.rec) {
        this.chunk[this.n++] = v;
        if (this.n === CAP_CHUNK) this.flush();
      }
    }
    this.sinceLevel += x.length;
    if (this.sinceLevel >= sampleRate / 30) {
      this.sinceLevel = 0;
      this.port.postMessage({ type: 'level', peak: this.peak });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('fs-capture', FsCapture);

/*
 * Output tap: records the final stereo mix (after the safety limiter) for
 * "Record mix". Same protocol as the microphone capture, with L and R chunks.
 */
class FsTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false;
    this.l = new Float32Array(CAP_CHUNK);
    this.r = new Float32Array(CAP_CHUNK);
    this.n = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || m.type !== 'rec') return;
      if (m.on && !this.rec) this.n = 0;
      if (!m.on && this.rec) {
        this.flush();
        this.port.postMessage({ type: 'recStopped' });
      }
      this.rec = !!m.on;
    };
  }
  flush() {
    if (this.n > 0) {
      const l = this.l.slice(0, this.n);
      const r = this.r.slice(0, this.n);
      this.port.postMessage({ type: 'chunk', l, r }, [l.buffer, r.buffer]);
      this.n = 0;
    }
  }
  process(inputs) {
    if (!this.rec) return true;
    const a = inCh(inputs, 0);
    const b = inCh(inputs, 1);
    for (let i = 0; i < a.length; i++) {
      this.l[this.n] = Number.isFinite(a[i]) ? a[i] : 0;
      this.r[this.n] = Number.isFinite(b[i]) ? b[i] : 0;
      if (++this.n === CAP_CHUNK) this.flush();
    }
    return true;
  }
}

registerProcessor('fs-tap', FsTap);
