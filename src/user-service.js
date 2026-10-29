const db = require('./db');
const { hashPassword } = require('./crypto');
const { newGuid } = require('./guid');
const { USER_FIELDS, saveCustom } = require('./admin-data');
const { addDirect } = require('./group-membership');
const { HISTORY_LIMIT } = require('./password-rules');

// The one place a local password is written, so every route records who changed it and how. `by` is the acting
// user's id (the person themselves for 'self' and 'recovery'), or null when the system did it.
const PASSWORD_VIA = ['self', 'admin', 'recovery', 'api', 'bulk'];

function setPasswordHash(userId, hash, { by = null, via }) {
  if (!PASSWORD_VIA.includes(via)) throw new Error(`Unknown password change source: ${via}`);
  // A new password makes any recovery link already sent useless.
  db.run('DELETE FROM recovery_tokens WHERE user_id = ?', userId);
  // Remember it so a password policy can refuse reuse; only the newest HISTORY_LIMIT are kept.
  if (hash) {
    db.run('INSERT INTO password_history (user_id, password_hash) VALUES (?, ?)', userId, hash);
    db.run('DELETE FROM password_history WHERE user_id = ? AND id NOT IN (SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)', userId, userId, HISTORY_LIMIT);
  }
  db.run("UPDATE users SET password_hash = ?, password_changed_at = datetime('now'), password_changed_by = ?, password_changed_via = ?, password_change_required = 0 WHERE id = ?",
    hash, by, via, userId);
}

/**
 * Makes these local accounts choose a new password before they do anything else, even in a session already open (the flag is
 * checked on every request). Directory accounts are skipped: their password is not ours to change. Returns how many were marked.
 */
function requirePasswordChange(userIds) {
  let marked = 0;
  for (const id of userIds) {
    marked += db.run('UPDATE users SET password_change_required = 1 WHERE id = ? AND directory_id IS NULL AND password_change_required = 0', id).changes;
  }
  return marked;
}

const setPassword = (userId, password, source) => setPasswordHash(userId, hashPassword(password), source);

// Ends a person's signed-in sessions, so deactivating or deleting them takes effect immediately. `except` is a session to keep.
function revokeSessions(userId, { except } = {}) {
  for (const r of db.all('SELECT sid, data FROM sessions')) {
    if (r.sid === except) continue;
    try {
      if (JSON.parse(r.data).userId === userId) db.run('DELETE FROM sessions WHERE sid = ?', r.sid);
    } catch { /* an unreadable session cannot belong to anyone */ }
  }
}

// Inserts a local account and everything stored beside it, inside the caller's or its own transaction. `spec` is
// { fields (USER_FIELDS), mfa_enabled, active, passwordHash, emails, attributes, custom, groupIds }; `extra(id)` lets a
// caller add its own rows (roles) in the same transaction.
function insertUser(spec, { by = null, via }, extra) {
  return db.tx(() => {
    const f = spec.fields;
    const r = db.run(
      `INSERT INTO users (guid, password_hash, ${USER_FIELDS.join(', ')}, mfa_enabled, active)
       VALUES (?, ?, ${USER_FIELDS.map(() => '?').join(', ')}, ?, ?)`,
      newGuid(), '', ...USER_FIELDS.map((k) => f[k] ?? ''), spec.mfa_enabled ? 1 : 0, spec.active === false ? 0 : 1);
    const id = Number(r.lastInsertRowid);
    setPasswordHash(id, spec.passwordHash, { by, via });
    saveEmails(id, spec.emails || []);
    if (spec.personalEmail) setPersonalEmail(id, spec.personalEmail, { verified: true });
    saveCustom(id, spec.custom || '', spec.attributes || {});
    for (const g of spec.groupIds || []) addDirect(g, id);
    if (extra) extra(id);
    return id;
  });
}

// What an administrator or the user sees about the last change. The changer's name is looked up now, so a deleted
// account shows as null while the id is kept.
function passwordInfo(user) {
  if (!user.password_changed_at) return null;
  const by = user.password_changed_by && db.get('SELECT id, username, display_name FROM users WHERE id = ?', user.password_changed_by);
  return {
    changed_at: user.password_changed_at,
    via: user.password_changed_via,
    by: by ? { id: by.id, username: by.username, display_name: by.display_name } : null,
    by_self: user.password_changed_by === user.id,
  };
}

