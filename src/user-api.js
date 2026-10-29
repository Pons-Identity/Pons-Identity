const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const roles = require('./roles');
const policies = require('./policies');
const auditLog = require('./audit');
const bulkUsers = require('./bulk-users');
const scheduler = require('./user-scheduler');
const userService = require('./user-service');
const attributeDefs = require('./attribute-defs');
const compromise = require('./compromise');
const { USER_FIELDS } = require('./admin-data');
const { GUID_RE } = require('./guid');
const { baseUrl } = require('./config');
// Loaded on first use: integrations/host.js requires this file, so a top-level require would be circular.
const integrations = { execute: (...a) => require('./integrations').execute(...a), getRun: (...a) => require('./integrations').getRun(...a) };

// REST API for external software (an HR system, a registration form) to create and manage local user accounts. Bearer
// tokens are made in Settings → User API, each with scopes and an optional expiry. A token can reach only ordinary local
// accounts: never an administrator (anyone holding a role) and never a user an external directory owns, because being able
// to set a password or deactivate an account would otherwise be a way to take one over. Roles cannot be set here.
// Users are addressed by GUID (`id`). The OpenAPI description is docs/openapi.yaml, served at /api/v1/openapi.yaml, with
// a rendered copy at /api/v1/docs once `npm run docs:build` has run.

const router = express.Router();
const BASE = '/api/v1';
const DOCS = path.join(__dirname, '..', 'docs');

const SCOPES = {
  'users:read': 'Look up users',
  'users:write': 'Create, change and delete ordinary users',
  'bulk:write': 'Create many users in one request',
  'schedules:write': 'Schedule account creation, activation, deactivation and deletion',
  'integrations:run': 'Run the integrations that have been opened to the API, and read their results',
};

class ApiError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

/* --------------------------------- Tokens ---------------------------------- */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createToken({ name, scopes, expiresAt = '', createdBy }) {
  const token = `uat_${crypto.randomBytes(32).toString('base64url')}`;
  const r = db.run('INSERT INTO user_api_tokens (name, token_hash, scopes, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    name, sha256(token), scopes.join(' '), expiresAt, new Date().toISOString(), createdBy || '');
  return { id: Number(r.lastInsertRowid), token };
}

const view = (t) => ({ id: t.id, name: t.name, scopes: t.scopes.split(' ').filter(Boolean), expires_at: t.expires_at, created_at: t.created_at, created_by: t.created_by, last_used_at: t.last_used_at });
const listTokens = () => db.all('SELECT * FROM user_api_tokens ORDER BY id').map(view);
const revokeToken = (id) => db.run('DELETE FROM user_api_tokens WHERE id = ?', Number(id)).changes > 0;

function tokenFor(presented) {
  const row = db.get('SELECT * FROM user_api_tokens WHERE token_hash = ?', sha256(presented));
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
  if (Date.now() - Date.parse(row.last_used_at || 0) > 60000) db.run('UPDATE user_api_tokens SET last_used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
  return view(row);
}

/* ----------------------------- Docs (no token) ----------------------------- */

router.get('/openapi.yaml', (req, res, next) => {
  const file = path.join(DOCS, 'openapi.yaml');
  if (!fs.existsSync(file)) return next(new ApiError(404, 'Not found.'));
  res.type('application/yaml').send(fs.readFileSync(file, 'utf8'));
});

// The rendered page is one self-contained file. Its script and styles are inline, so it gets a CSP of its own that allows
// nothing else: no network, no framing.
router.get('/docs', (req, res, next) => {
  const file = path.join(DOCS, 'api.html');
  if (!fs.existsSync(file)) return next(new ApiError(404, 'The API documentation has not been built. Run npm run docs:build.'));
  res.set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; worker-src blob:; child-src blob:; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send(fs.readFileSync(file, 'utf8'));
});

/* ---------------------------------- Auth ----------------------------------- */

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  const token = m && tokenFor(m[1]);
  if (!token) {
    res.set('WWW-Authenticate', 'Bearer realm="Pons Identity user API"');
    auditLog.user('token.auth_failure', { outcome: 'failure', actor: { type: 'anonymous', name: 'user-api' }, detail: { api: 'users', method: req.method, path: req.originalUrl.split('?')[0], tokenPresented: Boolean(m) } });
    return next(new ApiError(401, 'A valid bearer token is required.'));
  }
  req.token = token;
  req.actor = { type: 'integration', id: token.id, name: `user-api:${token.name}` };
  next();
});

