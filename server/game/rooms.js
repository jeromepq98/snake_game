'use strict';

const { Engine } = require('./engine');
const C = require('./constants');
const { getMap, DEFAULT_MAP_ID } = require('./maps');
const log = require('../utils/logger');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CLOSE_EMPTY_MS = 60000;
const VOICE_PROXIMITY_TICK_MS = 1000;

function randomCode(len = 5) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

class Room {
  constructor({ id, code, mode, map, io, stats, guests, config, onEmpty }) {
    this.id = id;
    this.code = code || null;
    this.mode = mode;
    this.map = map;
    this.io = io;
    this.stats = stats;
    this.guests = guests;
    this.config = config;
    this.onEmpty = onEmpty || (() => {});
    this.engine = new Engine({ map, mode, onEvent: (ev) => this.onEngineEvent(ev) });
    this.members = new Map(); // guestId -> member
    this.matchId = null;
    this.roundMatchId = null;
    this.statsLast = new Map();
    this.leftRows = [];
    this.lastFlush = Date.now();
    this.emptySince = null;
    this.created = Date.now();
    this.closed = false;
    this.graceTimers = new Map(); // guestId -> timeout
    this.voice = new Map(); // voiceId -> { guestId, nickname, socket, proximity }
    this.proximityTimer = null;
    this.tickMod = 0;
  }

  playerCount() {
    let n = 0;
    for (const m of this.members.values()) if (!m.spectate) n++;
    return n;
  }

  spectatorCount() {
    let n = 0;
    for (const m of this.members.values()) if (m.spectate) n++;
    return n;
  }

  hasCapacity() {
    return this.playerCount() < this.config.maxPlayersPerRoom;
  }

  hasSpectatorCapacity() {
    return this.spectatorCount() < this.config.maxSpectatorsPerRoom;
  }

  uniqueNickname(nick, exceptGuestId = null) {
    const taken = new Set();
    for (const m of this.members.values()) {
      if (m.guestId !== exceptGuestId) taken.add(m.nickname);
    }
    if (!taken.has(nick)) return nick;
    for (let i = 2; i < 100; i++) {
      const cand = `${nick}#${i}`;
      if (!taken.has(cand)) return cand;
    }
    return `${nick}#${Date.now() % 1000}`;
  }

  async addPlayer(socket, { guestId, nickname, skin, head }) {
    if (this.closed) return { ok: false, error: 'room_closed' };
    if (this.members.has(guestId)) return { ok: false, error: 'already_in_room' };
    if (!this.hasCapacity()) return { ok: false, error: 'room_full' };
    const nick = this.uniqueNickname(nickname);
    const snake = this.engine.addSnake({ guestId, nickname: nick, skin });
    if (!snake) return { ok: false, error: 'spawn_failed' };
    const prior = this.stats.takePrior(this, guestId);
    if (prior) {
      snake.totalKills = prior.kills;
      snake.totalDeaths = prior.deaths;
      snake.totalSurvivedMs = prior.survivedMs;
      snake.totalWins = prior.wins;
    }
    this.clearGrace(guestId);
    this.members.set(guestId, {
      guestId, pid: snake.pid, nickname: nick, socket, spectate: false,
      voiceOn: false, proximity: false, head: head || null, joined: Date.now(),
    });
    socket.join(this.id);
    socket.data.roomId = this.id;
    socket.data.pid = snake.pid;
    this.emptySince = null;
    if (this.mode.id === 'arena') await this.stats.ensureMatch(this);
    this.broadcastPlayers();
    return { ok: true, pid: snake.pid, nickname: nick };
  }

  addSpectator(socket, { guestId, nickname }) {
    if (this.closed) return { ok: false, error: 'room_closed' };
    if (this.members.has(guestId)) return { ok: false, error: 'already_in_room' };
    if (!this.hasSpectatorCapacity()) return { ok: false, error: 'spectators_full' };
    const nick = this.uniqueNickname(nickname);
    this.clearGrace(guestId);
    this.members.set(guestId, {
      guestId, pid: null, nickname: nick, socket, spectate: true,
      voiceOn: false, proximity: false, joined: Date.now(),
    });
    socket.join(this.id);
    socket.data.roomId = this.id;
    socket.data.pid = null;
    this.emptySince = null;
    this.broadcastPlayers();
    return { ok: true, nickname: nick };
  }

  // A player who is still within the reconnect grace window can resume.
  canResume(guestId) {
    const member = this.members.get(guestId);
    if (!member || member.spectate || !member.pid) return false;
    const snake = this.engine.getSnake(member.pid);
    if (!snake || snake.eliminated) return false;
    return true;
  }

