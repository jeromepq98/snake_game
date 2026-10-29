'use strict';

function makeIslands() {
  const obstacles = [];
  for (let gy = 4; gy + 6 < 44; gy += 8) {
    for (let gx = 4; gx + 6 < 64; gx += 8) {
      obstacles.push([gx, gy, 2, 2]);
    }
  }
  return obstacles;
}

/* Stylized layout of Hinunangan, Southern Leyte: land in the west, the
   Hinunangan Bay coast in the east, San Pedro and San Pablo islands offshore,
   the Das-ay River with fords, and the Mt. Nacolod uplands. */
function makeHinunangan() {
  const w = 64;
  const coastline = [
    61, 60, 60, 59, 58, 58, 57, 57, 56, 55, 55, 54,
    53, 52, 52, 51, 50, 49, 48, 47, 46, 45, 44, 44,
    45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 54, 55,
    56, 56, 57, 58, 59, 59, 60, 61,
  ];
  const water = coastline.map((x, y) => [x, y, w - x, 1]);

  const river = [];
  const hRun = (x1, x2, y) => {
    for (let x = x1; x <= x2; x++) river.push([x, y, 1, 1]);
  };
  const vRun = (x, y1, y2) => {
    for (let y = y1; y <= y2; y++) river.push([x, y, 1, 1]);
  };
  hRun(9, 13, 8);
  vRun(13, 9, 9);
  hRun(14, 17, 9);
  vRun(17, 10, 10);
  hRun(18, 21, 10);
  vRun(21, 11, 11);
  hRun(22, 26, 11);
  vRun(26, 12, 12);
  hRun(27, 30, 12);
  vRun(30, 13, 13);
  hRun(31, 34, 13);
  vRun(34, 14, 14);
  hRun(35, 38, 14);
  vRun(38, 15, 15);
  hRun(39, 42, 15);
  vRun(42, 16, 21);
  hRun(43, 44, 21);
  // Fords keep the river a tactical divider rather than a trap.
  const fords = new Set(['10,8', '11,8', '23,11', '24,11', '32,13', '33,13']);
  water.push(...river.filter(([x, y]) => !fords.has(`${x},${y}`)));

  return {
    water,
    coastline: coastline.map((x, y) => [x, y]),
    islands: [
      { x: 49, y: 17, w: 2, h: 2 },
      { x: 55, y: 31, w: 2, h: 2 },
    ],
    labels: [
      { text: 'HINUNANGAN BAY', x: 54, y: 21, kind: 'water' },
      { text: 'SAN PEDRO I.', x: 52, y: 19.4, kind: 'water' },
      { text: 'SAN PABLO I.', x: 58.5, y: 33.5, kind: 'water' },
      { text: 'DAS-AY RIVER', x: 26, y: 12.7, kind: 'water' },
      { text: 'POBLACION', x: 38, y: 28.4, kind: 'land' },
      { text: 'MT. NACOLOD', x: 11, y: 37.2, kind: 'land' },
    ],
    theme: {
      land: '#0c1712',
      water: '#0a2233',
      coast: 'rgba(214, 185, 124, 0.55)',
      grid: 'rgba(52, 88, 69, 0.3)',
      border: '#2d4a3a',
      obstacleFill: '#1f3027',
      obstacleStroke: '#3b5a47',
      island: '#14261a',
      islandStroke: 'rgba(214, 185, 124, 0.5)',
      labelWater: 'rgba(142, 210, 228, 0.62)',
      labelLand: 'rgba(198, 216, 202, 0.46)',
    },
    obstacles: [
      // Poblacion blocks, separated by narrow streets.
      [34, 19, 2, 2], [37, 19, 2, 2], [40, 19, 2, 2],
      [34, 22, 2, 2], [38, 22, 2, 2], [40, 22, 2, 2],
      [34, 25, 2, 2], [38, 25, 2, 2],
      // Mt. Nacolod uplands.
      [4, 28, 7, 3], [13, 27, 4, 3], [7, 33, 4, 3], [3, 34, 2, 2], [16, 32, 3, 2],
      // Outlying barangay hamlets.
      [20, 5, 2, 2], [27, 9, 2, 2], [7, 17, 2, 2], [23, 32, 2, 2], [33, 35, 2, 2], [47, 6, 2, 2],
    ],
  };
}

const HINUNANGAN = makeHinunangan();

const MAPS = [
  {
    id: 'hinunangan',
    name: 'Hinunangan',
    desc: 'Hinunangan, Southern Leyte — bay coast, Das-ay River fords, and Mt. Nacolod.',
    w: 64,
    h: 44,
    wrap: false,
    ...HINUNANGAN,
  },
  {
    id: 'meadow',
    name: 'Meadow',
    desc: 'Open field. Edges wrap around.',
    w: 60,
    h: 40,
    wrap: true,
    obstacles: [],
  },
  {
    id: 'maze',
    name: 'Maze',
    desc: 'Symmetric walls. No wrap — edges are deadly.',
    w: 48,
    h: 36,
    wrap: false,
    obstacles: [
      [10, 6, 12, 2], [26, 6, 12, 2],
      [10, 28, 12, 2], [26, 28, 12, 2],
      [6, 12, 2, 12], [40, 12, 2, 12],
      [22, 16, 4, 4],
    ],
  },
  {
    id: 'islands',
    name: 'Islands',
    desc: 'Scattered pillars. Lots of ambush corners.',
    w: 64,
    h: 44,
    wrap: false,
    obstacles: makeIslands(),
  },
  {
    id: 'duel',
    name: 'Duel Pit',
    desc: 'Tiny arena for fast, chaotic skirmishes.',
    w: 26,
    h: 18,
    wrap: false,
    obstacles: [
      [12, 8, 2, 2],
      [6, 5, 2, 2],
      [18, 11, 2, 2],
    ],
  },
];

const MAP_IDS = MAPS.map((m) => m.id);
const DEFAULT_MAP_ID = MAPS[0].id;

function getMap(id) {
  return MAPS.find((m) => m.id === id) || null;
}

module.exports = { MAPS, MAP_IDS, DEFAULT_MAP_ID, getMap };
