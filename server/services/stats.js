'use strict';

const { ACHIEVEMENTS } = require('../game/constants');
const { weekKey } = require('../db');
const log = require('../utils/logger');

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// Achievement rules. `st` = cumulative player_statistics row, `row` = this match's row.
const ACHIEVEMENT_CHECKS = [
  { id: 'first_bite', test: (st, row) => row.foodEaten >= 1 },
  { id: 'golden_5', test: (st, row) => row.goldenEaten >= 5 },
  { id: 'score_50', test: (st, row) => row.score >= 50 || st.highest_score >= 50 },
  { id: 'score_200', test: (st, row) => row.score >= 200 || st.highest_score >= 200 },
  { id: 'first_kill', test: (st, row) => row.kills >= 1 || st.total_kills >= 1 },
  { id: 'kills_25', test: (st, row) => st.total_kills >= 25 },
  { id: 'survive_180', test: (st, row) => row.longestLifeMs >= 180000 || st.longest_survival_seconds >= 180 },
  { id: 'win_1', test: (st, row) => st.wins >= 1 },
  { id: 'matches_10', test: (st, row) => st.matches_played >= 10 },
  { id: 'powers_10', test: (st, row) => row.powersTaken >= 10 },
];

const SKIN_REWARDS = { score_200: 'gold', kills_25: 'phantom' };

// Server-authoritative anti-cheat ceiling: a score above this is impossible to
// earn legitimately in the given alive time, so flag it for admin review.
function isSuspicious(row) {
  const cap = row.aliveTicks * 2.2 + row.kills * 10 + 40;
  return row.score > cap;
}

class StatsService {
  constructor(db, guests) {
    this.db = db;
    this.guests = guests;
  }

  async ensureMatch(room) {
    if (room.matchId !== null && room.matchId !== undefined) return;
    try {
      room.matchId = await this.db.ensureMatch({
        mode: room.mode.id, map: room.map.id, roomCode: room.code, playerCount: room.playerCount(),
      });
    } catch (e) {
      log.error('ensureMatch failed:', e.message);
    }
  }

  async ensureRoundMatch(room) {
    if (room.roundMatchId !== null && room.roundMatchId !== undefined) return;
    try {
      room.roundMatchId = await this.db.ensureMatch({
        mode: room.mode.id, map: room.map.id, roomCode: room.code, playerCount: room.playerCount(),
      });
    } catch (e) {
      log.error('ensureRoundMatch failed:', e.message);
    }
  }

  // Snapshot of a leaving player's cumulative row so later flushes include them.
  recordLeave(room, guestId) {
    const row = room.engine.snakesForStats().find((r) => r.guestId === guestId);
    if (!row) return;
    // One snapshot per guest: a newer cumulative row supersedes the old one.
    room.leftRows = room.leftRows.filter((r) => r.guestId !== guestId);
    room.leftRows.push(row);
  }

  // A guest who left and rejoined gets a fresh snake with zeroed totals. Carry
  // the earlier stint's cumulative counters forward so deltas stay correct
  // instead of going negative or counting the same stint twice.
  takePrior(room, guestId) {
    const last = room.statsLast.get(guestId);
    const left = room.leftRows.filter((r) => r.guestId === guestId).pop();
    if (!last && !left) return null;
    const pick = (k) => Math.max((last && last[k]) || 0, (left && left[k]) || 0);
    room.leftRows = room.leftRows.filter((r) => r.guestId !== guestId);
    return {
      kills: pick('kills'), deaths: pick('deaths'),
      survivedMs: pick('survivedMs'), wins: pick('wins'),
    };
  }

  // Current snakes win over departed snapshots for the same guest.
  mergeRows(room) {
    const byGuest = new Map();
    for (const row of room.leftRows) byGuest.set(row.guestId, row);
    for (const row of room.engine.snakesForStats()) byGuest.set(row.guestId, row);
    return [...byGuest.values()];
  }

  shouldFlush(room) {
    return Date.now() - room.lastFlush > FLUSH_INTERVAL_MS;
  }

  // Regular arena flush or room-close flush.
  async flush(room, { final = false } = {}) {
    try {
      const rows = this.mergeRows(room);
      if (!rows.length) return;
      await this.ensureMatch(room);
      const matchPlayers = rows.map((r) => ({
        guestId: r.guestId, nickname: r.nickname, score: r.score, kills: r.kills,
        deaths: r.deaths, survivedSeconds: Math.floor(r.survivedMs / 1000), won: r.wins > 0,
      }));
      const statsRows = [];
      const leaderboardRows = [];
      const nextLast = [];
      for (const r of rows) {
        const last = room.statsLast.get(r.guestId);
        const first = !last;
        statsRows.push({
          guestId: r.guestId, nickname: r.nickname,
          highestScore: r.score,
          killsDelta: r.kills - (last ? last.kills : 0),
          deathsDelta: r.deaths - (last ? last.deaths : 0),
          survivedMs: r.survivedMs - (last ? last.survivedMs : 0),
          winsDelta: r.wins - (last ? last.wins : 0),
          matchesDelta: first ? 1 : 0,
          suspicious: isSuspicious(r),
        });
        for (const period of ['daily', 'weekly', 'alltime']) {
          leaderboardRows.push({
            guestId: r.guestId, nickname: r.nickname, period,
            periodKey: period === 'daily' ? new Date().toISOString().slice(0, 10) : period === 'weekly' ? weekKey() : 'ALL',
            bestScore: r.score,
            killsDelta: r.kills - (last ? last.kills : 0),
            winsDelta: r.wins - (last ? last.wins : 0),
            matchesDelta: first ? 1 : 0,
            suspicious: isSuspicious(r),
          });
        }
        nextLast.push([r.guestId, { score: r.score, kills: r.kills, deaths: r.deaths, survivedMs: r.survivedMs, wins: r.wins }]);
      }
      await this.db.persistMatchResults({ matchId: room.matchId, end: final, matchPlayers, statsRows, leaderboardRows });
      // Advance baselines only after the write commits; otherwise a DB failure
      // would silently drop the deltas that were never persisted.
      for (const [guestId, last] of nextLast) room.statsLast.set(guestId, last);
      await this.checkAchievements(room, rows);
      room.lastFlush = Date.now();
      room.leftRows = [];
    } catch (e) {
      log.error('stats flush failed:', e.message);
    }
  }

