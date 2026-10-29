'use strict';

/* Socket.IO wrapper with promise-based acks and connection banner handling.
   Events starting with "net:" are local-only; everything else is a real socket event. */

(function () {
  const { $ } = SA;

  class Net {
    constructor() {
      this.socket = null;
      this.localHandlers = {};
    }

    connect() {
      if (this.socket) return this.socket;
      const socket = io({
        path: '/socket.io',
        reconnection: true,
        reconnectionDelay: 800,
        reconnectionDelayMax: 5000,
        timeout: 10000,
      });
      this.socket = socket;

      socket.on('connect', () => {
        this.setBanner(null);
        this.fireLocal('net:connected');
      });
      socket.on('disconnect', (reason) => {
        const transient = ['io client disconnect', 'transport close', 'transport error', 'ping timeout'].includes(reason);
        this.setBanner(transient ? 'Connection lost — reconnecting…' : `Disconnected (${reason}). Reconnecting…`);
        this.fireLocal('net:disconnected', reason);
      });
      socket.io.on('reconnect_attempt', () => {
        this.setBanner('Reconnecting…');
      });
      socket.io.on('reconnect_failed', () => {
        this.setBanner('Could not reconnect. Check your internet connection and reload.');
      });

      // Handlers may be registered before the socket exists (GameView/Voice
      // managers are constructed at boot); attach them once it does.
      for (const [event, list] of Object.entries(this.localHandlers)) {
        if (event.startsWith('net:')) continue;
        for (const entry of list) {
          if (entry.socketFn) socket.on(event, entry.socketFn);
        }
      }
      return socket;
    }

    setBanner(text) {
      const el = $('#connection-banner');
      if (!el) return;
      if (!text) {
        el.classList.add('hidden');
        return;
      }
      el.textContent = text;
      el.classList.remove('hidden');
    }

    on(event, fn) {
      if (event.startsWith('net:')) {
        (this.localHandlers[event] = this.localHandlers[event] || []).push(fn);
        return () => this.off(event, fn);
      }
      if (this.socket) this.socket.on(event, fn);
      (this.localHandlers[event] = this.localHandlers[event] || []).push({ socketFn: fn });
      return () => this.off(event, fn);
    }

    off(event, fn) {
      const list = this.localHandlers[event];
      if (!list) return;
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        if (typeof entry === 'function' ? entry === fn : entry.socketFn === fn) {
          list.splice(i, 1);
          if (entry.socketFn && this.socket) this.socket.off(event, entry.socketFn);
        }
      }
    }

    emit(event, payload) {
      if (this.socket) this.socket.emit(event, payload);
    }

    /* Fire an event with an ack callback; resolves { ok:false, error:'timeout' } on silence. */
    request(event, data, timeoutMs = 8000) {
      if (!this.socket) {
        return Promise.resolve({ ok: false, error: 'not_connected', message: 'Not connected to the server.' });
      }
      const socket = this.socket;
      const send = (waitMs) => new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ ok: false, error: 'timeout', message: 'The server did not respond. Try again.' });
          }
        }, waitMs);
        socket.timeout(waitMs).emit(event, data, (err, res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) resolve({ ok: false, error: 'timeout', message: 'The server did not respond. Try again.' });
          else resolve(res || { ok: false, error: 'empty_response' });
        });
      });
      if (socket.connected) return send(timeoutMs);
      // Boot and reconnect callers fire requests while the socket is still
      // connecting; waiting avoids reporting a false "session expired".
      return new Promise((resolve) => {
        const started = Date.now();
        let done = false;
        const finish = (errRes) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          socket.off('connect', onConnect);
          if (errRes) resolve(errRes);
          else send(Math.max(250, timeoutMs - (Date.now() - started))).then(resolve);
        };
        const onConnect = () => finish(null);
        const timer = setTimeout(() => finish({ ok: false, error: 'timeout', message: 'Not connected to the server.' }), timeoutMs);
        socket.once('connect', onConnect);
      });
    }

    fireLocal(event, payload) {
      const list = this.localHandlers[event];
      if (list) for (const entry of list) (typeof entry === 'function' ? entry : entry.socketFn)(payload);
    }

    get connected() {
      return !!(this.socket && this.socket.connected);
    }

    disconnect() {
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }
      this.localHandlers = {};
    }
  }

  SA.net = new Net();
})();
