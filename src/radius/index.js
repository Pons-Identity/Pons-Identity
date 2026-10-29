const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const db = require('../db');
const { verifyPassword } = require('../crypto');
const directories = require('../directories');
const ldap = require('../ldap');
const policies = require('../policies');
const factors = require('../factors');
const gm = require('../group-membership');
const totp = require('../totp');
const auditLog = require('../audit');
require('../authlog'); // turns the login events below into sign-in log rows
const context = require('../audit-context');
const packet = require('./packet');
const settings = require('./settings');

// This server as a RADIUS identity server (RFC 2865): network devices (VPN gateways, switches, wireless controllers, SSH jump
// hosts) send an Access-Request for a person and we answer Accept or Reject. What is supported, and why:
//   PAP         the device sends the password encrypted with the shared secret. We keep only one-way password hashes, so the
//               methods that need the plain or NT-hashed password (CHAP, MS-CHAP, EAP-MSCHAPv2) cannot be answered and are refused.
//   Second step an authenticator-app code, asked for with Access-Challenge (the device shows our prompt and sends the code back with
//               our State), or, per client, typed after the password ("secret123456").
// People are held to the same rules as at the sign-in page: disabled accounts, blocking policies, required and permitted factors,
// directory (LDAP) passwords, and a lockout after repeated failures. Risk-based rules are not applied, since the address
// we see is the device's, not the person's.

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 90 * 1000;
const REPLAY_TTL_MS = 30 * 1000;
const MAX_IN_FLIGHT = 200;
const UNKNOWN_LOG_MS = 10 * 60 * 1000;

const counters = { accepted: 0, rejected: 0, challenged: 0, dropped: 0, startedAt: null };
const failures = new Map(); // `${client}|${username}` -> [times]
const challenges = new Map(); // state hex -> { clientId, userId, expires }
const replies = new Map(); // `${client}:${id}:${authenticator}` -> { expires, response }
const unknownSeen = new Map();

const now = () => Date.now();
const sweep = (map) => { const t = now(); for (const [k, v] of map) if ((v.expires || 0) < t) map.delete(k); };

function recentFailures(key) {
  const t = now();
  const list = (failures.get(key) || []).filter((x) => t - x < FAILURE_WINDOW_MS);
  failures.set(key, list);
  return list;
}

const REJECT_TEXT = 'Authentication failed.';

// The attributes sent with an acceptance: the client's configured ones, those tied to a group only if the person is in it.
function replyAttributes(client, userId) {
  const memberOf = new Set(gm.effectiveGroupsOf(userId).map((g) => g.id));
  const out = [];
  for (const a of client.attributes) {
    if (a.group_id && !memberOf.has(a.group_id)) continue;
    if (a.attribute === 'VLAN') out.push(['Tunnel-Type', 13], ['Tunnel-Medium-Type', 6], ['Tunnel-Private-Group-Id', a.value]);
    else out.push([a.attribute, settings.REPLY_ATTRIBUTES[a.attribute].kind === 'text' ? a.value : Number(a.value)]);
  }
  return out;
}

// Looks the person up the way the sign-in page does (username or any of their addresses).
const findUser = (typed) => db.get('SELECT * FROM users WHERE username = ? OR email = ? OR id IN (SELECT user_id FROM user_emails WHERE email = ?) ORDER BY username = ? DESC', typed, typed, typed, typed);

/**
 * Answers one Access-Request already known to come from `client`. Resolves to { code, attributes, reason } where reason
 * is why a rejection happened (logged, never sent).
 */
