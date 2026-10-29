const crypto = require('crypto');
const db = require('../db');
const messaging = require('../messaging');
const templates = require('../messaging/templates');
const appSettings = require('../app-settings');
const factorSettings = require('./settings');
const auditLog = require('../audit');
const { baseUrl } = require('../config');

// Email, SMS and voice sign-in. A challenge is one message sent to one factor, valid for five minutes. Its way (mode) is set by
// the sign-in option the person chose (settings.js lists them):
//
//   code             a code of the configured length is sent and typed into the sign-in page. Only a hash is stored. Five tries.
//   number_match     the sign-in page shows a number; the device answers with it: following the link (email, SMS), pressing it on
//                    the keypad (voice), or replying to the message with it. Nothing is typed into the sign-in page. Three tries.
//   yes_no           unverified: nothing is shown on the sign-in page. The device answers Y or N (a reply, or 1 or 2 on the keypad).
//   yes_no_verified  the device answers yes with the number shown on the sign-in page, or no with N. Three tries.
//
// Adding a factor always uses a code, to prove the person owns the address or number. The text of each message comes from the
// message templates (messaging/templates.js), where an administrator can change it.

const TTL_SECONDS = 300;
const MAX_CODE_ATTEMPTS = 5;
const MAX_APPROVE_ATTEMPTS = 3;
const RESEND_GAP_SECONDS = 30;

const KIND = { code: 'mfa', number_match: 'mfaNumberMatch', yes_no: 'mfaYesNo', yes_no_verified: 'mfaYesNoVerified' };
const NUMBER_MODES = ['number_match', 'yes_no_verified'];

const now = () => Math.floor(Date.now() / 1000);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// A random number of `length` digits. Leading zeros are kept, so every value is equally likely.
const digits = (length) => String(crypto.randomInt(0, 10 ** length)).padStart(length, '0');

class ChallengeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Sends a challenge to a factor row, in the given mode. Returns { id, mode, number?, expires_in } where number is what the sign-in
 * page must show (number matching modes only). Throws ChallengeError (wait, or the message could not be sent).
 */
