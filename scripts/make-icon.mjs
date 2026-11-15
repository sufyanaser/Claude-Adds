// Rasterizes build/icon.svg to build/icon.png (512px) with plain Node.
// The icon is made of rounded rectangles only, so no browser is needed.
// electron-builder converts the PNG to the Windows .ico at packaging time.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 512;
const SAMPLES = 4;

const svg = await readFile(join(root, 'build', 'icon.svg'), 'utf8');
const rects = [...svg.matchAll(/<rect\s+([^>]*)\/>/g)].map(([, attrs]) => {
  const get = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
  const fill = get('fill');
  return {
    x: Number(get('x')),
    y: Number(get('y')),
    w: Number(get('width')),
    h: Number(get('height')),
    r: Number(get('rx') ?? 0),
    rgb: [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16)),
  };
});

function inside(rect, px, py) {
  const dx = Math.max(rect.x + rect.r - px, 0, px - (rect.x + rect.w - rect.r));
  const dy = Math.max(rect.y + rect.r - py, 0, py - (rect.y + rect.h - rect.r));
  if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) return false;
  return dx * dx + dy * dy <= rect.r * rect.r;
}

// One filter byte per row, then RGBA pixels.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let covered = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const px = x + (sx + 0.5) / SAMPLES;
        const py = y + (sy + 0.5) / SAMPLES;
        // Later rectangles paint over earlier ones.
        const top = rects.findLast((rect) => inside(rect, px, py));
        if (!top) continue;
        r += top.rgb[0];
        g += top.rgb[1];
        b += top.rgb[2];
        covered++;
      }
    }
    const offset = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (covered > 0) {
      raw[offset] = Math.round(r / covered);
      raw[offset + 1] = Math.round(g / covered);
      raw[offset + 2] = Math.round(b / covered);
      raw[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

await writeFile(join(root, 'build', 'icon.png'), png);
console.log(`build/icon.png written (${SIZE}x${SIZE}, ${rects.length} shapes)`);