async function authenticate(client, request, source) {
  const reject = (reason, user, typed) => {
    auditLog.user('login.failure', { outcome: 'failure', actor: user ? auditLog.who(user) : { type: 'anonymous', name: typed || '' },
      target: user ? { type: 'user', id: user.id, name: user.username } : undefined, detail: { reason, via: 'radius', client: client.name } });
    return { code: packet.CODES.ACCESS_REJECT, attributes: [['Reply-Message', REJECT_TEXT]], reason };
  };
  const accept = (user, amr) => {
    auditLog.user('login.success', { actor: auditLog.who(user), detail: { amr, via: 'radius', client: client.name } });
    return { code: packet.CODES.ACCESS_ACCEPT, attributes: replyAttributes(client, user.id) };
  };

  const typed = (packet.text(packet.first(request, 'User-Name')) || '').trim();
  if (!typed || typed.length > 256) return reject('missing_credentials', null, typed);
  if (packet.first(request, 'CHAP-Password') || packet.first(request, 'EAP-Message')) return reject('unsupported_method', null, typed);
  const encrypted = packet.first(request, 'User-Password');
  if (!encrypted) return reject('missing_credentials', null, typed);
  let password;
  try { password = packet.decryptPassword(encrypted, client.secret, request.authenticator); } catch { return reject('bad_password_attribute', null, typed); }

  const key = `${client.id}|${typed.toLowerCase()}`;
  if (recentFailures(key).length >= MAX_FAILURES) return reject('lockout', null, typed);
  const failed = (reason, user) => { recentFailures(key).push(now()); return reject(reason, user, typed); };

  // The second step of a challenge: the password field now holds the authenticator code.
  const state = packet.first(request, 'State');
  if (state) {
    sweep(challenges);
    const pending = challenges.get(state.toString('hex'));
    challenges.delete(state.toString('hex'));
    const user = pending && pending.clientId === client.id ? db.get('SELECT * FROM users WHERE id = ?', pending.userId) : null;
    if (!user || user.username.toLowerCase() !== typed.toLowerCase() || !user.active) return failed('challenge_expired', user);
    const step = user.totp_secret ? totp.verify(user.totp_secret, password, user.totp_last_step) : null;
    if (!step) {
      auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: 'totp', reason: 'bad_code', via: 'radius' } });
      return failed('bad_code', user);
    }
    db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    recentFailures(key).length = 0;
    return accept(user, ['pwd', 'otp']);
  }

  const existing = findUser(typed);
  // Does the second step arrive appended to the password? Only for people who will be asked for one.
  const needsSecondStep = (u) => Boolean(u && (factors.enrolled(u).length || u.mfa_enabled || policies.effectivePolicy(u.id).requireMfa));
  let secret = password;
  let appended = '';
  if (client.mfaMode === 'append' && needsSecondStep(existing) && /\d{6}$/.test(password) && password.length > 6) {
    secret = password.slice(0, -6);
    appended = password.slice(-6);
  }

  let user;
  let federated;
  try {
    federated = await directories.signIn(existing, typed, secret);
  } catch (e) {
    if (!(e instanceof ldap.DirectoryError)) throw e;
    console.error('RADIUS: directory sign-in failed:', e.message);
    return reject('directory_unavailable', null, typed);
  }
  if (federated) {
    if (federated.rejected) return failed('directory_rejected', existing);
    user = federated.user;
    if (!user.active) return failed('inactive', user);
  } else if (!(existing && existing.active && verifyPassword(secret, existing.password_hash))) {
    if (!existing) return failed('unknown_user');
    return failed(existing.active ? 'bad_credentials' : 'inactive', existing);
  } else {
    user = existing;
  }

  const policy = policies.effectivePolicy(user.id);
  if (policy.blockSignIn) return reject('blocked_by_policy', user, typed);
  if (client.groups.length) {
    const inGroup = gm.effectiveGroupsOf(user.id).some((g) => client.groups.includes(g.id));
    if (!inGroup) return reject('not_allowed_on_client', user, typed);
  }

  // The same question the sign-in page asks: does this person have to prove a second factor?
  if (!needsSecondStep(user)) return accept(user, ['pwd']);
  const usable = factors.eligible(user, policy);
  if (!user.totp_enabled || !user.totp_secret || !usable.some((f) => f.type === 'totp')) {
    // Security keys and codes sent by message need a web page; there is nothing to show them on a RADIUS prompt.
    return reject(usable.length ? 'no_radius_factor' : 'no_permitted_factor', user, typed);
  }
  if (appended) {
    const step = totp.verify(user.totp_secret, appended, user.totp_last_step);
    if (!step) {
      auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: 'totp', reason: 'bad_code', via: 'radius' } });
      return failed('bad_code', user);
    }
    db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    recentFailures(key).length = 0;
    return accept(user, ['pwd', 'otp']);
  }
  if (client.mfaMode === 'append') return failed('code_missing', user);
  sweep(challenges);
  const token = crypto.randomBytes(16);
  challenges.set(token.toString('hex'), { clientId: client.id, userId: user.id, expires: now() + CHALLENGE_TTL_MS });
  return { code: packet.CODES.ACCESS_CHALLENGE, attributes: [['Reply-Message', 'Enter the code from your authenticator app.'], ['State', token]], reason: 'challenge' };
}

/**
 * Handles one datagram from `source` ({ address, port }). Resolves to the response bytes, or null when nothing should be sent
 * (an unknown device, a damaged packet, a bad signature: RFC 2865 says to discard these silently).
 */