  // A round-mode player killed this round keeps its membership so the next
  // round revives it, but it must not spawn a second snake in the meantime.
  isEliminatedMember(guestId) {
    const member = this.members.get(guestId);
    if (!member || member.spectate || !member.pid) return false;
    const snake = this.engine.getSnake(member.pid);
    return !!(snake && snake.eliminated);
  }

  renameMember(guestId, nickname) {
    const member = this.members.get(guestId);
    if (!member) return;
    member.nickname = nickname;
    if (member.pid) {
      const snake = this.engine.getSnake(member.pid);
      if (snake) snake.nickname = nickname;
    }
    for (const v of this.voice.values()) {
      if (v.guestId === guestId) v.nickname = nickname;
    }
    this.broadcastPlayers();
    if (this.voice.size) this.broadcastVoicePeers();
  }

  setMemberHead(guestId, version) {
    const member = this.members.get(guestId);
    if (!member) return;
    member.head = version || null;
    this.broadcastPlayers();
  }

  playerInfos() {
    const infos = this.engine.playerInfos();
    for (const info of infos) {
      const member = this.members.get(info.guestId);
      info.head = member && member.head ? member.head : null;
    }
    return infos;
  }

  roundState() {
    if (this.mode.id !== 'round') return null;
    const r = this.engine.round;
    const out = { phase: r.phase, number: r.number };
    if (r.phase === 'running') out.endsInMs = Math.max(0, (r.endTick - this.engine.tick) * C.TICK_MS);
    else if (r.phase === 'intermission') out.nextInMs = Math.max(0, (r.intermissionEndTick - this.engine.tick) * C.TICK_MS);
    return out;
  }

  rebind(socket) {
    const guestId = socket.data.guestId;
    const member = this.members.get(guestId);
    if (!member) return null;
    this.clearGrace(guestId);
    this.emptySince = null;
    member.socket = socket;
    if (socket.data.head !== undefined) member.head = socket.data.head || null;
    socket.join(this.id);
    socket.data.roomId = this.id;
    socket.data.pid = member.pid;
    for (const v of this.voice.values()) {
      if (v.guestId === guestId) v.socket = socket;
    }
    if (member.pid) this.engine.setDisconnected(member.pid, false);
    this.broadcastPlayers();
    return member;
  }

  removeSocket(socket, { explicit = false } = {}) {
    const guestId = socket.data.guestId;
    const member = this.members.get(guestId);
    if (!member) return;
    // A replaced connection must not freeze/evict the newer socket's member.
    if (member.socket && member.socket.id !== socket.id) return;
    if (member.spectate || explicit) {
      this.removeMember(guestId, explicit ? 'left' : 'left');
      return;
    }
    // Player: freeze the snake and hold it for the reconnect grace period.
    if (member.pid) this.engine.setDisconnected(member.pid, true);
    this.clearGrace(guestId);
    this.graceTimers.set(guestId, setTimeout(() => {
      this.graceTimers.delete(guestId);
      this.removeMember(guestId, 'left');
    }, C.DISCONNECT_GRACE_MS));
    this.broadcastPlayers();
    if (this.noConnectedSockets()) this.emptySince = Date.now();
  }

  clearGrace(guestId) {
    const t = this.graceTimers.get(guestId);
    if (t) { clearTimeout(t); this.graceTimers.delete(guestId); }
  }

  removeMember(guestId, cause) {
    const member = this.members.get(guestId);
    if (!member) return;
    this.clearGrace(guestId);
    if (!member.spectate && member.pid) {
      this.stats.recordLeave(this, guestId);
      this.engine.removePlayer(member.pid, cause);
    }
    if (this.voice.size) this.voiceStopForMember(guestId);
    this.members.delete(guestId);
    if (member.socket) {
      if (member.socket.connected) member.socket.leave(this.id);
      member.socket.data.roomId = null;
      member.socket.data.pid = null;
    }
    this.broadcastPlayers();
    if (this.members.size === 0) this.emptySince = Date.now();
  }

  noConnectedSockets() {
    for (const m of this.members.values()) {
      if (m.socket && m.socket.connected) return false;
    }
    return true;
  }

  mapInfo() {
    const { id, name, w, h, wrap, obstacles, water, coastline, islands, labels, theme } = this.map;
    return { id, name, w, h, wrap, obstacles, water, coastline, islands, labels, theme };
  }

