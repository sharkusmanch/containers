// Writes the app icons, deterministically, with only node:zlib and node:fs.
// Usage: node scripts/make-icons.mjs [output-directory]   (default: web-static)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const BACKGROUND = [0x11, 0x14, 0x18];
const GLYPH = [0xe6, 0xe9, 0xee];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** An opaque square with a ring and a dot, all inside the central 60% (the maskable safe zone). */
function pixel(x, y, size) {
  const centre = (size - 1) / 2;
  const distance = Math.hypot(x - centre, y - centre) / size;
  const ring = distance <= 0.27 && distance >= 0.19;
  const dot = distance <= 0.09;
  return ring || dot ? GLYPH : BACKGROUND;
}

function makePng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour, no alpha
  const rowLength = 1 + size * 3;
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLength] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(pixel(x, y, size), y * rowLength + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = process.argv[2] ?? "web-static";
mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) writeFileSync(join(outDir, `icon-${size}.png`), makePng(size));
