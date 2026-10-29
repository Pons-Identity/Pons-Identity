const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const directories = require('./directories');
const auditLog = require('./audit');
const { USER_FIELDS } = require('./admin-data');
const { hashPassword } = require('./crypto');
const { GUID_RE } = require('./guid');
const { baseUrl } = require('./config');
const provisioning = require('./provisioning');
const policies = require('./policies');

// REST API for external directories to maintain the identities they own. Each directory has its own bearer
// token (created in the console). A token can only see and change users whose directory_id is its own
// directory: local accounts, other directories' users and roles are out of reach. Users are addressed by
// their GUID (the `id` field).

const router = express.Router();
const BASE = '/directory/v1';

class ApiError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function directoryForToken(presented) {
  const want = sha256(presented);
  for (const dir of directories.list()) {
    if (dir.token_hash && crypto.timingSafeEqual(want, Buffer.from(dir.token_hash, 'hex'))) return dir;
  }
  return null;
}

/* ---------------------------------- Auth ----------------------------------- */

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  const dir = m && directoryForToken(m[1]);
  if (!dir) {
    res.set('WWW-Authenticate', 'Bearer realm="Pons Identity directory API"');
    auditLog.user('token.auth_failure', { outcome: 'failure', actor: { type: 'anonymous', name: 'directory-api' }, detail: { api: 'directory', method: req.method, path: req.originalUrl.split('?')[0], tokenPresented: Boolean(m) } });
    return next(new ApiError(401, 'A valid bearer token is required.'));
  }
  if (!dir.enabled) return next(new ApiError(403, 'This directory is disabled.'));
  req.directory = dir;
  next();
});

// A source system delivers its whole population (or the changes) here. It has its own, larger body limit and accepts
// CSV as well as JSON. See provisioning.js.
router.post('/feed', express.text({ type: ['text/csv', 'text/plain'], limit: '25mb' }), express.json({ limit: '25mb' }), async (req, res, next) => {
  try {
    if (!provisioning.config(req.directory.id).enabled) throw new ApiError(403, 'The provisioning feed is not enabled for this directory.');
    const csv = /^text\//.test(req.get('content-type') || '');
    const empty = typeof req.body === 'object' && !Array.isArray(req.body) && !Object.keys(req.body || {}).length;
    if (req.body === undefined || empty) throw new ApiError(400, 'Send the feed as CSV (text/csv) or JSON (application/json).');
    const out = await provisioning.run(req.directory, req.body, {
      via: 'push', format: csv ? 'csv' : 'json', mode: req.query.mode, dryRun: req.query.dry_run === 'true', actor: 'push' });
    res.status(out.status === 'blocked' ? 409 : 200).json(out.status === 'blocked' ? { error: out.blocked, ...out } : out);
  } catch (e) {
    next(e instanceof provisioning.FeedError ? new ApiError(e.status, e.message, e.errors) : e);
  }
});

router.use(express.json({ limit: '1mb' }));

/* ------------------------------ Representation ----------------------------- */

function userResource(u) {
  const out = { id: u.guid, external_id: u.external_id || null };
  for (const f of USER_FIELDS) out[f] = u[f];
  out.active = Boolean(u.active);
  out.attributes = Object.fromEntries(db.all('SELECT name, value FROM user_attributes WHERE user_id = ?', u.id).map((r) => [r.name, r.value]));
  out.groups = db.all(`SELECT g.name FROM groups g JOIN group_members m ON m.group_id = g.id
                       WHERE m.user_id = ? AND g.directory_id = ? ORDER BY g.name`, u.id, u.directory_id).map((r) => r.name);
  out.created_at = new Date(`${u.created_at}Z`).toISOString();
  out.location = `${baseUrl}${BASE}/users/${u.guid}`;
  return out;
}

/* ------------------------------- Validation -------------------------------- */

const MAX_FIELD = 512;
const MAX_ATTRIBUTES = 100;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ATTR_NAME = /^[A-Za-z_][\w.:\-/]{0,199}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check a request body and return the values to write. Only fields present in the body are returned, so
 * PATCH can pass it straight through; `complete` (POST, PUT) additionally requires a username.
 */
function readBody(body, { complete }) {
  if (!isObject(body)) throw new ApiError(400, 'The request body must be a JSON object.');
  const errors = [];
  const values = {};
  const known = new Set([...USER_FIELDS, 'external_id', 'active', 'password', 'attributes', 'groups']);
  for (const k of Object.keys(body)) if (!known.has(k)) errors.push(`Unknown field "${k}".`);

  for (const f of [...USER_FIELDS, 'external_id']) {
    if (body[f] === undefined) continue;
    if (typeof body[f] !== 'string' && body[f] !== null) errors.push(`${f} must be a string.`);
    else {
      const v = (body[f] || '').trim();
      if (v.length > MAX_FIELD) errors.push(`${f} must be ${MAX_FIELD} characters or fewer.`);
      else if (CONTROL.test(v)) errors.push(`${f} must not contain control characters.`);
      else values[f] = v;
    }
  }
  if (values.username !== undefined && !values.username) errors.push('username must not be empty.');
  if (complete && values.username === undefined) errors.push('username is required.');
  if (values.email && !/^[^\s@]+@[^\s@]+$/.test(values.email)) errors.push('email is not a valid address.');

  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') errors.push('active must be true or false.');
    else values.active = body.active ? 1 : 0;
  }
  if (body.password !== undefined) {
    const minLength = policies.minimumPasswordLength();
    if (typeof body.password !== 'string' || body.password.length < minLength || body.password.length > 256) {
      errors.push(`password must be a string of ${minLength} to 256 characters.`);
    } else values.password_hash = hashPassword(body.password);
  }

  let custom;
  if (body.attributes !== undefined) {
    if (!isObject(body.attributes) || Object.keys(body.attributes).length > MAX_ATTRIBUTES) {
      errors.push(`attributes must be an object with at most ${MAX_ATTRIBUTES} entries.`);
    } else {
      custom = {};
      for (const [k, v] of Object.entries(body.attributes)) {
        if (!ATTR_NAME.test(k)) errors.push(`Attribute name "${k}" is not valid.`);
        else if (typeof v !== 'string' || v.length > MAX_FIELD || CONTROL.test(v)) errors.push(`Attribute "${k}" must be a string of ${MAX_FIELD} characters or fewer.`);
        else if (v) custom[k] = v;
      }
    }
  }

  let groups;
  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups) || body.groups.length > 500
      || body.groups.some((g) => typeof g !== 'string' || !g.trim() || g.length > MAX_FIELD || CONTROL.test(g))) {
      errors.push('groups must be an array of up to 500 non-empty group names.');
    } else groups = [...new Set(body.groups.map((g) => g.trim()))];
  }

  if (errors.length) throw new ApiError(400, 'The request was not valid.', errors);
  return { values, custom, groups, password: body.password };
}

