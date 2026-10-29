const crypto = require('crypto');
const db = require('./db');
const roles = require('./roles');
const policies = require('./policies');
const auditLog = require('./audit');
const appSettings = require('./app-settings');
const messaging = require('./messaging');
const msgSettings = require('./messaging/settings');
const userService = require('./user-service');
const identity = require('./identity');
const compromise = require('./compromise');
const { baseUrl } = require('./config');

// Forgotten-password recovery: a link, sent to the person's verified personal email address, that lets them choose a new
// password. Off until an administrator turns it on, and a policy can turn it off for a role or group.
//
// Two kinds of link. A password link (the default) sets a new password. An MFA link removes the person's second factors, so they
// set up a new one at their next sign-in. Either can be made to wait for an identity verification (identity/index.js): the
// verification must be approved after the link was sent, and it is the provider that approves it.
//
// What it will not do: recover accounts owned by an external directory (the password lives there), inactive or blocked
// accounts, or administrators (unless allowed in the settings). A password reset does not bypass a second factor: after the reset
// the person still signs in with it. An MFA reset is refused unless identity verification is required for it, so it is never a
// way around the second factor on its own. A request always gets the same answer whether or not an account matched, so it cannot be used to
// find out who has an account; the audit log records what actually happened.

const KEY = 'recovery';
const DEFAULTS = { enabled: false, allowAdmins: false };
const TOKEN_TTL = 30 * 60;
const MAX_REQUESTS_PER_HOUR = 3;

const get = () => ({ ...DEFAULTS, ...(appSettings.read(KEY) || {}) });

function parse(body, msg = msgSettings.messaging()) {
  const errors = [];
  const data = { enabled: Boolean(body.enabled), allowAdmins: Boolean(body.allowAdmins) };
  if (data.enabled && !msgSettings.configured('email', msg)) errors.push('Password recovery cannot be turned on until email delivery is set up under Messaging.');
  return { data, errors };
}
const save = (d) => appSettings.write(KEY, d);

/** Is recovery usable at all right now? Shown on the sign-in page. */
const available = () => get().enabled && msgSettings.configured('email');

const now = () => Math.floor(Date.now() / 1000);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mask = (e) => { const [u, d] = e.split('@'); return `${u.slice(0, 1)}${'*'.repeat(Math.max(u.length - 1, 1))}@${d}`; };

/** Why this person cannot recover by email (null = they can). Reasons are for the audit log, never for the requester. */
function ineligible(user, cfg = get()) {
  if (!cfg.enabled) return 'disabled';
  if (!user.active) return 'inactive';
  if (user.directory_id) return 'directory_account';
  const policy = policies.effectivePolicy(user.id);
  if (policy.blockSignIn) return 'blocked_by_policy';
  if (policy.disablePasswordRecovery) return 'disabled_by_policy';
  if (!user.personal_email || !user.personal_email_verified) return 'no_personal_email';
  if (!cfg.allowAdmins && roles.permissionsOf(user.id).size) return 'administrator';
  return null;
}

function candidates(identifier) {
  const id = identifier.trim();
  const direct = db.all(`SELECT * FROM users WHERE username = ? OR email = ? COLLATE NOCASE
                         OR id IN (SELECT user_id FROM user_emails WHERE email = ?) ORDER BY username = ? DESC LIMIT 1`, id, id, id, id);
  if (direct.length) return direct;
  // Someone who forgot which username they have may give their personal address: every account that lists it as verified.
  return db.all('SELECT * FROM users WHERE personal_email = ? COLLATE NOCASE AND personal_email_verified = 1 ORDER BY username LIMIT 5', id);
}

const KIND_TEXT = {
  password: { subject: 'Reset your {app} password', what: 'reset the password for the account', after: 'choose a new password' },
  mfa: { subject: 'Reset your {app} second factor', what: 'remove the second sign-in factors from the account', after: 'remove them' },
};

