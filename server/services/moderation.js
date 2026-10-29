'use strict';

const REPORT_REASONS = new Set(['spam', 'cheating', 'abuse', 'voice', 'inappropriate', 'other']);

class ModerationService {
  constructor(db, guests, roomManager) {
    this.db = db;
    this.guests = guests;
    this.roomManager = roomManager;
  }

  async report(socket, data) {
    data = (typeof data === 'object' && data) || {};
    const reporter = socket.data.guestId;
    const reported = String(data.targetGuestId || '');
    const reason = String(data.reason || 'other');
    const details = String(data.details || '').slice(0, 500);
    if (!/^g_[a-f0-9]{8,32}$/.test(reported)) return { ok: false, error: 'invalid_target' };
    if (!REPORT_REASONS.has(reason)) return { ok: false, error: 'invalid_reason' };
    if (reported === reporter) return { ok: false, error: 'self_report' };
    await this.db.reportCreate({ reporter, reported, reason, details });
    await this.db.auditLog({ actor: reporter, action: 'report_created', target: reported, details: `${reason}: ${details}` });
    return { ok: true };
  }

  async block(socket, data) {
    const target = String((data && data.targetGuestId) || '');
    if (!/^g_[a-f0-9]{8,32}$/.test(target)) return { ok: false, error: 'invalid_target' };
    await this.db.blockSet(socket.data.guestId, target);
    if (socket.data.blocks) socket.data.blocks.add(target);
    this.refreshVoicePeers(socket);
    return { ok: true };
  }

  async unblock(socket, data) {
    const target = String((data && data.targetGuestId) || '');
    if (!/^g_[a-f0-9]{8,32}$/.test(target)) return { ok: false, error: 'invalid_target' };
    await this.db.blockClear(socket.data.guestId, target);
    if (socket.data.blocks) socket.data.blocks.delete(target);
    this.refreshVoicePeers(socket);
    return { ok: true };
  }

  // Blocks also silence existing WebRTC calls: drop the pair from both peers'
  // lists so the clients tear the connection down.
  refreshVoicePeers(socket) {
    const room = socket.data.roomId ? this.roomManager.get(socket.data.roomId) : null;
    if (room && room.voice.size) room.broadcastVoicePeers();
  }

  async kick(guestId, { reason = '', banMinutes = 0, actor = 'admin' } = {}) {
    if (!/^g_[a-f0-9]{8,32}$/.test(String(guestId))) return { ok: false, error: 'invalid_guest' };
    if (banMinutes > 0) {
      await this.db.banCreate({ guestId, reason, minutes: banMinutes, by: actor });
    }
    const socket = this.guests.getSocket(guestId);
    if (socket) {
      const room = socket.data.roomId ? this.roomManager.get(socket.data.roomId) : null;
      if (room) room.removeMember(guestId, banMinutes > 0 ? 'banned' : 'kicked');
      socket.emit('kicked', { reason, until: banMinutes > 0 ? new Date(Date.now() + banMinutes * 60000) : null });
      socket.data.kicked = true;
      socket.data.roomId = null;
      socket.data.pid = null;
      if (socket.data.session) socket.data.session.roomId = null;
      this.db.sessionUpdate(socket.data.tokenHash, { roomId: null, playerId: null }).catch(() => {});
      socket.disconnect(true);
    }
    await this.db.auditLog({
      actor, action: banMinutes > 0 ? 'ban' : 'kick', target: guestId,
      details: `reason=${reason || 'unspecified'}${banMinutes > 0 ? ` minutes=${banMinutes}` : ''}`,
    });
    return { ok: true };
  }

  async unban(banId, actor = 'admin') {
    await this.db.banLift(banId);
    await this.db.auditLog({ actor, action: 'unban', target: null, details: `ban_id=${banId}` });
    return { ok: true };
  }

  // Active players overview for the admin dashboard (no IPs, no tokens).
  activePlayers() {
    const out = [];
    if (!this.roomManager) return out;
    for (const room of this.roomManager.rooms.values()) {
      for (const m of room.members.values()) {
        out.push({
          guestId: m.guestId,
          nickname: m.nickname,
          room: room.code ? `code:${room.code}` : room.id,
          mode: room.mode.id,
          map: room.map.id,
          spectate: !!m.spectate,
          voice: !!m.voiceOn,
          hasHead: !!m.head,
          connectedAt: m.joined,
        });
      }
    }
    return out;
  }
}

module.exports = { ModerationService, REPORT_REASONS };
