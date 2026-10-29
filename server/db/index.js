'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const log = require('../utils/logger');

const ACHIEVEMENT_IDS = ['first_bite', 'golden_5', 'score_50', 'score_200', 'first_kill', 'kills_25', 'survive_180', 'win_1', 'matches_10', 'powers_10'];

class DB {
  constructor() {
    this.pool = null;
    this.mode = 'memory';
    // In-memory driver state (used when DATABASE_URL is absent)
    this.m = {
      guests: new Map(),
      sessions: new Map(),
      matches: new Map(),
      matchSeq: 1,
      matchPlayers: new Map(), // matchId -> Map(guestId -> row)
      stats: new Map(),
      leaderboard: new Map(), // `${period}|${key}|${guest}` -> row
      skins: new Map(), // guest -> Set
      heads: new Map(), // guest -> { image, mime, version, updated_at }
      achievements: new Map(), // guest -> Set
      blocks: new Map(), // blocker -> Set
      reports: new Map(),
      reportSeq: 1,
      voice: new Map(),
      audit: [],
      bans: new Map(),
      banSeq: 1,
    };
  }

  async init() {
    if (!config.db.enabled) {
      log.warn('DATABASE_URL not set — running with in-memory storage. Leaderboards and statistics will reset on restart.');
      return;
    }
    if (config.db.error) {
      log.warn(`DATABASE_URL invalid (${config.db.error}) — running with in-memory storage.`);
      return;
    }
    try {
      this.pool = mysql.createPool({
        uri: config.db.url,
        ssl: config.db.ssl ? { ca: config.db.ca || undefined, rejectUnauthorized: true, minVersion: 'TLSv1.2' } : undefined,
        connectionLimit: 8,
        waitForConnections: true,
        timezone: 'Z',
        supportBigNumbers: true,
      });
      await this.pool.query('SELECT 1');
      this.mode = 'mysql';
      log.info(`MySQL connected (${config.db.host || 'unknown host'})`);
    } catch (err) {
      this.pool = null;
      this.mode = 'down';
      log.error(`MySQL connection failed: ${err.message}`);
      log.warn('Continuing with in-memory storage — restart with a valid DATABASE_URL for persistence.');
      this.mode = 'memory';
    }
  }