const scope = (name) => (req, res, next) => (req.token.scopes.includes(name) ? next() : next(new ApiError(403, `This token does not have the ${name} scope.`)));

router.use(express.json({ limit: '1mb' }));

/* ------------------------------- Idempotency ------------------------------- */

// With an Idempotency-Key header, the first answer to a POST is kept for a day and repeated for the same key and body;
// the same key with a different body is refused. A generated password is never kept, so a replay does not repeat it.
const IDEMPOTENCY_TTL = 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

function idempotent(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key) return next();
  if (key.length > 200) return next(new ApiError(400, 'Idempotency-Key is too long.'));
  db.run('DELETE FROM api_idempotency WHERE created_at < ?', nowSec() - IDEMPOTENCY_TTL);
  const hash = sha256(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body)}`);
  const seen = db.get('SELECT * FROM api_idempotency WHERE token_id = ? AND key = ?', req.token.id, key);
  if (seen) {
    if (seen.request_hash !== hash) return next(new ApiError(422, 'This Idempotency-Key was used with a different request.'));
    res.set('Idempotent-Replay', 'true');
    return res.status(seen.status).json(JSON.parse(seen.body));
  }
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) {
      const { generated_password: _gp, generated: _g, ...kept } = body && typeof body === 'object' ? body : {};
      db.run('INSERT OR IGNORE INTO api_idempotency (token_id, key, request_hash, status, body, created_at) VALUES (?,?,?,?,?,?)',
        req.token.id, key, hash, res.statusCode, JSON.stringify(body && typeof body === 'object' ? kept : body), nowSec());
    }
    return send(body);
  };
  next();
}

/* ------------------------------ Representation ----------------------------- */

function resource(u) {
  const out = { id: u.guid, username: u.username };
  for (const f of USER_FIELDS) if (f !== 'username') out[f] = u[f];
  out.emails = userService.emailsOf(u.id);
  out.personal_email = u.personal_email || null;
  out.active = Boolean(u.active);
  out.mfa_required = Boolean(u.mfa_enabled);
  out.attributes = Object.fromEntries(db.all('SELECT name, value FROM user_attributes WHERE user_id = ? ORDER BY name', u.id).map((r) => [r.name, r.value]));
  out.groups = db.all('SELECT g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name', u.id).map((r) => r.name);
  out.password_changed_at = u.password_changed_at ? new Date(`${u.password_changed_at}Z`).toISOString() : null;
  out.password_changed_via = u.password_changed_via || null;
  out.created_at = new Date(`${u.created_at}Z`).toISOString();
  out.location = `${baseUrl}${BASE}/users/${u.guid}`;
  return out;
}

function load(id) {
  if (!GUID_RE.test(id)) throw new ApiError(404, 'No such user.');
  const u = db.get('SELECT * FROM users WHERE guid = ?', id);
  if (!u) throw new ApiError(404, 'No such user.');
  return u;
}

// Only ordinary local accounts may be changed through the API (see the note at the top).
function writable(u) {
  if (u.directory_id) throw new ApiError(409, 'This user is managed by an external directory.');
  if (roles.permissionsOf(u.id).size) throw new ApiError(403, 'This account has administrative access and cannot be changed through the API.');
}

const validation = (errors) => new ApiError(400, 'The request is not valid.', errors);

/* ---------------------------------- Users ---------------------------------- */

const PAGE_MAX = 200;
function page(req) {
  const num = (v, d, max) => { const n = Number.parseInt(v, 10); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : d; };
  return { limit: num(req.query.limit, 50, PAGE_MAX) || 50, offset: num(req.query.offset, 0, 1e9) };
}

router.get('/users', scope('users:read'), (req, res) => {
  const where = [];
  const params = [];
  for (const k of ['username', 'email']) {
    if (req.query[k] !== undefined) {
      if (typeof req.query[k] !== 'string') throw new ApiError(400, `${k} must be a single value.`);
      if (k === 'email') { where.push('(u.email = ? COLLATE NOCASE OR u.id IN (SELECT user_id FROM user_emails WHERE email = ?))'); params.push(req.query[k], req.query[k]); }
      else { where.push('u.username = ? COLLATE NOCASE'); params.push(req.query[k]); }
    }
  }
  if (typeof req.query.q === 'string' && req.query.q) { where.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?)'); params.push(...Array(3).fill(`%${req.query.q}%`)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = page(req);
  const { n } = db.get(`SELECT COUNT(*) AS n FROM users u ${w}`, ...params);
  res.json({ total: n, limit, offset, users: db.all(`SELECT u.* FROM users u ${w} ORDER BY u.username LIMIT ? OFFSET ?`, ...params, limit, offset).map(resource) });
});

router.get('/users/:id', scope('users:read'), (req, res) => res.json(resource(load(req.params.id))));

const CREATE_KEYS = new Set([...USER_FIELDS, 'personal_email', 'password', 'generate_password', 'emails', 'groups', 'active', 'mfa_required', 'attributes']);

router.post('/users', scope('users:write'), idempotent, async (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'The request body must be a JSON object.');
    const unknown = Object.keys(body).filter((k) => !CREATE_KEYS.has(k));
    if (unknown.length) throw validation(unknown.map((k) => `Unknown field: ${k}.`));
    const { generate_password: generate, ...row } = body;
    const [r] = await bulkUsers.prepare([row], { canGroups: true, generatePasswords: generate === true });
    if (r.status === 'error') {
      throw (r.errors.some((e) => /already exists/.test(e)) ? new ApiError(409, 'That username already exists.', r.errors) : validation(r.errors));
    }
    bulkUsers.commit([r], { by: null, onError: 'skip', via: 'api' });
    if (r.status !== 'created') throw new ApiError(500, 'The user could not be saved.');
    auditLog.admin('user.create', { actor: req.actor, target: { type: 'user', id: r.id, name: r.username }, detail: { active: r.spec.active, mfa_required: r.spec.mfa_enabled, via: 'user-api' } });
    const u = db.get('SELECT * FROM users WHERE id = ?', r.id);
    res.status(201).set('Location', `${baseUrl}${BASE}/users/${u.guid}`).json({ ...resource(u), ...(r.generated ? { generated_password: r.generated } : {}) });
  } catch (e) { next(e); }
});

const PATCH_KEYS = new Set([...USER_FIELDS, 'personal_email', 'password', 'emails', 'active', 'mfa_required', 'attributes']);

router.patch('/users/:id', scope('users:write'), async (req, res, next) => {
  try {
  const u = load(req.params.id);
  writable(u);
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'The request body must be a JSON object.');
  const unknown = Object.keys(b).filter((k) => !PATCH_KEYS.has(k));
  const errors = unknown.map((k) => `Unknown field: ${k}.`);

  const set = {};
  for (const f of [...USER_FIELDS, 'personal_email']) {
    if (b[f] === undefined) continue;
    if (typeof b[f] !== 'string') { errors.push(`${f} must be a string.`); continue; }
    set[f] = b[f].trim();
  }
  if (set.username !== undefined) {
    if (!set.username) errors.push('Username cannot be empty.');
    else if (db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', set.username, u.id)) errors.push('That username already exists.');
  }
  for (const [k, label] of [['active', 'Active'], ['mfa_required', 'MFA required']]) if (b[k] !== undefined && typeof b[k] !== 'boolean') errors.push(`${label} must be true or false.`);

  if (set.personal_email !== undefined) {
    const bad = userService.personalEmailError(u.id, set.personal_email);
    if (bad) errors.push(bad);
  }
  let emails = null;
  if (b.emails !== undefined || set.email !== undefined) {
    const r = userService.readEmails(b.emails !== undefined ? { emails: b.emails } : {}, set.email !== undefined ? set.email : u.email, u.id);
    errors.push(...r.errors);
    emails = r.emails;
  }
  const defined = {}; const freeSet = {};
  if (b.attributes !== undefined) {
    if (!b.attributes || typeof b.attributes !== 'object' || Array.isArray(b.attributes)) errors.push('attributes must be an object.');
    else {
      const defs = new Set(attributeDefs.list().map((d) => d.name));
      for (const [k, v] of Object.entries(b.attributes)) {
        if (defs.has(k)) defined[k] = v;
        else if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(k)) errors.push(`Attribute name "${k}" is not valid.`);
        else freeSet[k] = v === null ? '' : String(v).replace(/[\r\n]+/g, ' ').trim();
      }
    }
  }
  const attrs = attributeDefs.resolve(defined, { isNew: false });
  errors.push(...attrs.errors);
  if (b.password !== undefined) {
    if (typeof b.password !== 'string') errors.push('password must be a string.');
    else errors.push(...await policies.passwordErrors(u.id, b.password));
  }
  if (errors.length) throw validation([...new Set(errors)]);

  db.tx(() => {
    if (set.personal_email !== undefined) userService.setPersonalEmail(u.id, set.personal_email, { verified: true });
    const cols = Object.keys(set).filter((k) => k !== 'email' && k !== 'personal_email');
    const extra = [...(b.active !== undefined ? [['active', b.active ? 1 : 0]] : []), ...(b.mfa_required !== undefined ? [['mfa_enabled', b.mfa_required ? 1 : 0]] : [])];
    const all = [...cols.map((k) => [k, set[k]]), ...extra];
    if (all.length) db.run(`UPDATE users SET ${all.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...all.map(([, v]) => v), u.id);
    if (emails) userService.saveEmails(u.id, emails);
    for (const [k, v] of Object.entries({ ...attrs.values, ...freeSet })) {
      if (v) db.run('INSERT OR REPLACE INTO user_attributes (user_id, name, value) VALUES (?,?,?)', u.id, k, v);
      else db.run('DELETE FROM user_attributes WHERE user_id = ? AND name = ?', u.id, k);
    }
    if (b.password !== undefined) userService.setPassword(u.id, b.password, { by: null, via: 'api' });
  });
  if (b.password !== undefined || b.active === false) userService.revokeSessions(u.id);
  const changed = [...Object.keys(set), ...(b.emails ? ['emails'] : []), ...(b.attributes ? ['attributes'] : []), ...['active', 'mfa_required'].filter((k) => b[k] !== undefined)];
  auditLog.admin('user.update', { actor: req.actor, target: { type: 'user', id: u.id, name: set.username || u.username }, detail: { changed, via: 'user-api' } });
  if (b.password !== undefined) auditLog.admin('user.password_reset', { actor: req.actor, target: { type: 'user', id: u.id, name: set.username || u.username }, detail: { via: 'user-api' } });
  res.json(resource(db.get('SELECT * FROM users WHERE id = ?', u.id)));
  } catch (e) { next(e); }
});

