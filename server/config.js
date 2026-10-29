'use strict';

require('dotenv').config();

const fs = require('fs');

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function parseIceServers(raw) {
  const fallback = [{ urls: ['stun:stun.l.google.com:19302'] }];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return fallback;
  }
}

function parseDb() {
  const url = process.env.DATABASE_URL;
  if (!url || !url.trim()) return { enabled: false };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { enabled: false, error: 'invalid DATABASE_URL' };
  }
  const q = u.searchParams;
  const sslParam = String(q.get('ssl') || q.get('ssl-mode') || '').toLowerCase();
  const aivenHost = /(aivencloud\.com|aiven\.io)$/i.test(u.hostname || '');
  const wantSsl = ['1', 'true', 'required', 'verify-identity'].includes(sslParam)
    || bool(process.env.DB_SSL, false)
    || aivenHost;
  // mysql2 treats unknown query params as connection options; ssl-mode is an
  // Aiven URI convention, not a mysql2 option, so strip it (TLS is set below).
  const clean = new URL(url);
  clean.searchParams.delete('ssl');
  clean.searchParams.delete('ssl-mode');
  let ca = process.env.DB_CA || process.env.DATABASE_CA || '';
  if (ca.startsWith('@')) {
    try {
      ca = fs.readFileSync(ca.slice(1), 'utf8');
    } catch {
      console.warn('[config] DB_CA file unreadable; falling back to system CAs');
      ca = '';
    }
  }
  return { enabled: true, url: clean.toString(), host: u.hostname, database: u.pathname.replace(/^\//, ''), ssl: wantSsl, ca };
}

const config = {
  port: int(process.env.PORT, 3000),
  env: process.env.NODE_ENV || 'development',
  trustProxy: bool(process.env.TRUST_PROXY, false),
  appSecret: process.env.APP_SECRET || 'dev-insecure-secret-change-me',
  adminToken: process.env.ADMIN_TOKEN || '',
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 168),
  retentionDays: int(process.env.RETENTION_DAYS, 30),
  maxPlayersPerRoom: int(process.env.MAX_PLAYERS_PER_ROOM, 20),
  maxSpectatorsPerRoom: int(process.env.MAX_SPECTATORS_PER_ROOM, 50),
  voiceCap: int(process.env.VOICE_CAP, 8),
  db: parseDb(),
  iceServers: parseIceServers(process.env.ICE_SERVERS),
};

if (config.env === 'production' && !process.env.APP_SECRET) {
  console.warn('[config] APP_SECRET is not set — session tokens will use an insecure default');
}

module.exports = config;
