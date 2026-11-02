'use strict';

// Generates assets/icon.png (256x256 RGBA) with no external dependencies:
// a rounded square in the accent gradient with a white chat-bubble + three dots.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 256, H = 256;
const buf = Buffer.alloc(W * H * 4); // transparent

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

// Rounded-rect mask
const RAD = 56;
function insideRounded(x, y) {
  const corners = [
    [RAD, RAD], [W - 1 - RAD, RAD], [RAD, H - 1 - RAD], [W - 1 - RAD, H - 1 - RAD]
  ];
  if (x < RAD && y < RAD) return (x - corners[0][0]) ** 2 + (y - corners[0][1]) ** 2 <= RAD * RAD;
  if (x > W - 1 - RAD && y < RAD) return (x - corners[1][0]) ** 2 + (y - corners[1][1]) ** 2 <= RAD * RAD;
  if (x < RAD && y > H - 1 - RAD) return (x - corners[2][0]) ** 2 + (y - corners[2][1]) ** 2 <= RAD * RAD;
  if (x > W - 1 - RAD && y > H - 1 - RAD) return (x - corners[3][0]) ** 2 + (y - corners[3][1]) ** 2 <= RAD * RAD;
  return true;
}

// Background gradient (indigo -> violet)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!insideRounded(x, y)) continue;
    const t = y / H;
    const r = Math.round(99 + (124 - 99) * t);
    const g = Math.round(102 + (58 - 102) * t);
    const b = Math.round(241 + (237 - 241) * t);
    set(x, y, r, g, b, 255);
  }
}

// White speech bubble
const cx = 128, cy = 116, cr = 62;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= cr * cr) set(x, y, 255, 255, 255, 255);
  }
}
// Bubble tail (simple triangle pointing down-left)
for (let y = cy; y < cy + 64; y++) {
  const span = Math.max(0, 26 - (y - cy) * 0.5);
  for (let x = cx - 44; x < cx - 44 + span; x++) set(x, y, 255, 255, 255, 255);
}

// Three accent dots inside the bubble
for (const dx of [-30, 0, 30]) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((x - (cx + dx)) ** 2 + (y - cy) ** 2 <= 10 * 10) set(x, y, 99, 102, 241, 255);
    }
  }
}

// ---- Minimal PNG encoder ----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
// compression(0), filter(0), interlace(0) already zero

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter type 0
  buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);

const outDir = path.join(__dirname, 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('Wrote', path.join(outDir, 'icon.png'), png.length, 'bytes');
