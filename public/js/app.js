'use strict';

/* App bootstrap: guest session flow, screen state machine, menu population,
   settings/report modals, leaderboard screen and reconnection handling. */

(function () {
  const { $, $$, toast, session, prefs, escapeHtml } = SA;

  const SCREENS = ['screen-nickname', 'screen-menu', 'screen-leaderboard', 'screen-game'];

  const app = {
    state: 'boot', // nickname | menu | game
    inRoom: false,
    lastJoin: null, // params for a fresh (non-resume) join after a reconnect
    config: null,
    selection: { mode: 'arena', map: 'hinunangan', skin: 'emerald', privateRoom: false },
    skins: new Set(),
    headVersion: null,
    headSeq: 0,
    reportTarget: null,
    helloPromise: null,

    /* ---------- boot ---------- */

    async boot() {
      Object.assign(this.selection, prefs.get());
      await this.loadConfig();
      SA.CONFIG = this.config;
      this.renderMenuCards();
      SA.net.connect();
      this.bindNet();
      this.bindUi();
      this.pollLive();
      setInterval(() => this.pollLive(), 10000);
      this.registerSw();

      const saved = session.get();
      if (saved.token) {
        this.showScreen('screen-nickname');
        this.setNickError('Restoring your guest session…');
        const res = await this.hello({ token: saved.token });
        if (!res.ok) {
          if (res.error === 'banned') {
            this.setNickError(res.message || 'You are banned from this server.');
          } else {
            this.setNickError('Your saved session expired. Pick a new nickname.');
          }
          session.clear();
          this.showScreen('screen-nickname');
          return;
        }
        this.setNickError('');
        this.showMenu();
      } else {
        this.showScreen('screen-nickname');
        this.randomNickname();
      }
    },

    async loadConfig() {
      try {
        const res = await fetch('/api/config', { cache: 'no-store' });
        this.config = await res.json();
      } catch (e) {
        toast('Could not load server config. Is the server running?', 'error', 6000);
        this.config = { modes: [], maps: [], skins: [], powerups: [], achievements: [], tickMs: 100, maxPlayers: 20, voiceCap: 8, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
      }
    },

    registerSw() {
      if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support best-effort */ });
      }
    },

    /* ---------- screens ---------- */

    showScreen(id) {
      for (const s of SCREENS) $(`#${s}`).classList.toggle('active', s === id);
    },

    showMenu(opts = {}) {
      if (this.inRoom) {
        this.inRoom = false;
        this.game.leave();
        if (!opts.kicked) {
          SA.net.request('game:leave', {}, 4000).catch(() => {});
        }
      }
      this.state = 'menu';
      this.showScreen('screen-menu');
      this.renderSkins();
      this.pollLive();
    },

    showGame(joinInfo) {
      this.state = 'game';
      this.inRoom = true;
      this.showScreen('screen-game');
      this.game.enter(joinInfo);
    },

    backToNickname(message) {
      if (this.inRoom) {
        this.inRoom = false;
        this.game.leave();
      }
      session.clear();
      this.state = 'nickname';
      this.showScreen('screen-nickname');
      if (message) this.setNickError(message);
      $('#nick-input').focus();
    },

    /* ---------- guest session ---------- */

    hello(payload) {
      const p = SA.net.request('guest:hello', payload, 10000).then((res) => {
        if (res.ok) {
          session.save({
            guestId: res.guestId,
            token: res.token || session.get().token,
            nickname: res.nickname,
          });
          this.skins = new Set(res.skins || []);
          this.headSeq++;
          this.headVersion = res.head ? res.head.version : null;
          this.applyingVoicePrefs(res.voicePrefs || null);
          $('#menu-nick').textContent = res.nickname;
        }
        return res;
      });
      this.helloPromise = p;
      p.then(() => { if (this.helloPromise === p) this.helloPromise = null; });
      return p;
    },

    async doNicknameFlow(nickname) {
      const v = nickname.trim();
      if (!v) return this.setNickError('Enter a nickname first.');
      if (v.length < 2 || v.length > 16) return this.setNickError('Nicknames must be 2-16 characters.');
      if (!/^[A-Za-z0-9 _\-.'#]+$/.test(v)) return this.setNickError("Letters, numbers, spaces and - . ' # only.");
      $('#nick-start').disabled = true;
      this.setNickError('');
      const res = await this.hello({ nickname: v });
      $('#nick-start').disabled = false;
      if (!res.ok) return this.setNickError(res.message || 'That nickname is not available. Try another.');
      this.state = 'menu';
      this.showScreen('screen-menu');
      this.renderSkins();
    },

    setNickError(msg) {
      $('#nick-error').textContent = msg || '';
    },

    async randomNickname() {
      try {
        const res = await fetch('/api/nickname/random', { cache: 'no-store' });
        const data = await res.json();
        $('#nick-input').value = data.nickname || '';
      } catch (e) { /* leave the input as-is */ }
    },

    /* ---------- networking ---------- */

    bindNet() {
      SA.net.on('session:replaced', (ev) => {
        toast((ev && ev.message) || 'This session opened in another window.', 'error', 6000);
        this.backToNickname('Your session moved to another window. Enter a nickname to start a new one here.');
      });

      SA.net.on('net:connected', async () => {
        const saved = session.get();
        if (!saved.token || this.state === 'boot' || this.helloPromise) return;
        // Reconnect: re-hello to re-authenticate the socket, then resume the room.
        const res = await this.hello({ token: saved.token });
        if (!res.ok) {
          toast(res.message || 'Your session expired while reconnecting.', 'error', 6000);
          this.backToNickname('Your session expired. Pick a nickname to continue.');
          return;
        }
        $('#menu-nick').textContent = res.nickname;
        if (this.inRoom && this.lastJoin) {
          const join = await SA.net.request('game:join', this.lastJoin, 10000);
          if (join.ok) {
            this.showGame(join);
            toast(join.resumed ? 'Resumed your game.' : 'Rejoined the arena.', 'info', 2500);
          } else {
            toast(join.message || 'Could not rejoin that room.', 'error', 4000);
            this.showMenu();
          }
        } else if (this.state === 'menu') {
          toast('Reconnected.', 'info', 2000);
        }
      });

      SA.net.on('net:disconnected', () => {
        // Banner is handled by Net. If we were in a room the server keeps our
        // snake frozen for the grace window; net:connected will resume.
      });
    },

    async join(payload) {
      this.lastJoin = payload;
      $('#menu-error').textContent = '';
      const res = await SA.net.request('game:join', payload, 12000);
      if (!res.ok) {
        $('#menu-error').textContent = res.message || 'Could not join right now. Try again.';
        if (res.error === 'room_full') toast('That room is full.', 'error');
        this.inRoom = false;
        this.showScreen('screen-menu');
        return;
      }
      this.showGame(res);
    },

    requestLeaveGame() {
      if (!this.inRoom) return;
      const res = SA.net.request('game:leave', {}, 5000);
      this.inRoom = false;
      this.lastJoin = null;
      this.game.leave();
      this.state = 'menu';
      this.showScreen('screen-menu');
      this.renderSkins();
      this.pollLive();
      return res;
    },

    /* ---------- menu ---------- */

    renderMenuCards() {
      const modeBox = $('#mode-cards');
      modeBox.innerHTML = '';
      for (const m of this.config.modes) {
        modeBox.appendChild(this.pickCard({
          title: m.name,
          desc: m.desc,
          meta: m.id === 'round' ? '2-minute rounds · no respawns' : 'endless · instant respawns',
          selected: this.selection.mode === m.id,
          onPick: () => {
            this.selection.mode = m.id;
            prefs.set({ mode: m.id });
            this.renderMenuCards();
          },
        }));
      }
      const mapBox = $('#map-cards');
      mapBox.innerHTML = '';
      for (const mp of this.config.maps) {
        mapBox.appendChild(this.pickCard({
          title: mp.name,
          desc: mp.desc || '',
          meta: `${mp.w}×${mp.h}${mp.wrap ? ' · wraps around' : ''}`,
          selected: this.selection.map === mp.id,
          onPick: () => {
            this.selection.map = mp.id;
            prefs.set({ map: mp.id });
            this.renderMenuCards();
          },
        }));
      }
      this.renderSkins();
    },

    pickCard({ title, desc, meta, selected, onPick }) {
      const btn = document.createElement('button');
      btn.className = 'pick-card' + (selected ? ' selected' : '');
      btn.innerHTML = `
        <div class="pick-title">${escapeHtml(title)}</div>
        ${desc ? `<div class="pick-desc">${escapeHtml(desc)}</div>` : ''}
        ${meta ? `<div class="pick-meta">${escapeHtml(meta)}</div>` : ''}`;
      btn.addEventListener('click', onPick);
      return btn;
    },

    renderSkins() {
      const row = $('#skin-row');
      if (!row || !this.config.skins) return;
      row.innerHTML = '';
      const unlockedAch = (SA.CONFIG && SA.CONFIG.achievements) || [];
      for (const skin of this.config.skins) {
        const locked = skin.unlock && !this.skins.has(skin.id);
        const sw = document.createElement('button');
        sw.className = 'skin-swatch' + (this.selection.skin === skin.id ? ' selected' : '') + (locked ? ' locked' : '');
        sw.title = skin.name + (locked ? ' (locked)' : '');
        sw.innerHTML = `<span class="dot" style="background: linear-gradient(135deg, ${skin.colors[0]}, ${skin.colors[1]})"></span>`;
        if (locked) {
          const ach = unlockedAch.find((a) => a.id === skin.unlock);
          const lock = document.createElement('span');
          lock.className = 'lock';
          lock.textContent = `needs: ${ach ? ach.name : skin.unlock}`;
          sw.appendChild(lock);
        } else {
          sw.addEventListener('click', () => {
            this.selection.skin = skin.id;
            prefs.set({ skin: skin.id });
            this.renderSkins();
          });
        }
        row.appendChild(sw);
      }
    },

    unlockSkins(ids) {
      for (const id of ids) this.skins.add(id);
      this.renderSkins();
    },

    async pollLive() {
      if (this.state === 'game') return;
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        const data = await res.json();
        $('#live-pill').textContent = `${data.players} online · ${data.rooms} room${data.rooms === 1 ? '' : 's'}`;
      } catch (e) { /* keep the old value */ }
    },

    /* ---------- UI bindings ---------- */

    bindUi() {
      $('#nick-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#nick-start').click();
      });
      $('#nick-start').addEventListener('click', () => this.doNicknameFlow($('#nick-input').value));
      $('#nick-dice').addEventListener('click', () => this.randomNickname());

      $('#btn-play').addEventListener('click', () => {
        this.join({
          mode: this.selection.mode,
          map: this.selection.map,
          skin: this.selection.skin,
          spectate: false,
          ...(this.selection.privateRoom ? { private: true } : {}),
        });
      });
      $('#btn-spectate').addEventListener('click', () => {
        this.join({ mode: this.selection.mode, map: this.selection.map, spectate: true });
      });
      $('#btn-join-code').addEventListener('click', () => {
        const code = $('#room-code-input').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{4,6}$/.test(code)) {
          $('#menu-error').textContent = 'Room codes are 4-6 letters or digits.';
          return;
        }
        this.join({ roomCode: code, spectate: false, skin: this.selection.skin });
      });
      $('#room-code-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('#btn-join-code').click();
      });
      $('#btn-create-private').addEventListener('click', () => {
        this.selection.privateRoom = !this.selection.privateRoom;
        $('#btn-create-private').textContent = this.selection.privateRoom ? 'Private room selected — click again to cancel' : 'Create private room';
        $('#private-hint').classList.toggle('hidden', !this.selection.privateRoom);
        if (this.selection.privateRoom) {
          $('#private-hint').textContent = 'Your next arena will be a private room with a shareable code. Friends join with the code under “Private room”.';
        }
      });

      $('#btn-leaderboard').addEventListener('click', () => {
        this.showScreen('screen-leaderboard');
        this.loadLeaderboard(this.lbPeriod || 'alltime');
      });
      $('#btn-lb-back').addEventListener('click', () => this.showScreen('screen-menu'));
      $$('#lb-tabs button').forEach((b) => {
        b.addEventListener('click', () => this.loadLeaderboard(b.dataset.period));
      });

      $('#btn-settings').addEventListener('click', () => this.openSettings());
      $('#btn-rename').addEventListener('click', () => this.openSettings(true));
      $('#btn-forget').addEventListener('click', () => {
        if (!confirm('Forget this guest session on this device? Your stats and unlocks will no longer be reachable from this browser.')) return;
        session.clear();
        this.backToNickname('Session forgotten. Pick a new nickname to start fresh.');
      });

      // Settings modal
      $('#settings-cancel').addEventListener('click', () => $('#modal-settings').classList.add('hidden'));
      $('#settings-save').addEventListener('click', () => this.saveSettings());
      $('#head-upload').addEventListener('click', () => $('#head-file').click());
      $('#head-file').addEventListener('change', () => this.uploadHead());
      $('#head-remove').addEventListener('click', () => this.removeHead());

      // Report modal
      $('#report-cancel').addEventListener('click', () => this.closeReport());
      $('#report-send').addEventListener('click', () => this.sendReport(false));
      $('#report-block').addEventListener('click', () => this.sendReport(true));
    },

    /* ---------- leaderboard ---------- */

    lbPeriod: 'alltime',

    async loadLeaderboard(period) {
      this.lbPeriod = period;
      $$('#lb-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
      const body = $('#lb-body');
      body.innerHTML = '<p class="lb-empty">Loading…</p>';
      try {
        const res = await fetch(`/api/leaderboard?period=${encodeURIComponent(period)}&limit=50`, { cache: 'no-store' });
        const data = await res.json();
        if (!data.entries || !data.entries.length) {
          body.innerHTML = '<p class="lb-empty">No entries yet. Be the first on the board — go eat some apples.</p>';
          return;
        }
        const myNick = session.get().nickname;
        const rows = data.entries.map((e) => `
          <tr class="${e.nickname === myNick ? 'me' : ''}">
            <td>${e.rank}</td>
            <td>${escapeHtml(e.nickname)}${e.suspicious ? ' <span class="hint" title="Flagged by the anti-cheat heuristics">(under review)</span>' : ''}</td>
            <td>${e.bestScore}</td>
            <td>${e.kills}</td>
            <td>${e.wins}</td>
            <td>${e.matches}</td>
          </tr>`).join('');
        body.innerHTML = `
          <table class="lb-table">
            <thead><tr><th>#</th><th>Nickname</th><th>Best score</th><th>Kills</th><th>Wins</th><th>Matches</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="hint" style="margin-top:0.8rem">Leaderboards use nicknames only. Guest progress is anonymous and may not be recoverable if you clear your browser data.</p>`;
      } catch (e) {
        body.innerHTML = '<p class="lb-empty">Leaderboard unavailable right now.</p>';
      }
    },

    /* ---------- settings ---------- */

    applyingVoicePrefs(voicePrefs) {
      const stored = prefs.get();
      const local = Object.assign({}, stored.voicePrefs || {});
      if (local.voiceEnabled !== undefined && local.enabled === undefined) local.enabled = local.voiceEnabled;
      delete local.voiceEnabled;
      const merged = Object.assign(
        { enabled: true, pushToTalk: false, proximity: false, outputVolume: 80 },
        voicePrefs || {},
        local
      );
      prefs.set({ voicePrefs: merged });
      if (this.game && this.game.voice) this.game.voice.updatePrefs(merged);
    },

    saveVoicePrefs(voicePrefs) {
      const merged = Object.assign({}, (prefs.get().voicePrefs) || {}, voicePrefs);
      prefs.set({ voicePrefs: merged });
      SA.net.request('settings:voice', {
        enabled: merged.enabled !== false,
        pushToTalk: !!merged.pushToTalk,
        proximity: !!merged.proximity,
        outputVolume: Number.isFinite(merged.outputVolume) ? merged.outputVolume : 80,
      }, 4000).catch(() => {});
    },

    openSettings(focusNick = false) {
      const vp = (prefs.get().voicePrefs) || {};
      $('#settings-nick').value = session.get().nickname || '';
      $('#settings-nick-error').textContent = '';
      $('#settings-voice-enable').checked = vp.enabled !== false;
      $('#settings-ptt').checked = !!vp.pushToTalk;
      $('#settings-proximity').checked = !!vp.proximity;
      $('#settings-volume').value = vp.outputVolume != null ? vp.outputVolume : 80;
      $('#head-status').textContent = '';
      this.renderHeadPreview();
      this.refreshHeadMeta();
      $('#modal-settings').classList.remove('hidden');
      if (focusNick) $('#settings-nick').select();
    },

    async refreshHeadMeta() {
      const token = session.get().token;
      if (!token) return;
      const seq = ++this.headSeq;
      try {
        const res = await fetch('/api/player/head', { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok || seq !== this.headSeq) return;
        const data = await res.json();
        this.headVersion = data.head ? data.head.version : null;
        if (!$('#modal-settings').classList.contains('hidden')) this.renderHeadPreview();
      } catch (e) { /* offline; keep the last known version */ }
    },

    renderHeadPreview() {
      const url = SA.headUrl(session.get().guestId, this.headVersion);
      const img = $('#head-preview-img');
      const empty = $('#head-preview-empty');
      if (url) {
        img.src = url;
        img.classList.remove('hidden');
        empty.classList.add('hidden');
        $('#head-remove').classList.remove('hidden');
      } else {
        img.removeAttribute('src');
        img.classList.add('hidden');
        empty.classList.remove('hidden');
        $('#head-remove').classList.add('hidden');
      }
    },

    async uploadHead() {
      const input = $('#head-file');
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      const token = session.get().token;
      const status = $('#head-status');
      if (!token) {
        status.textContent = 'Session not ready. Reconnect and try again.';
        return;
      }
      const uploadBtn = $('#head-upload');
      const removeBtn = $('#head-remove');
      uploadBtn.disabled = true;
      removeBtn.disabled = true;
      this.headSeq++;
      status.textContent = 'Preparing picture…';
      try {
        const blob = await SA.headPngFromFile(file);
        status.textContent = 'Uploading…';
        const res = await fetch('/api/player/head', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
          body: blob,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Upload failed. Try again.');
        this.headVersion = data.head.version;
        status.textContent = 'Saved — other players see it right away.';
        this.renderHeadPreview();
        toast('Snake head updated.', 'gold', 2500);
      } catch (e) {
        status.textContent = e.message || 'Upload failed.';
      } finally {
        uploadBtn.disabled = false;
        removeBtn.disabled = false;
      }
    },

    async removeHead() {
      const token = session.get().token;
      if (!token) return;
      const status = $('#head-status');
      this.headSeq++;
      status.textContent = 'Removing…';
      try {
        const res = await fetch('/api/player/head', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Could not remove that picture.');
        this.headVersion = null;
        this.renderHeadPreview();
        status.textContent = 'Custom head removed.';
      } catch (e) {
        status.textContent = e.message || 'Could not remove that picture.';
      }
    },

    async saveSettings() {
      const nick = $('#settings-nick').value.trim();
      if (nick) {
        if (nick.length < 2 || nick.length > 16 || !/^[A-Za-z0-9 _\-.'#]+$/.test(nick)) {
          $('#settings-nick-error').textContent = "2-16 characters; letters, numbers, spaces and - . ' # only.";
          return;
        }
        if (nick !== session.get().nickname) {
          const res = await SA.net.request('guest:nickname', { nickname: nick }, 8000);
          if (!res.ok) {
            $('#settings-nick-error').textContent = res.message || 'Could not change nickname.';
            return;
          }
          session.updateNick(res.nickname);
          $('#menu-nick').textContent = res.nickname;
          toast(`Nickname changed to ${res.nickname}.`, 'info', 2500);
        }
      }
      const voicePrefs = {
        enabled: $('#settings-voice-enable').checked,
        pushToTalk: $('#settings-ptt').checked,
        proximity: $('#settings-proximity').checked,
        outputVolume: Number($('#settings-volume').value),
      };
      this.saveVoicePrefs(voicePrefs);
      if (this.game && this.game.voice) {
        this.game.voice.updatePrefs(voicePrefs);
        if (!voicePrefs.enabled && this.game.voice.active) this.game.voice.stop();
        this.game.voice.applyMicState();
        this.game.updateVoicePanelVisibility();
        this.game.updateVoiceUI();
      }
      $('#modal-settings').classList.add('hidden');
    },

    /* ---------- report ---------- */

    openReport(target) {
      this.reportTarget = target;
      $('#report-target').textContent = `Reporting ${target.nickname}. Reports are anonymous and reviewed by moderators.`;
      $('#report-reason').value = 'abuse';
      $('#report-details').value = '';
      $('#modal-report').classList.remove('hidden');
    },

    closeReport() {
      this.reportTarget = null;
      $('#modal-report').classList.add('hidden');
    },

    async sendReport(alsoBlock) {
      const t = this.reportTarget;
      if (!t) return this.closeReport();
      const payload = {
        targetGuestId: t.guestId,
        reason: $('#report-reason').value,
        details: $('#report-details').value.trim(),
      };
      const res = await SA.net.request('player:report', payload, 8000);
      if (res.ok) toast('Report submitted. Thank you.', 'info', 3000);
      else toast(res.message || 'Could not submit the report.', 'error');
      if (alsoBlock && res.ok) {
        const bres = await SA.net.request('player:block', { targetGuestId: t.guestId }, 8000);
        toast(bres.ok ? 'Player blocked. Their chat will no longer reach you.' : 'Could not block that player.', bres.ok ? 'info' : 'error');
      }
      this.closeReport();
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    app.game = new SA.GameView(app);
    SA.app = app;
    app.boot();
  });
})();