  async ping() {
    if (!this.pool) return { ok: true, ms: 0, mode: this.mode };
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, ms: Date.now() - start, mode: this.mode };
    } catch (err) {
      return { ok: false, ms: Date.now() - start, mode: 'down', error: err.message };
    }
  }

  async close() {
    if (this.pool) await this.pool.end().catch(() => {});
  }

  // ---------- guests ----------

  async ensureGuest(guestId, nickname) {
    if (!this.pool) {
      const g = this.m.guests.get(guestId) || { guest_id: guestId, nickname, created_at: new Date(), last_seen_at: new Date(), nickname_updated_at: null };
      g.last_seen_at = new Date();
      this.m.guests.set(guestId, g);
      return;
    }
    await this.pool.execute(
      'INSERT INTO guest_players (guest_id, nickname) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_seen_at = NOW()',
      [guestId, nickname],
    );
  }

  async guestGet(guestId) {
    if (!this.pool) return this.m.guests.get(guestId) || null;
    const [rows] = await this.pool.execute('SELECT guest_id, nickname, created_at, last_seen_at FROM guest_players WHERE guest_id = ?', [guestId]);
    return rows[0] || null;
  }

  async guestRename(guestId, nickname) {
    if (!this.pool) {
      const g = this.m.guests.get(guestId);
      if (g) { g.nickname = nickname; g.nickname_updated_at = new Date(); }
      return;
    }
    await this.pool.execute('UPDATE guest_players SET nickname = ?, nickname_updated_at = NOW() WHERE guest_id = ?', [nickname, guestId]);
  }

  async guestTouch(guestId) {
    if (!this.pool) {
      const g = this.m.guests.get(guestId);
      if (g) g.last_seen_at = new Date();
      return;
    }
    await this.pool.execute('UPDATE guest_players SET last_seen_at = NOW() WHERE guest_id = ?', [guestId]).catch(() => {});
  }

  // ---------- sessions ----------

  async sessionCreate({ tokenHash, guestId, ipHash, ua, expiresAt }) {
    if (!this.pool) {
      this.m.sessions.set(tokenHash, {
        token_hash: tokenHash, guest_id: guestId, ip_hash: ipHash, user_agent: String(ua || '').slice(0, 255),
        room_id: null, player_id: null, created_at: new Date(), last_seen_at: new Date(), expires_at: expiresAt,
      });
      return;
    }
    await this.pool.execute(
      'INSERT INTO player_sessions (token_hash, guest_id, ip_hash, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)',
      [tokenHash, guestId, ipHash, String(ua || '').slice(0, 255), expiresAt],
    );
  }

  async sessionGet(tokenHash) {
    if (!this.pool) {
      const s = this.m.sessions.get(tokenHash);
      if (!s) return null;
      if (s.expires_at.getTime() < Date.now()) { this.m.sessions.delete(tokenHash); return null; }
      return { ...s };
    }
    const [rows] = await this.pool.execute(
      'SELECT token_hash, guest_id, room_id, player_id, expires_at FROM player_sessions WHERE token_hash = ? AND expires_at > NOW()',
      [tokenHash],
    );
    return rows[0] || null;
  }

  async sessionUpdate(tokenHash, { roomId, playerId, expiresAt } = {}) {
    if (!this.pool) {
      const s = this.m.sessions.get(tokenHash);
      if (!s) return;
      if (roomId !== undefined) s.room_id = roomId;
      if (playerId !== undefined) s.player_id = playerId;
      if (expiresAt) s.expires_at = expiresAt;
      s.last_seen_at = new Date();
      return;
    }
    const sets = [];
    const params = [];
    if (roomId !== undefined) { sets.push('room_id = ?'); params.push(roomId); }
    if (playerId !== undefined) { sets.push('player_id = ?'); params.push(playerId); }
    if (expiresAt) { sets.push('expires_at = ?'); params.push(expiresAt); }
    sets.push('last_seen_at = NOW()');
    params.push(tokenHash);
    await this.pool.execute(
      `UPDATE player_sessions SET ${sets.join(', ')} WHERE token_hash = ?`,
      params,
    ).catch((e) => log.error('sessionUpdate failed:', e.message));
  }

  async sessionDelete(tokenHash) {
    if (!this.pool) { this.m.sessions.delete(tokenHash); return; }
    await this.pool.execute('DELETE FROM player_sessions WHERE token_hash = ?', [tokenHash]);
  }

  async sessionDeleteForGuest(guestId) {
    if (!this.pool) {
      for (const [k, s] of this.m.sessions) if (s.guest_id === guestId) this.m.sessions.delete(k);
      return;
    }
    await this.pool.execute('DELETE FROM player_sessions WHERE guest_id = ?', [guestId]);
  }

  // ---------- bans ----------

  async banActive(guestId) {
    if (!this.pool) {
      let best = null;
      for (const b of this.m.bans.values()) {
        if (b.guest_id !== guestId || b.lifted_at) continue;
        if (b.until && b.until.getTime() < Date.now()) continue;
        if (!best || !b.until || !best.until || b.until > best.until) best = b;
      }
      return best;
    }
    const [rows] = await this.pool.execute(
      "SELECT id, guest_id, reason, until FROM admin_bans WHERE guest_id = ? AND lifted_at IS NULL AND (until IS NULL OR until > NOW()) ORDER BY id DESC LIMIT 1",
      [guestId],
    );
    return rows[0] || null;
  }

  async banCreate({ guestId, reason, minutes, by }) {
    const until = minutes ? new Date(Date.now() + minutes * 60000) : null;
    if (!this.pool) {
      const id = this.m.banSeq++;
      this.m.bans.set(id, { id, guest_id: guestId, reason: String(reason || '').slice(0, 200), until, created_by: by || 'admin', created_at: new Date(), lifted_at: null });
      return { id };
    }
    const [res] = await this.pool.execute(
      'INSERT INTO admin_bans (guest_id, reason, until, created_by) VALUES (?, ?, ?, ?)',
      [guestId, String(reason || '').slice(0, 200), until, by || 'admin'],
    );
    return { id: res.insertId };
  }

  async banList(activeOnly) {
    if (!this.pool) {
      let rows = [...this.m.bans.values()].sort((a, b) => b.id - a.id);
      if (activeOnly) rows = rows.filter((b) => !b.lifted_at && (!b.until || b.until.getTime() > Date.now()));
      return rows.slice(0, 200);
    }
    const sql = activeOnly
      ? 'SELECT id, guest_id, reason, until, created_by, created_at, lifted_at FROM admin_bans WHERE lifted_at IS NULL AND (until IS NULL OR until > NOW()) ORDER BY id DESC LIMIT 200'
      : 'SELECT id, guest_id, reason, until, created_by, created_at, lifted_at FROM admin_bans ORDER BY id DESC LIMIT 200';
    const [rows] = await this.pool.query(sql);
    return rows;
  }

  async banLift(id) {
    if (!this.pool) {
      const b = this.m.bans.get(id);
      if (b) b.lifted_at = new Date();
      return;
    }
    await this.pool.execute('UPDATE admin_bans SET lifted_at = NOW() WHERE id = ?', [id]);
  }

  // ---------- matches & stats ----------

  async ensureMatch({ mode, map, roomCode, playerCount }) {
    if (!this.pool) {
      const id = this.m.matchSeq++;
      this.m.matches.set(id, { id, mode, map, room_code: roomCode || null, started_at: new Date(), ended_at: null, player_count: playerCount });
      this.m.matchPlayers.set(id, new Map());
      return id;
    }
    const [res] = await this.pool.execute(
      'INSERT INTO matches (mode, map, room_code, player_count) VALUES (?, ?, ?, ?)',
      [mode, map, roomCode || null, playerCount],
    );
    return res.insertId;
  }

  // One atomic flush of match results. matchPlayers rows are absolute values
  // (upserted); statsRows and leaderboardRows are deltas/maxima.
  async persistMatchResults({ matchId, end, matchPlayers, statsRows, leaderboardRows }) {
    if (!this.pool) {
      if (end) {
        const m = this.m.matches.get(matchId);
        if (m) { m.ended_at = new Date(); m.player_count = matchPlayers.length; }
      }
      const mp = this.m.matchPlayers.get(matchId) || new Map();
      for (const row of matchPlayers) mp.set(row.guestId, { ...row, match_id: matchId });
      this.m.matchPlayers.set(matchId, mp);
      for (const row of statsRows) this.memStatsUpsert(row);
      for (const row of leaderboardRows) this.memLeaderboardUpsert(row);
      return;
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      if (end) {
        await conn.execute('UPDATE matches SET ended_at = NOW(), player_count = ? WHERE id = ?', [matchPlayers.length, matchId]);
      }
      for (const p of matchPlayers) {
        await conn.execute(
          `INSERT INTO match_players (match_id, guest_id, nickname, score, kills, deaths, survived_seconds, won)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), score = VALUES(score), kills = VALUES(kills),
             deaths = VALUES(deaths), survived_seconds = VALUES(survived_seconds), won = VALUES(won)`,
          [matchId, p.guestId, p.nickname, p.score, p.kills, p.deaths, p.survivedSeconds, p.won ? 1 : 0],
        );
      }
      for (const s of statsRows) {
        await conn.execute(
          `INSERT INTO player_statistics (guest_id, nickname, highest_score, total_kills, total_deaths, longest_survival_seconds, wins, matches_played, suspicious_flags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE nickname = VALUES(nickname),
             highest_score = GREATEST(highest_score, VALUES(highest_score)),
             total_kills = total_kills + VALUES(total_kills),
             total_deaths = total_deaths + VALUES(total_deaths),
             longest_survival_seconds = GREATEST(longest_survival_seconds, VALUES(longest_survival_seconds)),
             wins = wins + VALUES(wins),
             matches_played = matches_played + VALUES(matches_played),
             suspicious_flags = suspicious_flags + VALUES(suspicious_flags)`,
          [s.guestId, s.nickname, s.highestScore, s.killsDelta, s.deathsDelta, Math.floor(s.survivedMs / 1000), s.winsDelta, s.matchesDelta, s.suspicious ? 1 : 0],
        );
      }
      for (const l of leaderboardRows) {
        await conn.execute(
          `INSERT INTO leaderboard_entries (period, period_key, guest_id, nickname, best_score, kills, wins, matches, suspicious)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE nickname = VALUES(nickname),
             best_score = GREATEST(best_score, VALUES(best_score)),
             kills = kills + VALUES(kills),
             wins = wins + VALUES(wins),
             matches = matches + VALUES(matches),
             suspicious = suspicious | VALUES(suspicious)`,
          [l.period, l.periodKey, l.guestId, l.nickname, l.bestScore, l.killsDelta, l.winsDelta, l.matchesDelta, l.suspicious ? 1 : 0],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  memStatsUpsert(s) {
    const cur = this.m.stats.get(s.guestId) || {
      guest_id: s.guestId, nickname: s.nickname, highest_score: 0, total_kills: 0, total_deaths: 0,
      longest_survival_seconds: 0, wins: 0, matches_played: 0, suspicious_flags: 0, updated_at: new Date(),
    };
    cur.nickname = s.nickname;
    cur.highest_score = Math.max(cur.highest_score, s.highestScore);
    cur.total_kills += s.killsDelta;
    cur.total_deaths += s.deathsDelta;
    cur.longest_survival_seconds = Math.max(cur.longest_survival_seconds, Math.floor(s.survivedMs / 1000));
    cur.wins += s.winsDelta;
    cur.matches_played += s.matchesDelta;
    cur.suspicious_flags += s.suspicious ? 1 : 0;
    cur.updated_at = new Date();
    this.m.stats.set(s.guestId, cur);
  }

  memLeaderboardUpsert(l) {
    const key = `${l.period}|${l.periodKey}|${l.guestId}`;
    const cur = this.m.leaderboard.get(key) || {
      period: l.period, period_key: l.periodKey, guest_id: l.guestId, nickname: l.nickname,
      best_score: 0, kills: 0, wins: 0, matches: 0, suspicious: 0, updated_at: new Date(),
    };
    cur.nickname = l.nickname;
    cur.best_score = Math.max(cur.best_score, l.bestScore);
    cur.kills += l.killsDelta;
    cur.wins += l.winsDelta;
    cur.matches += l.matchesDelta;
    cur.suspicious = cur.suspicious || (l.suspicious ? 1 : 0);
    cur.updated_at = new Date();
    this.m.leaderboard.set(key, cur);
  }

  async statsGetMany(guestIds) {
    const out = new Map();
    if (!guestIds.length) return out;
    if (!this.pool) {
      for (const id of guestIds) {
        const s = this.m.stats.get(id);
        if (s) out.set(id, s);
      }
      return out;
    }
    const placeholders = guestIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute(
      `SELECT guest_id, nickname, highest_score, total_kills, total_deaths, longest_survival_seconds, wins, matches_played, suspicious_flags
       FROM player_statistics WHERE guest_id IN (${placeholders})`,
      guestIds,
    );
    for (const r of rows) out.set(r.guest_id, r);
    return out;
  }

  async leaderboardGet(period, limit) {
    if (!this.pool) {
      const key = period === 'alltime' ? 'ALL' : null;
      const rows = [...this.m.leaderboard.values()].filter((r) => {
        if (period === 'alltime') return r.period === 'alltime';
        if (period === 'daily') return r.period === 'daily' && r.period_key === new Date().toISOString().slice(0, 10);
        if (period === 'weekly') return r.period === 'weekly' && r.period_key === weekKey();
        return false;
      });
      return rows.sort((a, b) => b.best_score - a.best_score).slice(0, limit);
    }
    const periodKey = period === 'alltime' ? 'ALL' : period === 'daily' ? new Date().toISOString().slice(0, 10) : weekKey();
    const [rows] = await this.pool.execute(
      'SELECT period, period_key, guest_id, nickname, best_score, kills, wins, matches, suspicious, updated_at FROM leaderboard_entries WHERE period = ? AND period_key = ? ORDER BY best_score DESC, kills DESC LIMIT ?',
      [period, periodKey, limit],
    );
    return rows;
  }

  async suspiciousGet(limit) {
    if (!this.pool) {
      return [...this.m.leaderboard.values()]
        .filter((r) => r.suspicious)
        .sort((a, b) => b.best_score - a.best_score)
        .slice(0, limit);
    }
    const [rows] = await this.pool.execute(
      "SELECT period, period_key, guest_id, nickname, best_score, kills, wins, matches, updated_at FROM leaderboard_entries WHERE suspicious = 1 ORDER BY best_score DESC LIMIT ?",
      [limit],
    );
    return rows;
  }

  // ---------- skins ----------

  async skinsGet(guestId) {
    if (!this.pool) return [...(this.m.skins.get(guestId) || [])];
    const [rows] = await this.pool.execute('SELECT skin_id FROM player_skins WHERE guest_id = ?', [guestId]);
    return rows.map((r) => r.skin_id);
  }

  async skinUnlock(guestId, skinId) {
    if (!this.pool) {
      const set = this.m.skins.get(guestId) || new Set();
      set.add(skinId);
      this.m.skins.set(guestId, set);
      return;
    }
    await this.pool.execute('INSERT IGNORE INTO player_skins (guest_id, skin_id) VALUES (?, ?)', [guestId, skinId]);
  }

  // ---------- custom snake heads ----------

  async headGet(guestId) {
    if (!this.pool) {
      const row = this.m.heads.get(guestId);
      return row ? { ...row } : null;
    }
    const [rows] = await this.pool.execute(
      'SELECT mime, image, version, updated_at FROM player_heads WHERE guest_id = ?',
      [guestId],
    );
    return rows[0] || null;
  }

  async headMeta(guestId) {
    if (!this.pool) {
      const row = this.m.heads.get(guestId);
      return row ? { version: row.version, updated_at: row.updated_at } : null;
    }
    const [rows] = await this.pool.execute(
      'SELECT version, updated_at FROM player_heads WHERE guest_id = ?',
      [guestId],
    );
    return rows[0] || null;
  }

  async headSet(guestId, { image, mime, version }) {
    if (!this.pool) {
      this.m.heads.set(guestId, { guest_id: guestId, mime, image, version, updated_at: new Date() });
      return;
    }
    await this.pool.execute(
      `INSERT INTO player_heads (guest_id, mime, image, version)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE mime = VALUES(mime), image = VALUES(image),
         version = VALUES(version), updated_at = NOW()`,
      [guestId, mime, image, version],
    );
  }

  async headDelete(guestId) {
    if (!this.pool) { this.m.heads.delete(guestId); return; }
    await this.pool.execute('DELETE FROM player_heads WHERE guest_id = ?', [guestId]);
  }

  // ---------- achievements ----------

  async achievementsUnlocked(guestId) {
    if (!this.pool) return [...(this.m.achievements.get(guestId) || [])];
    const [rows] = await this.pool.execute('SELECT achievement_id FROM player_achievements WHERE guest_id = ?', [guestId]);
    return rows.map((r) => r.achievement_id);
  }

  async achievementsUnlockBatch(guestId, ids) {
    const unlocked = [];
    if (!ids.length) return unlocked;
    if (!this.pool) {
      const set = this.m.achievements.get(guestId) || new Set();
      for (const id of ids) {
        if (!set.has(id)) { set.add(id); unlocked.push(id); }
      }
      this.m.achievements.set(guestId, set);
      return unlocked;
    }
    for (const id of ids) {
      const [res] = await this.pool.execute('INSERT IGNORE INTO player_achievements (guest_id, achievement_id) VALUES (?, ?)', [guestId, id]);
      if (res.affectedRows > 0) unlocked.push(id);
    }
    return unlocked;
  }

  // ---------- blocks & reports ----------

  async blockSet(blocker, blocked) {
    if (!this.pool) {
      const set = this.m.blocks.get(blocker) || new Set();
      set.add(blocked);
      this.m.blocks.set(blocker, set);
      return;
    }
    await this.pool.execute('INSERT IGNORE INTO player_blocks (blocker_guest_id, blocked_guest_id) VALUES (?, ?)', [blocker, blocked]);
  }

  async blockClear(blocker, blocked) {
    if (!this.pool) {
      const set = this.m.blocks.get(blocker);
      if (set) set.delete(blocked);
      return;
    }
    await this.pool.execute('DELETE FROM player_blocks WHERE blocker_guest_id = ? AND blocked_guest_id = ?', [blocker, blocked]);
  }

  async blocksGet(blocker) {
    if (!this.pool) return [...(this.m.blocks.get(blocker) || [])];
    const [rows] = await this.pool.execute('SELECT blocked_guest_id FROM player_blocks WHERE blocker_guest_id = ?', [blocker]);
    return rows.map((r) => r.blocked_guest_id);
  }

  async reportCreate({ reporter, reported, reason, details }) {
    if (!this.pool) {
      const id = this.m.reportSeq++;
      this.m.reports.set(id, {
        id, reporter_guest_id: reporter, reported_guest_id: reported, reason, details,
        status: 'open', created_at: new Date(), reviewed_at: null,
      });
      return id;
    }
    const [res] = await this.pool.execute(
      'INSERT INTO player_reports (reporter_guest_id, reported_guest_id, reason, details) VALUES (?, ?, ?, ?)',
      [reporter, reported, reason, details],
    );
    return res.insertId;
  }

  async reportsList(status) {
    if (!this.pool) {
      let rows = [...this.m.reports.values()].sort((a, b) => b.id - a.id);
      if (status) rows = rows.filter((r) => r.status === status);
      return rows.slice(0, 200);
    }
    if (status) {
      const [rows] = await this.pool.execute('SELECT * FROM player_reports WHERE status = ? ORDER BY id DESC LIMIT 200', [status]);
      return rows;
    }
    const [rows] = await this.pool.query('SELECT * FROM player_reports ORDER BY id DESC LIMIT 200');
    return rows;
  }

  async reportSetStatus(id, status) {
    if (!this.pool) {
      const r = this.m.reports.get(id);
      if (r) { r.status = status; r.reviewed_at = new Date(); }
      return;
    }
    await this.pool.execute('UPDATE player_reports SET status = ?, reviewed_at = NOW() WHERE id = ?', [status, id]);
  }

  // ---------- voice preferences ----------

  async voicePrefsGet(guestId) {
    if (!this.pool) return this.m.voice.get(guestId) || null;
    const [rows] = await this.pool.execute(
      'SELECT enabled, push_to_talk AS pushToTalk, proximity, output_volume AS outputVolume FROM voice_preferences WHERE guest_id = ?',
      [guestId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      enabled: !!row.enabled,
      pushToTalk: !!row.pushToTalk,
      proximity: !!row.proximity,
      outputVolume: row.outputVolume == null ? 80 : Number(row.outputVolume),
    };
  }

  async voicePrefsSet(guestId, prefs) {
    if (!this.pool) { this.m.voice.set(guestId, { ...prefs }); return; }
    await this.pool.execute(
      `INSERT INTO voice_preferences (guest_id, enabled, push_to_talk, proximity, output_volume)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), push_to_talk = VALUES(push_to_talk),
         proximity = VALUES(proximity), output_volume = VALUES(output_volume)`,
      [guestId, prefs.enabled ? 1 : 0, prefs.pushToTalk ? 1 : 0, prefs.proximity ? 1 : 0, prefs.outputVolume | 0],
    );
  }

  // ---------- audit ----------

  async auditLog({ actor, action, target, details }) {
    if (!this.pool) {
      this.m.audit.unshift({ id: this.m.audit.length + 1, actor, action, target_guest_id: target || null, details: String(details || '').slice(0, 500), created_at: new Date() });
      if (this.m.audit.length > 1000) this.m.audit.length = 1000;
      return;
    }
    await this.pool.execute(
      'INSERT INTO audit_logs (actor, action, target_guest_id, details) VALUES (?, ?, ?, ?)',
      [actor, action, target || null, String(details || '').slice(0, 500)],
    );
  }

  async auditList({ action, limit, offset }) {
    if (!this.pool) {
      let rows = this.m.audit;
      if (action) rows = rows.filter((r) => r.action === action);
      return rows.slice(offset, offset + limit);
    }
    if (action) {
      const [rows] = await this.pool.execute('SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?', [action, limit, offset]);
      return rows;
    }
    const [rows] = await this.pool.execute('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
    return rows;
  }

  // ---------- retention ----------

  async cleanup(retentionDays) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000);
    if (!this.pool) {
      let guests = 0;
      for (const [id, g] of this.m.guests) {
        if (g.last_seen_at < cutoff) {
          guests++;
          this.m.guests.delete(id);
          this.m.stats.delete(id);
          this.m.skins.delete(id);
          this.m.heads.delete(id);
          this.m.achievements.delete(id);
          this.m.blocks.delete(id);
          this.m.voice.delete(id);
        }
      }
      let sessions = 0;
      for (const [k, s] of this.m.sessions) {
        if (s.expires_at.getTime() < Date.now() - 86400000) { this.m.sessions.delete(k); sessions++; }
      }
      return { guests, sessions };
    }
    const [s] = await this.pool.execute('DELETE FROM player_sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
    const [g] = await this.pool.execute('DELETE FROM guest_players WHERE last_seen_at < ?', [cutoff]);
    return { guests: g.affectedRows, sessions: s.affectedRows };
  }
}

function weekKey() {
  const now = new Date();
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - day);
  return monday.toISOString().slice(0, 10);
}

module.exports = { db: new DB(), weekKey, ACHIEVEMENT_IDS };