const MAX_EMAILS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emailsOf = (userId) => db.all('SELECT email, is_primary FROM user_emails WHERE user_id = ? ORDER BY is_primary DESC, id', userId)
  .map((r) => ({ email: r.email, primary: !!r.is_primary }));

// The addresses a form or API call asks for, as { emails: [{ email, primary }], errors }. Entries may be strings or
// { email, primary }. Without an `emails` list the single `email` field is the primary and any other addresses the
// person already has are kept. With none flagged primary the first is. `currentId` is the person being edited.
function readEmails(body, email, currentId = null) {
  const errors = [];
  let list;
  if (Array.isArray(body.emails)) {
    list = body.emails.map((e) => (typeof e === 'string' ? { email: e, primary: false } : { email: e && e.email, primary: !!(e && e.primary) }));
  } else {
    const others = currentId ? emailsOf(currentId).filter((e) => !e.primary) : [];
    list = [...(email ? [{ email, primary: true }] : []), ...others.map((e) => ({ ...e, primary: false }))];
  }
  list = list.map((e) => ({ email: typeof e.email === 'string' ? e.email.trim() : '', primary: e.primary })).filter((e) => e.email);
  if (list.length > MAX_EMAILS) errors.push(`At most ${MAX_EMAILS} email addresses are allowed.`);
  // An address a person already holds is never reported, so legacy duplicates do not block unrelated edits.
  const own = currentId && db.get('SELECT email FROM users WHERE id = ?', currentId);
  const seen = new Set();
  for (const e of list) {
    const key = e.email.toLowerCase();
    if (!EMAIL_RE.test(e.email)) errors.push(`"${e.email}" is not a valid email address.`);
    else if (seen.has(key)) errors.push(`"${e.email}" is listed more than once.`);
    else if (!(own && own.email.toLowerCase() === key) && db.get(`SELECT 1 FROM user_emails WHERE email = ? AND user_id != ?
                     UNION SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?`, e.email, currentId || 0, e.email, currentId || 0)) {
      errors.push(`"${e.email}" belongs to another user.`);
    }
    seen.add(key);
  }
  if (list.filter((e) => e.primary).length > 1) errors.push('Only one email address can be primary.');
  if (list.length && !list.some((e) => e.primary)) list[0].primary = true;
  return { emails: list, errors };
}

// Replaces a person's addresses and mirrors the primary into users.email. Call inside a transaction.
function saveEmails(userId, emails) {
  db.run('DELETE FROM user_emails WHERE user_id = ?', userId);
  for (const e of emails) db.run('INSERT INTO user_emails (user_id, email, is_primary) VALUES (?, ?, ?)', userId, e.email, e.primary ? 1 : 0);
  const primary = emails.find((e) => e.primary);
  db.run('UPDATE users SET email = ? WHERE id = ?', primary ? primary.email : '', userId);
}

// Why a personal (recovery) email address cannot be used, or null. Organizational addresses are refused, since a recovery
// address must not depend on the organization's mailbox. An empty address is fine: it clears the field.
// `orgEmails` is the list the person will have (when it is being changed in the same request); otherwise their stored one.
function personalEmailError(userId, email, orgEmails) {
  const e = typeof email === 'string' ? email.trim() : '';
  if (!e) return null;
  if (!EMAIL_RE.test(e) || e.length > 254) return 'Enter a valid personal email address.';
  const org = orgEmails || (userId ? emailsOf(userId) : []);
  if (org.some((m) => m.email.toLowerCase() === e.toLowerCase())) return 'The recovery address must be different from the organizational addresses.';
  return null;
}

// Sets or clears the personal email. `verified` is true when the person proved they own it, or an administrator vouched for it.
// Returns an error message or null.
function setPersonalEmail(userId, email, { verified }) {
  const err = personalEmailError(userId, email);
  if (err) return err;
  const e = typeof email === 'string' ? email.trim() : '';
  db.run('UPDATE users SET personal_email = ?, personal_email_verified = ? WHERE id = ?', e, e && verified ? 1 : 0, userId);
  return null;
}

module.exports = { personalEmailError, setPersonalEmail, setPassword, setPasswordHash, requirePasswordChange, revokeSessions, insertUser, passwordInfo, PASSWORD_VIA, emailsOf, readEmails, saveEmails, MAX_EMAILS };
