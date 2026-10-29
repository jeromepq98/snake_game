'use strict';

// Headless engine sanity test: runs simulations on every map and mode and
// asserts structural invariants. Exits non-zero on failure.

const assert = require('assert');
const { Engine } = require('../server/game/engine');
const { getMap, MAPS } = require('../server/game/maps');
const { MODES, TICK_MS, DIRS, SKIN_IDS } = require('../server/game/constants');

function runScenario({ mapId, modeId, players, ticks }) {
  const map = getMap(mapId);
  const mode = MODES.find((m) => m.id === modeId);
  const events = [];
  const engine = new Engine({ map, mode, onEvent: (ev) => events.push(ev) });

  const snakes = [];
  for (let i = 0; i < players; i++) {
    const s = engine.addSnake({ guestId: `g_test_${i}`, nickname: `Tester${i}`, skin: SKIN_IDS[i % SKIN_IDS.length] });
    assert.ok(s, `spawn failed for player ${i} on ${mapId}`);
    snakes.push(s);
  }

  let totalFoodEaten = 0;

  for (let t = 0; t < ticks; t++) {
    // Random inputs to simulate players
    for (const s of snakes) {
      if (Math.random() < 0.06) {
        const d = Math.floor(Math.random() * 4);
        engine.input(s.pid, { type: 'dir', dir: d });
      }
      if (Math.random() < 0.01) engine.input(s.pid, { type: 'boost', on: Math.random() < 0.5 });
    }

    engine.step();

    // Invariant: all alive snakes within bounds
    for (const s of engine.snakes.values()) {
      if (!s.alive) continue;
      for (const seg of s.segs) {
        assert.ok(seg.x >= 0 && seg.x < map.w && seg.y >= 0 && seg.y < map.h,
          `segment out of bounds on ${mapId}: ${JSON.stringify(seg)}`);
        const k = engine.key(seg.x, seg.y);
        assert.ok(engine.grid[k] !== -1, `segment inside obstacle on ${mapId}`);
      }
      // Grid cells of non-ghost, marked snakes match their pid
      if (s.gridMarked && engine.now() >= s.ghostUntil) {
        for (const seg of s.segs) {
          const k = engine.key(seg.x, seg.y);
          assert.ok(engine.grid[k] === s.pid || engine.grid[k] === 0,
            `grid cell mismatch: cell ${k} has ${engine.grid[k]}, snake ${s.pid}`);
        }
      }
    }

    // Track food eaten via score deltas is noisy; count deaths and check food bounds
    assert.ok(engine.food.size <= 140 + 40, `food overflow on ${mapId}: ${engine.food.size}`);
    assert.ok(engine.powers.size <= 4 + 1, `power overflow on ${mapId}: ${engine.powers.size}`);

    totalFoodEaten = engine.snakesForStats().reduce((acc, r) => acc + r.foodEaten, 0);
    if (totalFoodEaten === 0 && t > 150 && modeId === 'arena') {
      // With random movement snakes should find *some* food eventually on most runs,
      // but this is probabilistic — do not assert.
    }
  }

  const stats = engine.snakesForStats();
  assert.strictEqual(stats.length, players, 'snake count changed');
  for (const row of stats) {
    assert.ok(row.score >= 0, 'negative score');
    assert.ok(row.kills >= 0 && row.deaths >= 0, 'negative kills/deaths');
  }
  return { engine, events, stats };
}

let failures = 0;

for (const map of MAPS) {
  for (const mode of MODES) {
    try {
      const { events, stats } = runScenario({ mapId: map.id, modeId: mode.id, players: 6, ticks: 800 });
      const deaths = events.filter((e) => e.type === 'death').length;
      const respawns = events.filter((e) => e.type === 'respawn').length;
      const rounds = events.filter((e) => e.type === 'roundEnd').length;
      const scores = stats.map((s) => s.score).join(',');
      console.log(`OK  ${map.id}/${mode.id}: deaths=${deaths} respawns=${respawns} rounds=${rounds} scores=[${scores}]`);
      if (map.id === 'meadow' && mode.id === 'arena' && deaths === 0) {
        console.log('  note: no deaths in 800 ticks (lucky random walk)');
      }
    } catch (err) {
      failures++;
      console.error(`FAIL ${map.id}/${mode.id}: ${err.message}`);
    }
  }
}

// Deterministic collision check: two snakes aimed at each other must produce deaths.
try {
  const engine = new Engine({ map: getMap('meadow'), mode: MODES[0], onEvent: () => {} });
  const a = engine.addSnake({ guestId: 'g_a', nickname: 'A', skin: 'emerald' });
  const b = engine.addSnake({ guestId: 'g_b', nickname: 'B', skin: 'ruby' });
  // Force known positions
  a.segs = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
  a.dir = 1; a.queue = []; a.spawnShieldUntil = 0;
  b.segs = [{ x: 14, y: 10 }, { x: 15, y: 10 }, { x: 16, y: 10 }, { x: 17, y: 10 }, { x: 18, y: 10 }];
  b.dir = 3; b.queue = []; b.spawnShieldUntil = 0;
  engine.clearCells(a); engine.markCells(a);
  engine.clearCells(b); engine.markCells(b);
  const deaths = [];
  engine.onEvent = (ev) => { if (ev.type === 'death') deaths.push(ev); };
  for (let i = 0; i < 3; i++) engine.step();
  assert.ok(deaths.length >= 1, 'head-on collision produced no deaths');
  console.log('OK  deterministic head-on collision produced', deaths.length, 'deaths');
} catch (err) {
  failures++;
  console.error(`FAIL deterministic collision: ${err.message}`);
}

// Hinunangan: bay water and the Das-ay River are solid; fords stay open.
try {
  const map = getMap('hinunangan');
  const engine = new Engine({ map, mode: MODES[0], onEvent: () => {} });
  for (const [x, y, w, h] of map.water) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        assert.strictEqual(engine.grid[engine.key(xx, yy)], -1, `water cell ${xx},${yy} is not solid`);
      }
    }
  }
  for (const [x, y] of [[10, 8], [23, 11], [32, 13]]) {
    assert.strictEqual(engine.grid[engine.key(x, y)], 0, `river ford ${x},${y} is blocked`);
  }
  console.log('OK  hinunangan coastline and river fords');
} catch (err) {
  failures++;
  console.error(`FAIL hinunangan water: ${err.message}`);
}

// Wrap check on meadow: snake walking off the right edge re-enters on the left.
try {
  const engine = new Engine({ map: getMap('meadow'), mode: MODES[0], onEvent: () => {} });
  const s = engine.addSnake({ guestId: 'g_w', nickname: 'W', skin: 'ocean' });
  s.segs = [{ x: 59, y: 20 }, { x: 58, y: 20 }, { x: 57, y: 20 }, { x: 56, y: 20 }, { x: 55, y: 20 }];
  s.dir = 1; s.queue = [];
  engine.clearCells(s); engine.markCells(s);
  engine.step();
  assert.strictEqual(s.segs[0].x, 0, `wrap failed, head at ${s.segs[0].x}`);
  console.log('OK  wrap-around edge on meadow');
} catch (err) {
  failures++;
  console.error(`FAIL wrap: ${err.message}`);
}

if (failures > 0) {
  console.error(`\n${failures} test group(s) failed`);
  process.exit(1);
}
console.log('\nAll engine tests passed.');
