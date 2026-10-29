# Snake Arena

Real-time multiplayer Snake. **No account required** — anyone types a nickname and plays immediately. Nicknames are display names, not verified identities; guests with identical nicknames are distinguished by anonymous server-side guest sessions.

## Features

- **Instant guest play** — nickname-only entry (2–16 chars, profanity filter, character whitelist), random nickname generator, duplicate-nickname dedupe per room (`Nick`, `Nick#2`, …), nickname changes, session-token reconnection with a frozen-snake grace window.
- **Server-authoritative gameplay** — 10 ticks/second simulation on the server; clients only send intents (`dir`, `boost`). Compact per-tick snapshots (pid/skin/dir/flags + segment coords, food, power-ups) with client-side interpolation.
- **Two modes** — *Endless Arena* (instant respawns, persistent session score) and *Last Snake Standing* (2-minute rounds, no respawns, standings + intermission).
- **Five maps** — Hinunangan (the default: a stylized Southern Leyte coast with Hinunangan Bay, Das-ay River fords, San Pedro/San Pablo islands, Mt. Nacolod, and the Poblacion), Meadow (wraps), Maze, Islands, Duel; obstacles validated at spawn.
- **Power-ups** — Turbo, Shield, Magnet, Ghost, Double Points; golden food; boost burns length; kill feed; death drops food.
- **Custom snake heads** — upload any picture in Settings; it is center-cropped and resized to a 128×128 PNG in the browser, validated and stored server-side, then drawn rotated on your snake for everyone in the room. Remove it at any time; admins can clear offensive pictures. Pictures are tied to the guest session.
- **12 skins** — 10 free, 2 earned via achievements (Gold at score 200, Phantom at 25 career kills).
- **Matchmaking** — public rooms (auto-created per mode/map) and private rooms with shareable 5-char codes.
- **Spectate** — watch any public match, cycle between alive players.
- **Leaderboards** — daily / weekly / all-time by best score (server-computed), with suspicious-score flagging. Displayed honestly: guest progress is anonymous and may not be recoverable.
- **WebRTC voice chat** — optional, mute / volume / push-to-talk (hold `V`) / proximity mode, per-player block & report. Socket.IO carries signaling only; **audio never passes through the server**.
- **PWA** — installable, offline shell, generated PNG icons, service worker that never caches `/api` or `/socket.io` traffic (and never session tokens).
- **Admin dashboard** — `/admin`: live players/rooms, CPU/memory/event-loop/DB health, reports, kicks, temp/permanent bans, audit log, suspicious scores. Disabled unless `ADMIN_TOKEN` is set; shows no IPs or tokens.
- **Persistence** — MySQL via Aiven (TLS) with 15-table schema and migrations, or a zero-config in-memory mode for dev (no persistence).

## Quick start (local)

```bash
npm install
cp .env.example .env     # optional; sensible dev defaults work without MySQL
npm run dev              # http://localhost:3000
```

Without `DATABASE_URL` the server runs in **in-memory mode**: everything works (rooms, gameplay, leaderboards in-memory) but nothing survives restarts.

With MySQL available:

```bash
npm run migrate          # applies server/db/migrations/*.sql
npm start
```

### Other scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server with `--watch` |
| `npm start` | Production start |
| `npm run migrate` | Apply DB migrations |
| `npm run icons` | Regenerate PWA icons (`scripts/generate-icons.js`, pure Node/zlib) |
| `npm run test:engine` | Headless engine invariant tests (all maps × modes) |
| `npm run bots [n] [url] [secs]` | Spawn `n` headless bot clients for load testing |

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD / touch joystick | Steer |
| Space / Shift / BOOST button (touch) | Boost (burns length) |
| Enter | Chat |
| V (hold) | Push-to-talk when enabled |
| Esc | Leave room |

## Configuration

See [.env.example](.env.example) for the full list. Essentials:

- `PORT` — HTTP port (Render injects this automatically).
- `APP_SECRET` — long random string; hashes session tokens and IPs. **Set a strong value in production.**
- `ADMIN_TOKEN` — enables `/admin`. Empty = dashboard returns 503.
- `TRUST_PROXY` — set to `1` only when running behind a reverse proxy (Render already does). Makes IP-based rate limits and stored IP hashes use `X-Forwarded-For`. Leave unset for direct/local use.
- `DATABASE_URL` — Aiven service URI: `mysql://avnadmin:PASSWORD@host.aivencloud.com:PORT/defaultdb?ssl-mode=REQUIRED`. The `ssl-mode=REQUIRED` query param (Aiven format) is detected and enables TLS automatically.
- `DB_CA` — `@path` to Aiven CA file (or inline PEM) when the server should verify the CA.
- `MAX_PLAYERS_PER_ROOM`, `MAX_SPECTATORS_PER_ROOM`, `VOICE_CAP` — capacity limits.
- `SESSION_TTL_HOURS`, `RETENTION_DAYS` — guest session lifetime and inactive-record cleanup.
- `ICE_SERVERS` — JSON RTCIceServer array for WebRTC; add TURN for restrictive NATs.

