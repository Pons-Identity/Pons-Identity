const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

// Per-request context so code far from the route handler (sps.js, directories.js, ...) can still record
// who did something, from where, without being handed `req`.
const store = new AsyncLocalStorage();

function middleware(req, res, next) {
  store.run({
    requestId: crypto.randomUUID(),
    ip: req.ip || (req.socket && req.socket.remoteAddress) || '',
    userAgent: String(req.get('user-agent') || '').slice(0, 300),
    req,
  }, next);
}

const current = () => store.getStore() || null;

/** Runs `fn` with a context for work that does not arrive as an HTTP request (RADIUS, jobs): `ip`, `userAgent` and a stand-in `req`. */
function run({ ip = '', userAgent = '' } = {}, fn) {
  const req = { ip, get: (h) => (String(h).toLowerCase() === 'user-agent' ? userAgent : ''), deviceId: '' };
  return store.run({ requestId: crypto.randomUUID(), ip, userAgent: String(userAgent).slice(0, 300), req }, fn);
}

module.exports = { middleware, current, run };
