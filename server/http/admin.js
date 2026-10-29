'use strict';

const express = require('express');
const { safeEqual } = require('../utils/tokens');
const { globalBuckets } = require('../utils/ratelimit');
const log = require('../utils/logger');

const REPORT_STATUSES = new Set(['open', 'reviewed', 'actioned', 'dismissed']);

function buildAdminRouter({ config, metrics, db, manager, guests, moderation }) {
  const router = express.Router();
  const enabled = () => !!config.adminToken;
  // Express 4 does not forward rejected async handlers; without this a DB
  // failure would leave the admin's request hanging.
  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    log.error('admin route failed:', e.message);
    if (res.headersSent) return next(e);
    res.status(500).json({ error: 'server_error' });
  });

  router.post('/login', (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'admin_disabled', message: 'ADMIN_TOKEN is not configured on the server.' });
    const ip = req.ip || 'unknown';
    if (!globalBuckets.take(`adminlogin:${ip}`, 5, 0.05)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Wait a minute.' });
    }
    const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    if (!token || !safeEqual(token, config.adminToken)) {
      return res.status(401).json({ error: 'bad_token' });
    }
    res.json({ ok: true });
  });

  // Bearer-token guard for everything below.
  router.use((req, res, next) => {
    if (!enabled()) return res.status(503).json({ error: 'admin_disabled' });
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !safeEqual(token, config.adminToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  router.get('/metrics', async (req, res) => {
    const counts = manager.counts();
    const ping = await db.ping().catch(() => ({ ok: false, mode: 'down' }));
    let threads = null;
    if (db.pool) {
      try {
        const [rows] = await db.pool.query("SHOW STATUS LIKE 'Threads_connected'");
        threads = rows[0] ? Number(rows[0].Value) : null;
      } catch { /* non-fatal */ }
    }
    res.json({
      ...metrics.snapshot(),
      players: { online: counts.players, spectators: counts.spectators, rooms: counts.rooms },
      byMode: counts.byMode,
      db: { mode: db.mode, pingMs: ping.ms, ok: ping.ok, threads },
    });
  });

  router.get('/players', (req, res) => {
    res.json({ players: moderation.activePlayers() });
  });

  router.get('/rooms', (req, res) => {
    const rooms = [];
    for (const room of manager.rooms.values()) {
      rooms.push({
        id: room.id, code: room.code, mode: room.mode.id, map: room.map.id,
        players: room.playerCount(), spectators: room.spectatorCount(),
        voicePeers: room.voice.size, tick: room.engine.tick, created: room.created,
      });
    }
    res.json({ rooms });
  });

  router.get('/reports', async (req, res) => {
    const status = REPORT_STATUSES.has(req.query.status) ? req.query.status : null;
    try {
      res.json({ reports: await db.reportsList(status) });
    } catch {
      res.status(500).json({ error: 'db_error' });
    }
  });

  router.post('/reports/:id/status', route(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const status = req.body && req.body.status;
    if (!Number.isInteger(id) || !REPORT_STATUSES.has(status)) {
      return res.status(400).json({ error: 'bad_request' });
    }
    await db.reportSetStatus(id, status);
    await db.auditLog({ actor: 'admin', action: 'report_status', details: `report=${id} status=${status}` });
    res.json({ ok: true });
  }));

  router.get('/bans', async (req, res) => {
    try {
      res.json({ bans: await db.banList(req.query.active === '1') });
    } catch {
      res.status(500).json({ error: 'db_error' });
    }
  });

  router.post('/kick', route(async (req, res) => {
    const { guestId, reason, banMinutes } = req.body || {};
    const minutes = parseInt(banMinutes, 10) || 0;
    const result = await moderation.kick(String(guestId || ''), { reason: String(reason || '').slice(0, 200), banMinutes: minutes });
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true });
  }));

  router.post('/ban', route(async (req, res) => {
    const { guestId, reason, minutes } = req.body || {};
    const mins = parseInt(minutes, 10) || 0;
    const result = await moderation.kick(String(guestId || ''), { reason: String(reason || '').slice(0, 200), banMinutes: mins > 0 ? mins : 0 });
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true });
  }));

  router.post('/unban', route(async (req, res) => {
    const banId = parseInt(req.body && req.body.banId, 10);
    if (!Number.isInteger(banId)) return res.status(400).json({ error: 'bad_request' });
    await moderation.unban(banId);
    res.json({ ok: true });
  }));

  // Moderation: strip an offensive custom head picture without kicking the guest.
  router.post('/head/remove', route(async (req, res) => {
    const guestId = String((req.body && req.body.guestId) || '');
    if (!/^g_[a-f0-9]{24}$/.test(guestId)) return res.status(400).json({ error: 'bad_request' });
    await db.headDelete(guestId);
    await db.auditLog({ actor: 'admin', action: 'head_remove', target: guestId, details: 'moderation' });
    const socket = guests && guests.getSocket(guestId);
    if (socket) {
      socket.data.head = null;
      const room = socket.data.roomId ? manager.get(socket.data.roomId) : null;
      if (room) room.setMemberHead(guestId, null);
    }
    res.json({ ok: true });
  }));

  router.get('/audit', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    try {
      res.json({ entries: await db.auditList({ action: req.query.action || null, limit, offset }) });
    } catch {
      res.status(500).json({ error: 'db_error' });
    }
  });

  router.get('/suspicious', async (req, res) => {
    try {
      res.json({ entries: await db.suspiciousGet(50) });
    } catch {
      res.status(500).json({ error: 'db_error' });
    }
  });

  return router;
}

module.exports = { buildAdminRouter };
