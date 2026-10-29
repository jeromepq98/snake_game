'use strict';

/* Canvas renderer: interpolates server snapshots, follows the camera, draws
   snakes/food/power-ups/obstacles, and renders a minimap. Server state is
   authoritative; this module only presents it. */

(function () {
  const { clamp, lerp } = SA;

  const DIR_VEC = [
    { x: 0, y: -1 }, // 0 up
    { x: 1, y: 0 },  // 1 right
    { x: 0, y: 1 },  // 2 down
    { x: -1, y: 0 }, // 3 left
  ];

  const FLAG = { DISC: 1, BOOST: 2, GHOST: 4, SHIELD: 8, SPAWN: 16, SPEED: 32, MAGNET: 64, DOUBLE: 128 };
  const MAX_PARTICLES = 220;

  class Renderer {
    constructor(canvas, minimap) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.minimap = minimap;
      this.mctx = minimap ? minimap.getContext('2d') : null;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.map = null;
      this.youPid = null;
      this.camTarget = { x: 0, y: 0 };
      this.cam = { x: 0, y: 0 };
      this.camInit = false;
      this.prev = null;   // previous snapshot
      this.next = null;   // latest snapshot
      this.prevAt = 0;
      this.nextAt = 0;
      this.tickMs = 100;
      this.players = [];  // latest game:players roster (for nicknames)
      this.headCache = new Map(); // image URL -> { img, ready, failed }
      this.spectatePid = null;
      this.particles = [];
      this.time = 0;
      this.minimapAt = 0;
      this.resize();
      window.addEventListener('resize', () => this.resize());
      window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 150));
    }

    resize() {
      const c = this.canvas;
      const w = c.clientWidth || window.innerWidth;
      const h = c.clientHeight || window.innerHeight;
      this.w = w;
      this.h = h;
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    setRoom({ map, tickMs }) {
      this.map = map;
      if (tickMs) this.tickMs = tickMs;
      this.camInit = false;
      this.prev = null;
      this.next = null;
      this.particles = [];
    }

    setYou(pid) {
      this.youPid = pid;
      this.spectatePid = null;
    }

    setSpectate(pid) {
      this.spectatePid = pid;
    }

    setPlayers(players) {
      this.players = players || [];
    }

    setState(snap) {
      if (snap.tickMs) this.tickMs = snap.tickMs;
      this.prev = this.next;
      this.prevAt = this.nextAt;
      this.next = snap;
      this.nextAt = performance.now();
    }

    nicknameFor(pid) {
      const p = this.players.find((pl) => pl.pid === pid);
      return p ? p.nick : null;
    }

    headImageFor(s) {
      if (!s) return null;
      const player = this.players.find((pl) => pl.pid === s.pid);
      if (!player || !player.guestId || !player.head) return null;
      const url = SA.headUrl(player.guestId, player.head);
      if (!url) return null;
      let entry = this.headCache.get(url);
      if (!entry) {
        const img = new Image();
        entry = { img, ready: false, failed: false };
        img.onload = () => { entry.ready = img.naturalWidth > 0; };
        img.onerror = () => { entry.failed = true; };
        img.src = url;
        this.headCache.set(url, entry);
        if (this.headCache.size > 120) {
          const oldest = this.headCache.keys().next().value;
          if (oldest !== url) this.headCache.delete(oldest);
        }
      }
      return entry.ready && !entry.failed ? entry.img : null;
    }

    /* ---------- effects ---------- */

    burst(x, y, color, n = 14) {
      for (let i = 0; i < n; i++) {
        if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
        const a = Math.random() * Math.PI * 2;
        const sp = 0.05 + Math.random() * 0.16;
        this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.02 + Math.random() * 0.03, color });
      }
    }

    ring(x, y, color) {
      this.particles.push({ x, y, ring: true, life: 1, decay: 0.06, color });
    }

    /* ---------- snapshot helpers ---------- */

    /* Decoded snake: { pid, skin, dir, flags, pts: [{x,y}...] } */
    decodeSnakes(snap) {
      const out = [];
      for (const arr of snap.snakes) {
        const pts = [];
        for (let i = 4; i < arr.length; i += 2) pts.push({ x: arr[i], y: arr[i + 1] });
        out.push({ pid: arr[0], skin: arr[1], dir: arr[2], flags: arr[3], pts });
      }
      return out;
    }

    interpolatedSnakes() {
      if (!this.next) return [];
      const nowSnap = this.decodeSnakes(this.next);
      if (!this.prev) return nowSnap;
      const prevSnakes = this.decodeSnakes(this.prev);
      const alpha = clamp((performance.now() - this.nextAt) / this.tickMs, 0, 1);
      const mw = this.map ? this.map.w : Infinity;
      const mh = this.map ? this.map.h : Infinity;
      const byPid = new Map(prevSnakes.map((s) => [s.pid, s]));
      for (const s of nowSnap) {
        const p = byPid.get(s.pid);
        if (!p || !p.pts.length) continue;
        const n = Math.min(p.pts.length, s.pts.length);
        for (let i = 0; i < n; i++) {
          const a = p.pts[i];
          const b = s.pts[i];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          // Wrapping edge-cross: snap instead of sweeping across the whole map.
          if (dx > mw / 2) dx -= mw; else if (dx < -mw / 2) dx += mw;
          if (dy > mh / 2) dy -= mh; else if (dy < -mh / 2) dy += mh;
          b.x = a.x + dx * alpha;
          b.y = a.y + dy * alpha;
        }
      }
      return nowSnap;
    }

    focusPoint(snakes) {
      let pid = this.youPid;
      if (this.spectatePid != null) pid = this.spectatePid;
      if (pid != null) {
        const s = snakes.find((sn) => sn.pid === pid);
        if (s && s.pts.length) return s.pts[0];
      }
      if (snakes.length && snakes[0].pts.length) return snakes[0].pts[0];
      return this.map ? { x: this.map.w / 2, y: this.map.h / 2 } : { x: 0, y: 0 };
    }

    /* ---------- main frame ---------- */

    frame() {
      this.time = performance.now();
      this.updateCamera();
      this.draw();
      this.drawParticles();
      this.drawMinimap();
      this.updateParticles();
    }

    updateCamera() {
      const snakes = this.interpolatedSnakes();
      const focus = this.focusPoint(snakes);
      this.camTarget.x = focus.x + 0.5;
      this.camTarget.y = focus.y + 0.5;
      if (!this.camInit) {
        this.cam.x = this.camTarget.x;
        this.cam.y = this.camTarget.y;
        this.camInit = true;
      } else {
        const k = 0.18;
        this.cam.x = lerp(this.cam.x, this.camTarget.x, k);
        this.cam.y = lerp(this.cam.y, this.camTarget.y, k);
      }
    }

    computeCell() {
      const desiredW = SA.isTouch() ? 26 : 34;
      const desiredH = SA.isTouch() ? 18 : 22;
      return clamp(Math.min(this.w / desiredW, this.h / desiredH), 13, 46);
    }

    /* Offsets at which to draw a point near the map edge (wrap maps). */
    wrapOffsets(x, y) {
      const offs = [{ dx: 0, dy: 0 }];
      if (!this.map || !this.map.wrap) return offs;
      const edge = 3;
      const w = this.map.w;
      const h = this.map.h;
      const addX = x < edge ? w : x > w - 1 - edge ? -w : 0;
      const addY = y < edge ? h : y > h - 1 - edge ? -h : 0;
      if (addX) offs.push({ dx: addX, dy: 0 });
      if (addY) offs.push({ dx: 0, dy: addY });
      if (addX && addY) offs.push({ dx: addX, dy: addY });
      return offs;
    }

    draw() {
      const ctx = this.ctx;
      ctx.fillStyle = '#0a0f1a';
      ctx.fillRect(0, 0, this.w, this.h);
      if (!this.map || !this.next) return;

      const cell = this.computeCell();
      this.cell = cell;
      // Camera clamped to map bounds on non-wrap maps.
      let cx = this.cam.x;
      let cy = this.cam.y;
      const viewW = this.w / cell;
      const viewH = this.h / cell;
      if (!this.map.wrap) {
        if (this.map.w <= viewW) cx = this.map.w / 2;
        else cx = clamp(cx, viewW / 2, this.map.w - viewW / 2);
        if (this.map.h <= viewH) cy = this.map.h / 2;
        else cy = clamp(cy, viewH / 2, this.map.h - viewH / 2);
      }
      this.viewCx = cx;
      this.viewCy = cy;
      const originX = this.w / 2 - cx * cell;
      const originY = this.h / 2 - cy * cell;
      this.originX = originX;
      this.originY = originY;

      // arena background + grid
      ctx.save();
      this.drawArenaBackground(ctx, cell, originX, originY);
      this.drawObstacles(ctx, cell, originX, originY);
      this.drawMapLabels(ctx, cell, originX, originY);
      this.drawFood(ctx, cell, originX, originY);
      this.drawPowers(ctx, cell, originX, originY);
      const snakes = this.interpolatedSnakes();
      const others = snakes.filter((s) => s.pid !== this.youPid);
      const mine = snakes.filter((s) => s.pid === this.youPid);
      for (const s of others) this.drawSnake(ctx, s, cell, originX, originY, false);
      for (const s of mine) this.drawSnake(ctx, s, cell, originX, originY, true);
      ctx.restore();
    }

    drawArenaBackground(ctx, cell, ox, oy) {
      const { w, h } = this.map;
      const theme = this.map.theme || {};
      const x0 = ox;
      const y0 = oy;
      const gw = w * cell;
      const gh = h * cell;
      ctx.fillStyle = theme.land || '#0d1420';
      ctx.fillRect(x0, y0, gw, gh);
      ctx.strokeStyle = theme.grid || 'rgba(36, 48, 77, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = cell;
      for (let gx = 0; gx <= w; gx++) {
        ctx.moveTo(Math.round(x0 + gx * step) + 0.5, y0);
        ctx.lineTo(Math.round(x0 + gx * step) + 0.5, y0 + gh);
      }
      for (let gy = 0; gy <= h; gy++) {
        ctx.moveTo(x0, Math.round(y0 + gy * step) + 0.5);
        ctx.lineTo(x0 + gw, Math.round(y0 + gy * step) + 0.5);
      }
      ctx.stroke();
      // Water covers the grid so bays and rivers read as open water.
      if (this.map.water && this.map.water.length) {
        ctx.fillStyle = theme.water || '#0e1a2b';
        for (const [wx, wy, ww, wh] of this.map.water) {
          ctx.fillRect(x0 + wx * cell, y0 + wy * cell, ww * cell, wh * cell);
        }
      }
      if (this.map.islands) {
        for (const isle of this.map.islands) {
          ctx.fillStyle = theme.island || '#16231a';
          ctx.fillRect(x0 + isle.x * cell, y0 + isle.y * cell, isle.w * cell, isle.h * cell);
          if (theme.islandStroke) {
            ctx.strokeStyle = theme.islandStroke;
            ctx.lineWidth = Math.max(1, cell * 0.08);
            ctx.strokeRect(x0 + isle.x * cell, y0 + isle.y * cell, isle.w * cell, isle.h * cell);
          }
        }
      }
      if (this.map.coastline && this.map.coastline.length > 1) {
        ctx.strokeStyle = theme.coast || 'rgba(214, 185, 124, 0.5)';
        ctx.lineWidth = Math.max(1, cell * 0.1);
        ctx.beginPath();
        this.map.coastline.forEach(([x, y], i) => {
          const px = x0 + x * cell;
          const py = y0 + (y + 0.5) * cell;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
      ctx.strokeStyle = theme.border || '#24304d';
      ctx.lineWidth = 2;
      ctx.strokeRect(x0, y0, gw, gh);
    }

    drawObstacles(ctx, cell, ox, oy) {
      if (!this.map.obstacles || !this.map.obstacles.length) return;
      const theme = this.map.theme || {};
      ctx.fillStyle = theme.obstacleFill || '#1c2333';
      ctx.strokeStyle = theme.obstacleStroke || '#37415f';
      for (const [x, y, w, h] of this.map.obstacles) {
        ctx.fillRect(ox + x * cell + 1, oy + y * cell + 1, w * cell - 2, h * cell - 2);
        ctx.strokeRect(ox + x * cell + 1, oy + y * cell + 1, w * cell - 2, h * cell - 2);
      }
    }

    drawMapLabels(ctx, cell, ox, oy) {
      if (!this.map.labels || !this.map.labels.length) return;
      const theme = this.map.theme || {};
      const size = Math.max(9, Math.round(cell * 0.55));
      ctx.save();
      ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const label of this.map.labels) {
        ctx.fillStyle = label.kind === 'water'
          ? (theme.labelWater || 'rgba(142, 210, 228, 0.62)')
          : (theme.labelLand || 'rgba(198, 216, 202, 0.46)');
        ctx.fillText(label.text, ox + label.x * cell, oy + label.y * cell);
      }
      ctx.restore();
    }

    drawFood(ctx, cell, ox, oy) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time / 300);
      for (const f of this.next.food) {
        const [fx, fy, v] = f;
        const golden = v > 1;
        const r = cell * (golden ? 0.34 + 0.05 * pulse : 0.26);
        for (const off of this.wrapOffsets(fx, fy)) {
          const px = ox + (fx + 0.5 + off.dx) * cell;
          const py = oy + (fy + 0.5 + off.dy) * cell;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          if (golden) {
            ctx.shadowColor = '#fbbf24';
            ctx.shadowBlur = 10 + 8 * pulse;
            ctx.fillStyle = '#fbbf24';
          } else {
            ctx.fillStyle = '#ef4444';
          }
          ctx.fill();
          ctx.shadowBlur = 0;
          if (golden) {
            ctx.fillStyle = '#fff7cc';
            ctx.beginPath();
            ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.28, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    drawPowers(ctx, cell, ox, oy) {
      const cfg = (SA.CONFIG && SA.CONFIG.powerups) || [];
      for (const p of this.next.powers) {
        const [px, py, typeIdx] = p;
        const info = cfg[typeIdx] || { color: '#f59e0b', letter: '?' };
        for (const off of this.wrapOffsets(px, py)) {
          const x = ox + (px + 0.5 + off.dx) * cell;
          const y = oy + (py + 0.5 + off.dy) * cell;
          const s = cell * 0.72;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(Math.sin(this.time / 500 + px) * 0.12);
          ctx.fillStyle = info.color;
          ctx.shadowColor = info.color;
          ctx.shadowBlur = 12;
          ctx.beginPath();
          this.roundRect(ctx, -s / 2, -s / 2, s, s, s * 0.22);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#0a0f1a';
          ctx.font = `700 ${Math.round(s * 0.5)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(info.letter || '?', 0, 1);
          ctx.restore();
        }
      }
    }

    skinColors(skinId) {
      const skins = (SA.CONFIG && SA.CONFIG.skins) || [];
      const s = skins.find((sk) => sk.id === skinId) || { colors: ['#22c55e', '#16a34a'], pattern: 'solid' };
      return s;
    }

    segmentColor(skin, i) {
      if (skin.pattern === 'rainbow') return `hsl(${(i * 22 + this.time / 30) % 360}, 85%, 55%)`;
      if (skin.pattern === 'striped') return i % 4 < 2 ? skin.colors[0] : skin.colors[1];
      if (skin.pattern === 'checker') return i % 2 === 0 ? skin.colors[0] : skin.colors[1];
      return i % 2 === 0 ? skin.colors[0] : skin.colors[1];
    }

    drawSnake(ctx, s, cell, ox, oy, isMe) {
      if (!s.pts.length) return;
      const skin = this.skinColors(s.skin);
      const ghost = !!(s.flags & FLAG.GHOST);
      const boost = !!(s.flags & FLAG.BOOST);
      const shield = !!(s.flags & FLAG.SHIELD);
      const spawn = !!(s.flags & FLAG.SPAWN);
      const speed = !!(s.flags & FLAG.SPEED);
      const disc = !!(s.flags & FLAG.DISC);

      ctx.save();
      if (ghost) ctx.globalAlpha = 0.45;
      if (disc) ctx.globalAlpha = Math.min(ctx.globalAlpha, 0.5);

      const drawPass = (dxOff, dyOff) => {
        // body: draw from tail to head so the head lands on top
        const n = s.pts.length;
        for (let i = n - 1; i >= 1; i--) {
          const seg = s.pts[i];
          const x = ox + (seg.x + 0.5 + dxOff) * cell;
          const y = oy + (seg.y + 0.5 + dyOff) * cell;
          const shrink = i === n - 1 ? 0.2 : 0.08; // taper the tail tip
          const size = cell * (1 - shrink);
          ctx.fillStyle = this.segmentColor(skin, i);
          if (boost) {
            ctx.shadowColor = skin.colors[0];
            ctx.shadowBlur = 9;
          } else if (speed) {
            ctx.shadowColor = '#f59e0b';
            ctx.shadowBlur = 7;
          }
          ctx.beginPath();
          this.roundRect(ctx, x - size / 2, y - size / 2, size, size, size * 0.3);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        // head
        const head = s.pts[0];
        const hx = ox + (head.x + 0.5 + dxOff) * cell;
        const hy = oy + (head.y + 0.5 + dyOff) * cell;
        const hs = cell * 0.94;
        ctx.fillStyle = skin.colors[0];
        ctx.beginPath();
        this.roundRect(ctx, hx - hs / 2, hy - hs / 2, hs, hs, hs * 0.3);
        ctx.fill();
        const customHead = this.headImageFor(s);
        if (customHead) {
          // Pictures are authored facing up; rotate with the snake and overscan
          // so the corners stay covered while turning.
          const inner = hs * 0.84;
          ctx.save();
          ctx.beginPath();
          this.roundRect(ctx, hx - inner / 2, hy - inner / 2, inner, inner, hs * 0.24);
          ctx.clip();
          ctx.translate(hx, hy);
          ctx.rotate((s.dir || 0) * Math.PI / 2);
          ctx.drawImage(customHead, -hs * 0.62, -hs * 0.62, hs * 1.24, hs * 1.24);
          ctx.restore();
        } else {
          // eyes oriented by direction
          const d = DIR_VEC[s.dir] || DIR_VEC[1];
          const ex = -d.y;
          const ey = d.x; // perpendicular
          const eyeOff = hs * 0.22;
          const fwd = hs * 0.16;
          for (const side of [-1, 1]) {
            const cxp = hx + ex * eyeOff * side + d.x * fwd;
            const cyp = hy + ey * eyeOff * side + d.y * fwd;
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(cxp, cyp, hs * 0.13, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#0a0f1a';
            ctx.beginPath();
            ctx.arc(cxp + d.x * hs * 0.03, cyp + d.y * hs * 0.03, hs * 0.06, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // shield / spawn-shield rings
        if (shield || spawn) {
          const blink = spawn ? 0.4 + 0.6 * Math.abs(Math.sin(this.time / 130)) : 1;
          ctx.strokeStyle = spawn ? `rgba(226,232,240,${blink})` : 'rgba(56,189,248,0.9)';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(hx, hy, hs * 0.75, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (isMe) {
          ctx.strokeStyle = 'rgba(226,232,240,0.7)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          this.roundRect(ctx, hx - hs / 2 - 2, hy - hs / 2 - 2, hs + 4, hs + 4, hs * 0.34);
          ctx.stroke();
        }
      };

      const head = s.pts[0];
      for (const off of this.wrapOffsets(head.x, head.y)) drawPass(off.dx, off.dy);

      // nickname label
      const nick = this.nicknameFor(s.pid);
      if (nick) {
        const x = ox + (head.x + 0.5) * cell;
        const y = oy + (head.y + 0.5) * cell;
        ctx.globalAlpha = ghost ? 0.55 : 0.9;
        ctx.font = `600 ${Math.max(11, Math.round(cell * 0.42))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = isMe ? '#a7f3b9' : '#cbd5e1';
        ctx.fillText(nick, x, y - cell * 0.7);
      }
      ctx.restore();
    }

    /* ---------- particles ---------- */

    drawParticles() {
      const ctx = this.ctx;
      const cell = this.cell || 24;
      for (const p of this.particles) {
        const x = this.originX + (p.x + 0.5) * cell;
        const y = this.originY + (p.y + 0.5) * cell;
        if (p.ring) {
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = p.life;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, (1 - p.life) * cell * 2 + cell * 0.4, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.fillStyle = p.color;
          ctx.globalAlpha = p.life;
          const s = cell * 0.22 * p.life + 1;
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
      }
      ctx.globalAlpha = 1;
    }

    updateParticles() {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life -= p.decay;
        if (!p.ring) {
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= 0.96;
          p.vy *= 0.96;
        }
        if (p.life <= 0) this.particles.splice(i, 1);
      }
    }

    /* ---------- minimap ---------- */

    drawMinimap() {
      if (!this.mctx || !this.map || !this.next) return;
      const now = performance.now();
      if (now - this.minimapAt < 150) return;
      this.minimapAt = now;
      const m = this.minimap;
      const ctx = this.mctx;
      const scaleX = m.width / this.map.w;
      const scaleY = m.height / this.map.h;
      const theme = this.map.theme || {};
      ctx.fillStyle = theme.land || '#0a0f1a';
      ctx.fillRect(0, 0, m.width, m.height);
      if (this.map.water) {
        ctx.fillStyle = theme.water || '#0e1a2b';
        for (const [wx, wy, ww, wh] of this.map.water) {
          ctx.fillRect(wx * scaleX, wy * scaleY, ww * scaleX, wh * scaleY);
        }
      }
      if (this.map.islands) {
        ctx.fillStyle = theme.island || '#16231a';
        for (const isle of this.map.islands) {
          ctx.fillRect(isle.x * scaleX, isle.y * scaleY, isle.w * scaleX, isle.h * scaleY);
        }
      }
      if (this.map.obstacles) {
        ctx.fillStyle = theme.obstacleFill || '#1c2333';
        for (const [x, y, w, h] of this.map.obstacles) {
          ctx.fillRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
        }
      }
      for (const s of this.decodeSnakes(this.next)) {
        if (!s.pts.length) continue;
        const head = s.pts[0];
        ctx.fillStyle = s.pid === this.youPid ? '#2fbf4f' : s.pid === this.spectatePid ? '#38bdf8' : '#64748b';
        ctx.fillRect(head.x * scaleX - 1.5, head.y * scaleY - 1.5, 4, 4);
      }
      // viewport rectangle
      if (this.cell) {
        const vw = (this.w / this.cell) * scaleX;
        const vh = (this.h / this.cell) * scaleY;
        const vx = (this.viewCx || 0) * scaleX - vw / 2;
        const vy = (this.viewCy || 0) * scaleY - vh / 2;
        ctx.strokeStyle = 'rgba(226,232,240,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(vx, vy, vw, vh);
      }
    }

    roundRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }
  }

  SA.Renderer = Renderer;
})();