async function handle(buf, source, cfg = settings.get()) {
  const client = settings.matchClient(cfg.clients.filter((c) => c.enabled), source.address);
  if (!client) {
    counters.dropped += 1;
    const t = now();
    if (t - (unknownSeen.get(source.address) || 0) > UNKNOWN_LOG_MS) {
      unknownSeen.set(source.address, t);
      if (unknownSeen.size > 1000) unknownSeen.clear();
      context.run({ ip: source.address, userAgent: 'RADIUS' }, () => auditLog.system('radius.unknown_client', { outcome: 'failure', detail: { address: source.address } }));
    }
    return null;
  }
  let request;
  try { request = packet.parse(buf); } catch { counters.dropped += 1; return null; }
  if (request.code !== packet.CODES.ACCESS_REQUEST) { counters.dropped += 1; return null; }
  const signature = packet.checkMessageAuthenticator(request, client.secret);
  if (signature === 'invalid' || (signature === 'absent' && client.requireMessageAuthenticator)) {
    counters.dropped += 1;
    context.run({ ip: source.address, userAgent: `RADIUS ${client.name}` }, () => auditLog.system('radius.bad_request', { outcome: 'failure',
      detail: { client: client.name, reason: signature === 'invalid' ? 'bad_message_authenticator' : 'missing_message_authenticator' } }));
    return null;
  }

  // A device that did not hear our answer asks again with the same identifier and authenticator: send the same answer
  // (a code in a challenge may be used only once, and a retry must not count as another failure).
  sweep(replies);
  const replayKey = `${client.id}:${request.id}:${request.authenticator.toString('hex')}`;
  const seen = replies.get(replayKey);
  if (seen) return seen.response;

  // The answer is stored as a promise before it is ready, so a retry that arrives while we are still working shares it.
  const response = (async () => {
    const result = await context.run({ ip: source.address, userAgent: `RADIUS ${client.name}` }, () => authenticate(client, request, source));
    if (result.code === packet.CODES.ACCESS_ACCEPT) counters.accepted += 1;
    else if (result.code === packet.CODES.ACCESS_CHALLENGE) counters.challenged += 1;
    else counters.rejected += 1;
    return packet.respond(request, result.code, result.attributes, client.secret, { signed: signature === 'valid' });
  })();
  replies.set(replayKey, { expires: now() + REPLAY_TTL_MS, response });
  response.catch(() => replies.delete(replayKey));
  return response;
}

/* --------------------------------- The socket -------------------------------- */

let socket = null;
let status = { listening: false, port: null, address: null, error: '' };
let inFlight = 0;

function stop() {
  const s = socket;
  socket = null;
  status = { listening: false, port: null, address: null, error: '' };
  return new Promise((resolve) => { if (!s) return resolve(); try { s.close(resolve); } catch { resolve(); } });
}

/** (Re)starts the listener to match the saved settings. Never throws: a port that cannot be bound is reported in status(). */
async function apply() {
  await stop();
  const cfg = settings.get();
  if (!cfg.enabled) return status;
  const s = dgram.createSocket({ type: net.isIPv6(cfg.bindAddress) ? 'udp6' : 'udp4' });
  s.on('message', (msg, rinfo) => {
    if (inFlight >= MAX_IN_FLIGHT) { counters.dropped += 1; return; }
    inFlight += 1;
    handle(msg, rinfo).then((response) => { if (response) s.send(response, rinfo.port, rinfo.address); })
      .catch((e) => console.error('RADIUS request failed:', e.message))
      .finally(() => { inFlight -= 1; });
  });
  await new Promise((resolve) => {
    s.once('error', (e) => {
      status = { listening: false, port: cfg.port, address: cfg.bindAddress, error: e.code === 'EACCES' ? `Not allowed to listen on port ${cfg.port}. Use a port above 1023 or give the process permission.` : e.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use.` : e.message };
      console.error('RADIUS server could not start:', e.message);
      try { s.close(); } catch { /* not open */ }
      resolve();
    });
    s.bind(cfg.port, cfg.bindAddress, () => {
      socket = s;
      counters.startedAt = new Date().toISOString();
      status = { listening: true, port: s.address().port, address: s.address().address, error: '' };
      s.removeAllListeners('error');
      s.on('error', (e) => console.error('RADIUS socket error:', e.message));
      console.log(`RADIUS server listening on udp ${status.address}:${status.port}`);
      resolve();
    });
  });
  return status;
}

const getStatus = () => ({ ...status, counters: { ...counters } });

module.exports = { handle, apply, stop, getStatus, authenticate, MAX_FAILURES };