## Deploying to Render + Aiven

### 1. Aiven MySQL

1. Create a MySQL service in [Aiven](https://aiven.io/).
2. Copy the **service URI** (`mysql://avnadmin:...@....aivencloud.com:.../defaultdb?ssl-mode=REQUIRED`).
3. Download the CA certificate (`ca.pem`) from the service overview.

### 2. Render

This repo includes `render.yaml` (Render Blueprint):

```bash
# from the Render dashboard: New → Blueprint → select this repo
```

Or manually: **New Web Service** → Node → build command `npm install && npm run icons`, start command `npm start`. Then set environment variables:

| Key | Value |
|---|---|
| `APP_SECRET` | generate: `openssl rand -hex 32` |
| `ADMIN_TOKEN` | your admin dashboard passcode |
| `TRUST_PROXY` | `1` (Render terminates TLS in front of the app) |
| `DATABASE_URL` | the Aiven service URI |
| `DB_CA` | `@ca.pem` and add `ca.pem` via Render **Secret Files** |

Run migrations once (Render Shell):

```bash
npm run migrate
```

Health checks hit `/api/healthz` (configured in `render.yaml`). Serve HTTPS/WSS from Render's edge — the app expects `wss://` automatically when the page is loaded over `https://`.

### Scaling past one instance

Socket.IO rooms live in process memory. To run multiple Node instances, add the [`@socket.io/redis-adapter`](https://socket.io/docs/v4/redis-adapter/) and point all instances at the same Redis; the game engine stays per-room on whichever instance owns the room (pin rooms by ID, e.g. with sticky sessions or a room-registry in Redis). MySQL is already shared. The voice mesh needs no server changes (peer-to-peer).

### Voice chat at scale

The built-in voice is a **WebRTC mesh** capped at 8 peers/room — fine for casual rooms. For larger rooms use an SFU such as [LiveKit](https://livekit.io/) or mediasoup: keep the existing Socket.IO signaling for session bootstrap, but exchange LiveKit/mediasoup tokens and connection info instead of SDP offers. No audio ever flows through this server; only signaling.

## Architecture

```
server/
  index.js            entry: HTTP + Socket.IO, security headers, static, ticker
  config.js           env parsing (Aiven TLS detection, ICE servers)
  utils/              logger, tokens (sha256 + safeEqual), profanity, validation, rate limits
  game/
    constants.js      all tuning values (tick, speeds, power-ups, skins, modes)
    maps.js           hinunangan / meadow / maze / islands / duel
    engine.js         server-authoritative simulation (occupancy grid, substeps)
    rooms.js          Room (members, chat, voice registry, reconnect grace) + RoomManager
  services/
    guest.js          guest sessions: hello/rename, one active socket per guest
    stats.js          delta flushes to DB, leaderboard UPSERTs, achievements
    moderation.js     reports, blocks, kicks, bans
    metrics.js        event-loop delay + CPU sampler for /admin
  db/
    migrations/       001_init.sql (14 tables), 002_player_heads.sql (custom heads)
    index.js          dual driver: mysql2 pool or in-memory fallback
    migrate.js        CLI migration runner
  http/
    routes.js         /api/healthz|config|live|leaderboard|nickname/random + custom-head endpoints
    admin.js          /api/admin/* (Bearer ADMIN_TOKEN)
  sockets/index.js    all Socket.IO event handlers, rate-limited
public/
  index.html          game UI (Bootstrap 5 CDN + custom theme)
  js/                 util, net, renderer, input, voice, game, app
  admin.html          admin dashboard (js/admin.js)
  sw.js, manifest…    PWA shell
tests/engine-test.js  headless invariants (bounds/ownership/caps, collisions, wrap)
scripts/bot-client.js load-testing bots
```

### Security notes

- Server validates every nickname, chat message, room code, and rate-limits every socket event (token bucket).
- Parameterized SQL everywhere; CSP locks scripts to `self` + cdn.jsdelivr.net.
- Session tokens are 32-byte random, stored sha256-hashed, compared with constant-time `safeEqual`, expire after `SESSION_TTL_HOURS`. A bare guest ID is **never** accepted as authentication.
- Client scores/movement are never trusted; suspicious scores (impossible given survival time) are flagged, not auto-deleted.
- IPs are only stored hashed (with `APP_SECRET`) and never exposed by any API.
- Custom head uploads are authenticated by the session token (never by nickname), rate-limited per guest/IP, and must be structurally valid PNGs within 512×512 and 256 KB. Images are served with `Content-Type: image/png`, `nosniff`, and immutable cache-busted URLs; SVG and other executable formats are rejected. Browsers rasterize and shrink pictures to 128×128 before upload, so no native image library runs on the server.
- Custom head pictures are public to anyone who knows the guest's room-visible ID. They are cosmetic only, never affect gameplay, and can be removed by the guest or an admin.

### Honest limitations

- Guest identity is per-device. Clearing browser data or switching devices creates a new guest; stats and unlocks are not recoverable, and the UI says so.
- Nicknames are not unique or verified — the room appends `#2`, `#3`… when two players pick the same one.

## License

MIT