router.delete('/users/:id', scope('users:write'), (req, res) => {
  const u = load(req.params.id);
  writable(u);
  userService.revokeSessions(u.id);
  db.run('DELETE FROM users WHERE id = ?', u.id);
  auditLog.admin('user.delete', { actor: req.actor, target: { type: 'user', id: u.id, name: u.username }, detail: { via: 'user-api' } });
  res.status(204).end();
});

// Locks down an account that may be compromised: runs the built-in "Compromised account lockdown" integration, which applies the
// steps the Compromised account policies set for this person. The integration must be turned on. Ends with 409 if it cannot run,
// and 500 if it ran but did not finish (some steps may already have happened; the run says which).
router.post('/users/:id/lockdown', scope('users:write'), idempotent, async (req, res, next) => {
  try {
    const u = load(req.params.id);
    writable(u);
    const result = await compromise.runLockdown({ id: u.id, username: u.username }, { actor: req.actor, via: 'user-api' });
    if (result.error) throw new ApiError(409, result.error);
    if (!result.ok) throw new ApiError(500, `The lockdown did not finish${result.error ? `: ${result.error}` : ''}. Some steps may have run; see run ${result.run.id}.`);
    res.json({
      user: resource(db.get('SELECT * FROM users WHERE id = ?', u.id)),
      lockdown: compromise.userView(u.id).lockdown,
      run: { id: result.run.id, status: result.run.status },
    });
  } catch (e) { next(e); }
});

