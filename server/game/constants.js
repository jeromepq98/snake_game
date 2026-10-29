'use strict';

const TICK_MS = 100;

// 0=up, 1=right, 2=down, 3=left
const DIRS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];
const opposite = (d) => (d + 2) % 4;

const START_LEN = 5;
const BOOST_MIN_LEN = 6;
const BOOST_BURN_EVERY = 4; // ticks between length burns while boosting
const RESPAWN_MS = 3000;
const DISCONNECT_GRACE_MS = 30000;
const SPAWN_SHIELD_MS = 2500;

const FOOD_TARGET_BASE = 10;
const FOOD_TARGET_PER_PLAYER = 3;
const FOOD_MAX = 140;
const GOLDEN_CHANCE = 0.06;
const GOLDEN_VALUE = 5;
const GOLDEN_GROW = 3;

const POWER_MAX = 4;
const POWER_SPAWN_MIN_TICKS = 80;
const POWER_SPAWN_RAND_TICKS = 80;
const POWER_EXPIRE_TICKS = 150;

const MAGNET_RADIUS = 5;
const VOICE_PROXIMITY_RADIUS = 12;
const MAX_INPUT_QUEUE = 3;

const ROUND_SECONDS = 120;
const INTERMISSION_SECONDS = 8;

const KILL_SCORE = 10;

const SKINS = [
  { id: 'emerald', name: 'Emerald', colors: ['#22c55e', '#16a34a'], pattern: 'solid' },
  { id: 'ruby', name: 'Ruby', colors: ['#ef4444', '#b91c1c'], pattern: 'solid' },
  { id: 'ocean', name: 'Ocean', colors: ['#38bdf8', '#0284c7'], pattern: 'solid' },
  { id: 'sunset', name: 'Sunset', colors: ['#f97316', '#ea580c'], pattern: 'solid' },
  { id: 'viper', name: 'Viper', colors: ['#a3e635', '#65a30d'], pattern: 'striped' },
  { id: 'hazard', name: 'Hazard', colors: ['#facc15', '#18181b'], pattern: 'striped' },
  { id: 'ice', name: 'Ice', colors: ['#e0f2fe', '#7dd3fc'], pattern: 'striped' },
  { id: 'shadow', name: 'Shadow', colors: ['#6b7280', '#1f2937'], pattern: 'solid' },
  { id: 'rainbow', name: 'Rainbow', colors: ['#f87171', '#fbbf24'], pattern: 'rainbow' },
  { id: 'pixel', name: 'Pixel', colors: ['#8b5cf6', '#4c1d95'], pattern: 'checker' },
  { id: 'gold', name: 'Gold', colors: ['#fde047', '#d97706'], pattern: 'solid', unlock: 'score_200' },
  { id: 'phantom', name: 'Phantom', colors: ['#c084fc', '#3b0764'], pattern: 'solid', unlock: 'kills_25' },
];
const SKIN_IDS = SKINS.map((s) => s.id);

const MODES = [
  {
    id: 'arena',
    name: 'Endless Arena',
    desc: 'Free-for-all with instant respawns. Grow your session score forever.',
    respawn: true,
    roundSeconds: 0,
    intermissionSeconds: 0,
  },
  {
    id: 'round',
    name: 'Last Snake Standing',
    desc: '2-minute rounds, no respawns. Last snake alive or highest score wins.',
    respawn: false,
    roundSeconds: ROUND_SECONDS,
    intermissionSeconds: INTERMISSION_SECONDS,
  },
];
const MODE_IDS = MODES.map((m) => m.id);

const POWERUPS = [
  { id: 'turbo', name: 'Turbo', color: '#f59e0b', letter: 'T', ms: 5000 },
  { id: 'shield', name: 'Shield', color: '#38bdf8', letter: 'S', ms: 0 },
  { id: 'magnet', name: 'Magnet', color: '#a78bfa', letter: 'M', ms: 6000 },
  { id: 'ghost', name: 'Ghost', color: '#e879f9', letter: 'G', ms: 4000 },
  { id: 'double', name: 'Double Points', color: '#fbbf24', letter: 'x2', ms: 8000 },
];
const POWERUP_IDS = POWERUPS.map((p) => p.id);

const ACHIEVEMENTS = [
  { id: 'first_bite', name: 'First Bite', desc: 'Eat your first food.' },
  { id: 'golden_5', name: 'Gold Rush', desc: 'Eat 5 golden apples in one match.' },
  { id: 'score_50', name: 'Half Century', desc: 'Score 50 in a single round or session.' },
  { id: 'score_200', name: 'Double Century', desc: 'Score 200 in a single round or session.' },
  { id: 'first_kill', name: 'Hunter', desc: 'Eliminate your first rival.' },
  { id: 'kills_25', name: 'Apex Predator', desc: '25 career eliminations.' },
  { id: 'survive_180', name: 'Marathon', desc: 'Survive 3 minutes on one life.' },
  { id: 'win_1', name: 'Champion', desc: 'Win a round.' },
  { id: 'matches_10', name: 'Regular', desc: 'Play 10 matches.' },
  { id: 'powers_10', name: 'Collector', desc: 'Grab 10 power-ups in one match.' },
];

module.exports = {
  TICK_MS, DIRS, opposite,
  START_LEN, BOOST_MIN_LEN, BOOST_BURN_EVERY, RESPAWN_MS, DISCONNECT_GRACE_MS, SPAWN_SHIELD_MS,
  FOOD_TARGET_BASE, FOOD_TARGET_PER_PLAYER, FOOD_MAX, GOLDEN_CHANCE, GOLDEN_VALUE, GOLDEN_GROW,
  POWER_MAX, POWER_SPAWN_MIN_TICKS, POWER_SPAWN_RAND_TICKS, POWER_EXPIRE_TICKS,
  MAGNET_RADIUS, VOICE_PROXIMITY_RADIUS, MAX_INPUT_QUEUE,
  ROUND_SECONDS, INTERMISSION_SECONDS, KILL_SCORE,
  SKINS, SKIN_IDS, MODES, MODE_IDS, POWERUPS, POWERUP_IDS, ACHIEVEMENTS,
};