/**
 * Handles a recovery request. Returns nothing: the caller answers the same way regardless. Delivery runs after the answer is
 * sent (the caller does not wait), so response time does not reveal whether an email went out either. `purpose` is 'password'
 * (the default) or 'mfa'.
 */
async function request(identifier, { ip = '', purpose = 'password' } = {}) {
  if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 254) return;
  if (!KIND_TEXT[purpose]) return;
  if (purpose === 'mfa' && !identity.required('mfa_reset')) {
    auditLog.user('recovery.request', { outcome: 'failure', actor: { type: 'anonymous', name: identifier.trim().slice(0, 100) }, detail: { reason: 'mfa_reset_not_allowed', purpose } });
    return;
  }
  const cfg = get();
  const found = candidates(identifier);
  if (!found.length) {
    auditLog.user('recovery.request', { outcome: 'failure', actor: { type: 'anonymous', name: identifier.trim().slice(0, 100) }, detail: { reason: 'unknown_user' } });
    return;
  }
  for (const user of found) {
    const why = ineligible(user, cfg);
    const actor = { type: 'anonymous', name: user.username };
    if (why) { auditLog.user('recovery.request', { outcome: 'failure', actor, target: auditLog.who(user), detail: { reason: why, purpose } }); continue; }
    const recent = db.get('SELECT COUNT(*) AS n FROM recovery_tokens WHERE user_id = ? AND created_at > ?', user.id, now() - 3600).n;
    if (recent >= MAX_REQUESTS_PER_HOUR) { auditLog.user('recovery.request', { outcome: 'failure', actor, target: auditLog.who(user), detail: { reason: 'throttled' } }); continue; }

    // Only the newest link works. Older ones are marked used, not deleted, so the hourly count above still sees them.
    db.run('UPDATE recovery_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', now(), user.id);
    db.run('DELETE FROM recovery_tokens WHERE created_at < ?', now() - 86400);
    const token = crypto.randomBytes(32).toString('base64url');
    db.run('INSERT INTO recovery_tokens (user_id, token_hash, created_at, expires_at, ip, purpose) VALUES (?,?,?,?,?,?)', user.id, sha(token), now(), now() + TOKEN_TTL, ip, purpose);
    const app = appSettings.productName();
    const kind = KIND_TEXT[purpose];
    try {
      await messaging.send('email', user.personal_email, {
        subject: kind.subject.replace('{app}', app),
        text: `Someone asked to ${kind.what} "${user.username}" at ${app}.\n\nTo continue, open this link within 30 minutes:\n${baseUrl}/recover/${token}\n\n`
          + `If you did not ask for this, ignore this message: nothing will change.`,
      }, { rateKey: `recovery:${user.id}` });
      auditLog.user('recovery.request', { actor, target: auditLog.who(user), detail: { sent_to: mask(user.personal_email), purpose } });
    } catch (e) {
      db.run('DELETE FROM recovery_tokens WHERE token_hash = ?', sha(token));
      auditLog.user('recovery.request', { outcome: 'failure', actor, target: auditLog.who(user), detail: { reason: 'delivery_failed', purpose, error: e instanceof messaging.MessagingError ? e.message : 'unexpected' } });
    }
  }
}

/** The live token and its user, or null. Does not consume the token. */
function lookup(token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const row = db.get('SELECT * FROM recovery_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', sha(token), now());
  const user = row && db.get('SELECT * FROM users WHERE id = ?', row.user_id);
  return user && !ineligible(user) ? { row, user } : null;
}

/**
 * The identity verification a link is waiting on: 'none' when none is needed, 'approved' when one passed after the link was sent, or
 * the status of the latest one (or 'missing' when nothing has been started). `kind` is the link's purpose ('password' or 'mfa').
 */
function identityState(row, user) {
  const purpose = row.purpose === 'mfa' ? 'mfa_reset' : 'password_reset';
  if (!identity.required(purpose)) return { required: false, status: 'none' };
  const latestRow = identity.latest(user.id, purpose);
  const passed = latestRow && latestRow.status === 'approved' && latestRow.created_at >= row.created_at;
  return { required: true, purpose, status: passed ? 'approved' : latestRow && latestRow.created_at >= row.created_at ? latestRow.status : 'missing' };
}