  // Round-mode flush at round end: per-round match rows from standings,
  // cumulative stat deltas from engine totals.
  async roundFlush(room, ev) {
    try {
      const rows = this.mergeRows(room);
      const byGuest = new Map(rows.map((r) => [r.guestId, r]));
      const winnerIds = new Set(ev.winners.map((w) => w.guestId));
      await this.ensureRoundMatch(room);
      const matchPlayers = ev.standings.map((p) => ({
        guestId: p.guestId, nickname: p.nickname, score: p.score, kills: p.kills,
        deaths: p.deaths || 0, survivedSeconds: 0, won: winnerIds.has(p.guestId),
      }));
      const statsRows = [];
      const leaderboardRows = [];
      const nextLast = [];
      for (const r of rows) {
        const last = room.statsLast.get(r.guestId);
        const round = byGuest.get(r.guestId);
        const roundScore = ev.standings.find((p) => p.guestId === r.guestId);
        statsRows.push({
          guestId: r.guestId, nickname: r.nickname,
          highestScore: roundScore ? roundScore.score : 0,
          killsDelta: r.kills - (last ? last.kills : 0),
          deathsDelta: r.deaths - (last ? last.deaths : 0),
          survivedMs: r.survivedMs - (last ? last.survivedMs : 0),
          winsDelta: winnerIds.has(r.guestId) ? 1 : 0,
          matchesDelta: 1,
          suspicious: isSuspicious({ ...r, score: roundScore ? roundScore.score : 0, aliveTicks: r.aliveTicks }),
        });
        for (const period of ['daily', 'weekly', 'alltime']) {
          leaderboardRows.push({
            guestId: r.guestId, nickname: r.nickname, period,
            periodKey: period === 'daily' ? new Date().toISOString().slice(0, 10) : period === 'weekly' ? weekKey() : 'ALL',
            bestScore: roundScore ? roundScore.score : 0,
            killsDelta: r.kills - (last ? last.kills : 0),
            winsDelta: winnerIds.has(r.guestId) ? 1 : 0,
            matchesDelta: 1,
            suspicious: isSuspicious({ ...r, score: roundScore ? roundScore.score : 0, aliveTicks: r.aliveTicks }),
          });
        }
        nextLast.push([r.guestId, { score: r.score, kills: r.kills, deaths: r.deaths, survivedMs: r.survivedMs, wins: r.wins }]);
      }
      if (room.roundMatchId) {
        await this.db.persistMatchResults({ matchId: room.roundMatchId, end: true, matchPlayers, statsRows, leaderboardRows });
        for (const [guestId, last] of nextLast) room.statsLast.set(guestId, last);
        await this.checkAchievements(room, rows);
        room.lastFlush = Date.now();
        room.roundMatchId = null;
        room.leftRows = [];
      }
    } catch (e) {
      log.error('round flush failed:', e.message);
    }
  }

  async checkAchievements(room, rows) {
    try {
      const guestIds = [...new Set(rows.map((r) => r.guestId))];
      const statsMap = await this.db.statsGetMany(guestIds);
      for (const r of rows) {
        const st = statsMap.get(r.guestId) || {
          highest_score: 0, total_kills: 0, longest_survival_seconds: 0, wins: 0, matches_played: 0,
        };
        const have = new Set(await this.db.achievementsUnlocked(r.guestId));
        const newly = ACHIEVEMENT_CHECKS.filter((c) => !have.has(c.id) && c.test(st, r)).map((c) => c.id);
        if (!newly.length) continue;
        const inserted = await this.db.achievementsUnlockBatch(r.guestId, newly);
        for (const id of inserted) {
          const ach = ACHIEVEMENTS.find((a) => a.id === id);
          const socket = this.guests.getSocket(r.guestId);
          if (socket && ach) {
            socket.emit('achievement:unlocked', { id: ach.id, name: ach.name, desc: ach.desc });
          }
          const skinId = SKIN_REWARDS[id];
          if (skinId) {
            await this.db.skinUnlock(r.guestId, skinId).catch(() => {});
            if (socket) socket.emit('skins:updated', { skins: [skinId] });
          }
          log.info(`achievement ${id} unlocked by ${r.guestId}`);
        }
      }
    } catch (e) {
      log.error('achievement check failed:', e.message);
    }
  }
}

module.exports = { StatsService };
