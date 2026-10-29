'use strict';

const C = require('./constants');
const { DIRS, opposite, TICK_MS } = C;

let NEXT_PID = 1;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Grid cell values: 0 = empty, -1 = obstacle, >0 = pid of the snake occupying it.
class Engine {
  constructor({ map, mode, onEvent }) {
    this.map = map;
    this.mode = mode;
    this.onEvent = onEvent || (() => {});
    this.w = map.w;
    this.h = map.h;
    this.grid = new Int16Array(this.w * this.h);
    const blockers = map.water ? map.obstacles.concat(map.water) : map.obstacles;
    for (const [ox, oy, ow, oh] of blockers) {
      for (let y = oy; y < oy + oh; y++) {
        for (let x = ox; x < ox + ow; x++) {
          if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.grid[y * this.w + x] = -1;
        }
      }
    }
    this.snakes = new Map();
    this.food = new Map(); // key -> { x, y, v }
    this.powers = new Map(); // key -> { x, y, typeIdx, expireTick }
    this.tick = 0;
    this.lastPowerTick = 0;
    this.round = { number: 0, phase: 'waiting', endTick: 0, intermissionEndTick: 0 };
  }

  now() {
    return this.tick * TICK_MS;
  }

  key(x, y) {
    return y * this.w + x;
  }

  aliveCount() {
    let n = 0;
    for (const s of this.snakes.values()) if (s.alive) n++;
    return n;
  }

  getSnake(pid) {
    return this.snakes.get(pid) || null;
  }

  isFast(s) {
    return (s.boostOn && s.segs.length > C.BOOST_MIN_LEN) || this.now() < s.speedUntil;
  }

  isGhost(s) {
    return this.now() < s.ghostUntil;
  }

  isProtected(s) {
    return s.shield || this.now() < s.spawnShieldUntil;
  }

  // ---------- spawning ----------

  findSpawnCell() {
    for (let tries = 0; tries < 60; tries++) {
      const x = 4 + Math.floor(Math.random() * (this.w - 8));
      const y = 4 + Math.floor(Math.random() * (this.h - 8));
      if (this.grid[this.key(x, y)] !== 0) continue;
      if (this.food.has(this.key(x, y)) || this.powers.has(this.key(x, y))) continue;
      return { x, y };
    }
    return null;
  }

