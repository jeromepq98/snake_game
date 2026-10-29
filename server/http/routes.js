'use strict';

const express = require('express');
const C = require('../game/constants');
const { MAPS } = require('../game/maps');
const { randomNickname } = require('../utils/profanity');
const { randomToken, sha256 } = require('../utils/tokens');
const { globalBuckets } = require('../utils/ratelimit');
const { validatePng } = require('../utils/image');
const log = require('../utils/logger');

const GUEST_ID_RE = /^g_[a-f0-9]{24}$/;
const MAX_HEAD_BYTES = 256 * 1024;

function buildApiRouter({ db, manager, guests, config }) {
  const router = express.Router();
  // Express 4 does not forward rejected async handlers.
  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    log.error('api route failed:', e.message);
    if (res.headersSent) return next(e);
    res.status(500).json({ error: 'server_error' });
  });

  const sessionFor = async (req) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7).trim();
    if (!/^[a-f0-9]{32,128}$/.test(token)) return null;
    return db.sessionGet(sha256(token)).catch(() => null);
  };

  const banned = async (guestId) => !!(await db.banActive(guestId).catch(() => null));

  // Keep the live room roster and the guest's socket in sync with a head change.
  const refreshHead = (guestId, version) => {
    const socket = guests && guests.getSocket(guestId);
    if (!socket) return;
    socket.data.head = version;
    const room = socket.data.roomId ? manager.get(socket.data.roomId) : null;
    if (room) room.setMemberHead(guestId, version);
  };

  router.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      service: 'snake-arena',
      db: db.mode,
      uptime: Math.floor(process.uptime()),
      players: manager.counts().players,
      rooms: manager.counts().rooms,
    });
  });

  router.get('/config', (req, res) => {
    res.json({
      tickMs: C.TICK_MS,
      maxPlayers: config.maxPlayersPerRoom,
      voiceCap: config.voiceCap,
      modes: C.MODES,
      maps: MAPS.map(({ id, name, desc, w, h, wrap }) => ({ id, name, desc, w, h, wrap })),
      skins: C.SKINS,
      powerups: C.POWERUPS,
      achievements: C.ACHIEVEMENTS,
      iceServers: config.iceServers,
    });
  });

  router.get('/live', (req, res) => {
    res.json(manager.counts());
  });

  router.get('/leaderboard', async (req, res) => {
    const period = ['daily', 'weekly', 'alltime'].includes(req.query.period) ? req.query.period : 'alltime';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    try {
      const rows = await db.leaderboardGet(period, limit);
      res.json({
        period,
        entries: rows.map((r, i) => ({
          rank: i + 1,
          nickname: r.nickname,
          bestScore: r.best_score,
          kills: r.kills,
          wins: r.wins,
          matches: r.matches,
          suspicious: !!r.suspicious,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: 'leaderboard_unavailable' });
    }
  });

  router.get('/nickname/random', (req, res) => {
    res.json({ nickname: randomNickname() });
  });

  // ---------- custom snake heads ----------

  // Public, read-only image endpoint. Guest IDs are already visible in room
  // rosters, and the URL carries a version token for immutable caching.
  router.get('/head/:guestId', route(async (req, res) => {
    const guestId = req.params.guestId;
    if (!GUEST_ID_RE.test(guestId)) return res.status(404).json({ error: 'not_found' });
    const head = await db.headGet(guestId).catch(() => null);
    if (!head || !head.image) return res.status(404).json({ error: 'not_found' });

    const etag = `"h-${head.version}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'inline; filename="head.png"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const versioned = req.query.v === head.version;
    res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    if (req.headers['if-none-match'] && req.headers['if-none-match'].split(',').map((v) => v.trim()).includes(etag)) {
      return res.status(304).end();
    }
    res.end(head.image);
  }));

  router.get('/player/head', route(async (req, res) => {
    const session = await sessionFor(req);
    if (!session) return res.status(401).json({ error: 'unauthorized' });
    const meta = await db.headMeta(session.guest_id).catch(() => null);
    res.json({
      ok: true,
      head: meta ? { version: meta.version, updatedAt: meta.updated_at } : null,
    });
  }));

  const rawHead = express.raw({ type: ['image/png', 'application/octet-stream'], limit: MAX_HEAD_BYTES });
  const headIpLimit = (req, res, next) => {
    if (!globalBuckets.take(`headup-ip:${req.ip || 'unknown'}`, 20, 0.2)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many uploads. Wait a minute and try again.' });
    }
    next();
  };
  const parseHeadBody = (req, res, next) => {
    rawHead(req, res, (err) => {
      if (err) return res.status(413).json({ error: 'too_large', message: 'That image is too large. Pick a smaller picture.' });
      next();
    });
  };

  router.post('/player/head', headIpLimit, parseHeadBody, route(async (req, res) => {
    const session = await sessionFor(req);
    if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Your session expired. Reconnect and try again.' });
    const guestId = session.guest_id;
    if (await banned(guestId)) return res.status(403).json({ error: 'banned', message: 'Banned guests cannot change their snake head.' });
    if (!globalBuckets.take(`headup:${guestId}`, 5, 0.05)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many uploads. Wait a minute and try again.' });
    }
    if (!Buffer.isBuffer(req.body)) {
      return res.status(415).json({ error: 'unsupported_type', message: 'Send the picture as image/png.' });
    }
    const check = validatePng(req.body);
    if (!check.ok) {
      return res.status(400).json({ error: check.error, message: 'That file is not a valid PNG image. Try another picture.' });
    }
    const version = randomToken(8);
    try {
      await db.headSet(guestId, { image: req.body, mime: 'image/png', version });
    } catch (e) {
      log.error('head upload failed:', e.message);
      return res.status(500).json({ error: 'db_error', message: 'Could not save that picture. Try again.' });
    }
    await db.auditLog({
      actor: 'guest', action: 'head_set', target: guestId,
      details: `bytes=${req.body.length} size=${check.width}x${check.height}`,
    }).catch(() => {});
    refreshHead(guestId, version);
    res.json({ ok: true, head: { version, url: `/api/head/${guestId}?v=${version}` } });
  }));

  router.delete('/player/head', route(async (req, res) => {
    const session = await sessionFor(req);
    if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Your session expired. Reconnect and try again.' });
    const guestId = session.guest_id;
    if (!globalBuckets.take(`headdel:${guestId}`, 5, 0.05)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Wait a moment.' });
    }
    await db.headDelete(guestId);
    await db.auditLog({ actor: 'guest', action: 'head_clear', target: guestId, details: '' }).catch(() => {});
    refreshHead(guestId, null);
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { buildApiRouter };
