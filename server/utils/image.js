'use strict';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_HEAD_DIMENSION = 512;

// Structural PNG check without decoding pixels. The client always sends a
// canvas-produced PNG, so we only need to guarantee that what we store and
// serve to browsers is a real, bounded PNG (never HTML/SVG).
function validatePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 45) return { ok: false, error: 'not_png' };
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, error: 'not_png' };
  if (buf.readUInt32BE(8) !== 13) return { ok: false, error: 'bad_header' };
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return { ok: false, error: 'bad_header' };

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const compression = buf[26];
  const filter = buf[27];
  const interlace = buf[28];

  if (!width || !height) return { ok: false, error: 'bad_dimensions' };
  if (width > MAX_HEAD_DIMENSION || height > MAX_HEAD_DIMENSION) return { ok: false, error: 'bad_dimensions' };
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return { ok: false, error: 'bad_header' };
  if (![0, 2, 3, 4, 6].includes(colorType)) return { ok: false, error: 'bad_header' };
  if (compression !== 0 || filter !== 0 || interlace > 1) return { ok: false, error: 'bad_header' };

  let offset = 8;
  let hasData = false;
  let hasEnd = false;
  for (let chunks = 0; chunks < 2048; chunks++) {
    if (offset + 12 > buf.length) return { ok: false, error: 'truncated' };
    const length = buf.readUInt32BE(offset);
    if (length > buf.length - offset - 12) return { ok: false, error: 'truncated' };
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT' && length > 0) hasData = true;
    if (type === 'IEND') { hasEnd = true; break; }
    offset += 12 + length;
  }
  if (!hasData || !hasEnd) return { ok: false, error: 'truncated' };

  return { ok: true, width, height };
}

module.exports = { validatePng, MAX_HEAD_DIMENSION };