  findSpawn() {
    for (const minDist of [6, 4, 2, 0]) {
      for (let tries = 0; tries < 80; tries++) {
        const x = 2 + Math.floor(Math.random() * (this.w - 4));
        const y = 2 + Math.floor(Math.random() * (this.h - 4));
        if (this.grid[this.key(x, y)] !== 0) continue;
        const dx = this.w / 2 - x;
        const dy = this.h / 2 - y;
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
        // The head, one cell ahead, and START_LEN-1 cells behind must be free
        let ok = true;
        for (let i = -(C.START_LEN - 1); i <= 1 && ok; i++) {
          const cx = x + DIRS[dir].x * i;
          const cy = y + DIRS[dir].y * i;
          if (cx < 1 || cy < 1 || cx >= this.w - 1 || cy >= this.h - 1) ok = false;
          else if (this.grid[this.key(cx, cy)] !== 0) ok = false;
        }
        if (!ok) continue;
        if (minDist > 0) {
          for (const s of this.snakes.values()) {
            if (!s.alive || !s.segs.length) continue;
            const head = s.segs[0];
            if (Math.max(Math.abs(head.x - x), Math.abs(head.y - y)) < minDist) { ok = false; break; }
          }
        }
        if (!ok) continue;
        return { x, y, dir };
      }
    }
    // Last resort: any cell with at least 2 free cells behind it
    for (let tries = 0; tries < 80; tries++) {
      const x = 2 + Math.floor(Math.random() * (this.w - 4));
      const y = 2 + Math.floor(Math.random() * (this.h - 4));
      if (this.grid[this.key(x, y)] !== 0) continue;
      const dx = this.w / 2 - x;
      const dy = this.h / 2 - y;
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      let free = 0;
      for (let i = 1; i <= 2; i++) {
        const cx = x - DIRS[dir].x * i;
        const cy = y - DIRS[dir].y * i;
        if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) break;
        if (this.grid[this.key(cx, cy)] !== 0) break;
        free++;
      }
      if (free >= 2) return { x, y, dir, short: true };
    }
    return null;
  }

  buildSegs(spawn) {
    const segs = [];
    for (let i = 0; i < C.START_LEN; i++) {
      const x = spawn.x - DIRS[spawn.dir].x * i;
      const y = spawn.y - DIRS[spawn.dir].y * i;
      if (i > 0 && (x < 0 || y < 0 || x >= this.w || y >= this.h || this.grid[this.key(x, y)] !== 0)) break;
      segs.push({ x, y });
    }
    return segs;
  }

  addSnake({ guestId, nickname, skin }) {
    const spawn = this.findSpawn();
    if (!spawn) return null;
    const segs = this.buildSegs(spawn);
    if (segs.length < 2) return null;
    const s = {
      pid: NEXT_PID++, guestId, nickname, skin,
      dir: spawn.dir, queue: [],
      segs: [], pendingGrow: 0, gridMarked: false,
      alive: true, eliminated: false, disconnected: false,
      score: 0, kills: 0, deaths: 0, wins: 0,
      totalScore: 0, totalKills: 0, totalDeaths: 0, totalWins: 0,
      totalSurvivedMs: 0, survivedLastMs: 0,
      foodEaten: 0, goldenEaten: 0, powersTaken: 0,
      boostOn: false, shield: false,
      spawnShieldUntil: this.now() + C.SPAWN_SHIELD_MS,
      ghostUntil: 0, magnetUntil: 0, speedUntil: 0, doubleUntil: 0,
      respawnTick: 0, lifeStartTick: this.tick, joinedTick: this.tick, turned: false,
    };
    s.segs = segs;
    this.markCells(s);
    this.snakes.set(s.pid, s);
    return s;
  }

  removePlayer(pid, cause = 'left') {
    const s = this.snakes.get(pid);
    if (!s) return;
    this.kill(s, cause, null);
    this.clearCells(s);
    this.snakes.delete(pid);
  }

  input(pid, msg) {
    const s = this.snakes.get(pid);
    if (!s || !s.alive) return;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'dir') {
      const d = msg.dir | 0;
      if (!Number.isInteger(d) || d < 0 || d > 3) return;
      const last = s.queue.length ? s.queue[s.queue.length - 1] : s.dir;
      if (d === last || d === opposite(last)) return;
      if (s.queue.length < C.MAX_INPUT_QUEUE) s.queue.push(d);
    } else if (msg.type === 'boost') {
      s.boostOn = !!msg.on;
    }
  }

  setDisconnected(pid, disc) {
    const s = this.snakes.get(pid);
    if (!s) return;
    s.disconnected = !!disc;
    if (disc) s.boostOn = false;
  }

  // ---------- grid helpers ----------

  markCells(s) {
    for (const seg of s.segs) this.grid[this.key(seg.x, seg.y)] = s.pid;
    s.gridMarked = true;
  }

  clearCells(s) {
    for (const seg of s.segs) {
      const k = this.key(seg.x, seg.y);
      if (this.grid[k] === s.pid) this.grid[k] = 0;
    }
    s.gridMarked = false;
  }

  vacateTail(s) {
    if (!s.segs.length) return;
    const tail = s.segs[s.segs.length - 1];
    const k = this.key(tail.x, tail.y);
    if (this.grid[k] === s.pid) this.grid[k] = 0;
  }

  remarkTail(s) {
    if (!s.segs.length) return;
    const tail = s.segs[s.segs.length - 1];
    const k = this.key(tail.x, tail.y);
    if (this.grid[k] === 0) this.grid[k] = s.pid;
  }

  // Called when a snake stalls (shield saved it). Its tail was vacated pre-move;
  // if another snake claimed that cell meanwhile, the segment is lost — and a
  // snake squeezed down to nothing dies.
  stallSnake(s) {
    this.consumeShield(s);
    if (!s.segs.length) return;
    const tail = s.segs[s.segs.length - 1];
    const k = this.key(tail.x, tail.y);
    if (this.grid[k] === 0) {
      this.grid[k] = s.pid;
    } else if (this.grid[k] !== s.pid) {
      if (s.segs.length > 2) s.segs.pop();
      else this.kill(s, 'squish', null);
    }
  }

  shrink(s) {
    if (s.segs.length <= 2) return;
    const tail = s.segs.pop();
    const k = this.key(tail.x, tail.y);
    if (this.grid[k] === s.pid) this.grid[k] = 0;
  }

  // ---------- main tick ----------

  step() {
    this.tick++;
    const t = this.tick;
    if (this.mode.id === 'round') this.stepRound();
    const running = this.mode.id !== 'round' || this.round.phase === 'running';

    if (this.mode.respawn) {
      for (const s of this.snakes.values()) {
        if (!s.alive && !s.eliminated && s.respawnTick && t >= s.respawnTick && !s.disconnected) {
          this.respawn(s);
        }
      }
    }

    if (running) {
      this.tickGhosts();
      this.substep(true); // fast movers, first cell
      this.substep(false); // everyone, one cell (fast snakes get their second)
      if (t % C.BOOST_BURN_EVERY === 0) {
        for (const s of this.snakes.values()) {
          if (s.alive && s.boostOn && s.pendingGrow <= 0 && s.segs.length > C.BOOST_MIN_LEN) this.shrink(s);
        }
      }
      for (const s of this.snakes.values()) {
        if (s.alive && this.now() < s.magnetUntil) this.magnetPull(s);
      }
    }

    this.maintainWorld();
  }

  tickGhosts() {
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const ghost = this.isGhost(s);
      if (ghost && s.gridMarked) {
        this.clearCells(s);
      } else if (!ghost && !s.gridMarked) {
        this.remarkCells(s);
      }
    }
  }

  // A ghost snake is intangible; when the effect ends its cells may overlap
  // another snake. Cut the tail at the first overlap; die if the cut is fatal.
  remarkCells(s) {
    for (let i = 0; i < s.segs.length; i++) {
      const k = this.key(s.segs[i].x, s.segs[i].y);
      const owner = this.grid[k];
      if (owner !== 0 && owner !== s.pid) {
        s.segs = s.segs.slice(0, i);
        if (s.segs.length < 2) {
          this.kill(s, 'squish', null);
          return;
        }
        break;
      }
    }
    this.markCells(s);
  }

  substep(fastOnly) {
    const movers = [];
    for (const s of this.snakes.values()) {
      if (!s.alive || s.disconnected || !s.segs.length) continue;
      if (fastOnly && !this.isFast(s)) continue;
      movers.push(s);
    }
    if (!movers.length) return;
    shuffle(movers);

    for (const s of movers) {
      if (!s.turned) {
        s.turned = true;
        if (s.queue.length) {
          const d = s.queue.shift();
          if (d !== opposite(s.dir)) s.dir = d;
        }
      }
      if (s.pendingGrow <= 0) this.vacateTail(s);
    }

    // Intended cells
    const intents = new Map();
    const cellPids = new Map();
    for (const s of movers) {
      const head = s.segs[0];
      let nx = head.x + DIRS[s.dir].x;
      let ny = head.y + DIRS[s.dir].y;
      if (this.map.wrap) {
        nx = (nx + this.w) % this.w;
        ny = (ny + this.h) % this.h;
      } else if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) {
        intents.set(s.pid, { wall: true });
        continue;
      }
      intents.set(s.pid, { x: nx, y: ny });
      const k = this.key(nx, ny);
      if (!cellPids.has(k)) cellPids.set(k, []);
      cellPids.get(k).push(s.pid);
    }

    // Head-on conflicts: 2+ snakes entering the same cell
    const skipPids = new Set();
    const deathQueue = [];
    const diedPids = new Set();
    for (const [, pids] of cellPids) {
      if (pids.length < 2) continue;
      const parts = pids.map((pid) => this.snakes.get(pid)).filter((s) => s && !this.isGhost(s));
      if (parts.length < 2) continue;
      const prot = parts.filter((s) => this.isProtected(s));
      const dying = parts.filter((s) => !this.isProtected(s));
      for (const s of dying) {
        const killer = prot.length ? prot[0] : dying.find((x) => x !== s) || null;
        deathQueue.push({ s, cause: 'headon', killerPid: killer ? killer.pid : null });
        diedPids.add(s.pid);
        skipPids.add(s.pid);
      }
      for (const s of prot) {
        skipPids.add(s.pid);
        this.stallSnake(s);
      }
    }

    // Sequential application (movers were shuffled)
    for (const s of movers) {
      if (skipPids.has(s.pid) || diedPids.has(s.pid) || !s.alive) continue;
      const intent = intents.get(s.pid);
      if (!intent) continue;
      if (intent.wall) {
        if (this.isProtected(s)) this.stallSnake(s);
        else {
          deathQueue.push({ s, cause: 'wall', killerPid: null });
          diedPids.add(s.pid);
        }
        continue;
      }
      const k = this.key(intent.x, intent.y);
      if (this.grid[k] === -1) {
        if (this.isProtected(s)) this.stallSnake(s);
        else {
          deathQueue.push({ s, cause: 'wall', killerPid: null });
          diedPids.add(s.pid);
        }
        continue;
      }
      if (!this.isGhost(s)) {
        const owner = this.grid[k];
        if (owner > 0 && owner !== s.pid) {
          if (this.isProtected(s)) this.stallSnake(s);
          else {
            deathQueue.push({ s, cause: 'snake', killerPid: owner });
            diedPids.add(s.pid);
          }
          continue;
        }
        if (owner === s.pid) {
          if (this.isProtected(s)) this.stallSnake(s);
          else {
            deathQueue.push({ s, cause: 'self', killerPid: null });
            diedPids.add(s.pid);
          }
          continue;
        }
      }

      // Move is safe
      s.segs.unshift({ x: intent.x, y: intent.y });
      if (s.pendingGrow > 0) s.pendingGrow--;
      else s.segs.pop(); // tail cell was vacated pre-move
      if (!this.isGhost(s)) this.grid[k] = s.pid;

      const food = this.food.get(k);
      if (food) this.eatFood(s, food, k);
      const power = this.powers.get(k);
      if (power) this.applyPower(s, power, k);
    }

    for (const s of movers) s.turned = false;

    for (const d of deathQueue) this.kill(d.s, d.cause, d.killerPid);
  }

  consumeShield(s) {
    if (s.shield) s.shield = false;
  }

  eatFood(s, food, k) {
    this.food.delete(k);
    const mult = this.now() < s.doubleUntil ? 2 : 1;
    s.score += food.v * mult;
    s.pendingGrow += food.v > 1 ? C.GOLDEN_GROW : 1;
    s.foodEaten++;
    if (food.v > 1) s.goldenEaten++;
  }

  applyPower(s, power, k) {
    this.powers.delete(k);
    s.powersTaken++;
    const now = this.now();
    switch (power.typeIdx) {
      case 0: s.speedUntil = now + C.POWERUPS[0].ms; break; // turbo
      case 1: s.shield = true; break; // shield
      case 2: s.magnetUntil = now + C.POWERUPS[2].ms; break; // magnet
      case 3: // ghost
        s.ghostUntil = now + C.POWERUPS[3].ms;
        this.clearCells(s);
        break;
      case 4: s.doubleUntil = now + C.POWERUPS[4].ms; break; // double
      default: break;
    }
  }

  magnetPull(s) {
    if (!s.segs.length) return;
    const head = s.segs[0];
    const entries = Array.from(this.food.entries());
    for (const [k, f] of entries) {
      const dx = head.x - f.x;
      const dy = head.y - f.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > C.MAGNET_RADIUS) continue;
      let tx = f.x;
      let ty = f.y;
      if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) tx += Math.sign(dx);
      else if (dy !== 0) ty += Math.sign(dy);
      if (tx === head.x && ty === head.y) {
        this.eatFood(s, f, k);
        continue;
      }
      const tk = this.key(tx, ty);
      if (this.grid[tk] === 0 && !this.food.has(tk) && !this.powers.has(tk)) {
        this.food.delete(k);
        this.food.set(tk, { x: tx, y: ty, v: f.v });
      }
    }
  }

  maintainWorld() {
    const target = Math.min(C.FOOD_MAX, this.aliveCount() * C.FOOD_TARGET_PER_PLAYER + C.FOOD_TARGET_BASE);
    let guard = 0;
    while (this.food.size < target && guard++ < 20) {
      const cell = this.findSpawnCell();
      if (!cell) break;
      const v = Math.random() < C.GOLDEN_CHANCE ? C.GOLDEN_VALUE : 1;
      this.food.set(this.key(cell.x, cell.y), { x: cell.x, y: cell.y, v });
    }
    for (const [k, p] of this.powers) {
      if (this.tick >= p.expireTick) this.powers.delete(k);
    }
    if (this.powers.size < C.POWER_MAX
      && this.tick - this.lastPowerTick > C.POWER_SPAWN_MIN_TICKS + Math.floor(Math.random() * C.POWER_SPAWN_RAND_TICKS)) {
      const cell = this.findSpawnCell();
      if (cell) {
        const typeIdx = Math.floor(Math.random() * C.POWERUPS.length);
        this.powers.set(this.key(cell.x, cell.y), {
          x: cell.x, y: cell.y, typeIdx, expireTick: this.tick + C.POWER_EXPIRE_TICKS,
        });
        this.lastPowerTick = this.tick;
      }
    }
  }

  kill(s, cause, killerPid) {
    if (!s.alive) return;
    s.alive = false;
    const lifeMs = (this.tick - s.lifeStartTick) * TICK_MS;
    s.survivedLastMs = lifeMs;
    s.totalSurvivedMs += lifeMs;
    s.totalDeaths++;
    s.deaths++;
    if (killerPid) {
      const k = this.snakes.get(killerPid);
      if (k && k !== s && k.alive) {
        k.kills++;
        k.totalKills++;
        k.score += C.KILL_SCORE;
      }
    }
    this.clearCells(s);
    let dropped = 0;
    for (let i = 0; i < s.segs.length && dropped < 40; i += 2) {
      const c = s.segs[i];
      const k = this.key(c.x, c.y);
      if (this.grid[k] === 0 && !this.food.has(k) && this.food.size < C.FOOD_MAX) {
        this.food.set(k, { x: c.x, y: c.y, v: 1 });
        dropped++;
      }
    }
    s.segs = [];
    s.boostOn = false;
    s.shield = false;
    s.ghostUntil = 0;
    s.magnetUntil = 0;
    s.speedUntil = 0;
    s.doubleUntil = 0;
    if (this.mode.respawn && cause !== 'left') {
      s.respawnTick = this.tick + C.RESPAWN_MS / TICK_MS;
    } else {
      s.eliminated = true;
    }
    this.onEvent({
      type: 'death',
      pid: s.pid, guestId: s.guestId, nickname: s.nickname,
      cause, killerPid: killerPid || null,
      score: s.score, kills: s.totalKills,
      lifeMs, totalSurvivedMs: s.totalSurvivedMs,
      foodEaten: s.foodEaten, goldenEaten: s.goldenEaten, powersTaken: s.powersTaken,
      tick: this.tick,
    });
  }

  respawn(s) {
    const spawn = this.findSpawn();
    if (!spawn) {
      s.respawnTick = this.tick + 1;
      return;
    }
    const segs = this.buildSegs(spawn);
    if (segs.length < 2) {
      s.respawnTick = this.tick + 1;
      return;
    }
    this.clearCells(s);
    s.alive = true;
    s.eliminated = false;
    s.dir = spawn.dir;
    s.queue = [];
    s.segs = segs;
    s.pendingGrow = 0;
    this.markCells(s);
    s.spawnShieldUntil = this.now() + C.SPAWN_SHIELD_MS;
    s.shield = false;
    s.ghostUntil = 0;
    s.magnetUntil = 0;
    s.speedUntil = 0;
    s.doubleUntil = 0;
    s.boostOn = false;
    s.lifeStartTick = this.tick;
    this.onEvent({ type: 'respawn', pid: s.pid });
  }

  // ---------- round mode ----------

  stepRound() {
    const r = this.round;
    const playerCount = this.snakes.size;
    if (r.phase === 'waiting') {
      if (playerCount >= 2) {
        r.number++;
        r.phase = 'running';
        r.endTick = this.tick + (this.mode.roundSeconds * 1000 / TICK_MS);
        this.resetRound();
        this.onEvent({ type: 'roundStart', number: r.number, endTick: r.endTick });
      }
    } else if (r.phase === 'running') {
      if (playerCount < 2) {
        this.endRound(true);
      } else if (this.aliveCount() <= 1 || (r.endTick && this.tick >= r.endTick)) {
        this.endRound(false);
      }
    } else if (r.phase === 'intermission' && this.tick >= r.intermissionEndTick) {
      r.phase = 'waiting';
    }
  }

  endRound(abort) {
    const r = this.round;
    const standings = [...this.snakes.values()].map((s) => ({
      pid: s.pid, guestId: s.guestId, nickname: s.nickname, score: s.score, kills: s.kills, deaths: s.deaths, alive: s.alive,
    })).sort((a, b) => b.score - a.score || b.kills - a.kills);
    let winners = [];
    if (!abort) {
      const aliveOnes = standings.filter((p) => p.alive);
      winners = aliveOnes.length ? aliveOnes : standings.slice(0, 1);
      for (const w of winners) {
        const s = this.snakes.get(w.pid);
        if (s) {
          s.wins++;
          s.totalWins++;
        }
      }
    }
    for (const s of this.snakes.values()) s.totalScore += s.score;
    r.phase = 'intermission';
    r.intermissionEndTick = this.tick + (this.mode.intermissionSeconds * 1000 / TICK_MS);
    this.onEvent({
      type: 'roundEnd',
      winners: winners.map((w) => ({ pid: w.pid, guestId: w.guestId, nickname: w.nickname, score: w.score })),
      standings,
      number: r.number,
    });
  }

  resetRound() {
    for (const s of this.snakes.values()) {
      s.score = 0;
      s.kills = 0;
      s.deaths = 0;
      s.eliminated = false;
      this.respawn(s);
    }
  }

  // ---------- output ----------

  snapshot() {
    const snakes = [];
    for (const s of this.snakes.values()) {
      if (!s.alive || !s.segs.length) continue;
      const now = this.now();
      let flags = 0;
      if (s.disconnected) flags |= 1;
      if (s.boostOn && this.isFast(s)) flags |= 2;
      if (now < s.ghostUntil) flags |= 4;
      if (s.shield) flags |= 8;
      if (now < s.spawnShieldUntil) flags |= 16;
      if (now < s.speedUntil) flags |= 32;
      if (now < s.magnetUntil) flags |= 64;
      if (now < s.doubleUntil) flags |= 128;
      const arr = [s.pid, s.skin, s.dir, flags];
      for (const seg of s.segs) arr.push(seg.x, seg.y);
      snakes.push(arr);
    }
    const food = [];
    for (const f of this.food.values()) food.push([f.x, f.y, f.v]);
    const powers = [];
    for (const p of this.powers.values()) powers.push([p.x, p.y, p.typeIdx, p.expireTick]);
    return { tick: this.tick, t: this.now(), snakes, food, powers };
  }

  playerInfos() {
    const arr = [];
    for (const s of this.snakes.values()) {
      arr.push({
        pid: s.pid, guestId: s.guestId, nick: s.nickname, skin: s.skin,
        score: s.score, kills: s.kills, deaths: s.deaths,
        alive: s.alive, disc: s.disconnected, len: s.segs.length,
      });
    }
    return arr;
  }

  // Rows consumed by the stats service at flush time.
  snakesForStats() {
    const rows = [];
    for (const s of this.snakes.values()) {
      const lifeMsNow = s.alive ? (this.tick - s.lifeStartTick) * TICK_MS : s.survivedLastMs;
      rows.push({
        guestId: s.guestId, nickname: s.nickname, pid: s.pid,
        score: this.mode.id === 'arena' ? s.score : s.totalScore,
        kills: s.totalKills, deaths: s.totalDeaths,
        survivedMs: s.totalSurvivedMs,
        longestLifeMs: Math.max(s.survivedLastMs, lifeMsNow),
        wins: s.totalWins, foodEaten: s.foodEaten, goldenEaten: s.goldenEaten,
        powersTaken: s.powersTaken, aliveTicks: Math.floor(s.totalSurvivedMs / TICK_MS),
      });
    }
    return rows;
  }
}

module.exports = { Engine };
