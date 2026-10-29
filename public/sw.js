'use strict';

// Snake Arena service worker: app-shell caching for PWA install & offline shell.
// Live multiplayer requires connectivity — the game API and Socket.IO are never
// cached, and no session tokens are ever stored in the cache (localStorage only).

const VERSION = 'snake-arena-v4';
const SHELL = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/css/admin.css',
  '/js/util.js',
  '/js/net.js',
  '/js/renderer.js',
  '/js/input.js',
  '/js/voice.js',
  '/js/game.js',
  '/js/app.js',
  '/js/admin.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];
const CDN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Never cache live data or signaling traffic.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

    if (req.mode === 'navigate') {
      event.respondWith(
        fetch(req, { cache: 'no-cache' })
          .then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put('/', copy));
            return res;
          })
          .catch(() => caches.match('/').then((cached) => cached || caches.match('/offline.html'))),
      );
      return;
    }

    // Static assets: network-first so app updates land immediately, with the
    // cached copy as the offline fallback.
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  if (url.origin === CDN) {
    // Cache the Bootstrap CDN bundle so the installed app still styles offline.
    event.respondWith(
      caches.match(req).then(
        (cached) => cached
          || fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((cache) => cache.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
