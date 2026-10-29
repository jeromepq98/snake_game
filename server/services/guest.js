'use strict';

const { randomToken, sha256 } = require('../utils/tokens');
const { validateNickname } = require('../utils/validate');
const { clientIp } = require('../utils/net');
const { SKINS } = require('../game/constants');
const log = require('../utils/logger');

const DEFAULT_SKINS = SKINS.filter((s) => !s.unlock).map((s) => s.id);

// Guest identity = opaque guest ID + session token. Nicknames are display only.
class GuestService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.socketsByGuest = new Map(); // guestId -> active socket
  }

  ipHash(ip) {
    return sha256(`${ip}|${this.config.appSecret}`);
  }

  async hello(socket, data) {
    data = (typeof data === 'object' && data) || {};
    // Returning player: session token is the only credential. A bare guestId is
    // never accepted as proof of identity (prevents impersonation).
    if (typeof data.token === 'string' && /^[a-f0-9]{32,128}$/.test(data.token)) {
      const tokenHash = sha256(data.token);
      const session = await this.db.sessionGet(tokenHash).catch(() => null);
      if (session) {
        const ban = await this.db.banActive(session.guest_id).catch(() => null);
        if (ban) {
          return { ok: false, error: 'banned', message: 'You are banned from this server.', until: ban.until, reason: ban.reason };
        }
        const guest = await this.db.guestGet(session.guest_id).catch(() => null);
        let nickname = guest ? guest.nickname : 'Guest';
        if (data.nickname !== undefined) {
          const v = validateNickname(data.nickname);
          if (v.ok && v.value !== nickname) {
            nickname = v.value;
            await this.db.guestRename(session.guest_id, nickname).catch(() => {});
          }
        }
        return this.bindSession(socket, session, tokenHash, nickname, {});
      }
      // invalid/expired token: fall through to new guest
    }

    const v = validateNickname(data.nickname);
    if (!v.ok) return { ok: false, error: 'invalid_nickname', message: v.reason };

    const guestId = `g_${randomToken(12)}`;
    const token = randomToken(32);
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 3600000);
    await this.db.ensureGuest(guestId, v.value).catch((e) => log.error('guestCreate failed:', e.message));
    await this.db.sessionCreate({
      tokenHash,
      guestId,
      ipHash: this.ipHash(clientIp(socket.handshake, this.config.trustProxy)),
      ua: socket.handshake.headers && socket.handshake.headers['user-agent'],
      expiresAt,
    }).catch((e) => log.error('sessionCreate failed:', e.message));
    return this.bindSession(socket, { token_hash: tokenHash, guest_id: guestId, room_id: null, player_id: null, expires_at: expiresAt }, tokenHash, v.value, { token, isNew: true });
  }

  async bindSession(socket, session, tokenHash, nickname, extra) {
    const guestId = session.guest_id;
    // One active socket per guest — replaces any previous connection.
    const prev = this.socketsByGuest.get(guestId);
    if (prev && prev.id !== socket.id && prev.connected) {
      prev.emit('session:replaced', { message: 'Your guest session was opened in another window.' });
      prev.disconnect(true);
      this.socketsByGuest.delete(guestId);
    }
    this.socketsByGuest.set(guestId, socket);
    socket.data.guestId = guestId;
    socket.data.tokenHash = tokenHash;
    socket.data.nickname = nickname;
    socket.data.session = { roomId: session.room_id, playerId: session.player_id, expiresAt: session.expires_at };
    socket.data.blocks = new Set(await this.db.blocksGet(guestId).catch(() => []) || []);

    const unlocked = await this.db.achievementsUnlocked(guestId).catch(() => []) || [];
    const unlockedSkins = await this.db.skinsGet(guestId).catch(() => []) || [];
    const voicePrefs = await this.db.voicePrefsGet(guestId).catch(() => null);
    const headMeta = await this.db.headMeta(guestId).catch(() => null);
    await this.db.guestTouch(guestId).catch(() => {});
    const skins = [...new Set([...DEFAULT_SKINS, ...unlockedSkins])];
    socket.data.skins = new Set(skins);
    socket.data.achievements = new Set(unlocked);
    socket.data.head = headMeta ? headMeta.version : null;

    return {
      ok: true,
      guestId,
      token: extra.token || undefined,
      nickname,
      achievements: unlocked,
      skins,
      head: headMeta ? { version: headMeta.version, updatedAt: headMeta.updated_at } : null,
      voicePrefs: voicePrefs || { enabled: true, pushToTalk: false, proximity: false, outputVolume: 80 },
      note: 'Nicknames are display names, not verified identities. Guest progress lives on this device only.',
    };
  }

  onSocketDisconnect(socket) {
    const guestId = socket.data.guestId;
    if (guestId && this.socketsByGuest.get(guestId) === socket) {
      this.socketsByGuest.delete(guestId);
    }
  }

  getSocket(guestId) {
    const s = this.socketsByGuest.get(guestId);
    return s && s.connected ? s : null;
  }

  async rename(socket, rawNickname, dedupeInRoom) {
    const v = validateNickname(rawNickname);
    if (!v.ok) return { ok: false, error: 'invalid_nickname', message: v.reason };
    const guestId = socket.data.guestId;
    let nickname = v.value;
    if (dedupeInRoom) nickname = dedupeInRoom(nickname);
    socket.data.nickname = nickname;
    await this.db.guestRename(guestId, nickname).catch(() => {});
    return { ok: true, nickname };
  }
}

module.exports = { GuestService, DEFAULT_SKINS };
