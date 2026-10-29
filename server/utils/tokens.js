'use strict';

const crypto = require('crypto');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function safeEqual(a, b) {
  const ha = Buffer.from(sha256(a || ''), 'hex');
  const hb = Buffer.from(sha256(b || ''), 'hex');
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { randomToken, sha256, safeEqual };
