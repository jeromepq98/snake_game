'use strict';

/* Headless bot clients for load testing.
   Usage:  node scripts/bot-client.js [count] [url] [seconds]
     count   number of bots (default 10)
     url     server origin (default http://localhost:PORT)
     seconds run duration, 0 = run forever (default 60)

   Each bot: hello -> join public arena -> steer randomly every ~250ms,
   boosting occasionally. Server-authoritative rules apply like any client. */

const { io } = require('socket.io-client');

const count = Math.max(1, parseInt(process.argv[2], 10) || 10);
const url = process.argv[3] || `http://localhost:${process.env.PORT || 3000}`;
const durationSec = parseInt(process.argv[4], 10);
const RUN_MS = durationSec > 0 ? durationSec * 1000 : Infinity;

const NICKS = ['Adder', 'Boa', 'Cobra', 'Mamba', 'Viper', 'Rattler', 'Python', 'Anaconda', 'Taipan', 'Krait', 'Keelback', 'Bushmaster'];

const bots = [];
let started = Date.now();

function spawnBot(i) {
  const socket = io(url, { reconnection: true, timeout: 8000 });
  const bot = {
    i,
    socket,
    pid: null,
    dir: 1,
    alive: false,
    score: 0,
    deaths: 0,
    inputs: 0,
  };
  bots.push(bot);

  socket.on('connect', () => {
    socket.emit('guest:hello', { nickname: `${NICKS[i % NICKS.length]}${i}` }, (res) => {
      if (!res.ok) return;
      socket.emit('game:join', { mode: 'arena', map: 'meadow' }, (join) => {
        if (join.ok) {
          bot.pid = join.you && join.you.pid;
          bot.alive = !join.spectating;
        }
      });
    });
  });

  socket.on('game:state', () => { /* states flow; bots don't need them */ });
  socket.on('game:death', () => { bot.deaths += 1; });
  socket.on('game:respawn', () => { bot.alive = true; });
  socket.on('game:players', (data) => {
    const me = (data.players || []).find((p) => p.pid === bot.pid);
    if (me) bot.score = me.score;
  });
  socket.on('disconnect', () => { bot.alive = false; });

  const think = () => {
    if (!socket.connected || !bot.alive) return;
    // 70% keep heading, 30% turn to a non-opposite direction.
    if (Math.random() < 0.3) {
      const turn = Math.random() < 0.5 ? (bot.dir + 1) % 4 : (bot.dir + 3) % 4;
      bot.dir = turn;
    }
    socket.emit('game:input', { type: 'dir', dir: bot.dir });
    bot.inputs += 1;
    socket.emit('game:input', { type: 'boost', on: Math.random() < 0.12 });
  };
  bot.timer = setInterval(think, 200 + Math.floor(Math.random() * 120));

  socket.on('connect_error', (err) => {
    process.stderr.write(`bot ${i} connect_error: ${err.message}\n`);
  });
}

for (let i = 0; i < count; i++) spawnBot(i);

const report = setInterval(() => {
  const up = bots.filter((b) => b.socket.connected).length;
  const totalScore = bots.reduce((a, b) => a + b.score, 0);
  const totalInputs = bots.reduce((a, b) => a + b.inputs, 0);
  const totalDeaths = bots.reduce((a, b) => a + b.deaths, 0);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[${elapsed}s] bots up=${up}/${bots.length} score=${totalScore} deaths=${totalDeaths} inputs sent=${totalInputs}`);
  if (Date.now() - started >= RUN_MS) shutdown(0);
}, 5000);

function shutdown(code) {
  clearInterval(report);
  for (const b of bots) {
    clearInterval(b.timer);
    b.socket.disconnect();
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`Spawned ${count} bots against ${url}${RUN_MS === Infinity ? ' (running until Ctrl+C)' : ` for ${durationSec}s`}`);
