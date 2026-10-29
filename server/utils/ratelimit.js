'use strict';

const log = require('./logger');

class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerSec;
    this.last = Date.now();
  }

  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

// Bucket registry keyed by string (e.g. `${socketId}:${event}` or ip).
class BucketSet {
  constructor() {
    this.map = new Map();
    this.lastSweep = Date.now();
  }

  take(key, capacity, refillPerSec, n = 1) {
    let b = this.map.get(key);
    if (!b) {
      b = new TokenBucket(capacity, refillPerSec);
      this.map.set(key, b);
    }
    // Opportunistic sweep so idle buckets don't accumulate forever. Only drop
    // buckets idle for 10+ minutes; clearing the whole map would hand fresh
    // tokens to every connected client mid-abuse.
    if (this.map.size > 5000 && Date.now() - this.lastSweep > 30000) {
      this.lastSweep = Date.now();
      const cutoff = Date.now() - 600000;
      for (const [key, bucket] of this.map) {
        if (bucket.last < cutoff) this.map.delete(key);
      }
    }
    return b.take(n);
  }

  delete(key) {
    this.map.delete(key);
  }
}

const globalBuckets = new BucketSet();

// Wrap a socket handler with a per-socket, per-handler rate limit. Socket.IO
// invokes listeners with the socket bound as `this` and the payload (+ optional
// ack callback) as arguments, so the wrapped fn keeps its (socket, data, ack)
// signature regardless of whether the client sent an ack.
function limited(capacity, refillPerSec, fn) {
  // Each wrapped handler gets its own bucket set: gameplay input must not
  // drain the tokens used by chat/join/leave.
  const buckets = new BucketSet();
  return function rateLimitedHandler(...args) {
    const socket = this;
    const ack = args.length && typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    let acked = false;
    const reply = ack ? (payload) => {
      if (acked) return;
      acked = true;
      ack(payload);
    } : undefined;
    if (!buckets.take(socket.id, capacity, refillPerSec)) {
      if (reply) reply({ ok: false, error: 'rate_limited', message: 'Slow down a little.' });
      return;
    }
    const fail = (err) => {
      log.error(`socket handler failed: ${err && err.stack ? err.stack : err}`);
      if (reply) reply({ ok: false, error: 'server_error', message: 'Something went wrong. Try again.' });
    };
    try {
      const result = reply
        ? fn(socket, ...(args.length ? args : [undefined]), reply)
        : fn(socket, ...args);
      if (result && typeof result.catch === 'function') result.catch(fail);
    } catch (err) {
      fail(err);
    }
  };
}

module.exports = { TokenBucket, BucketSet, globalBuckets, limited };
