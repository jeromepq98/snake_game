'use strict';

const C = require('../game/constants');
const { getMap, DEFAULT_MAP_ID } = require('../game/maps');
const { validateNickname, validateRoomCode, validateChatText, cleanString, isInt } = require('../utils/validate');
const { filterText } = require('../utils/profanity');
const { limited, globalBuckets } = require('../utils/ratelimit');
const { clientIp } = require('../utils/net');
const log = require('../utils/logger');

const respond = (ack) => (typeof ack === 'function' ? ack : () => {});

const ELIMINATED_REPLY = {
  ok: false,
  error: 'eliminated',
  message: 'You were eliminated this round. Wait for the next round, then join again.',
};

function joinPayload(room, { resumed = false, spectating = false, pid = null, nickname }) {
  return {
    ok: true,
    resumed: !!resumed,
    spectating: !!spectating,
    roomId: room.id,
    roomCode: room.code,
    mode: room.mode.id,
    map: room.mapInfo(),
    tickMs: C.TICK_MS,
    you: { pid, nickname },
    players: room.playerInfos(),
    spectators: room.spectatorCount(),
    round: room.roundState(),
  };
}

function setupSockets(io, { guests, stats, moderation, manager, config, db }) {
  // Throttle connection attempts per IP.
  io.use((socket, next) => {
    const ip = clientIp(socket.handshake, config.trustProxy);
    if (!globalBuckets.take(`conn:${ip}`, 20, 2)) {
      return next(new Error('Too many connections. Wait a moment and retry.'));
    }
    next();
  });

  io.on('connection', (socket) => {
    socket.data.guestId = null;
    socket.data.roomId = null;
    socket.data.pid = null;

    const requireGuest = () => {
      if (!socket.data.guestId) {
        socket.emit('guest:error', { code: 'not_authenticated', message: 'Say hello first.' });
        return false;
      }
      return true;
    };

    const currentRoom = () => (socket.data.roomId ? manager.get(socket.data.roomId) : null);

    // ---------- guest session ----------

    socket.on('guest:hello', limited(5, 0.5, async (s, data, ack) => {
      const res = await guests.hello(s, data).catch((e) => {
        log.error('hello failed:', e.message);
        return { ok: false, error: 'server_error', message: 'Something went wrong. Try again.' };
      });
      respond(ack)(res);
      if (res.ok) log.info(`guest ${res.nickname} connected (${res.guestId.slice(0, 10)}…)`);
    }));

    socket.on('guest:nickname', limited(2, 0.03, async (s, data, ack) => {
      if (!requireGuest()) return respond(ack)({ ok: false, error: 'not_authenticated' });
      const room = currentRoom();
      const res = await guests.rename(s, data && data.nickname, room ? (n) => room.uniqueNickname(n, s.data.guestId) : null);
      respond(ack)(res);
      if (res.ok && room) room.renameMember(s.data.guestId, res.nickname);
    }));

    // ---------- joining ----------

    socket.on('game:join', limited(5, 0.5, async (s, data, ack) => {
      if (!requireGuest()) return respond(ack)({ ok: false, error: 'not_authenticated' });
      data = (typeof data === 'object' && data) || {};
      const guestId = s.data.guestId;

      // A socket that is still attached to a room must detach fully before any
      // new join. Otherwise the old room keeps a ghost member and this socket
      // stays subscribed to its events.
      const active = currentRoom();
      if (active) {
        const member = active.members.get(guestId);
        if (member) {
          if (active.canResume(guestId)) {
            const rebound = active.rebind(s);
            db.sessionUpdate(s.data.tokenHash, { roomId: active.id, playerId: rebound.pid }).catch(() => {});
            if (s.data.session) s.data.session.roomId = active.id;
            return respond(ack)(joinPayload(active, {
              resumed: true, pid: rebound.pid, nickname: rebound.nickname,
            }));
          }
          if (active.isEliminatedMember(guestId)) return respond(ack)(ELIMINATED_REPLY);
          active.removeMember(guestId, 'left');
        }
        s.data.roomId = null;
        s.data.pid = null;
        if (s.data.session) s.data.session.roomId = null;
        db.sessionUpdate(s.data.tokenHash, { roomId: null, playerId: null }).catch(() => {});
      }

      // Resume the stored room after a reload/reconnect (fresh socket).
      if (s.data.session && s.data.session.roomId) {
        const room = manager.get(s.data.session.roomId);
        if (room) {
          const member = room.members.get(guestId);
          if (member) {
            if (room.canResume(guestId)) {
              const rebound = room.rebind(s);
              db.sessionUpdate(s.data.tokenHash, { roomId: room.id, playerId: rebound.pid }).catch(() => {});
              s.data.session.roomId = room.id;
              return respond(ack)(joinPayload(room, {
                resumed: true, pid: rebound.pid, nickname: rebound.nickname,
              }));
            }
            if (room.isEliminatedMember(guestId)) return respond(ack)(ELIMINATED_REPLY);
            room.removeMember(guestId, 'left');
          }
        }
        s.data.session.roomId = null;
        db.sessionUpdate(s.data.tokenHash, { roomId: null, playerId: null }).catch(() => {});
      }

      const mode = C.MODES.find((m) => m.id === data.mode) || C.MODES[0];
      const map = getMap(data.map) || getMap(DEFAULT_MAP_ID);
      const spectate = !!data.spectate;

      let skin = 'emerald';
      if (data.skin && typeof data.skin === 'string') {
        const unlocked = new Set(s.data.skins || []);
        if (C.SKIN_IDS.includes(data.skin) && unlocked.has(data.skin)) skin = data.skin;
      }

      let room = null;
      if (data.roomCode && typeof data.roomCode === 'string') {
        const code = data.roomCode.trim().toUpperCase();
        if (!validateRoomCode(code)) return respond(ack)({ ok: false, error: 'invalid_code', message: 'Room codes are 4-6 letters/digits.' });
        room = manager.findByCode(code);
        if (!room) return respond(ack)({ ok: false, error: 'not_found', message: 'No room with that code.' });
      } else if (data.private === true) {
        room = manager.createRoom({ mode, map, code: manager.newCode() });
      } else {
        room = manager.findPublic(mode.id, map.id);
      }

      if (spectate) {
        const res = room.addSpectator(s, { guestId: s.data.guestId, nickname: s.data.nickname });
        if (!res.ok) return respond(ack)(res);
        db.sessionUpdate(s.data.tokenHash, { roomId: room.id, playerId: null }).catch(() => {});
        if (s.data.session) s.data.session.roomId = room.id;
        return respond(ack)(joinPayload(room, { spectating: true, nickname: res.nickname }));
      }

      if (!room.hasCapacity()) {
        return respond(ack)({ ok: false, error: 'room_full', message: 'That room is full. Try spectating or another room.' });
      }

      const res = await room.addPlayer(s, { guestId: s.data.guestId, nickname: s.data.nickname, skin, head: s.data.head });
      if (!res.ok) return respond(ack)(res);
      db.sessionUpdate(s.data.tokenHash, { roomId: room.id, playerId: res.pid }).catch(() => {});
      if (s.data.session) s.data.session.roomId = room.id;
      respond(ack)(joinPayload(room, { pid: res.pid, nickname: res.nickname }));
    }));

    // ---------- gameplay input (server-authoritative) ----------

    socket.on('game:input', limited(40, 10, (s, data) => {
      const room = currentRoom();
      if (!room || !s.data.pid) return;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'dir') {
        if (isInt(data.dir, 0, 3)) room.engine.input(s.data.pid, { type: 'dir', dir: data.dir });
      } else if (data.type === 'boost') {
        room.engine.input(s.data.pid, { type: 'boost', on: !!data.on });
      }
    }));

    socket.on('game:spectate', (data) => {
      // Client-side camera target selection; no server state needed.
    });

    socket.on('game:leave', limited(5, 0.5, async (s, data, ack) => {
      const room = currentRoom();
      if (room) {
        room.removeMember(s.data.guestId, 'left');
        db.sessionUpdate(s.data.tokenHash, { roomId: null, playerId: null }).catch(() => {});
        if (s.data.session) s.data.session.roomId = null;
      }
      respond(ack)({ ok: true });
    }));

    // ---------- chat ----------

    socket.on('chat:send', limited(5, 0.5, (s, data) => {
      const room = currentRoom();
      if (!room) return;
      const v = validateChatText(data && data.text);
      if (!v.ok) return;
      const filtered = filterText(v.value);
      if (filtered === null) {
        s.emit('chat:blocked', { message: 'Message blocked by the language filter.' });
        return;
      }
      const member = room.members.get(s.data.guestId);
      if (!member) return;
      room.chat(member, filtered);
    }));

    // ---------- voice chat signaling ----------

    socket.on('voice:start', limited(5, 0.5, (s, data, ack) => {
      const room = currentRoom();
      if (!room) return respond(ack)({ ok: false, error: 'not_in_room' });
      const member = room.members.get(s.data.guestId);
      if (!member) return respond(ack)({ ok: false, error: 'not_in_room' });
      respond(ack)(room.voiceStart(member));
    }));

    socket.on('voice:stop', limited(5, 0.5, (s, data, ack) => {
      const room = currentRoom();
      if (room) room.voiceStop(s);
      respond(ack)({ ok: true });
    }));

    socket.on('voice:signal', limited(120, 30, (s, data, ack) => {
      const room = currentRoom();
      if (!room) return respond(ack)({ ok: false, error: 'not_in_room' });
      respond(ack)(room.voiceSignal(s, data));
    }));

    socket.on('voice:mode', limited(10, 0.5, (s, data) => {
      const room = currentRoom();
      if (!room) return;
      room.voiceSetProximity(s, !!(data && data.proximity));
    }));

    // ---------- settings ----------

    socket.on('settings:voice', limited(10, 0.2, async (s, data, ack) => {
      if (!requireGuest()) return respond(ack)({ ok: false, error: 'not_authenticated' });
      data = (typeof data === 'object' && data) || {};
      const prefs = {
        enabled: data.enabled !== false,
        pushToTalk: !!data.pushToTalk,
        proximity: !!data.proximity,
        outputVolume: isInt(data.outputVolume, 0, 100) ? data.outputVolume : 80,
      };
      await db.voicePrefsSet(s.data.guestId, prefs).catch(() => {});
      s.data.voicePrefs = prefs;
      respond(ack)({ ok: true, prefs });
    }));

    // ---------- moderation ----------

    socket.on('player:report', limited(3, 0.03, async (s, data, ack) => {
      if (!requireGuest()) return respond(ack)({ ok: false, error: 'not_authenticated' });
      respond(ack)(await moderation.report(s, data).catch(() => ({ ok: false, error: 'server_error' })));
    }));

    socket.on('player:block', limited(10, 0.2, async (s, data, ack) => {
      if (!requireGuest()) return respond(ack)({ ok: false, error: 'not_authenticated' });
      respond(ack)(await moderation.block(s, data).catch(() => ({ ok: false, error: 'server_error' })));
    }));

    socket.on('player:unblock', limited(10, 0.2, async (s, data, ack) => {
      if (!requireGuest()) return respond(ack)({ ok: false, error: 'not_authenticated' });
      respond(ack)(await moderation.unblock(s, data).catch(() => ({ ok: false, error: 'server_error' })));
    }));

    // ---------- lifecycle ----------

    socket.on('disconnect', (reason) => {
      const room = currentRoom();
      // Room membership is kept for the reconnect grace period, so the session's
      // room binding in the DB is intentionally NOT cleared here.
      if (room && !socket.data.kicked) room.removeSocket(socket);
      guests.onSocketDisconnect(socket);
      if (socket.data.guestId) {
        log.info(`guest disconnected (${reason})`);
      }
    });
  });
}

module.exports = { setupSockets };
