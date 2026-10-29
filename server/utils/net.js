'use strict';

// Behind a reverse proxy (Render, nginx, etc.) the TCP peer is the proxy, so
// per-IP limits must use the first X-Forwarded-For hop. Only trust it when the
// deployment explicitly opts in.
function clientIp(handshake, trustProxy) {
  if (trustProxy) {
    const fwd = handshake && handshake.headers && handshake.headers['x-forwarded-for'];
    if (typeof fwd === 'string') {
      const first = fwd.split(',')[0].trim();
      if (first) return first;
    }
  }
  return (handshake && handshake.address) || 'unknown';
}

module.exports = { clientIp };