  onEngineEvent(ev) {
    if (this.closed) return;
    if (ev.type === 'death') {
      const victimMember = [...this.members.values()].find((m) => m.pid === ev.pid);
      const killer = ev.killerPid ? this.engine.getSnake(ev.killerPid) : null;
      this.io.to(this.id).emit('game:kill', {
        victim: { pid: ev.pid, nickname: ev.nickname },
        killer: killer ? { pid: killer.pid, nickname: killer.nickname } : null,
        cause: ev.cause,
      });
      if (victimMember && victimMember.socket && victimMember.socket.connected) {
        victimMember.socket.emit('game:death', {
          pid: ev.pid,
          respawnIn: this.mode.respawn ? C.RESPAWN_MS : null,
          score: ev.score,
          survivedMs: ev.lifeMs,
        });
      }
    } else if (ev.type === 'respawn') {
      this.io.to(this.id).emit('game:respawn', { pid: ev.pid });
    } else if (ev.type === 'roundStart') {
      this.io.to(this.id).emit('game:round', {
        phase: 'running', number: ev.number, endsInMs: Math.max(0, (ev.endTick - this.engine.tick) * C.TICK_MS),
      });
      if (this.mode.id === 'round') this.stats.ensureRoundMatch(this);
    } else if (ev.type === 'roundEnd') {
      this.io.to(this.id).emit('game:round', {
        phase: 'intermission', number: ev.number,
        winners: ev.winners,
        standings: ev.standings.slice(0, 10),
        nextInMs: this.mode.intermissionSeconds * 1000,
      });
      if (this.mode.id === 'round') this.stats.roundFlush(this, ev);
    }
  }

  tick() {
    if (this.closed) return;
    this.engine.step();
    this.io.to(this.id).emit('game:state', this.engine.snapshot());
    this.tickMod++;
    if (this.tickMod % 5 === 0) this.broadcastPlayers();
    if (this.mode.id === 'arena' && this.stats.shouldFlush(this) && this.playerCount() > 0) {
      this.stats.flush(this, { final: false }).catch(() => {});
    }
    if (this.emptySince && Date.now() - this.emptySince > ROOM_CLOSE_EMPTY_MS) {
      this.close().catch((e) => log.error(`room close failed: ${e.message}`));
    }
    if (this.voice.size) this.updateProximity();
  }

  broadcastPlayers() {
    const players = this.playerInfos();
    this.io.to(this.id).emit('game:players', {
      players,
      spectators: this.spectatorCount(),
      roomCode: this.code,
      mode: this.mode.id,
      map: this.map.id,
    });
  }

  chat(member, text) {
    for (const m of this.members.values()) {
      if (!m.socket || !m.socket.connected) continue;
      // Blocked players' messages are not delivered to the blocker.
      if (m.socket.data.blocks && m.socket.data.blocks.has(member.guestId)) continue;
      m.socket.emit('chat:message', {
        pid: member.pid, nickname: member.nickname, text, ts: Date.now(),
      });
    }
  }

  // ---------- voice (WebRTC signaling only; audio never passes through here) ----------

  voiceIdForMember(member) {
    return member.pid ? `p${member.pid}` : `s${member.guestId}`;
  }

  voiceStart(member) {
    const id = this.voiceIdForMember(member);
    if (!this.voice.has(id) && this.voice.size >= this.config.voiceCap) {
      return { ok: false, error: 'voice_full', message: `Voice chat is limited to ${this.config.voiceCap} players per room.` };
    }
    this.voice.set(id, { guestId: member.guestId, nickname: member.nickname, socket: member.socket, proximity: !!member.proximity });
    member.voiceOn = true;
    this.broadcastVoicePeers();
    return { ok: true, id };
  }

  voiceStopForMember(guestId) {
    for (const [id, v] of this.voice) {
      if (v.guestId === guestId) {
        this.voice.delete(id);
        const m = this.members.get(guestId);
        if (m) m.voiceOn = false;
      }
    }
    this.broadcastVoicePeers();
  }

  voiceStop(socket) {
    const member = this.members.get(socket.data.guestId);
    if (member) member.voiceOn = false;
    this.voiceStopForMember(socket.data.guestId);
    return { ok: true };
  }

  broadcastVoicePeers() {
    if (!this.voice.size) return;
    const peers = [...this.voice.entries()].map(([id, v]) => ({ id, nickname: v.nickname, guestId: v.guestId }));
    const blocksOf = new Map();
    for (const v of this.voice.values()) {
      if (v.socket && v.socket.data.blocks) blocksOf.set(v.guestId, v.socket.data.blocks);
    }
    for (const [id, v] of this.voice) {
      if (!v.socket || !v.socket.connected) continue;
      const mine = blocksOf.get(v.guestId);
      const visible = peers.filter((p) => {
        if (p.id === id) return false;
        const theirs = blocksOf.get(p.guestId);
        return !(mine && mine.has(p.guestId)) && !(theirs && theirs.has(v.guestId));
      });
      v.socket.emit('voice:peers', { you: id, peers: visible });
    }
  }

