'use strict';

/* Admin dashboard client. Talks only to /api/admin. The token lives in
   sessionStorage and is sent as a Bearer header — never in URLs. */

(function () {
  const { $, $$, toast, escapeHtml } = SA;

  const TOKEN_KEY = 'sa_admin_token';

  const admin = {
    token: sessionStorage.getItem(TOKEN_KEY) || null,
    tab: 'overview',
    reportStatus: '',
    auditOffset: 0,
    auditLimit: 50,
    autoTimer: null,

    async boot() {
      this.bind();
      if (!this.token) return this.showLogin();
      const ok = await this.check();
      if (ok) this.showDash();
      else this.showLogin();
    },

    async check() {
      const res = await this.api('GET', '/metrics').catch(() => null);
      return !!(res && !res.error);
    },

    bind() {
      $('#admin-login-btn').addEventListener('click', () => this.login());
      $('#admin-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.login(); });
      $('#admin-logout').addEventListener('click', () => this.logout());
      $('#admin-refresh').addEventListener('click', () => this.refreshTab());
      $$('.admin-tabs button').forEach((b) => {
        b.addEventListener('click', () => {
          this.tab = b.dataset.tab;
          $$('.admin-tabs button').forEach((x) => x.classList.toggle('active', x === b));
          $$('.admin-tab').forEach((t) => t.classList.add('hidden'));
          $(`#tab-${this.tab}`).classList.remove('hidden');
          this.refreshTab();
        });
      });
      $$('#report-status-tabs button').forEach((b) => {
        b.addEventListener('click', () => {
          this.reportStatus = b.dataset.status;
          $$('#report-status-tabs button').forEach((x) => x.classList.toggle('active', x === b));
          this.loadReports();
        });
      });
      $('#audit-action').addEventListener('change', () => { this.auditOffset = 0; this.loadAudit(); });
      $('#audit-prev').addEventListener('click', () => {
        this.auditOffset = Math.max(0, this.auditOffset - this.auditLimit);
        this.loadAudit();
      });
      $('#audit-next').addEventListener('click', () => {
        this.auditOffset += this.auditLimit;
        this.loadAudit();
      });
      $('#ban-create').addEventListener('click', () => this.createBan());
    },

    async api(method, path, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await fetch(`/api/admin${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && this.token) {
        this.logout('Your admin session expired. Sign in again.');
        throw new Error('unauthorized');
      }
      if (res.status === 503) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Admin dashboard is not enabled on this server (set ADMIN_TOKEN).');
      }
      return res.json();
    },

    async login() {
      const token = $('#admin-token').value.trim();
      if (!token) return;
      $('#admin-login-btn').disabled = true;
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }).then((r) => r.json());
        if (!res.ok) {
          $('#admin-login-error').textContent = res.message || 'Invalid admin token.';
          return;
        }
        this.token = token;
        sessionStorage.setItem(TOKEN_KEY, token);
        this.showDash();
      } catch (e) {
        $('#admin-login-error').textContent = 'Could not reach the server.';
      } finally {
        $('#admin-login-btn').disabled = false;
      }
    },

    logout(message) {
      this.token = null;
      sessionStorage.removeItem(TOKEN_KEY);
      if (this.autoTimer) clearInterval(this.autoTimer);
      this.showLogin(message);
    },

    showLogin(message) {
      $('#admin-dash').classList.add('hidden');
      $('#admin-login').classList.remove('hidden');
      $('#admin-login-error').textContent = message || '';
    },

    showDash() {
      $('#admin-login').classList.add('hidden');
      $('#admin-dash').classList.remove('hidden');
      this.refreshTab();
      if (this.autoTimer) clearInterval(this.autoTimer);
      this.autoTimer = setInterval(() => {
        if (!$('#admin-dash').classList.contains('hidden') && ['overview', 'players', 'rooms'].includes(this.tab)) {
          this.refreshTab();
        }
      }, 5000);
    },

    refreshTab() {
      const loaders = {
        overview: () => this.loadOverview(),
        players: () => this.loadPlayers(),
        rooms: () => this.loadRooms(),
        reports: () => this.loadReports(),
        bans: () => this.loadBans(),
        audit: () => this.loadAudit(),
        suspicious: () => this.loadSuspicious(),
      };
      (loaders[this.tab] || loaders.overview)().catch((e) => {
        toast(e.message || 'Request failed.', 'error');
      });
    },

    /* ---------- rendering helpers ---------- */

    table(el, headers, rowsHtml, emptyText) {
      const box = typeof el === 'string' ? $(el) : el;
      if (!rowsHtml) {
        box.innerHTML = `<p class="admin-empty">${escapeHtml(emptyText || 'Nothing here.')}</p>`;
        return;
      }
      box.innerHTML = `<table class="admin-table"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
    },

    fmtDate(v) {
      if (!v) return '—';
      const d = new Date(v);
      return isNaN(d) ? String(v) : d.toLocaleString();
    },

    shortGuest(id) {
      if (!id) return '—';
      return id.length > 14 ? `${id.slice(0, 12)}…` : id;
    },

    /* ---------- tabs ---------- */

    async loadOverview() {
      const m = await this.api('GET', '/metrics');
      $('#admin-status').textContent = `up ${Math.floor(m.uptimeSeconds / 60)}m · ${m.players.online} online`;
      const cards = [
        { label: 'Players online', value: m.players.online, sub: `${m.players.spectators} spectators · ${m.players.rooms} rooms` },
        { label: 'Process CPU', value: `${m.processCpuPercent}%`, sub: `${m.cores} cores · load ${(m.loadavg || []).join(' / ')}`, cls: m.processCpuPercent > 80 ? 'bad' : m.processCpuPercent > 50 ? 'warn' : '' },
        { label: 'Event-loop delay', value: `${m.eventLoopDelayMs} ms`, sub: 'interval jitter; should stay low', cls: m.eventLoopDelayMs > 50 ? 'bad' : m.eventLoopDelayMs > 15 ? 'warn' : '' },
        { label: 'Memory (RSS)', value: `${m.memory.rssMb} MB`, sub: `heap ${m.memory.heapUsedMb}/${m.memory.heapTotalMb} MB` },
        { label: 'OS memory', value: `${m.memory.osFreeMb} MB free`, sub: `of ${m.memory.osTotalMb} MB` },
        { label: 'Database', value: m.db.mode === 'mysql' ? `MySQL ${m.db.ok ? 'OK' : 'DOWN'}` : 'in-memory', sub: m.db.mode === 'mysql' ? `ping ${m.db.pingMs} ms · threads ${m.db.threads}` : 'runs without MySQL; stats are not persisted', cls: m.db.mode === 'mysql' && !m.db.ok ? 'bad' : '' },
        { label: 'Runtime', value: m.nodeVersion, sub: `${m.platform} · uptime ${Math.floor(m.uptimeSeconds / 60)}m` },
      ];
      $('#metric-cards').innerHTML = cards.map((c) => `
        <div class="metric-card ${c.cls || ''}">
          <div class="m-label">${escapeHtml(c.label)}</div>
          <div class="m-value">${escapeHtml(String(c.value))}</div>
          <div class="m-sub">${escapeHtml(c.sub || '')}</div>
        </div>`).join('');
      const modes = Object.entries(m.byMode || {});
      $('#by-mode').innerHTML = modes.length
        ? `<table class="admin-table"><thead><tr><th>Mode</th><th>Players</th><th>Rooms</th></tr></thead><tbody>${modes.map(([id, v]) => `<tr><td>${escapeHtml(id)}</td><td>${v.players}</td><td>${v.rooms}</td></tr>`).join('')}</tbody></table>`
        : '<p class="admin-empty">No rooms running.</p>';
    },

    async loadPlayers() {
      const { players } = await this.api('GET', '/players');
      const rows = (players || []).map((p) => `
        <tr>
          <td>${escapeHtml(p.nickname)}${p.spectate ? ' <span class="tag">spectating</span>' : ''}${p.voice ? ' <span class="tag">voice</span>' : ''}${p.hasHead ? ' <span class="tag">custom head</span>' : ''}</td>
          <td><code title="${escapeHtml(p.guestId)}">${escapeHtml(this.shortGuest(p.guestId))}</code></td>
          <td>${escapeHtml(p.room)}</td>
          <td>${escapeHtml(p.mode)} / ${escapeHtml(p.map)}</td>
          <td>${this.fmtDate(p.connectedAt)}</td>
          <td class="row-actions">
            ${p.hasHead ? `<button class="btn btn-sm" data-clearhead="${escapeHtml(p.guestId)}" data-nick="${escapeHtml(p.nickname)}">Clear head</button>` : ''}
            <button class="btn btn-sm" data-kick="${escapeHtml(p.guestId)}" data-nick="${escapeHtml(p.nickname)}">Kick</button>
            <button class="btn btn-sm btn-danger" data-ban="${escapeHtml(p.guestId)}" data-nick="${escapeHtml(p.nickname)}">Ban</button>
          </td>
        </tr>`).join('');
      this.table('#players-table', ['Nickname', 'Guest', 'Room', 'Mode/Map', 'Connected', 'Actions'], rows, 'No players connected.');
      this.bindModerationActions('#players-table');
    },

    async loadRooms() {
      const { rooms } = await this.api('GET', '/rooms');
      const rows = (rooms || []).map((r) => `
        <tr>
          <td>${escapeHtml(r.id)}</td>
          <td>${r.code ? `<code>${escapeHtml(r.code)}</code>` : '—'}</td>
          <td>${escapeHtml(r.mode)} / ${escapeHtml(r.map)}</td>
          <td>${r.players}</td>
          <td>${r.spectators}</td>
          <td>${r.voicePeers}</td>
          <td>${r.tick}</td>
          <td>${this.fmtDate(r.created)}</td>
        </tr>`).join('');
      this.table('#rooms-table', ['Room', 'Code', 'Mode/Map', 'Players', 'Spectators', 'Voice peers', 'Tick', 'Created'], rows, 'No rooms.');
    },

    async loadReports() {
      const q = this.reportStatus ? `?status=${encodeURIComponent(this.reportStatus)}` : '';
      const { reports } = await this.api('GET', `/reports${q}`);
      const rows = (reports || []).map((r) => `
        <tr>
          <td>#${r.id}</td>
          <td><span class="tag ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
          <td>${escapeHtml(r.reason)}</td>
          <td><code title="${escapeHtml(r.reported_guest_id)}">${escapeHtml(this.shortGuest(r.reported_guest_id))}</code></td>
          <td><code title="${escapeHtml(r.reporter_guest_id)}">${escapeHtml(this.shortGuest(r.reporter_guest_id))}</code></td>
          <td>${escapeHtml((r.details || '').slice(0, 80))}</td>
          <td>${this.fmtDate(r.created_at)}</td>
          <td class="row-actions">
            <button class="btn btn-sm" data-rstatus="${r.id}:reviewed">Reviewed</button>
            <button class="btn btn-sm" data-rstatus="${r.id}:actioned">Actioned</button>
            <button class="btn btn-sm" data-rstatus="${r.id}:dismissed">Dismiss</button>
            <button class="btn btn-sm btn-danger" data-ban="${escapeHtml(r.reported_guest_id)}" data-nick="reported guest">Ban</button>
          </td>
        </tr>`).join('');
      this.table('#reports-table', ['#', 'Status', 'Reason', 'Reported', 'Reporter', 'Details', 'Created', 'Actions'], rows, 'No reports.');
      $$('#reports-table [data-rstatus]').forEach((b) => {
        b.addEventListener('click', async () => {
          const [id, status] = b.dataset.rstatus.split(':');
          await this.api('POST', `/reports/${id}/status`, { status }).catch((e) => toast(e.message, 'error'));
          toast(`Report #${id} marked ${status}.`, 'info');
          this.loadReports();
        });
      });
      this.bindModerationActions('#reports-table');
    },

    async loadBans() {
      const { bans } = await this.api('GET', '/bans?active=1');
      const rows = (bans || []).map((b) => `
        <tr>
          <td>#${b.id}</td>
          <td><code title="${escapeHtml(b.guest_id)}">${escapeHtml(this.shortGuest(b.guest_id))}</code></td>
          <td>${escapeHtml(b.reason || '—')}</td>
          <td>${b.until ? this.fmtDate(b.until) : 'permanent'}</td>
          <td>${escapeHtml(b.created_by || 'admin')}</td>
          <td>${this.fmtDate(b.created_at)}</td>
          <td><button class="btn btn-sm" data-unban="${b.id}">Lift ban</button></td>
        </tr>`).join('');
      this.table('#bans-table', ['#', 'Guest', 'Reason', 'Until', 'By', 'Created', ''], rows, 'No active bans.');
      $$('#bans-table [data-unban]').forEach((b) => {
        b.addEventListener('click', async () => {
          await this.api('POST', '/unban', { banId: Number(b.dataset.unban) }).catch((e) => toast(e.message, 'error'));
          toast('Ban lifted.', 'info');
          this.loadBans();
        });
      });
    },

    async createBan() {
      const guestId = $('#ban-guest').value.trim();
      const minutes = parseInt($('#ban-minutes').value, 10) || 0;
      const reason = $('#ban-reason').value.trim();
      if (!/^g_[a-f0-9]{8,32}$/.test(guestId)) {
        toast('Enter a valid guest id (g_…).', 'error');
        return;
      }
      await this.api('POST', '/ban', { guestId, minutes, reason }).catch((e) => toast(e.message, 'error'));
      toast(minutes > 0 ? `Guest banned for ${minutes} minutes.` : 'Guest banned permanently.', 'info');
      $('#ban-guest').value = '';
      $('#ban-minutes').value = '';
      $('#ban-reason').value = '';
      this.loadBans();
    },

    async loadAudit() {
      const action = $('#audit-action').value;
      const q = `?limit=${this.auditLimit}&offset=${this.auditOffset}${action ? `&action=${encodeURIComponent(action)}` : ''}`;
      const { entries } = await this.api('GET', `/audit${q}`);
      const rows = (entries || []).map((a) => `
        <tr>
          <td>#${a.id}</td>
          <td>${this.fmtDate(a.created_at)}</td>
          <td><code>${escapeHtml(a.actor)}</code></td>
          <td>${escapeHtml(a.action)}</td>
          <td><code title="${escapeHtml(a.target_guest_id || '')}">${escapeHtml(this.shortGuest(a.target_guest_id))}</code></td>
          <td>${escapeHtml(a.details || '')}</td>
        </tr>`).join('');
      this.table('#audit-table', ['#', 'When', 'Actor', 'Action', 'Target', 'Details'], rows, 'No audit entries.');
    },

    async loadSuspicious() {
      const { entries } = await this.api('GET', '/suspicious');
      const rows = (entries || []).map((e) => `
        <tr>
          <td>${escapeHtml(e.nickname)}</td>
          <td><code title="${escapeHtml(e.guest_id)}">${escapeHtml(this.shortGuest(e.guest_id))}</code></td>
          <td>${e.best_score}</td>
          <td>${e.kills}</td>
          <td>${e.wins}</td>
          <td>${e.matches}</td>
          <td>${escapeHtml(e.period)} / ${escapeHtml(e.period_key)}</td>
          <td>${this.fmtDate(e.updated_at)}</td>
          <td><button class="btn btn-sm btn-danger" data-ban="${escapeHtml(e.guest_id)}" data-nick="${escapeHtml(e.nickname)}">Ban</button></td>
        </tr>`).join('');
      this.table('#suspicious-table', ['Nickname', 'Guest', 'Best', 'Kills', 'Wins', 'Matches', 'Period', 'Updated', ''], rows, 'No suspicious entries.');
      this.bindModerationActions('#suspicious-table');
    },

    bindModerationActions(scope) {
      $$(`${scope} [data-kick]`).forEach((b) => {
        b.addEventListener('click', () => this.moderate('kick', b.dataset.kick, b.dataset.nick));
      });
      $$(`${scope} [data-ban]`).forEach((b) => {
        b.addEventListener('click', () => this.moderate('ban', b.dataset.ban, b.dataset.nick));
      });
      $$(`${scope} [data-clearhead]`).forEach((b) => {
        b.addEventListener('click', async () => {
          if (!confirm(`Remove the custom snake head for ${b.dataset.nick || b.dataset.clearhead}?`)) return;
          try {
            await this.api('POST', '/head/remove', { guestId: b.dataset.clearhead });
            toast('Custom head removed.', 'info');
            this.loadPlayers();
          } catch (e) {
            toast(e.message, 'error');
          }
        });
      });
    },

    async moderate(action, guestId, nickname) {
      const reason = prompt(`${action === 'kick' ? 'Kick' : 'Ban'} ${nickname || guestId} — reason (optional):`) ?? null;
      if (reason === null) return; // cancelled
      if (action === 'kick') {
        await this.api('POST', '/kick', { guestId, reason }).catch((e) => toast(e.message, 'error'));
        toast('Player kicked.', 'info');
      } else {
        const minutesStr = prompt('Ban duration in minutes (0 or empty = permanent):', '60');
        if (minutesStr === null) return;
        const minutes = parseInt(minutesStr, 10) || 0;
        await this.api('POST', '/ban', { guestId, reason, minutes }).catch((e) => toast(e.message, 'error'));
        toast(minutes > 0 ? `Banned for ${minutes} minutes.` : 'Banned permanently.', 'info');
      }
      this.refreshTab();
    },
  };

  document.addEventListener('DOMContentLoaded', () => admin.boot());
})();
