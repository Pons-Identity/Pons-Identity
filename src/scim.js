const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const appSettings = require('./app-settings');
const auditLog = require('./audit');
const { baseUrl } = require('./config');

// SCIM 2.0 (RFC 7643/7644) endpoint for Internet2 Grouper's SCIM provisioner. Grouper pushes its groups and
// memberships here; they are stored as groups with source 'grouper', which the console treats as read-only.
// Users are never created or changed over SCIM: members are matched to existing users, by GUID (the SCIM
// user id) or, failing that, by username. Groups created in the console are invisible to this API.

const router = express.Router();
const BASE = '/scim/v2';

const SCHEMA = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
};
const MEDIA_TYPE = 'application/scim+json';

class ScimError extends Error {
  constructor(status, detail, scimType) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** A fresh provisioning token (shown once) and the hash to store. */
function newToken() {
  const token = `gpt_${crypto.randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

function tokenMatches(presented, hash) {
  if (!presented || !hash) return false;
  const a = Buffer.from(sha256(presented));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------ Representation ----------------------------- */

const userResource = (u) => ({
  schemas: [SCHEMA.user],
  id: u.guid,
  externalId: u.employee_id || undefined,
  userName: u.username,
  displayName: u.display_name || undefined,
  name: { givenName: u.first_name, familyName: u.last_name },
  emails: u.email ? [{ value: u.email, primary: true }] : [],
  active: Boolean(u.active),
  meta: { resourceType: 'User', created: new Date(`${u.created_at}Z`).toISOString(), location: `${baseUrl}${BASE}/Users/${u.guid}` },
});

function groupResource(g) {
  const members = db.all(
    `SELECT u.guid, u.username FROM users u JOIN group_members m ON m.user_id = u.id
     WHERE m.group_id = ? AND m.via_grouper = 1 ORDER BY u.username`, g.id);
  return {
    schemas: [SCHEMA.group],
    id: String(g.id),
    externalId: g.external_id || undefined,
    displayName: g.name,
    members: members.map((m) => ({ value: m.guid, display: m.username, type: 'User', $ref: `${baseUrl}${BASE}/Users/${m.guid}` })),
    meta: { resourceType: 'Group', location: `${baseUrl}${BASE}/Groups/${g.id}` },
  };
}

/* --------------------------------- Helpers --------------------------------- */

const findGroup = (id) => {
  const g = /^\d+$/.test(String(id)) && db.get("SELECT * FROM groups WHERE id = ? AND source = 'grouper'", Number(id));
  if (!g) throw new ScimError(404, `No group with id ${id}.`);
  return g;
};

function checkName(name, exceptId = 0) {
  if (typeof name !== 'string' || !name.trim()) throw new ScimError(400, 'displayName is required.', 'invalidValue');
  if (name.trim().length > 512) throw new ScimError(400, 'displayName is too long.', 'invalidValue');
  if (db.get('SELECT 1 FROM groups WHERE name = ? AND id != ?', name.trim(), exceptId)) {
    throw new ScimError(409, `A group named "${name.trim()}" already exists.`, 'uniqueness');
  }
  return name.trim();
}

/** SCIM member value -> user id (GUID first, then username). */
function memberUserId(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  const u = db.get('SELECT id FROM users WHERE guid = ?', v) || db.get('SELECT id FROM users WHERE username = ?', v);
  return u ? u.id : null;
}

// Members that matched no user in this request; reported in the activity summary.
let unmatched = 0;

function addMembers(groupId, values) {
  for (const m of values) {
    const uid = memberUserId(m && typeof m === 'object' ? m.value : m);
    if (uid === null) unmatched++;
    else {
      db.run(`INSERT INTO group_members (group_id, user_id, via_grouper) VALUES (?, ?, 1)
              ON CONFLICT(group_id, user_id) DO UPDATE SET via_grouper = 1`, groupId, uid);
    }
  }
}

// Grouper can only withdraw what it provided: memberships an administrator pinned stay.
function dropProvided(groupId, userId) {
  db.run('UPDATE group_members SET via_grouper = 0 WHERE group_id = ? AND user_id = ?', groupId, userId);
  db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND pinned = 0', groupId, userId);
}

function removeMembers(groupId, values) {
  for (const m of values) {
    const uid = memberUserId(m && typeof m === 'object' ? m.value : m);
    if (uid !== null) dropProvided(groupId, uid);
  }
}

function setMembers(groupId, values) {
  db.run('UPDATE group_members SET via_grouper = 0 WHERE group_id = ?', groupId);
  addMembers(groupId, values);
  db.run('DELETE FROM group_members WHERE group_id = ? AND pinned = 0 AND via_grouper = 0', groupId);
}

const memberList = (v) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ScimError(400, 'members must be an array.', 'invalidValue');
  return v;
};

/** Only `attr eq "value"` filters, which is all Grouper (and most SCIM clients) send for lookups. */
function parseFilter(filter) {
  if (!filter) return null;
  const m = /^\s*([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, 'Only filters of the form: attribute eq "value" are supported.', 'invalidFilter');
  return { attr: m[1].toLowerCase(), value: m[2].replace(/\\(.)/g, '$1') };
}

function page(req, rows, toResource) {
  const startIndex = Math.max(1, parseInt(req.query.startIndex, 10) || 1);
  const count = Math.min(200, Math.max(0, parseInt(req.query.count, 10) || 100));
  return {
    schemas: [SCHEMA.list],
    totalResults: rows.length,
    startIndex,
    itemsPerPage: Math.min(count, Math.max(0, rows.length - startIndex + 1)),
    Resources: rows.slice(startIndex - 1, startIndex - 1 + count).map(toResource),
  };
}

function applyPatch(group, operations) {
  for (const op of operations) {
    const kind = String(op.op || '').toLowerCase();
    if (!['add', 'remove', 'replace'].includes(kind)) throw new ScimError(400, `Unsupported operation "${op.op}".`, 'invalidSyntax');
    const path = typeof op.path === 'string' ? op.path.trim() : '';
    const filtered = /^members\s*\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i.exec(path);

    if (!path) { // no path: the value is an object of attributes
      const v = op.value && typeof op.value === 'object' ? op.value : {};
      if (kind === 'remove') throw new ScimError(400, 'A remove operation needs a path.', 'noTarget');
      if (v.displayName !== undefined) renameGroup(group, v.displayName);
      if (v.externalId !== undefined) db.run('UPDATE groups SET external_id = ? WHERE id = ?', String(v.externalId || ''), group.id);
      if (v.members !== undefined) (kind === 'replace' ? setMembers : addMembers)(group.id, memberList(v.members));
    } else if (filtered) {
      if (kind === 'add') throw new ScimError(400, 'A filtered path is only valid for remove or replace.', 'invalidPath');
      removeMembers(group.id, [filtered[1]]);
      if (kind === 'replace') addMembers(group.id, memberList(op.value));
    } else if (path.toLowerCase() === 'members') {
      if (kind === 'add') addMembers(group.id, memberList(op.value));
      else if (kind === 'replace') setMembers(group.id, memberList(op.value));
      else if (op.value === undefined) setMembers(group.id, []);
      else removeMembers(group.id, memberList(op.value));
    } else if (path.toLowerCase() === 'displayname') {
      if (kind === 'remove') throw new ScimError(400, 'displayName is required.', 'mutability');
      renameGroup(group, op.value);
    } else if (path.toLowerCase() === 'externalid') {
      db.run('UPDATE groups SET external_id = ? WHERE id = ?', kind === 'remove' ? '' : String(op.value || ''), group.id);
    } else {
      throw new ScimError(400, `Unsupported path "${path}".`, 'invalidPath');
    }
  }
}

function renameGroup(group, name) {
  db.run('UPDATE groups SET name = ? WHERE id = ?', checkName(name, group.id), group.id);
}

/* ---------------------------------- Routes --------------------------------- */

router.use((req, res, next) => {
  res.type(MEDIA_TYPE);
  const cfg = appSettings.grouper();
  if (!cfg.enabled) return next(new ScimError(403, 'The Grouper integration is disabled.'));
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!m || !tokenMatches(m[1], cfg.tokenHash)) {
    res.set('WWW-Authenticate', 'Bearer realm="Pons Identity SCIM"');
    auditLog.user('token.auth_failure', { outcome: 'failure', actor: { type: 'anonymous', name: 'scim' }, detail: { api: 'scim', method: req.method, path: req.originalUrl.split('?')[0], tokenPresented: Boolean(m) } });
    return next(new ScimError(401, 'A valid bearer token is required.'));
  }
  next();
});

router.use(express.json({ type: ['application/json', MEDIA_TYPE], limit: '5mb' }));

// Run a write in one transaction and note it for the settings page.
function write(res, label, fn) {
  unmatched = 0;
  const out = db.tx(fn);
  auditLog.admin('scim.write', { actor: { type: 'integration', name: 'grouper' }, detail: { summary: label, unmatchedMembers: unmatched } });
  appSettings.recordGrouperActivity(`${label}${unmatched ? ` (${unmatched} member${unmatched === 1 ? '' : 's'} matched no user)` : ''}`);
  return out;
}

router.get('/ServiceProviderConfig', (req, res) => res.json({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Token created in the admin console.', primary: true }],
}));

router.get('/ResourceTypes', (req, res) => res.json([
  { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA.user },
  { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCHEMA.group },
]));

/* Users: read-only, so Grouper can look up the ids to use as group members. */

router.get('/Users', (req, res) => {
  const f = parseFilter(req.query.filter);
  let rows = db.all('SELECT * FROM users ORDER BY username');
  if (f) {
    const field = { username: 'username', 'emails.value': 'email', externalid: 'employee_id', id: 'guid' }[f.attr];
    if (!field) throw new ScimError(400, `Cannot filter users by ${f.attr}.`, 'invalidFilter');
    rows = rows.filter((u) => String(u[field]).toLowerCase() === f.value.toLowerCase());
  }
  res.json(page(req, rows, userResource));
});

router.get('/Users/:id', (req, res) => {
  const u = db.get('SELECT * FROM users WHERE guid = ?', req.params.id);
  if (!u) throw new ScimError(404, 'No such user.');
  res.json(userResource(u));
});

const noUserWrites = () => {
  throw new ScimError(501, `Users are managed in ${appSettings.productName()}; Grouper can only manage groups and memberships.`);
};
router.post('/Users', noUserWrites);
router.put('/Users/:id', noUserWrites);
router.patch('/Users/:id', noUserWrites);
router.delete('/Users/:id', noUserWrites);

/* Groups */

router.get('/Groups', (req, res) => {
  const f = parseFilter(req.query.filter);
  let rows = db.all("SELECT * FROM groups WHERE source = 'grouper' ORDER BY name");
  if (f) {
    const field = { displayname: 'name', externalid: 'external_id', id: 'id' }[f.attr];
    if (!field) throw new ScimError(400, `Cannot filter groups by ${f.attr}.`, 'invalidFilter');
    rows = rows.filter((g) => String(g[field]).toLowerCase() === f.value.toLowerCase());
  }
  res.json(page(req, rows, groupResource));
});

router.get('/Groups/:id', (req, res) => res.json(groupResource(findGroup(req.params.id))));

router.post('/Groups', (req, res) => {
  const body = req.body || {};
  const g = write(res, `Created group ${body.displayName}`, () => {
    const externalId = String(body.externalId || '');
    // A group Grouper deleted but that kept pinned members is taken back rather than treated as a clash.
    const retained = typeof body.displayName === 'string'
      && db.get("SELECT * FROM groups WHERE source = 'grouper' AND external_id = '' AND name = ?", body.displayName.trim());
    if (retained) {
      db.run('UPDATE groups SET external_id = ? WHERE id = ?', externalId, retained.id);
      addMembers(retained.id, memberList(body.members));
      return db.get('SELECT * FROM groups WHERE id = ?', retained.id);
    }
    const name = checkName(body.displayName);
    if (externalId && db.get("SELECT 1 FROM groups WHERE source = 'grouper' AND external_id = ?", externalId)) {
      throw new ScimError(409, `A group with externalId "${externalId}" already exists.`, 'uniqueness');
    }
    const id = Number(db.run("INSERT INTO groups (name, description, source, external_id) VALUES (?, '', 'grouper', ?)", name, externalId).lastInsertRowid);
    addMembers(id, memberList(body.members));
    return db.get('SELECT * FROM groups WHERE id = ?', id);
  });
  res.status(201).location(`${baseUrl}${BASE}/Groups/${g.id}`).json(groupResource(g));
});

router.put('/Groups/:id', (req, res) => {
  const body = req.body || {};
  const g = write(res, `Replaced group ${body.displayName}`, () => {
    const group = findGroup(req.params.id);
    renameGroup(group, body.displayName);
    db.run('UPDATE groups SET external_id = ? WHERE id = ?', String(body.externalId || ''), group.id);
    setMembers(group.id, memberList(body.members));
    return db.get('SELECT * FROM groups WHERE id = ?', group.id);
  });
  res.json(groupResource(g));
});

router.patch('/Groups/:id', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.Operations) && !Array.isArray(body.operations)) {
    throw new ScimError(400, 'Operations are required.', 'invalidSyntax');
  }
  const g = write(res, `Updated group ${findGroup(req.params.id).name}`, () => {
    const group = findGroup(req.params.id);
    applyPatch(group, body.Operations || body.operations);
    return db.get('SELECT * FROM groups WHERE id = ?', group.id);
  });
  res.json(groupResource(g));
});

router.delete('/Groups/:id', (req, res) => {
  const group = findGroup(req.params.id);
  write(res, `Deleted group ${group.name}`, () => {
    setMembers(group.id, []);
    // Keep a group that still has pinned members, so the roles and access they carry survive; Grouper can recreate it later.
    if (db.get('SELECT 1 FROM group_members WHERE group_id = ?', group.id)) db.run("UPDATE groups SET external_id = '' WHERE id = ?", group.id);
    else db.run('DELETE FROM groups WHERE id = ?', group.id);
  });
  res.status(204).end();
});

router.use((req, res, next) => next(new ScimError(404, 'Not found.')));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  const known = err instanceof ScimError;
  if (!known) {
    if (err.type === 'entity.parse.failed') err = new ScimError(400, 'Request body is not valid JSON.', 'invalidSyntax');
    else {
      console.error(err);
      err = new ScimError(500, 'Something went wrong.');
    }
  }
  res.status(err.status).type(MEDIA_TYPE).json({ schemas: [SCHEMA.error], status: String(err.status), detail: err.message, scimType: err.scimType });
});

module.exports = { router, newToken, tokenMatches, BASE };