/** Sets the new password. Resolves to { ok: true } or { error: 'invalid' | 'weak' | 'identity', message? }. */
async function complete(token, newPassword, { ip = '' } = {}) {
  const found = lookup(token);
  if (!found) {
    auditLog.user('recovery.failure', { outcome: 'failure', actor: { type: 'anonymous', name: '' }, detail: { reason: 'invalid_token' } });
    return { error: 'invalid' };
  }
  const { row, user } = found;
  if (row.purpose !== 'password') return { error: 'invalid' };
  const state = identityState(row, user);
  if (state.required && state.status !== 'approved') {
    auditLog.user('recovery.failure', { outcome: 'failure', actor: auditLog.who(user), target: auditLog.who(user), detail: { reason: 'identity_not_verified' } });
    return { error: 'identity', message: 'Verify your identity first.' };
  }
  if (typeof newPassword !== 'string') return { error: 'weak', message: 'Choose a new password.' };
  const weak = await policies.passwordErrors(user.id, newPassword);
  if (weak.length) return { error: 'weak', message: weak[0] };
  // The claim is atomic, so two requests with the same link cannot both succeed.
  const claimed = db.tx(() => {
    if (db.run('UPDATE recovery_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), row.id).changes === 0) return false;
    userService.setPassword(user.id, newPassword, { by: user.id, via: 'recovery' });
    return true;
  });
  if (!claimed) return { error: 'invalid' };
  userService.revokeSessions(user.id);
  auditLog.user('recovery.complete', { actor: auditLog.who(user), target: auditLog.who(user), detail: { ip } });
  // Tell the owner, so a reset they did not make does not go unnoticed. Best effort.
  const app = appSettings.productName();
  messaging.send('email', user.personal_email, {
    subject: `Your ${app} password was changed`,
    text: `The password for "${user.username}" at ${app} was just changed using password recovery. If this was not you, contact your administrator right away.`,
  }, { rateKey: `recovery-notice:${user.id}` }).catch(() => {});
  return { ok: true };
}

/**
 * Removes a person's second factors, for a link made for an MFA reset, once identity verification has passed for it. The person sets
 * up a new factor at their next sign-in. Resolves to { ok: true, removed } or { error }.
 */
async function completeMfaReset(token, { ip = '' } = {}) {
  const found = lookup(token);
  if (!found || found.row.purpose !== 'mfa') {
    auditLog.user('recovery.failure', { outcome: 'failure', actor: { type: 'anonymous', name: '' }, detail: { reason: 'invalid_token', purpose: 'mfa' } });
    return { error: 'invalid' };
  }
  const { row, user } = found;
  if (!identity.required('mfa_reset')) return { error: 'disabled' };
  const state = identityState(row, user);
  if (state.status !== 'approved') return { error: 'identity', message: 'Verify your identity first.' };
  const removed = db.tx(() => {
    if (db.run('UPDATE recovery_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), row.id).changes === 0) return null;
    return compromise.resetAuthenticators(user.id);
  });
  if (removed === null) return { error: 'invalid' };
  userService.revokeSessions(user.id);
  auditLog.user('recovery.mfa_reset', { actor: auditLog.who(user), target: auditLog.who(user), detail: { ip, removed } });
  const app = appSettings.productName();
  messaging.send('email', user.personal_email, {
    subject: `Your ${app} second factor was removed`,
    text: `The second sign-in factors for "${user.username}" at ${app} were removed using identity verification. If this was not you, contact your administrator right away.`,
  }, { rateKey: `recovery-notice:${user.id}` }).catch(() => {});
  return { ok: true, removed };
}

module.exports = { get, parse, save, available, ineligible, request, lookup, complete, completeMfaReset, identityState, mask, TOKEN_TTL };