// Ends a lockdown: turns the account back on if the lockdown turned it off. Sign-in methods and the password are not restored.
router.delete('/users/:id/lockdown', scope('users:write'), (req, res) => {
  const u = load(req.params.id);
  writable(u);
  const ended = compromise.endLockdown(u.id);
  if (!ended) throw new ApiError(404, 'That account is not in lockdown.');
  auditLog.admin('user.lockdown_end', { actor: req.actor, target: { type: 'user', id: u.id, name: u.username }, detail: { reactivated: ended.reactivated, via: 'user-api' } });
  res.json(resource(db.get('SELECT * FROM users WHERE id = ?', u.id)));
});

/* ----------------------------------- Bulk ---------------------------------- */

router.post('/users/bulk', scope('bulk:write'), idempotent, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.users)) throw new ApiError(400, 'users must be a list.');
    const unknown = Object.keys(b).filter((k) => !['users', 'dry_run', 'on_error', 'generate_passwords'].includes(k));
    if (unknown.length) throw validation(unknown.map((k) => `Unknown field: ${k}.`));
    const out = await bulkUsers.run(b, { actor: req.actor, byName: req.actor.name, canGroups: true, via: 'api' });
    res.status(out.dry_run ? 200 : 201).json(out);
  } catch (e) {
    next(e instanceof bulkUsers.BulkError ? validation([e.message]) : e);
  }
});

/* -------------------------------- Schedules -------------------------------- */

