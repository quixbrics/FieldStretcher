// Renders the PNG app icons (iOS needs PNG for the home-screen icon) with no
// dependencies: a sine wave on the app background, anti-aliased by distance.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [13, 17, 23];
const FG = [94, 224, 192];

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const thick = size * 0.043;
  const amp = size * 0.19;
  // the wave's envelope tapers it at both ends, like a stretched grain
  const curve = (x) => {
    const u = x / size;
    const env = Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.17) / 0.66)));
    return size / 2 + Math.sin(u * Math.PI * 2 * 2.2) * amp * env;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const d = Math.abs(y - curve(x)) / Math.sqrt(1 + (curve(x + 1) - curve(x)) ** 2);
      const inside = u > 0.15 && u < 0.85;
      const a = inside ? Math.min(1, Math.max(0, thick / 2 - d + 0.5)) : 0;
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
      px[o + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [180, 192, 512]) writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), icon(s));
console.log('icons written');
