const crypto = require('crypto');
const { utils: sshUtils } = require('ssh2');
const db = require('./db');
const passwords = require('./crypto');
const files = require('./files/store');

// Service accounts: sign-in names for other software that exchanges files with this server over SFTP. They are separate from
// people: a service account cannot sign in to the console or any other page, and a person's username does not clash with one.
// Each has a password, one or more SSH public keys, or both, and grants (see files/store.js) for the directories it may use.

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const MAX_KEYS = 20;
const MAX_DESCRIPTION = 500;
const MIN_PASSWORD = 12;
const MAX_ACCOUNTS = 500;

const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// A public key as a short label for lists: its type and comment (the key itself is shown in the form).
const keyLabel = (k) => (k.comment ? `${k.type} ${k.comment}` : k.type);

/** A parsed key from its OpenSSH text, or null. */
function parsePublicKey(text) {
  const parsed = sshUtils.parseKey(text.trim());
  if (parsed instanceof Error || !parsed || parsed.isPrivateKey()) return null;
  return parsed;
}

const view = (r) => ({
  id: r.id,
  username: r.username,
  description: r.description,
  enabled: Boolean(r.enabled),
  has_password: Boolean(r.password_hash),
  public_keys: parseJson(r.public_keys, []),
  key_labels: parseJson(r.public_keys, []).map((k) => {
    const parsed = parsePublicKey(k);
    return parsed ? keyLabel(parsed) : k.split(' ')[0];
  }),
  grants: parseJson(r.grants, []),
  locked_down: Boolean(r.locked_down),
  lockdown: r.locked_down ? { started_at: r.lockdown_started_at, started_by: r.lockdown_started_by, keys_suspended: parseJson(r.suspended_keys, []).length, enabled_before: Boolean(r.lockdown_enabled_before) } : null,
  created_at: r.created_at,
  created_by: r.created_by,
  updated_at: r.updated_at,
});

const list = () => db.all('SELECT * FROM service_accounts ORDER BY username COLLATE NOCASE').map(view);
const get = (id) => { const r = db.get('SELECT * FROM service_accounts WHERE id = ?', Number(id)); return r ? view(r) : null; };

/** A new password, shown once. Long enough for the policy and easy to copy. */
const generatePassword = () => crypto.randomBytes(18).toString('base64url');

/**
 * Validates a service account from its form. `existingId` is set when editing. Returns { data, errors }, where `data.password`
 * is the plain password to store (hashed by the caller) or undefined to keep the current one.
 */
function parse(body, existingId = null) {
  const errors = [];
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!USERNAME_RE.test(username)) errors.push('The name is 2 to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit.');
  else if (db.get('SELECT 1 FROM service_accounts WHERE username = ? COLLATE NOCASE AND id != ?', username, existingId || 0)) errors.push('A service account with that name already exists.');
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > MAX_DESCRIPTION) errors.push(`The description can be at most ${MAX_DESCRIPTION} characters.`);

  let password;
  if (typeof body.password === 'string' && body.password !== '') {
    if (body.password.length < MIN_PASSWORD) errors.push(`The password must be at least ${MIN_PASSWORD} characters.`);
    else password = body.password;
  }

  const rawKeys = Array.isArray(body.public_keys) ? body.public_keys : String(body.public_keys || '').split(/\r?\n/);
  const public_keys = [];
  for (const k of rawKeys.map((s) => String(s).trim()).filter(Boolean)) {
    if (!parsePublicKey(k)) { errors.push(`This is not an SSH public key: ${k.slice(0, 40)}…`); continue; }
    public_keys.push(k);
  }
  if (public_keys.length > MAX_KEYS) errors.push(`A service account can have at most ${MAX_KEYS} public keys.`);

  const { grants, errors: grantErrors } = files.parseGrants(body.grants);
  errors.push(...grantErrors);
  if (!grants.length) errors.push('Give at least one directory the account may use.');

  return {
    errors,
    data: { username, description, enabled: body.enabled !== false, password, public_keys: JSON.stringify(public_keys), grants: JSON.stringify(grants) },
  };
}

