const db = require('./db');

// Limits on guessing. Failures are rows in auth_failures, so they survive a new session, a new connection and a restart.
// A key is blocked while it has LIMIT or more failures in the last WINDOW_MS; the oldest one aging out unblocks it. A sign-in
// is checked against every key it counts toward (the account and the address it came from), so one address cannot work through
// many accounts and one account cannot be guessed at from many addresses without hitting the account's own limit.
//
// The cost is that someone who knows a username can keep that account locked out for as long as they keep failing. The window
// is short for that reason, and RADIUS already behaves the same way.

const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = {
  password: { account: 10, ip: 100 },
  totp: { account: 10 },
  sftp: { account: 10, ip: 100 },
  // Guesses at the one-time token that guards the first-run setup wizard.
  setup: { ip: 10 },
};

const now = () => Date.now();
const norm = (v) => String(v || '').trim().toLowerCase().slice(0, 256);

/** The keys a sign-in counts toward: `account` is whatever names the account (the typed username, a user id), `ip` the client address. */
const keysFor = (scope, { account, ip }) => [
  ...(LIMITS[scope].account && account !== undefined ? [[`acct:${norm(account)}`, LIMITS[scope].account]] : []),
  ...(LIMITS[scope].ip && ip ? [[`ip:${ip}`, LIMITS[scope].ip]] : []),
];

/** { blocked, retryAfter } (seconds until the oldest counted failure ages out) for a sign-in attempt that has not been checked yet. */
function check(scope, who) {
  const since = now() - WINDOW_MS;
  let retryAfter = 0;
  for (const [key, limit] of keysFor(scope, who)) {
    const rows = db.all('SELECT ts FROM auth_failures WHERE scope = ? AND key = ? AND ts > ? ORDER BY ts DESC LIMIT ?', scope, key, since, limit);
    if (rows.length >= limit) retryAfter = Math.max(retryAfter, Math.ceil((rows[rows.length - 1].ts + WINDOW_MS - now()) / 1000));
  }
  return { blocked: retryAfter > 0, retryAfter };
}

/** Counts one failure toward each key. */
function fail(scope, who) {
  const t = now();
  db.run('DELETE FROM auth_failures WHERE ts < ?', t - WINDOW_MS);
  for (const [key] of keysFor(scope, who)) db.run('INSERT INTO auth_failures (scope, key, ts) VALUES (?,?,?)', scope, key, t);
}

/** A success clears the account's count. The address's count stays: it is about everything that address has tried. */
function reset(scope, who) {
  if (who.account !== undefined) db.run('DELETE FROM auth_failures WHERE scope = ? AND key = ?', scope, `acct:${norm(who.account)}`);
}

module.exports = { check, fail, reset, WINDOW_MS, LIMITS };
