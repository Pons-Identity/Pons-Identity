const db = require('./db');
const policies = require('./policies');
const factors = require('./factors');
const duo = require('./duo');

// "Remember me" for second factors. When a person completes a second factor in a browser, that browser keeps the proof for
// the period their policy sets (policies.rememberMfaHours), measured from when the factor was completed. Within the period
// a password sign-in from the same browser skips the second factor. Only the built-in factors are remembered, and only while
// Duo is off: Duo decides for itself each time, so it is never skipped.

const HOUR_MS = 3600 * 1000;

/** Keeps (or, when the policy remembers nothing, forgets) the factor this browser just completed. */
function remember(req, user, method, amr) {
  if (!req.deviceId || !method) return;
  if (!policies.effectivePolicy(user.id).rememberMfaHours || duo.enabled()) return forget(user.id, req.deviceId);
  db.run(`INSERT INTO mfa_remembered (user_id, device_id, factor_id, factor_type, amr, completed_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(user_id, device_id) DO UPDATE SET factor_id = excluded.factor_id, factor_type = excluded.factor_type,
          amr = excluded.amr, completed_at = excluded.completed_at`,
  user.id, req.deviceId, method.id, method.type, JSON.stringify(amr), Date.now());
}

const stillEnrolled = (user, method) => (method.id === 'totp' ? Boolean(user.totp_enabled) : factors.enrolled(user).some((f) => f.id === method.id));

/**
 * The factor this browser may skip again for this person right now, as { method, amr }, or null. `policy` is the person's
 * effective policy. A factor that has since been removed or is no longer permitted is never reused.
 */
function rememberedFor(req, user, policy) {
  if (!policy.rememberMfaHours || !req.deviceId || duo.enabled()) return null;
  const row = db.get('SELECT * FROM mfa_remembered WHERE user_id = ? AND device_id = ?', user.id, req.deviceId);
  if (!row || Date.now() - row.completed_at >= policy.rememberMfaHours * HOUR_MS) return null;
  const method = { id: row.factor_id, type: row.factor_type };
  if (!stillEnrolled(user, method) || !factors.permitted(method.type, factors.limitsOf(policy))) return null;
  return { method, amr: JSON.parse(row.amr) };
}

function forget(userId, deviceId) {
  return deviceId
    ? db.run('DELETE FROM mfa_remembered WHERE user_id = ? AND device_id = ?', userId, deviceId).changes
    : db.run('DELETE FROM mfa_remembered WHERE user_id = ?', userId).changes;
}

module.exports = { remember, rememberedFor, forget };