/** Creates an account. Returns { account, password } where `password` is set only when one was generated. */
function create(data, { by = '', generate = false } = {}) {
  if (db.get('SELECT COUNT(*) AS n FROM service_accounts').n >= MAX_ACCOUNTS) return { errors: [`At most ${MAX_ACCOUNTS} service accounts are allowed.`] };
  const generated = !data.password && generate ? generatePassword() : null;
  const pw = data.password || generated;
  if (!pw && data.public_keys === '[]') return { errors: ['Give the account a password, a public key, or ask for a generated password.'] };
  const now = new Date().toISOString();
  const id = Number(db.run('INSERT INTO service_accounts (username, description, enabled, password_hash, public_keys, grants, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    data.username, data.description, data.enabled ? 1 : 0, pw ? passwords.hashPassword(pw) : '', data.public_keys, data.grants, now, by, now).lastInsertRowid);
  return { account: get(id), password: generated };
}

/** Changes an account. A password in `data` replaces the current one; without one, the password stays as it is. */
function update(id, data) {
  const sets = ['username = ?', 'description = ?', 'enabled = ?', 'public_keys = ?', 'grants = ?', 'updated_at = ?'];
  const params = [data.username, data.description, data.enabled ? 1 : 0, data.public_keys, data.grants, new Date().toISOString()];
  if (data.password) { sets.push('password_hash = ?'); params.push(passwords.hashPassword(data.password)); }
  db.run(`UPDATE service_accounts SET ${sets.join(', ')} WHERE id = ?`, ...params, Number(id));
  return get(id);
}

/** Gives an account a new generated password. Returns { account, password }. */
function resetPassword(id) {
  const password = generatePassword();
  db.run('UPDATE service_accounts SET password_hash = ?, updated_at = ? WHERE id = ?', passwords.hashPassword(password), new Date().toISOString(), Number(id));
  return { account: get(id), password };
}

const remove = (id) => db.run('DELETE FROM service_accounts WHERE id = ?', Number(id)).changes > 0;

// Locks an account down: it is turned off, its password is replaced with one nobody knows, and its SSH keys are suspended, so
// nothing it was given can sign in. Its open SFTP connections are closed by the caller (sftp-server.js). The password is not shown,
// and is not restored by ending the lockdown: an administrator sets a new one. Returns { keysSuspended }, or null if the account
// is missing or already locked down.
function lockDown(id, { by = '' } = {}) {
  const r = db.get('SELECT * FROM service_accounts WHERE id = ?', Number(id));
  if (!r || r.locked_down) return null;
  const now = new Date().toISOString();
  const keys = r.public_keys;
  const password = r.password_hash ? passwords.hashPassword(generatePassword()) : '';
  db.run(`UPDATE service_accounts SET enabled = 0, password_hash = ?, public_keys = '[]', suspended_keys = ?, locked_down = 1,
          lockdown_started_at = ?, lockdown_started_by = ?, lockdown_enabled_before = ?, updated_at = ? WHERE id = ?`,
  password, keys, now, by, r.enabled, now, r.id);
  return { keysSuspended: parseJson(keys, []).length };
}

// Ends a lockdown. The account is turned on again only if it was on before. The suspended SSH keys come back only when `restoreKeys`
// is true; otherwise they are discarded. Returns { keysRestored }, or null if the account is not in lockdown.
function endLockdown(id, { restoreKeys = false } = {}) {
  const r = db.get('SELECT * FROM service_accounts WHERE id = ?', Number(id));
  if (!r || !r.locked_down) return null;
  const keys = restoreKeys ? r.suspended_keys : '[]';
  db.run(`UPDATE service_accounts SET enabled = ?, public_keys = ?, suspended_keys = '[]', locked_down = 0, lockdown_started_at = '',
          lockdown_started_by = '', updated_at = ? WHERE id = ?`, r.lockdown_enabled_before, keys, new Date().toISOString(), r.id);
  return { keysRestored: restoreKeys ? parseJson(r.suspended_keys, []).length : 0 };
}

/** The account for a sign-in, if it is enabled and the password is right. Returns the stored row, or null. */
function authenticate(username, password) {
  const r = db.get('SELECT * FROM service_accounts WHERE username = ? COLLATE NOCASE', String(username || ''));
  if (!r || !r.enabled || !r.password_hash || typeof password !== 'string') return null;
  return passwords.verifyPassword(password, r.password_hash) ? r : null;
}

/** authenticate, without holding up the server while the password is hashed. Resolves the row or null. */
async function authenticateAsync(username, password) {
  const r = db.get('SELECT * FROM service_accounts WHERE username = ? COLLATE NOCASE', String(username || ''));
  const usable = r && r.enabled && r.password_hash && typeof password === 'string';
  const ok = await passwords.verifyPasswordAsync(typeof password === 'string' ? password : '', usable ? r.password_hash : passwords.dummyPasswordHash());
  return usable && ok ? r : null;
}

/** The stored row for an enabled account by name, or null. Used again on every SFTP request, so a change or a disable applies at once. */
const enabledByName = (username) => {
  const r = db.get('SELECT * FROM service_accounts WHERE username = ? COLLATE NOCASE AND enabled = 1', String(username || ''));
  return r || null;
};

/** The parsed public keys of a stored account row. */
const keysOf = (row) => parseJson(row.public_keys, []).map(parsePublicKey).filter(Boolean);
const grantsOf = (row) => parseJson(row.grants, []);

module.exports = { list, get, parse, create, update, resetPassword, remove, lockDown, endLockdown, authenticate, authenticateAsync, enabledByName, keysOf, grantsOf, parsePublicKey, generatePassword, USERNAME_RE, MIN_PASSWORD, MAX_ACCOUNTS };
