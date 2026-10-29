'use strict';

/* Input: keyboard steering + boost, and a touch joystick with hysteresis
   so jitter around sector boundaries doesn't spam direction changes. */

(function () {
  const { $ } = SA;

  const KEY_DIRS = {
    ArrowUp: 0, KeyW: 0,
    ArrowRight: 1, KeyD: 1,
    ArrowDown: 2, KeyS: 2,
    ArrowLeft: 3, KeyA: 3,
  };

  class Input {
    constructor({ onDir, onBoost, onChat, onEscape }) {
      this.onDir = onDir;
      this.onBoost = onBoost;
      this.onChat = onChat;
      this.onEscape = onEscape;
      this.lastDirSent = null;
      this.boostOn = false;
      this.touchDir = null; // current joystick direction (0-3) or null
      this.enabled = false;
      this.keyHandler = (e) => this.onKey(e, true);
      this.keyUpHandler = (e) => this.onKey(e, false);
      this.attach();
    }

    attach() {
      window.addEventListener('keydown', this.keyHandler);
      window.addEventListener('keyup', this.keyUpHandler);
      this.setupJoystick();
      this.setupBoostButton();
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) {
        this.lastDirSent = null;
        this.touchDir = null;
        if (this.boostOn) this.setBoost(false);
        this.resetJoystick();
      }
    }

    onKey(e, down) {
      if (!this.enabled) return;
      const tag = document.activeElement && document.activeElement.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (typing) return;
      const dir = KEY_DIRS[e.code];
      if (dir !== undefined) {
        e.preventDefault();
        if (down) this.sendDir(dir);
        return;
      }
      if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        e.preventDefault();
        if (down && !e.repeat) this.setBoost(true);
        if (!down) this.setBoost(false);
        return;
      }
      if (down && e.code === 'Enter' && this.onChat) {
        e.preventDefault();
        this.onChat();
        return;
      }
      if (down && e.code === 'Escape' && this.onEscape) {
        e.preventDefault();
        this.onEscape();
      }
    }

    sendDir(dir) {
      // The client only suppresses obvious repeats and 180° flips; the server
      // re-validates everything.
      if (this.lastDirSent !== null && (dir === this.lastDirSent || dir === (this.lastDirSent + 2) % 4)) return;
      this.lastDirSent = dir;
      this.onDir(dir);
    }

    setBoost(on) {
      if (this.boostOn === on) return;
      this.boostOn = on;
      this.onBoost(on);
    }

    /* ---------- touch joystick ---------- */

    setupJoystick() {
      const pad = $('#joystick');
      const knob = $('#joystick-knob');
      if (!pad || !knob) return;
      this.joy = { pad, knob, active: false, cx: 0, cy: 0, radius: 45 };
      const onStart = (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.joy.active = true;
        const r = pad.getBoundingClientRect();
        this.joy.cx = r.left + r.width / 2;
        this.joy.cy = r.top + r.height / 2;
        this.joy.radius = r.width / 2 - 12;
        this.joyMove(e);
      };
      const onMoveAny = (e) => {
        if (!this.joy.active) return;
        e.preventDefault();
        this.joyMove(e);
      };
      const onEnd = () => {
        if (!this.joy.active) return;
        this.joy.active = false;
        this.resetJoystick();
      };
      pad.addEventListener('touchstart', onStart, { passive: false });
      pad.addEventListener('touchmove', onMoveAny, { passive: false });
      pad.addEventListener('touchend', onEnd);
      pad.addEventListener('touchcancel', onEnd);
      // Mouse fallback for desktop testing of the joystick.
      pad.addEventListener('mousedown', onStart);
      window.addEventListener('mousemove', (e) => {
        if (this.joy.active) this.joyMove(e);
      });
      window.addEventListener('mouseup', onEnd);
    }

    joyMove(e) {
      const t = e.touches ? e.touches[0] : e;
      if (!t) return;
      let dx = t.clientX - this.joy.cx;
      let dy = t.clientY - this.joy.cy;
      const dist = Math.hypot(dx, dy);
      const max = this.joy.radius;
      if (dist > max) {
        dx = (dx / dist) * max;
        dy = (dy / dist) * max;
      }
      this.joy.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const dead = max * 0.3;
      if (dist < dead) return; // dead zone: keep current direction
      // Stick angle in degrees, 0 = up, clockwise (up=0 right=90 down=180 left=270).
      const stickDeg = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
      const sector = Math.floor(((stickDeg + 45) % 360) / 90); // 0 up, 1 right, 2 down, 3 left
      if (this.touchDir !== null) {
        // Hysteresis: stick must leave the current sector's ±45° band to switch.
        let diff = Math.abs(stickDeg - this.touchDir * 90);
        if (diff > 180) diff = 360 - diff;
        if (diff < 45) return;
      }
      this.touchDir = sector;
      this.lastDirSent = sector;
      this.onDir(sector);
    }

    resetJoystick() {
      if (!this.joy) return;
      this.joy.knob.style.transform = 'translate(-50%, -50%)';
    }

    /* ---------- boost button ---------- */

    setupBoostButton() {
      const btn = $('#boost-btn');
      if (!btn) return;
      const on = (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        btn.classList.add('active');
        this.setBoost(true);
      };
      const off = (e) => {
        e.preventDefault();
        btn.classList.remove('active');
        this.setBoost(false);
      };
      btn.addEventListener('touchstart', on, { passive: false });
      btn.addEventListener('touchend', off);
      btn.addEventListener('touchcancel', off);
      btn.addEventListener('mousedown', on);
      btn.addEventListener('mouseup', off);
      btn.addEventListener('mouseleave', off);
    }

    /* True when the on-screen controls should be visible. */
    static shouldShowTouchUI() {
      return SA.isTouch();
    }
  }

  SA.Input = Input;
})();