  voiceSignal(socket, data) {
    data = (typeof data === 'object' && data) || {};
    const member = this.members.get(socket.data.guestId);
    if (!member || !member.voiceOn) return { ok: false, error: 'not_in_voice' };
    const fromId = this.voiceIdForMember(member);
    const target = this.voice.get(String(data.to || ''));
    if (!target) return { ok: false, error: 'no_target' };
    const mine = member.socket && member.socket.data.blocks;
    const theirs = target.socket && target.socket.data.blocks;
    if ((mine && mine.has(target.guestId)) || (theirs && theirs.has(member.guestId))) {
      return { ok: false, error: 'blocked' };
    }
    const kind = String(data.kind || '');
    if (!['offer', 'answer', 'ice'].includes(kind)) return { ok: false, error: 'bad_kind' };
    const payload = data.data === undefined ? null : data.data;
    if (payload && JSON.stringify(payload).length > 16384) return { ok: false, error: 'too_large' };
    if (target.socket && target.socket.connected) {
      target.socket.emit('voice:signal', { from: fromId, kind, data: payload });
    }
    return { ok: true };
  }

  voiceSetProximity(socket, on) {
    const member = this.members.get(socket.data.guestId);
    if (!member) return { ok: false };
    member.proximity = !!on;
    const id = this.voiceIdForMember(member);
    const v = this.voice.get(id);
    if (v) v.proximity = !!on;
    return { ok: true };
  }

  updateProximity() {
    let any = false;
    for (const v of this.voice.values()) if (v.proximity) any = true;
    if (!any) return;
    const positions = new Map(); // voiceId -> head cell
    for (const [id, v] of this.voice) {
      const member = this.members.get(v.guestId);
      if (member && member.pid) {
        const snake = this.engine.getSnake(member.pid);
        if (snake && snake.segs.length) positions.set(id, snake.segs[0]);
      }
    }
    for (const [id, v] of this.voice) {
      if (!v.proximity || !v.socket || !v.socket.connected) continue;
      const me = positions.get(id);
      const ids = [];
      for (const [otherId, pos] of positions) {
        if (otherId === id) { ids.push(otherId); continue; }
        if (!me) { ids.push(otherId); continue; }
        const d = Math.max(Math.abs(me.x - pos.x), Math.abs(me.y - pos.y));
        if (d <= C.VOICE_PROXIMITY_RADIUS) ids.push(otherId);
      }
      v.socket.emit('voice:proximity', { ids });
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    await this.stats.flush(this, { final: true }).catch((e) => log.error(`final flush failed: ${e.message}`));
    this.io.to(this.id).emit('game:closed');
    this.onEmpty(this);
  }
}

class RoomManager {
  constructor({ io, stats, guests, config }) {
    this.io = io;
    this.stats = stats;
    this.guests = guests;
    this.config = config;
    this.rooms = new Map();
    this.byCode = new Map();
    this.seq = 1;
  }

  createRoom({ mode, map, code }) {
    const id = `r${this.seq++}`;
    const room = new Room({
      id, code, mode, map, io: this.io, stats: this.stats, guests: this.guests, config: this.config,
      onEmpty: (r) => {
        this.rooms.delete(r.id);
        if (r.code) this.byCode.delete(r.code);
      },
    });
    this.rooms.set(id, room);
    if (code) this.byCode.set(code, room);
    return room;
  }

  findPublic(modeId, mapId) {
    const mode = C.MODES.find((m) => m.id === modeId) || C.MODES[0];
    const map = getMap(mapId) || getMap(DEFAULT_MAP_ID);
    for (const room of this.rooms.values()) {
      if (room.code) continue;
      if (room.mode.id !== mode.id || room.map.id !== map.id) continue;
      if (room.hasCapacity()) return room;
    }
    return this.createRoom({ mode, map, code: null });
  }

  findByCode(code) {
    return this.byCode.get(code) || null;
  }

  get(roomId) {
    return this.rooms.get(roomId) || null;
  }

  newCode() {
    for (let i = 0; i < 50; i++) {
      const code = randomCode();
      if (!this.byCode.has(code)) return code;
    }
    return randomCode(6);
  }

  tickAll() {
    for (const room of [...this.rooms.values()]) {
      room.tick();
    }
  }

  counts() {
    let players = 0;
    let spectators = 0;
    const byMode = {};
    for (const m of C.MODES) byMode[m.id] = { players: 0, rooms: 0 };
    for (const room of this.rooms.values()) {
      const pc = room.playerCount();
      players += pc;
      spectators += room.spectatorCount();
      if (byMode[room.mode.id]) { byMode[room.mode.id].players += pc; byMode[room.mode.id].rooms += 1; }
    }
    return { players, spectators, rooms: this.rooms.size, byMode };
  }

  async closeAll() {
    for (const room of this.rooms.values()) {
      await room.close().catch(() => {});
    }
  }
}

module.exports = { RoomManager, Room };
