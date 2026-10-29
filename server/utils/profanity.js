'use strict';

// Basic English profanity/slur blocklist with leetspeak normalization.
// Not exhaustive — server-side moderation, reports, and bans complement it.
const BAD_WORDS = [
  'anal', 'anus', 'arse', 'asshole', 'bastard', 'bitch', 'bollocks', 'boob',
  'clit', 'cock', 'cunt', 'cum', 'dick', 'dildo', 'fag', 'faggot', 'fuck',
  'fucker', 'hitler', 'horny', 'jerkoff', 'jizz', 'kike', 'molest', 'nazi',
  'nigg', 'nigger', 'penis', 'porn', 'prick', 'pussy', 'rape', 'retard',
  'shit', 'slut', 'spic', 'twat', 'vagina', 'wanker', 'whore', 'xxx', 'pedo',
];

const RESERVED_NAMES = [
  'admin', 'administrator', 'mod', 'moderator', 'system', 'server', 'staff',
  'owner', 'root', 'official', 'support', 'null', 'undefined', 'you', 'player',
];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '+': 't' };

function normalize(text) {
  const lowered = String(text || '').toLowerCase();
  let out = '';
  for (const ch of lowered) {
    out += LEET[ch] !== undefined ? LEET[ch] : ch;
  }
  // Strip everything that is not a letter — catches separators like ".", "_", "-", "*"
  return out.replace(/[^a-z]/g, '');
}

function containsProfanity(text) {
  const norm = normalize(text);
  if (!norm) return false;
  return BAD_WORDS.some((w) => norm.includes(w));
}

// Replace plain-form profanity with asterisks for chat. Returns null if the
// message still contains leetspeak-obfuscated profanity after replacement.
function filterText(text) {
  let out = String(text || '');
  for (const w of BAD_WORDS) {
    const re = new RegExp(`${w}s?`, 'gi');
    out = out.replace(re, (m) => '*'.repeat(m.length));
  }
  if (containsProfanity(out)) return null;
  return out;
}

const ADJECTIVES = [
  'Sneaky', 'Turbo', 'Silent', 'Crimson', 'Electric', 'Fuzzy', 'Rapid', 'Mellow',
  'Neon', 'Cosmic', 'Wobbly', 'Spicy', 'Lucky', 'Shadow', 'Golden', 'Chrome',
  'Wild', 'Nimble', 'Brave', 'Salty', 'Zippy', 'Grim', 'Velvet', 'Radiant',
  'Frosty', 'Mega', 'Tiny', 'Angry', 'Sleepy', 'Bouncy',
];

const ANIMALS = [
  'Viper', 'Cobra', 'Python', 'Mamba', 'Adder', 'Boa', 'Krait', 'Taipan',
  'Fox', 'Wolf', 'Otter', 'Falcon', 'Panda', 'Tiger', 'Koala', 'Raven',
  'Lynx', 'Gecko', 'Bandicoot', 'Mongoose', 'Heron', 'Ibex', 'Jaguar', 'Okapi',
  'Quokka', 'Newt', 'Gecko', 'Frog', 'Bat', 'Hawk',
];

function randomNickname() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `${a}${b}${n}`;
}

module.exports = { containsProfanity, filterText, randomNickname, RESERVED_NAMES, BAD_WORDS };
