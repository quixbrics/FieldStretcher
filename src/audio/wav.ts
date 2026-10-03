/*
 * WAV: 24-bit (or 16-bit) PCM writer for Float32 channels, and a small reader
 * for the files this app writes (PCM 16/24/32-bit and 32-bit float).
 */

export function encodeWav(chans: Float32Array[], sampleRate: number, bits: 16 | 24 = 24): Blob {
  const ch = chans.length;
  const len = chans[0].length;
  const bps = bits / 8;
  const dataBytes = len * ch * bps;
  const ab = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(ab);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * bps, true);
  v.setUint16(32, ch * bps, true);
  v.setUint16(34, bits, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  const max = bits === 24 ? 8388607 : 32767;
  const lsb = 1 / max;
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      // light TPDF dither when reducing from float
      const x = Math.max(-1, Math.min(1, chans[c][i] + (Math.random() - Math.random()) * lsb));
      const q = Math.round(x * max);
      if (bits === 24) {
        v.setUint8(o, q & 0xff);
        v.setUint8(o + 1, (q >> 8) & 0xff);
        v.setUint8(o + 2, (q >> 16) & 0xff);
      } else v.setInt16(o, q, true);
      o += bps;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

export interface WavData {
  sampleRate: number;
  channels: Float32Array[];
}

export function parseWav(buf: ArrayBuffer | Uint8Array): WavData {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (u8.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: { format: number; ch: number; sr: number; bits: number } | null = null;
  let p = 12;
  while (p + 8 <= u8.length) {
    const id = tag(p);
    const size = v.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(p + 8, true), ch: v.getUint16(p + 10, true), sr: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true) };
    else if (id === 'data') {
      if (!fmt) throw new Error('WAV has no fmt chunk');
      const bps = fmt.bits / 8;
      const n = Math.floor(Math.min(size, u8.length - p - 8) / (bps * fmt.ch));
      const chans = Array.from({ length: fmt.ch }, () => new Float32Array(n));
      let o = p + 8;
      for (let i = 0; i < n; i++)
        for (let c = 0; c < fmt.ch; c++) {
          let x: number;
          if (fmt.format === 3 && fmt.bits === 32) x = v.getFloat32(o, true);
          else if (fmt.bits === 16) x = v.getInt16(o, true) / 32768;
          else if (fmt.bits === 24) x = (((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16)) << 8) >> 8) / 8388608;
          else if (fmt.bits === 32) x = v.getInt32(o, true) / 2147483648;
          else throw new Error(`unsupported WAV (${fmt.bits}-bit)`);
          chans[c][i] = x;
          o += bps;
        }
      return { sampleRate: fmt.sr, channels: chans };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('WAV has no audio data');
}
