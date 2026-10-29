'use strict';

const { containsProfanity, RESERVED_NAMES } = require('./profanity');

const NICK_MIN = 2;
const NICK_MAX = 16;
const NICK_CHARS = /^[A-Za-z0-9 _\-.'#]+$/;

// Strip control characters, zero-width and combining marks, then collapse spaces.
function cleanString(raw, maxLen = 200) {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u0300-\u036f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function validateNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'Nickname must be text.' };
  const nick = cleanString(raw, NICK_MAX);
  if (nick.length < NICK_MIN) return { ok: false, reason: `Nickname must be at least ${NICK_MIN} characters.` };
  if (nick.length > NICK_MAX) return { ok: false, reason: `Nickname must be at most ${NICK_MAX} characters.` };
  if (!NICK_CHARS.test(nick)) return { ok: false, reason: 'Use letters, numbers, spaces, and - . \' # only.' };
  if (RESERVED_NAMES.includes(nick.toLowerCase())) return { ok: false, reason: 'That nickname is reserved.' };
  if (containsProfanity(nick)) return { ok: false, reason: 'That nickname is not allowed.' };
  return { ok: true, value: nick };
}

const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{4,6}$/;

function validateRoomCode(raw) {
  return typeof raw === 'string' && ROOM_CODE_RE.test(raw.trim().toUpperCase());
}

function validateChatText(raw) {
  const text = cleanString(raw, 200);
  if (!text) return { ok: false, reason: 'Empty message.' };
  return { ok: true, value: text };
}

function isInt(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

module.exports = { validateNickname, validateRoomCode, validateChatText, cleanString, isInt };