async function start({ user, factor, mode = 'code', purpose = 'login', cfg = factorSettings.get() }) {
  const channel = factor.type;
  const chosen = purpose === 'verify' ? 'code' : mode;
  const last = db.get('SELECT created_at FROM otp_challenges WHERE factor_id = ? ORDER BY created_at DESC LIMIT 1', factor.id);
  if (last && now() - last.created_at < RESEND_GAP_SECONDS) throw new ChallengeError('Wait a moment before asking for another message.', 429);

  const id = crypto.randomBytes(18).toString('base64url');
  const token = chosen === 'code' ? '' : crypto.randomBytes(32).toString('base64url');
  const row = { id, user_id: user.id, factor_id: factor.id, purpose, mode: chosen, code_hash: '', display_number: '', token_hash: '' };
  let code = '';
  if (chosen === 'code') {
    code = digits(factorSettings.codeLength(cfg));
    row.code_hash = sha(`${id}:${code}`);
  }
  if (NUMBER_MODES.includes(chosen)) row.display_number = digits(factorSettings.numberLength(cfg));
  if (token) row.token_hash = sha(token);

  const rendered = templates.render(KIND[chosen], channel, {
    appName: appSettings.productName(),
    username: user.username,
    displayName: user.display_name || user.username,
    expiresInMinutes: TTL_SECONDS / 60,
    code,
    link: chosen === 'number_match' && channel !== 'voice' ? `${baseUrl}/approve/${token}` : undefined,
  });
  const message = { subject: rendered.subject, text: rendered.text };
  if (channel === 'voice' && token) message.url = `${baseUrl}/factors/voice/${token}`;

  // Only one live challenge per factor, so an old message cannot be used after a new one is sent.
  db.run("UPDATE otp_challenges SET status = 'failed' WHERE factor_id = ? AND status IN ('pending', 'approved')", factor.id);
  db.run(`INSERT INTO otp_challenges (id, user_id, factor_id, purpose, mode, code_hash, display_number, token_hash, created_at, expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, row.id, row.user_id, row.factor_id, purpose, chosen, row.code_hash, row.display_number, row.token_hash, now(), now() + TTL_SECONDS);
  try {
    await messaging.send(channel, factor.destination, message, { rateKey: `factor:${factor.id}` });
  } catch (e) {
    db.run("UPDATE otp_challenges SET status = 'failed' WHERE id = ?", id);
    if (!(e instanceof messaging.MessagingError)) throw e;
    auditLog.user('mfa.delivery_failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: channel, error: e.message } });
    throw new ChallengeError('The message could not be sent. Try another method.', e.status === 429 ? 429 : 502);
  }
  auditLog.user('mfa.challenge_sent', { actor: auditLog.who(user), detail: { method: channel, mode: chosen, purpose } });
  return { id, mode: chosen, number: row.display_number || undefined, expires_in: TTL_SECONDS };
}

const live = (id, userId) => {
  const c = db.get('SELECT * FROM otp_challenges WHERE id = ? AND user_id = ?', id, userId);
  return c && c.expires_at > now() ? c : null;
};

/** Checks a typed code. Returns 'ok', 'bad', 'locked' or 'gone' (expired, used or never sent). */
function checkCode(id, userId, code) {
  const c = live(id, userId);
  if (!c || c.mode !== 'code' || c.status !== 'pending') return 'gone';
  if (c.attempts >= MAX_CODE_ATTEMPTS) return 'locked';
  db.run('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?', id);
  if (!same(c.code_hash, sha(`${id}:${String(code || '').replace(/\s+/g, '')}`))) {
    if (c.attempts + 1 >= MAX_CODE_ATTEMPTS) db.run("UPDATE otp_challenges SET status = 'failed' WHERE id = ?", id);
    return 'bad';
  }
  db.run("UPDATE otp_challenges SET status = 'consumed' WHERE id = ? AND status = 'pending'", id);
  return 'ok';
}

/** Compares a number the device sent back with the one on the sign-in page. Returns 'ok', 'bad' or 'locked'. */
function matchNumber(c, number) {
  if (c.attempts >= MAX_APPROVE_ATTEMPTS) return 'locked';
  db.run('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?', c.id);
  if (!same(c.display_number, String(number || '').trim())) {
    if (c.attempts + 1 >= MAX_APPROVE_ATTEMPTS) {
      db.run("UPDATE otp_challenges SET status = 'failed' WHERE id = ?", c.id);
      return 'locked';
    }
    return 'bad';
  }
  db.run("UPDATE otp_challenges SET status = 'approved' WHERE id = ? AND status = 'pending'", c.id);
  return 'ok';
}

// The challenge a device token belongs to, when it is still waiting for an answer. Used by the links and by voice calls.
const byToken = (token) => {
  const c = db.get("SELECT * FROM otp_challenges WHERE token_hash = ? AND mode != 'code' AND token_hash != ''", sha(String(token)));
  return c && c.expires_at > now() && c.status === 'pending' ? c : null;
};

/** The device-side check for a link or a keypad entry: the number, for the number matching modes. */
function approve(token, number) {
  const c = byToken(token);
  if (!c || !NUMBER_MODES.includes(c.mode)) return 'gone';
  return matchNumber(c, number);
}

/** A voice call's answer to a yes or no question: '1' or 'yes' approves, '2' or 'no' denies. */
function answerByVoice(token, answer) {
  const c = byToken(token);
  if (!c || c.mode !== 'yes_no') return 'gone';
  const decision = decide(answer);
  if (decision === 'yes') { db.run("UPDATE otp_challenges SET status = 'approved' WHERE id = ? AND status = 'pending'", c.id); return 'approved'; }
  if (decision === 'no') { db.run("UPDATE otp_challenges SET status = 'failed' WHERE id = ?", c.id); return 'denied'; }
  return 'unclear';
}

// Reads a yes or no answer: y/yes and n/no, the words a caller says, or (keypad = true) the keys 1 and 2.
function decide(answer, { keypad = true } = {}) {
  const s = String(answer || '').trim().toLowerCase();
  const yes = keypad ? /^(y|yes|1)$/ : /^(y|yes)$/;
  const no = keypad ? /^(n|no|2)$/ : /^(n|no)$/;
  if (yes.test(s) || /^yes\b/.test(s)) return 'yes';
  if (no.test(s) || /^no\b/.test(s)) return 'no';
  return 'unclear';
}

/**
 * A reply to a sign-in message. Matched only to a pending challenge sent to the same address or number, so a stray reply
 * approves nothing. Returns 'approved', 'denied', 'bad', 'locked', 'unclear' or 'none' (no sign-in is waiting for this sender).
 */
function reply({ channel, from, text }) {
  const address = channel === 'email' ? String(from || '').trim().toLowerCase() : String(from || '').trim();
  if (!address) return 'none';
  const c = db.get(`SELECT c.* FROM otp_challenges c JOIN user_factors f ON f.id = c.factor_id
    WHERE f.type = ? AND f.verified = 1 AND lower(f.destination) = ? AND c.mode != 'code' AND c.status = 'pending' AND c.expires_at > ?
    ORDER BY c.created_at DESC LIMIT 1`, channel, address, now());
  if (!c) return 'none';
  const decision = decide(text, { keypad: false });
  let result;
  if (c.mode === 'yes_no') {
    result = decision === 'yes' ? 'approved' : decision === 'no' ? 'denied' : 'unclear';
    if (result === 'approved') db.run("UPDATE otp_challenges SET status = 'approved' WHERE id = ? AND status = 'pending'", c.id);
    if (result === 'denied') db.run("UPDATE otp_challenges SET status = 'failed' WHERE id = ?", c.id);
  } else if (decision === 'no' && c.mode === 'yes_no_verified') {
    db.run("UPDATE otp_challenges SET status = 'failed' WHERE id = ?", c.id);
    result = 'denied';
  } else {
    const found = /\d+/.exec(String(text || ''));
    if (!found) result = 'unclear';
    else result = { ok: 'approved', bad: 'bad', locked: 'locked' }[matchNumber(c, found[0])];
  }
  auditLog.user('mfa.reply', { outcome: result === 'approved' ? 'success' : result === 'unclear' ? 'unknown' : 'failure', actor: { type: 'anonymous', name: channel },
    detail: { method: channel, mode: c.mode, result } });
  return result;
}

/** The prompt a voice call reads out for a waiting challenge, and how many keys to collect: { mode, length, text }. */
function voicePrompt(token) {
  const c = byToken(token);
  if (!c) return null;
  const u = db.get('SELECT username, display_name FROM users WHERE id = ?', c.user_id);
  const text = templates.render(KIND[c.mode], 'voice', {
    appName: appSettings.productName(), username: u.username, displayName: u.display_name || u.username, expiresInMinutes: TTL_SECONDS / 60,
  }).text;
  return { mode: c.mode, length: c.display_number.length, text };
}

/** For the sign-in page's polling: 'waiting', 'approved' (and consumed, once), 'failed'. */
function pollApproval(id, userId) {
  const c = db.get('SELECT * FROM otp_challenges WHERE id = ? AND user_id = ?', id, userId);
  if (!c || c.mode === 'code') return 'failed';
  if (c.status === 'approved' && c.expires_at > now()) {
    return db.run("UPDATE otp_challenges SET status = 'consumed' WHERE id = ? AND status = 'approved'", id).changes ? 'approved' : 'failed';
  }
  if (c.status === 'pending' && c.expires_at > now()) return 'waiting';
  return 'failed';
}

module.exports = { start, checkCode, approve, answerByVoice, reply, voicePrompt, byToken, pollApproval, ChallengeError, TTL_SECONDS };