/** A password only means something for a directory that does not authenticate users itself. */
function checkPassword(dir, values) {
  if (values.password_hash !== undefined && directories.usesLdap(dir)) {
    throw new ApiError(400, 'The request was not valid.', ['password cannot be set: this directory authenticates users against its LDAP server.']);
  }
}

/** A new account must meet the policies of the groups it is put in. A group that does not exist yet has no policy to apply. */
async function checkNewPassword(values, password, groups = []) {
  if (password === undefined) return;
  const groupIds = groups.map((name) => db.get('SELECT id FROM groups WHERE name = ?', name)).filter(Boolean).map((g) => g.id);
  const errors = await policies.draftPasswordErrors({ groupIds }, password, values);
  if (errors.length) throw new ApiError(400, 'The request was not valid.', errors);
}

const owned = (req) => {
  const u = GUID_RE.test(req.params.id) && db.get('SELECT * FROM users WHERE guid = ? AND directory_id = ?', req.params.id, req.directory.id);
  if (!u) throw new ApiError(404, 'No such user.');
  return u;
};

function write(req, summary, fn) {
  try {
    const out = db.tx(fn);
    auditLog.admin('directory_api.write', { actor: { type: 'integration', id: req.directory.id, name: req.directory.name }, target: { type: 'directory', id: req.directory.id, name: req.directory.name }, detail: { summary: summary(out) } });
    directories.recordActivity(req.directory.id, summary(out));
    return out;
  } catch (e) {
    if (e.status === 409) throw new ApiError(409, e.message);
    throw e;
  }
}

/* ---------------------------------- Routes --------------------------------- */

router.get('/users', (req, res) => {
  const where = ['directory_id = ?'];
  const params = [req.directory.id];
  for (const [q, col] of [['username', 'username'], ['external_id', 'external_id'], ['email', 'email']]) {
    if (req.query[q] !== undefined) {
      if (typeof req.query[q] !== 'string') throw new ApiError(400, `${q} must be a single value.`);
      where.push(`${col} = ? COLLATE NOCASE`);
      params.push(req.query[q]);
    }
  }
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const { n } = db.get(`SELECT COUNT(*) AS n FROM users WHERE ${where.join(' AND ')}`, ...params);
  const rows = db.all(`SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY username LIMIT ? OFFSET ?`, ...params, limit, offset);
  res.json({ total: n, limit, offset, users: rows.map(userResource) });
});

router.get('/users/:id', (req, res) => res.json(userResource(owned(req))));

router.post('/users', async (req, res, next) => {
  try {
    const { values, custom, groups, password } = readBody(req.body, { complete: true });
    checkPassword(req.directory, values);
    await checkNewPassword(values, password, groups);
    const user = write(req, (u) => `Created ${u.username}`,
      () => directories.writeUser(req.directory, null, { active: 1, ...values }, { custom, groups }));
    res.status(201).location(userResource(user).location).json(userResource(user));
  } catch (e) { next(e); }
});

// PUT replaces the profile: profile fields left out are cleared. attributes, groups and password are only
// changed when present.
router.put('/users/:id', (req, res) => {
  const current = owned(req);
  const { values, custom, groups } = readBody(req.body, { complete: true });
  checkPassword(req.directory, values);
  const blank = Object.fromEntries([...USER_FIELDS, 'external_id'].map((f) => [f, '']));
  const user = write(req, (u) => `Replaced ${u.username}`,
    () => directories.writeUser(req.directory, current, { ...blank, ...values }, { custom, groups }));
  res.json(userResource(user));
});

router.patch('/users/:id', (req, res) => {
  const current = owned(req);
  const { values, custom, groups } = readBody(req.body, { complete: false });
  checkPassword(req.directory, values);
  const user = write(req, (u) => `Updated ${u.username}`,
    () => directories.writeUser(req.directory, current, values, { custom, groups }));
  res.json(userResource(user));
});

router.delete('/users/:id', (req, res) => {
  const current = owned(req);
  write(req, () => `Deleted ${current.username}`, () => db.run('DELETE FROM users WHERE id = ?', current.id));
  res.status(204).end();
});

router.use((req, res, next) => next(new ApiError(404, 'Not found.')));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') err = new ApiError(400, 'Request body is not valid JSON.');
  else if (err.type === 'entity.too.large') err = new ApiError(413, 'Request body is too large.');
  else if (!(err instanceof ApiError)) {
    console.error(err);
    err = new ApiError(500, 'Something went wrong.');
  }
  res.status(err.status).json({ error: err.message, ...(err.errors && { errors: err.errors }) });
});

module.exports = { router, BASE };
