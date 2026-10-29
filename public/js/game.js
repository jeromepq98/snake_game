'use strict';

/* GameView: owns the game screen — renderer loop, HUD, chat, kill feed,
   round banners, death overlays, spectate picker and the voice panel. */

(function () {
  const { $, escapeHtml, toast, fmtTime, formatRoomChip, isTouch } = SA;

  class GameView {
    constructor(app) {
      this.app = app;
      this.active = false;
      this.spectating = false;
      this.myPid = null;
      this.myGuestId = null;
      this.roomCode = null;
      this.modeId = 'arena';
      this.players = [];
      this.aliveSince = Date.now();
      this.frozenAliveMs = null;
      this.respawnAt = null;
      this.eliminated = false;
      this.roundPhase = null;
      this.roundEndsAt = null;
      this.nextRoundAt = null;
      this.raf = null;
      this.hudDirty = true;

      this.renderer = new SA.Renderer($('#game-canvas'), $('#minimap'));
      this.voice = new SA.VoiceManager(SA.net);
      this.input = new SA.Input({
        onDir: (dir) => SA.net.emit('game:input', { type: 'dir', dir }),
        onBoost: (on) => SA.net.emit('game:input', { type: 'boost', on }),
        onChat: () => this.expandChat(),
        onEscape: () => this.confirmLeave(),
      });

      this.bindSocketEvents();
      this.bindDom();
    }

    /* ---------- lifecycle ---------- */

    enter(joinInfo) {
      this.active = true;
      this.spectating = !!joinInfo.spectating;
      this.myPid = joinInfo.you ? joinInfo.you.pid : null;
      this.myGuestId = SA.session.get().guestId;
      this.roomCode = joinInfo.roomCode || null;
      this.modeId = joinInfo.mode || 'arena';
      this.respawnAt = null;
      this.eliminated = false;
      this.frozenAliveMs = null;
      this.aliveSince = Date.now();
      this.roundPhase = this.modeId === 'round' ? 'waiting' : null;
      this.roundEndsAt = null;
      this.nextRoundAt = null;
      if (joinInfo.round) {
        this.roundPhase = joinInfo.round.phase;
        if (this.roundPhase === 'running') this.roundEndsAt = Date.now() + (joinInfo.round.endsInMs || 0);
        else if (this.roundPhase === 'intermission') this.nextRoundAt = Date.now() + (joinInfo.round.nextInMs || 0);
      }
      this.renderer.setRoom({ map: joinInfo.map, tickMs: joinInfo.tickMs });
      this.renderer.setYou(this.spectating ? null : this.myPid);
      this.renderer.setPlayers(joinInfo.players || []);
      this.renderer.setSpectate(null);
      this.players = joinInfo.players || [];

      $('#room-chip').textContent = formatRoomChip({
        mode: this.modeId,
        map: joinInfo.map ? joinInfo.map.name : '',
        roomCode: this.roomCode,
        players: this.players.filter((p) => !p.spectate).length,
        spectators: joinInfo.spectators || 0,
      });
      $('#kill-feed').innerHTML = '';
      $('#chat-messages').innerHTML = '';
      $('#chat-panel').classList.add('collapsed');
      $('#round-banner').classList.add('hidden');
      $('#spectate-controls').classList.toggle('hidden', !this.spectating);
      this.updateVoicePanelVisibility();
      this.updateVoiceUI();

      const touch = isTouch();
      $('#joystick').classList.toggle('hidden', !touch || this.spectating);
      $('#boost-btn').classList.toggle('hidden', !touch || this.spectating);

      if (this.spectating) {
        this.showOverlay('Spectating', `
          <p class="sub">You are watching this match.</p>
          <p class="hint">Use the arrows below the screen to follow a player.</p>`);
      } else if (this.roundPhase === 'waiting') {
        this.showOverlay('Waiting for players…', '<p class="sub">The round starts when at least 2 snakes are in the arena.</p>');
      } else if (this.roundPhase === 'intermission') {
        this.showOverlay('Round over', '<p class="sub">The next round starts shortly.</p>');
      } else {
        this.hideOverlay();
      }
      this.renderHudList();

      this.input.setEnabled(!this.spectating);
      if (!this.spectating && this.roomCode) {
        toast(`Private room — code ${this.roomCode}. Click the chip at the top to copy it.`, 'info', 5000);
      }
      if (!this.raf) this.loop();
    }

    leave() {
      this.active = false;
      this.input.setEnabled(false);
      this.voice.stop();
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      this.hideOverlay();
      $('#round-banner').classList.add('hidden');
      $('#spectate-controls').classList.add('hidden');
      $('#voice-panel').classList.add('hidden');
    }

    loop = () => {
      if (!this.active) {
        this.raf = null;
        return;
      }
      this.renderer.frame();
      this.updateHud();
      this.updateOverlayCountdown();
      this.raf = requestAnimationFrame(this.loop);
    };

    confirmLeave() {
      if (this.active) this.app.requestLeaveGame();
    }

    /* ---------- socket events ---------- */

    bindSocketEvents() {
      const net = SA.net;
      net.on('game:state', (snap) => {
        if (!this.active) return;
        this.renderer.setState(snap);
      });
      net.on('game:players', (data) => {
        if (!this.active) return;
        this.players = data.players || [];
        this.renderer.setPlayers(this.players);
        this.renderHudList();
        $('#room-chip').textContent = formatRoomChip({
          mode: data.mode || this.modeId,
          map: (SA.CONFIG && SA.CONFIG.maps.find((m) => m.id === data.map) || {}).name || data.map,
          roomCode: data.roomCode || this.roomCode,
          players: this.players.length,
          spectators: data.spectators || 0,
        });
        this.updateSpectateName();
      });
      net.on('game:kill', (ev) => {
        if (!this.active) return;
        this.addKillFeed(ev);
        const snake = this.renderer.next && this.renderer.decodeSnakes(this.renderer.next).find((s) => s.pid === ev.victim.pid);
        if (snake && snake.pts.length) {
          this.renderer.burst(snake.pts[0].x, snake.pts[0].y, '#ef4444', 20);
        }
      });
      net.on('game:death', (ev) => {
        if (!this.active || ev.pid !== this.myPid) return;
        this.frozenAliveMs = ev.survivedMs || 0;
        this.aliveSince = null;
        if (ev.respawnIn) {
          this.respawnAt = Date.now() + ev.respawnIn;
          this.showOverlay('Eaten!', `
            <div class="big-num">${ev.score != null ? ev.score : 0}</div>
            <p class="sub">final score · survived ${fmtTime(ev.survivedMs || 0)}</p>
            <p class="hint">Respawning…</p>`);
        } else {
          this.respawnAt = null;
          this.eliminated = true;
          this.showOverlay('Eliminated', `
            <div class="big-num">${ev.score != null ? ev.score : 0}</div>
            <p class="sub">final score · survived ${fmtTime(ev.survivedMs || 0)}</p>
            <p class="hint">You are spectating the rest of the round.</p>`);
        }
      });
      net.on('game:respawn', (ev) => {
        if (!this.active) return;
        if (ev.pid === this.myPid) {
          this.respawnAt = null;
          this.eliminated = false;
          this.frozenAliveMs = null;
          this.aliveSince = Date.now();
          if (this.roundPhase !== 'intermission') this.hideOverlay();
          const snake = this.renderer.next && this.renderer.decodeSnakes(this.renderer.next).find((s) => s.pid === this.myPid);
          if (snake && snake.pts.length) this.renderer.ring(snake.pts[0].x, snake.pts[0].y, '#2fbf4f');
        }
      });
      net.on('game:round', (ev) => {
        if (!this.active) return;
        this.roundPhase = ev.phase;
        if (ev.phase === 'running') {
          this.roundEndsAt = Date.now() + (ev.endsInMs || 0);
          this.nextRoundAt = null;
          $('#round-banner').classList.add('hidden');
          if (!this.spectating && !this.eliminated) this.hideOverlay();
          this.aliveSince = this.aliveSince || Date.now();
        } else if (ev.phase === 'intermission') {
          this.nextRoundAt = Date.now() + (ev.nextInMs || 0);
          this.showRoundBanner(ev);
        }
      });
      net.on('chat:message', (msg) => {
        if (!this.active) return;
        this.addChatLine(msg);
      });
      net.on('chat:blocked', (msg) => {
        toast((msg && msg.message) || 'Message blocked.', 'error');
      });
      net.on('game:closed', () => {
        if (!this.active) return;
        toast('This room has closed.', 'info');
        this.app.showMenu({ reason: 'closed' });
      });
      net.on('kicked', (ev) => {
        toast(`You were removed by a moderator${ev && ev.reason ? `: ${ev.reason}` : ''}.`, 'error', 6000);
        this.app.showMenu({ kicked: true });
      });
      net.on('achievement:unlocked', (ev) => {
        toast(`Achievement unlocked: ${ev.name} — ${ev.desc}`, 'gold', 5000);
      });
      net.on('skins:updated', (ev) => {
        if (this.app) this.app.unlockSkins(ev.skins || []);
      });
      // KeyV push-to-talk while voice is active.
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyV' && this.voice.active && this.voice.prefs.pushToTalk) this.voice.setPttHeld(true);
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'KeyV') this.voice.setPttHeld(false);
      });
    }

    /* ---------- DOM handlers ---------- */

    bindDom() {
      $('#btn-leave').addEventListener('click', () => this.app.requestLeaveGame());
      $('#room-chip').addEventListener('click', async () => {
        if (this.roomCode && await SA.copyText(this.roomCode)) toast(`Room code ${this.roomCode} copied.`, 'info', 2500);
      });
      $('#chat-toggle').addEventListener('click', () => {
        $('#chat-panel').classList.toggle('collapsed');
      });
      $('#chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#chat-input');
        const text = input.value.trim();
        if (text) SA.net.emit('chat:send', { text });
        input.value = '';
        input.focus();
      });

      // Voice panel
      $('#voice-toggle').addEventListener('click', async () => {
        if (!this.voice.prefs.enabled) {
          toast('Voice chat is disabled in Settings.', 'info');
          return;
        }
        const res = await this.voice.start();
        if (!res.ok) {
          toast(res.message || 'Voice chat is unavailable right now.', 'error');
          return;
        }
        this.updateVoiceUI();
      });
      $('#voice-leave').addEventListener('click', () => {
        this.voice.stop();
        this.updateVoiceUI();
      });
      $('#voice-mute').addEventListener('click', () => {
        this.voice.setMuted(!this.voice.muted);
        this.updateVoiceUI();
      });
      $('#voice-ptt').addEventListener('click', () => {
        this.voice.updatePrefs({ pushToTalk: !this.voice.prefs.pushToTalk });
        this.voice.applyMicState();
        this.app.saveVoicePrefs(this.voice.prefs);
        this.updateVoiceUI();
      });
      $('#voice-proximity').addEventListener('click', () => {
        this.voice.setProximity(!this.voice.prefs.proximity);
        this.app.saveVoicePrefs(this.voice.prefs);
        this.updateVoiceUI();
      });
      $('#voice-volume').addEventListener('input', (e) => {
        this.voice.updatePrefs({ outputVolume: Number(e.target.value) });
        this.app.saveVoicePrefs(this.voice.prefs);
      });

      // Spectate picker
      $('#spectate-prev').addEventListener('click', () => this.cycleSpectate(-1));
      $('#spectate-next').addEventListener('click', () => this.cycleSpectate(1));
      $('#spectate-exit').addEventListener('click', () => this.app.requestLeaveGame());
    }

    expandChat() {
      $('#chat-panel').classList.remove('collapsed');
      $('#chat-input').focus();
    }

    /* ---------- HUD ---------- */

    updateHud() {
      const me = this.players.find((p) => p.pid === this.myPid);
      if (me) {
        $('#hud-score').textContent = me.score;
        $('#hud-kills').textContent = me.kills;
        $('#hud-len').textContent = me.len;
        if (this.aliveSince) {
          $('#hud-alive').textContent = fmtTime(Date.now() - this.aliveSince);
        } else if (this.frozenAliveMs != null) {
          $('#hud-alive').textContent = fmtTime(this.frozenAliveMs);
        }
      }
    }

    renderHudList() {
      const list = $('#hud-lb-list');
      if (!list) return;
      const sorted = [...this.players].sort((a, b) => (b.score - a.score) || (b.kills - a.kills));
      const top = sorted.slice(0, 8);
      list.innerHTML = '';
      top.forEach((p, i) => {
        const li = document.createElement('li');
        if (p.pid === this.myPid) li.classList.add('me');
        if (!p.alive) li.classList.add('dead');
        const nick = document.createElement('span');
        nick.className = 'lb-nick';
        nick.textContent = `${i + 1}. ${p.nick}${p.disc ? ' (reconnecting)' : ''}`;
        const score = document.createElement('span');
        score.className = 'lb-score';
        score.textContent = p.score;
        li.appendChild(nick);
        li.appendChild(score);
        if (p.guestId && p.guestId !== this.myGuestId) {
          const actions = document.createElement('span');
          actions.className = 'player-actions';
          const reportBtn = document.createElement('button');
          reportBtn.className = 'btn btn-sm';
          reportBtn.title = 'Report or block this player';
          reportBtn.textContent = '!';
          reportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.app.openReport({ guestId: p.guestId, nickname: p.nick });
          });
          actions.appendChild(reportBtn);
          li.appendChild(actions);
        }
        list.appendChild(li);
      });
    }

    addKillFeed(ev) {
      const feed = $('#kill-feed');
      const item = document.createElement('div');
      item.className = 'kill-item';
      if (ev.killer) {
        item.innerHTML = `<b>${escapeHtml(ev.killer.nickname)}</b> ate <b>${escapeHtml(ev.victim.nickname)}</b>`;
      } else {
        const causes = { wall: 'hit the wall', self: 'bit their own tail', squish: 'got squeezed', starve: 'burned out' };
        item.innerHTML = `<b>${escapeHtml(ev.victim.nickname)}</b> ${causes[ev.cause] || 'died'}`;
      }
      feed.appendChild(item);
      while (feed.children.length > 5) feed.removeChild(feed.firstChild);
      setTimeout(() => item.remove(), 7000);
    }

    addChatLine(msg) {
      const box = $('#chat-messages');
      const line = document.createElement('div');
      line.className = 'chat-line';
      line.innerHTML = `<b>${escapeHtml(msg.nickname)}:</b> ${escapeHtml(msg.text)}`;
      box.appendChild(line);
      while (box.children.length > 60) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }

    /* ---------- overlays / round banner ---------- */

    showOverlay(title, inner) {
      const card = $('#overlay-card');
      card.innerHTML = `<h2>${escapeHtml(title)}</h2>${inner}`;
      $('#overlay-center').classList.remove('hidden');
    }

    hideOverlay() {
      $('#overlay-center').classList.add('hidden');
    }

    updateOverlayCountdown() {
      if (this.respawnAt) {
        const left = Math.max(0, this.respawnAt - Date.now());
        const el = $('#overlay-card .hint');
        if (el) el.textContent = `Respawning in ${(left / 1000).toFixed(1)}s`;
      } else if (this.nextRoundAt && this.roundPhase === 'intermission') {
        const left = Math.max(0, this.nextRoundAt - Date.now());
        const el = $('#round-banner .sub');
        if (el) el.textContent = `Next round in ${Math.ceil(left / 1000)}s`;
      }
    }

    showRoundBanner(ev) {
      const banner = $('#round-banner');
      const winners = ev.winners || [];
      let html = `<h2>Round ${ev.number} over</h2>`;
      if (winners.length === 1) {
        html += `<p class="sub">Winner: <b>${escapeHtml(winners[0].nickname)}</b></p>`;
      } else if (winners.length > 1) {
        html += `<p class="sub">Winners: ${winners.map((w) => escapeHtml(w.nickname)).join(', ')}</p>`;
      }
      html += '<div class="standings">';
      for (const row of ev.standings || []) {
        html += `<div>${escapeHtml(row.nickname)} — ${row.score}</div>`;
      }
      html += '</div><p class="sub" style="margin-top:0.5rem">Next round in 8s</p>';
      banner.innerHTML = html;
      banner.classList.remove('hidden');
      this.hideOverlay();
    }

    /* ---------- spectate ---------- */

    spectateTargets() {
      return this.players.filter((p) => p.alive);
    }

    cycleSpectate(delta) {
      const targets = this.spectateTargets();
      if (!targets.length) return;
      const cur = this.renderer.spectatePid;
      let idx = targets.findIndex((p) => p.pid === cur);
      idx = (idx + delta + targets.length) % targets.length;
      const pid = targets[idx].pid;
      this.renderer.setSpectate(pid);
      this.updateSpectateName();
    }

    updateSpectateName() {
      if (!this.spectating && !this.eliminated) return;
      const pid = this.renderer.spectatePid;
      const p = this.players.find((pl) => pl.pid === pid);
      $('#spectate-name').textContent = p ? p.nick : '—';
    }

    /* ---------- voice UI ---------- */

    updateVoicePanelVisibility() {
      const show = this.active && this.voice.prefs.enabled;
      $('#voice-panel').classList.toggle('hidden', !show);
    }

    updateVoiceUI() {
      this.updateVoicePanelVisibility();
      const on = this.voice.active;
      $('#voice-toggle').classList.toggle('hidden', on);
      $('#voice-leave').classList.toggle('hidden', !on);
      $('#voice-controls').classList.toggle('hidden', !on);
      if (on) {
        $('#voice-mute').textContent = this.voice.muted ? 'Unmute' : 'Mute';
        $('#voice-ptt').textContent = this.voice.prefs.pushToTalk ? 'PTT: on' : 'PTT: off';
        $('#voice-proximity').textContent = `Proximity: ${this.voice.prefs.proximity ? 'on' : 'off'}`;
        $('#voice-volume').value = this.voice.prefs.outputVolume;
        this.renderVoicePeers();
      }
    }

    renderVoicePeers() {
      const box = $('#voice-peers');
      const peers = this.voice.peerList();
      if (!peers.length) {
        box.innerHTML = '<div style="color:#94a3b8">Waiting for others to join voice…</div>';
        return;
      }
      box.innerHTML = '';
      for (const p of peers) {
        const row = document.createElement('div');
        row.className = 'voice-peer';
        const name = document.createElement('span');
        name.textContent = p.nickname;
        const status = document.createElement('span');
        status.style.color = this.voice.prefs.proximity ? (p.audible ? '#86efac' : '#64748b') : '#86efac';
        status.textContent = this.voice.prefs.proximity ? (p.audible ? 'near' : 'far') : 'live';
        row.appendChild(name);
        row.appendChild(status);
        box.appendChild(row);
      }
    }
  }

  SA.GameView = GameView;
})();