const actorFor = (req) => ({ integration: true, tokenId: req.token.id, name: req.actor.name, canGroups: true });

router.get('/schedules', scope('schedules:write'), (req, res) => {
  res.json(scheduler.list({ status: typeof req.query.status === 'string' ? req.query.status : undefined }).filter((s) => s.created_by === req.actor.name));
});

router.post('/schedules', scope('schedules:write'), idempotent, async (req, res, next) => {
  try {
    const b = req.body || {};
    const spec = { action: b.action, run_at: b.run_at, rows: b.users, on_error: b.on_error };
    if (b.user_id !== undefined) {
      const u = db.get('SELECT id FROM users WHERE guid = ?', String(b.user_id));
      if (!u) throw new ApiError(404, 'No such user.');
      spec.user_id = u.id;
    }
    if (b.group !== undefined) {
      const g = db.get('SELECT id FROM groups WHERE name = ? COLLATE NOCASE', String(b.group));
      if (!g) throw new ApiError(404, 'No such group.');
      spec.group_id = g.id;
    }
    res.status(201).json(await scheduler.schedule(spec, actorFor(req)));
  } catch (e) {
    next(e instanceof scheduler.ScheduleError ? validation([e.message]) : e);
  }
});

router.delete('/schedules/:id', scope('schedules:write'), (req, res, next) => {
  try {
    const row = db.get('SELECT created_by_name FROM user_schedule WHERE id = ?', Number(req.params.id));
    if (!row || row.created_by_name !== req.actor.name) throw new ApiError(404, 'No such schedule.');
    res.json(scheduler.cancel(Number(req.params.id), actorFor(req)));
  } catch (e) {
    next(e instanceof scheduler.ScheduleError ? validation([e.message]) : e);
  }
});

/* ------------------------------- Integrations ------------------------------ */

// An integration is reachable here only if an administrator turned on "Allow API requests to run this" for it (and it is on). The
// script then runs with the integration's own scopes, whatever the token's other scopes are.
const integrationOf = (id) => {
  const row = /^\d+$/.test(String(id)) ? db.get('SELECT * FROM integrations WHERE id = ? AND enabled = 1 AND api_enabled = 1', Number(id)) : null;
  if (!row) throw new ApiError(404, 'No such integration.');
  return row;
};

const integrationResource = (r) => ({
  id: r.id, name: r.name, description: r.description,
  inputs: JSON.parse(r.inputs || '[]').map((i) => i.name),
  runs: `${baseUrl}${BASE}/integrations/${r.id}/runs`,
});

const runResource = (integrationId, run) => ({
  id: run.id, integration_id: integrationId, status: run.status, trigger: run.trigger, started_at: run.started_at, duration_ms: run.duration_ms,
  result: run.result, output: run.output.map((o) => o.text), logs: run.logs.map(({ level, text }) => ({ level, text })), error: run.error,
  location: `${baseUrl}${BASE}/integrations/${integrationId}/runs/${run.id}`,
});

router.get('/integrations', scope('integrations:run'), (req, res) => {
  res.json({ integrations: db.all('SELECT * FROM integrations WHERE enabled = 1 AND api_enabled = 1 ORDER BY name COLLATE NOCASE').map(integrationResource) });
});

router.post('/integrations/:id/runs', scope('integrations:run'), idempotent, async (req, res, next) => {
  try {
    const row = integrationOf(req.params.id);
    const b = req.body;
    if (b !== undefined && (b === null || typeof b !== 'object' || Array.isArray(b))) throw new ApiError(400, 'The request body must be a JSON object.');
    const unknown = Object.keys(b || {}).filter((k) => k !== 'input');
    if (unknown.length) throw validation(unknown.map((k) => `Unknown field: ${k}.`));
    const { run } = await integrations.execute(row, { input: b && b.input !== undefined ? b.input : null, trigger: 'api', actor: req.actor.name });
    res.status(201).set('Location', `${baseUrl}${BASE}/integrations/${row.id}/runs/${run.id}`).json(runResource(row.id, run));
  } catch (e) { next(e); }
});

router.get('/integrations/:id/runs/:runId', scope('integrations:run'), (req, res) => {
  const row = integrationOf(req.params.id);
  const run = /^\d+$/.test(req.params.runId) ? integrations.getRun(row.id, req.params.runId) : null;
  if (!run) throw new ApiError(404, 'No such run.');
  res.json(runResource(row.id, run));
});

/* ---------------------------------- Errors --------------------------------- */

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

module.exports = { router, BASE, SCOPES, createToken, listTokens, revokeToken, resource };
