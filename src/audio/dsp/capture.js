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
    const inp = inputs[0];
    const x = inp && inp[0];
    if (!x) return true;
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
