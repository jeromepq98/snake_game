'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const log = require('./utils/logger');
const { db } = require('./db');
const { GuestService } = require('./services/guest');
const { StatsService } = require('./services/stats');
const { ModerationService } = require('./services/moderation');
const { MetricsService } = require('./services/metrics');
const { RoomManager } = require('./game/rooms');
const { setupSockets } = require('./sockets');
const { buildApiRouter } = require('./http/routes');
const { buildAdminRouter } = require('./http/admin');
const C = require('./game/constants');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Never die silently: log unexpected failures with a stack, then let the
// platform supervisor (Render) restart a crashed instance.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception:', err && err.stack ? err.stack : err);
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "connect-src 'self' https: wss: ws:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

async function main() {
  await db.init();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(self)');
    res.setHeader('Content-Security-Policy', CSP);
    next();
  });

  const metrics = new MetricsService();
  const guests = new GuestService(db, config);
  const stats = new StatsService(db, guests);

  const server = http.createServer(app);
  const io = new Server(server, {
    perMessageDeflate: { threshold: 1024 },
    maxHttpBufferSize: 256 * 1024,
    pingInterval: 20000,
    pingTimeout: 25000,
  });

  const manager = new RoomManager({ io, stats, guests, config });
  const moderation = new ModerationService(db, guests, manager);

  app.use('/api', buildApiRouter({ db, manager, guests, config }));
  app.use('/api/admin', buildAdminRouter({ config, metrics, db, manager, guests, moderation }));

  app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (req.path.startsWith('/icons/')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else if (req.path.startsWith('/css/') || req.path.startsWith('/js/')) {
      // Revalidate so code updates reach clients immediately (ETag handles 304s).
      res.setHeader('Cache-Control', 'no-cache');
    }
    next();
  });
  app.use(express.static(PUBLIC_DIR));

  // SPA-ish fallbacks
  app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  app.get('/offline.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'offline.html')));
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  setupSockets(io, { guests, stats, moderation, manager, config, db });

  // One global loop drives every room engine at the game tick rate.
  const ticker = setInterval(() => {
    try {
      manager.tickAll();
    } catch (err) {
      log.error('tick error:', err.message);
    }
  }, C.TICK_MS);

  metrics.start();

  // Retention: purge expired sessions and stale guest records periodically.
  const cleanup = setInterval(() => {
    db.cleanup(config.retentionDays)
      .then(({ guests: g, sessions: s }) => {
        if (g || s) log.info(`retention cleanup: ${g} guest(s), ${s} session(s) removed`);
      })
      .catch((e) => log.error('cleanup failed:', e.message));
  }, 6 * 3600 * 1000);
  setTimeout(() => {
    db.cleanup(config.retentionDays).catch(() => {});
  }, 10 * 60 * 1000);

  const shutdown = async (signal) => {
    log.info(`${signal} received — shutting down`);
    clearInterval(ticker);
    clearInterval(cleanup);
    try {
      await manager.closeAll(); // final stats flush for every room
    } catch { /* best effort */ }
    io.close();
    await db.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(config.port, () => {
    const shown = config.adminToken ? 'enabled' : 'disabled (set ADMIN_TOKEN)';
    log.info('');
    log.info('  Snake Arena — nickname-only multiplayer');
    log.info(`  http://localhost:${config.port}`);
    log.info(`  storage: ${db.mode === 'mysql' ? 'MySQL' : 'in-memory (no DATABASE_URL)'}`);
    log.info(`  admin dashboard: /admin (${shown})`);
    log.info('');
  });
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
