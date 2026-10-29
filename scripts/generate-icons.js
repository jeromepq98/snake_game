'use strict';

// Generates PWA icons as PNGs with zero image dependencies: draws 16x16 pixel
// art and encodes PNG via Node's built-in zlib. Run: npm run icons

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- pixel art ----------

const COLORS = {
  bg: [14, 22, 38, 255],
  ring: [36, 48, 77, 255],
  body: [47, 191, 79, 255],
  head: [70, 217, 104, 255],
  eye: [11, 18, 32, 255],
  apple: [255, 82, 82, 255],
  stem: [122, 74, 33, 255],
  transparent: [0, 0, 0, 0],
};

function insideRounded(x, y, r) {
  // 16x16 grid, rounded corner radius r (circle test at corner centers)
  const lo = r - 0.5;
  const hi = 15 - lo;
  const cx = x < r ? lo : x > 15 - r ? hi : x;
  const cy = y < r ? lo : y > 15 - r ? hi : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 0.4;
}

function drawArt() {
  const px = new Uint8Array(16 * 16 * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    const i = (y * 16 + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
  };

  // Background with rounded corners and a 1px inner ring
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (insideRounded(x, y, 3)) set(x, y, COLORS.bg);
    }
  }
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (insideRounded(x, y, 3) && !insideRounded(x, y, 4)) set(x, y, COLORS.ring);
    }
  }

  // S-shaped snake (3px thick)
  rect(3, 3, 12, 5, COLORS.body);   // top bar
  rect(3, 5, 5, 9, COLORS.body);    // left connector
  rect(3, 9, 12, 11, COLORS.body);  // middle bar
  rect(10, 11, 12, 11, COLORS.body);// right connector start
  rect(3, 11, 12, 13, COLORS.body); // bottom bar

  // Head (bottom-left, slightly larger, facing left)
  rect(2, 10, 5, 14, COLORS.head);
  set(3, 11, COLORS.eye);
  set(3, 13, COLORS.eye);

  // Apple at the end of the top bar
  rect(12, 3, 13, 4, COLORS.apple);
  set(12, 2, COLORS.stem);

  return px;
}

function scale(px, size) {
  const out = Buffer.alloc(size * size * 4);
  const f = size / 16;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(15, Math.floor(y / f));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(15, Math.floor(x / f));
      const src = (sy * 16 + sx) * 4;
      const dst = (y * size + x) * 4;
      out[dst] = px[src];
      out[dst + 1] = px[src + 1];
      out[dst + 2] = px[src + 2];
      out[dst + 3] = px[src + 3];
    }
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const art = drawArt();
for (const size of [180, 192, 512, 1024]) {
  const png = encodePng(size, size, scale(art, size));
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`wrote public/icons/${name} (${png.length} bytes)`);
}
console.log('icons done');
