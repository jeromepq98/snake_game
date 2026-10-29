'use strict';

const { Engine } = require('../server/game/engine');
const { getMap } = require('../server/game/maps');
const { MODES } = require('../server/game/constants');

const map = getMap('maze');
const mode = MODES[0];
const engine = new Engine({ map, mode, onEvent: (ev) => events.push(ev) });
const events = [];

const snakes = [];
for (let i = 0; i < 6; i++) {
  snakes.push(engine.addSnake({ guestId: `g${i}`, nickname: `T${i}`, skin: 'emerald' }));
}

for (let t = 0; t < 2000; t++) {
  for (const s of snakes) {
    if (Math.random() < 0.06) engine.input(s.pid, { type: 'dir', dir: Math.floor(Math.random() * 4) });
    if (Math.random() < 0.01) engine.input(s.pid, { type: 'boost', on: Math.random() < 0.5 });
  }
  engine.step();

  for (const s of engine.snakes.values()) {
    if (!s.alive) continue;
    if (!s.gridMarked) continue;
    if (engine.now() < s.ghostUntil) continue;
    for (const seg of s.segs) {
      const k = engine.key(seg.x, seg.y);
      const g = engine.grid[k];
      if (g !== s.pid && g !== 0) {
        console.log(`MISMATCH at tick ${engine.tick}: cell ${k} (x=${seg.x},y=${seg.y}) grid=${g} snake=${s.pid}`);
        const other = engine.snakes.get(g);
        if (other) {
          console.log('  other snake:', JSON.stringify({
            pid: other.pid, alive: other.alive, gridMarked: other.gridMarked,
            ghostUntil: other.ghostUntil, now: engine.now(),
            segs: other.segs.map((q) => `(${q.x},${q.y})`).join(' '),
          }));
        }
        console.log('  this snake segs:', s.segs.map((q) => `(${q.x},${q.y})`).join(' '));
        console.log('  recent events:', events.slice(-6).map((e) => `${e.type}:${e.pid || ''}/${e.cause || ''}`).join(', '));
        process.exit(0);
      }
    }
  }
}
console.log('no mismatch in 2000 ticks');
