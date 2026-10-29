'use strict';

/* Shared helpers for the Snake Arena client. Exposes window.SA. */

const SA = window.SA || {};

SA.$ = (sel, root) => (root || document).querySelector(sel);
SA.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

SA.escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

SA.clamp = (v, min, max) => Math.max(min, Math.min(max, v));
SA.lerp = (a, b, t) => a + (b - a) * t;

SA.fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

SA.copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
};

/* ---------- guest session storage (token only; never cached by the service worker) ---------- */

const LS_GUEST = 'sa_guestId';
const LS_TOKEN = 'sa_token';
const LS_NICK = 'sa_nick';
const LS_PREFS = 'sa_prefs';

SA.session = {
  get() {
    return {
      guestId: localStorage.getItem(LS_GUEST) || null,
      token: localStorage.getItem(LS_TOKEN) || null,
      nickname: localStorage.getItem(LS_NICK) || null,
    };
  },
  save({ guestId, token, nickname }) {
    localStorage.setItem(LS_GUEST, guestId);
    if (token) localStorage.setItem(LS_TOKEN, token);
    localStorage.setItem(LS_NICK, nickname);
  },
  updateNick(nickname) {
    localStorage.setItem(LS_NICK, nickname);
  },
  clear() {
    localStorage.removeItem(LS_GUEST);
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_NICK);
  },
};

SA.prefs = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
    } catch (e) {
      return {};
    }
  },
  set(patch) {
    const merged = Object.assign({}, SA.prefs.get(), patch);
    localStorage.setItem(LS_PREFS, JSON.stringify(merged));
    return merged;
  },
};

/* ---------- toasts ---------- */

SA.toast = (message, type = 'info', ms = 3500) => {
  const box = SA.$('#toast-container');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast-item ${type === 'error' ? 'error' : type === 'gold' ? 'gold' : ''}`;
  el.textContent = message;
  box.appendChild(el);
  while (box.children.length > 5) box.removeChild(box.firstChild);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 350);
  }, ms);
};

/* ---------- misc ---------- */

SA.isTouch = () => window.matchMedia('(pointer: coarse)').matches;

SA.formatRoomChip = ({ mode, map, roomCode, players, spectators }) => {
  const parts = [];
  if (roomCode) parts.push(`code ${roomCode}`);
  parts.push(mode === 'round' ? 'Last Snake Standing' : 'Endless Arena');
  parts.push(map);
  parts.push(`${players}P${spectators ? ` +${spectators} watching` : ''}`);
  return parts.join(' · ');
};

/* ---------- custom snake heads ---------- */

SA.headUrl = (guestId, version) => (
  guestId && version
    ? `/api/head/${encodeURIComponent(guestId)}?v=${encodeURIComponent(version)}`
    : null
);

// Rasterize the chosen picture locally so the server only ever receives a
// small, bounded PNG (and never needs native image libraries).
SA.headPngFromFile = async (file) => {
  if (!file) throw new Error('Pick a picture first.');
  if (file.type === 'image/svg+xml') throw new Error('SVG files are not supported. Pick a PNG, JPEG, WebP or GIF.');
  if (file.size > 8 * 1024 * 1024) throw new Error('That picture is too large (max 8 MB).');
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('That file could not be opened as an image.'));
      im.src = objectUrl;
    });
    if (img.naturalWidth * img.naturalHeight > 20000000) {
      throw new Error('That picture has too many pixels. Pick a smaller one.');
    }
    const SIZE = 128;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Cover-fit: fill the square and center-crop the overflow.
    const scale = Math.max(SIZE / img.naturalWidth, SIZE / img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.drawImage(img, Math.round((SIZE - w) / 2), Math.round((SIZE - h) / 2), w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not prepare that picture.');
    return blob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

window.SA = SA;
