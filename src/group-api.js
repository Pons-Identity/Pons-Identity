const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const gm = require('./group-membership');
const folders = require('./group-folders');
const auditLog = require('./audit');
const { audit } = require('./group-audit');
const { baseUrl } = require('./config');
const appSettings = require('./app-settings');
const ieGroups = require('./group-include-exclude');
const { groupErrors } = require('./group-naming');

// REST API for external software to manage groups and the folders that organize them. Bearer tokens are created in
// Settings → Group API with a 'read' or 'write' scope; a token reaches every group, so treat it like an
// administrator credential. Like the console, it edits only local groups (Grouper and directory groups can be
// filed into folders but are changed at their source). No cookies, no CSRF.

const router = express.Router();
const BASE = '/group-api/v1';

class ApiError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

/* --------------------------------- Tokens ---------------------------------- */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function newToken() {
  const token = `gat_${crypto.randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

function createToken({ name, scope, createdBy }) {
  const { token, hash } = newToken();
  const r = db.run('INSERT INTO group_api_tokens (name, token_hash, scope, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
    name, hash, scope, new Date().toISOString(), createdBy || '');
  return { id: Number(r.lastInsertRowid), token };
}

const listTokens = () => db.all('SELECT id, name, scope, created_at, created_by, last_used_at FROM group_api_tokens ORDER BY id');
const revokeToken = (id) => db.run('DELETE FROM group_api_tokens WHERE id = ?', Number(id)).changes > 0;

function tokenFor(presented) {
  const row = db.get('SELECT id, name, scope, last_used_at FROM group_api_tokens WHERE token_hash = ?', sha256(presented));
  if (row && Date.now() - Date.parse(row.last_used_at || 0) > 60000) {
    db.run('UPDATE group_api_tokens SET last_used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
  }
  return row;
}

/* ---------------------------------- Auth ----------------------------------- */

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  const token = m && tokenFor(m[1]);
  if (!token) {
    res.set('WWW-Authenticate', 'Bearer realm="Pons Identity group API"');
    auditLog.user('token.auth_failure', { outcome: 'failure', actor: { type: 'anonymous', name: 'group-api' }, detail: { api: 'groups', method: req.method, path: req.originalUrl.split('?')[0], tokenPresented: Boolean(m) } });
    return next(new ApiError(401, 'A valid bearer token is required.'));
  }
  if (!['GET', 'HEAD'].includes(req.method) && token.scope !== 'write') {
    return next(new ApiError(403, 'This token is read-only.'));
  }
  req.token = token;
  req.ctx = { actor: { type: 'integration', id: token.id, name: `group-api:${token.name}` }, name: `api:${token.name}` };
  next();
});

router.use(express.json({ limit: '1mb' }));

/* ------------------------------ Representation ----------------------------- */

const folderResource = (f) => ({
  id: f.id, parent_id: f.parent_id, name: f.name, description: f.description, position: f.position,
  path: folders.pathOf(f.id), location: `${baseUrl}${BASE}/folders/${f.id}`,
});

const groupResource = (g) => ({
  id: g.id, name: g.name, description: g.description, source: g.source, folder_id: g.folder_id ?? null,
  folder_path: g.folder_id ? folders.pathOf(g.folder_id) : '', position: g.position,
  composite: Boolean(db.get('SELECT 1 FROM group_composites WHERE group_id = ?', g.id)),
  direct_member_count: db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', g.id).n,
  location: `${baseUrl}${BASE}/groups/${g.id}`,
});

/* ------------------------------- Helpers ----------------------------------- */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const body = (req) => {
  if (!isObject(req.body)) throw new ApiError(400, 'The request body must be a JSON object.');
  return req.body;
};
const only = (b, allowed) => {
  const bad = Object.keys(b).filter((k) => !allowed.includes(k));
  if (bad.length) throw new ApiError(400, 'The request was not valid.', bad.map((k) => `Unknown field "${k}".`));
};

// Folder errors from the shared service carry an HTTP status.
const wrap = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (e) {
    next(e instanceof folders.FolderError ? new ApiError(e.status, e.message) : e);
  }
};

const folderOf = (req) => {
  const f = /^\d+$/.test(req.params.id) && folders.folderRow(req.params.id);
  if (!f) throw new ApiError(404, 'No such folder.');
  return f;
};
const groupOf = (req) => {
  const g = /^\d+$/.test(req.params.id) && db.get('SELECT * FROM groups WHERE id = ?', Number(req.params.id));
  if (!g) throw new ApiError(404, 'No such group.');
  return g;
};
const localGroup = (req) => {
  const g = groupOf(req);
  if (g.source !== 'local') throw new ApiError(409, `This group is managed outside ${appSettings.productName()} (Grouper or an external directory). Change it there.`);
  return g;
};
const userByRef = (ref) => (/^\d+$/.test(String(ref))
  ? db.get('SELECT id, username FROM users WHERE id = ?', Number(ref))
  : db.get('SELECT id, username FROM users WHERE username = ?', String(ref)));

const NAME_MAX = 200;
function groupName(v) {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) throw new ApiError(400, 'name is required.');
  if (name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw new ApiError(400, `name must be ${NAME_MAX} characters or fewer, without control characters.`);
  return name;
}

const page = (req) => ({
  limit: Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100)),
  offset: Math.max(0, parseInt(req.query.offset, 10) || 0),
});

/* --------------------------------- Folders --------------------------------- */

// The whole organization in one call: folders nested to any depth, each holding its groups.
router.get('/tree', (req, res) => {
  const { folders: fs, groups } = folders.tree();
  const node = (f) => ({
    id: f.id, name: f.name, description: f.description, path: f.path,
    folders: fs.filter((c) => c.parent_id === f.id).map(node),
    groups: groups.filter((g) => g.folder_id === f.id).map((g) => ({ id: g.id, name: g.name, source: g.source })),
  });
  res.json({
    folders: fs.filter((f) => f.parent_id === null).map(node),
    groups: groups.filter((g) => g.folder_id === null).map((g) => ({ id: g.id, name: g.name, source: g.source })),
  });
});

router.get('/folders', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.parent_id !== undefined) {
    if (req.query.parent_id === 'none') where.push('parent_id IS NULL');
    else if (/^\d+$/.test(req.query.parent_id)) { where.push('parent_id = ?'); params.push(Number(req.query.parent_id)); }
    else throw new ApiError(400, 'parent_id must be a folder id or "none".');
  }
  const rows = db.all(`SELECT * FROM group_folders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY position, name`, ...params);
  res.json({ folders: rows.map(folderResource) });
});

router.get('/folders/:id', (req, res) => res.json(folderResource(folderOf(req))));

router.post('/folders', wrap((req, res) => {
  const b = body(req);
  only(b, ['name', 'description', 'parent_id', 'before_id']);
  const f = folders.createFolder(req.ctx, b);
  const placed = b.before_id === undefined ? f : folders.place(req.ctx, { type: 'folder', id: f.id, parent_id: f.parent_id, before_id: b.before_id });
  res.status(201).location(folderResource(placed).location).json(folderResource(placed));
}));

// name / description edit the folder; parent_id and before_id move it (parent_id null = top level).
router.patch('/folders/:id', wrap((req, res) => {
  const f = folderOf(req);
  const b = body(req);
  only(b, ['name', 'description', 'parent_id', 'before_id']);
  db.tx(() => {
    if (b.name !== undefined || b.description !== undefined) folders.updateFolder(req.ctx, f.id, b);
    if (b.parent_id !== undefined || b.before_id !== undefined) {
      folders.place(req.ctx, { type: 'folder', id: f.id, parent_id: b.parent_id === undefined ? f.parent_id : b.parent_id, before_id: b.before_id });
    }
  });
  res.json(folderResource(folderOf(req)));
}));

// Groups and subfolders inside move up one level.
router.delete('/folders/:id', wrap((req, res) => {
  folders.deleteFolder(req.ctx, folderOf(req).id);
  res.status(204).end();
}));

/* ---------------------------------- Groups --------------------------------- */

router.get('/groups', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.folder_id !== undefined) {
    if (req.query.folder_id === 'none') where.push('folder_id IS NULL');
    else if (/^\d+$/.test(req.query.folder_id)) { where.push('folder_id = ?'); params.push(Number(req.query.folder_id)); }
    else throw new ApiError(400, 'folder_id must be a folder id or "none".');
  }
  for (const k of ['name', 'source']) {
    if (req.query[k] !== undefined) {
      if (typeof req.query[k] !== 'string') throw new ApiError(400, `${k} must be a single value.`);
      where.push(`${k} = ?`);
      params.push(req.query[k]);
    }
  }
  if (typeof req.query.q === 'string' && req.query.q) { where.push('(name LIKE ? OR description LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = page(req);
  const { n } = db.get(`SELECT COUNT(*) AS n FROM groups ${w}`, ...params);
  const rows = db.all(`SELECT * FROM groups ${w} ORDER BY position, name LIMIT ? OFFSET ?`, ...params, limit, offset);
  res.json({ total: n, limit, offset, groups: rows.map(groupResource) });
});

router.get('/groups/:id', (req, res) => res.json(groupResource(groupOf(req))));

router.post('/groups', wrap((req, res) => {
  const b = body(req);
  only(b, ['name', 'description', 'folder_id', 'before_id']);
  const name = groupName(b.name);
  if (db.get('SELECT 1 FROM groups WHERE name = ?', name)) throw new ApiError(409, 'Group already exists.');
  if (b.description !== undefined && typeof b.description !== 'string') throw new ApiError(400, 'description must be a string.');
  const problems = groupErrors({ name, description: b.description });
  if (problems.length) throw new ApiError(400, problems.join(' '), problems);
  const clash = ieGroups.nameError(name);
  if (clash) throw new ApiError(409, clash);
  const r = db.run('INSERT INTO groups (name, description) VALUES (?, ?)', name, (b.description || '').trim());
  const group = db.get('SELECT * FROM groups WHERE id = ?', Number(r.lastInsertRowid));
  audit(req.ctx.name, group, 'group.create', '', req.ctx.actor);
  ieGroups.create({ id: group.id, name, folder_id: null, source: 'local' }, req.ctx.name, req.ctx.actor);
  if (b.folder_id !== undefined || b.before_id !== undefined) {
    folders.place(req.ctx, { type: 'group', id: group.id, parent_id: b.folder_id, before_id: b.before_id });
  }
  const out = groupResource(db.get('SELECT * FROM groups WHERE id = ?', group.id));
  res.status(201).location(out.location).json(out);
}));

// name / description edit a local group; folder_id and before_id file any group (folder_id null = top level).
router.patch('/groups/:id', wrap((req, res) => {
  const g = groupOf(req);
  const b = body(req);
  only(b, ['name', 'description', 'folder_id', 'before_id']);
  if (b.name !== undefined || b.description !== undefined) {
    if (g.source !== 'local') throw new ApiError(409, `This group is managed outside ${appSettings.productName()} (Grouper or an external directory). Only its folder can change here.`);
    const name = b.name === undefined ? g.name : groupName(b.name);
    if (db.get('SELECT 1 FROM groups WHERE name = ? AND id != ?', name, g.id)) throw new ApiError(409, 'Another group already has that name.');
    if (b.description !== undefined && typeof b.description !== 'string') throw new ApiError(400, 'description must be a string.');
    const description = b.description === undefined ? g.description : b.description.trim();
    const problems = groupErrors({ name, description }, { system: Boolean(ieGroups.ownerOf(g.id)) });
    if (problems.length) throw new ApiError(400, problems.join(' '), problems);
    if (name !== g.name && ieGroups.pairOf(g.id)) {
      const clash = ieGroups.nameError(name);
      if (clash) throw new ApiError(409, clash);
    }
    db.run('UPDATE groups SET name = ?, description = ? WHERE id = ?', name, description, g.id);
    audit(req.ctx.name, { id: g.id, name }, 'group.update', name !== g.name ? `renamed from ${g.name}` : '', req.ctx.actor);
    if (name !== g.name) ieGroups.rename(g.id, name, req.ctx.name, req.ctx.actor);
  }
  if (b.folder_id !== undefined || b.before_id !== undefined) {
    folders.place(req.ctx, { type: 'group', id: g.id, parent_id: b.folder_id === undefined ? g.folder_id : b.folder_id, before_id: b.before_id });
  }
  res.json(groupResource(groupOf(req)));
}));

router.delete('/groups/:id', (req, res) => {
  const g = localGroup(req);
  const owner = ieGroups.ownerOf(g.id);
  if (owner) return res.status(409).json({ error: `This is the include or exclude group of ${owner.name}. Delete ${owner.name} to remove it.` });
  ieGroups.removeFor(g.id, req.ctx.name, req.ctx.actor);
  audit(req.ctx.name, g, 'group.delete', '', req.ctx.actor);
  db.run('DELETE FROM groups WHERE id = ?', g.id);
  res.status(204).end();
});

/* --------------------------------- Members --------------------------------- */

const memberRows = (id) => db.all(`SELECT u.id AS user_id, u.username, u.display_name, u.email, m.start_at, m.end_at
                                   FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.username`, id);

router.get('/groups/:id/members', (req, res) => res.json({ members: memberRows(groupOf(req).id) }));

router.get('/groups/:id/effective-members', (req, res) => {
  const ids = [...gm.effectiveMembers(groupOf(req).id)];
  res.json({
    members: ids.length
      ? db.all(`SELECT id AS user_id, username, display_name, email FROM users WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY username`, ...ids)
      : [],
  });
});

// Add people by username or user id. People already in the group are left alone; unknown ones are reported.
router.post('/groups/:id/members', (req, res) => {
  const g = localGroup(req);
  const b = body(req);
  only(b, ['users']);
  if (!Array.isArray(b.users) || !b.users.length || b.users.length > 500) throw new ApiError(400, 'users must be an array of 1 to 500 usernames or user ids.');
  if (db.get('SELECT 1 FROM group_composites WHERE group_id = ?', g.id)) throw new ApiError(409, 'This is a composite group; its members come from its two factor groups.');
  const added = [];
  const unknown = [];
  for (const ref of b.users) {
    const u = (typeof ref === 'string' || Number.isInteger(ref)) && userByRef(ref);
    if (!u) { unknown.push(ref); continue; }
    if (gm.addDirect(g.id, u.id)) {
      audit(req.ctx.name, g, 'member.add', u.username, req.ctx.actor);
      added.push(u.username);
    }
  }
  res.json({ added, unknown, members: memberRows(g.id) });
});

router.delete('/groups/:id/members/:user', (req, res) => {
  const g = localGroup(req);
  const u = userByRef(req.params.user);
  if (u && db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', g.id, u.id).changes) {
    audit(req.ctx.name, g, 'member.remove', u.username, req.ctx.actor);
  }
  res.status(204).end();
});

/* ------------------------------- Member groups ----------------------------- */

const includeRows = (id) => db.all(`SELECT c.id, c.name, c.source FROM group_includes i JOIN groups c ON c.id = i.member_group_id
                                    WHERE i.group_id = ? ORDER BY c.name`, id);

router.get('/groups/:id/includes', (req, res) => res.json({ includes: includeRows(groupOf(req).id) }));

router.post('/groups/:id/includes', (req, res) => {
  const g = localGroup(req);
  const b = body(req);
  only(b, ['group_id']);
  const child = Number.isInteger(b.group_id) && db.get('SELECT id, name FROM groups WHERE id = ?', b.group_id);
  if (!child) throw new ApiError(400, 'group_id must be the id of the group to add as a member.');
  if (db.get('SELECT 1 FROM group_composites WHERE group_id = ?', g.id)) throw new ApiError(409, 'A composite group takes its members from its two factor groups; it cannot also have member groups.');
  if (gm.wouldCycle(g.id, child.id)) throw new ApiError(400, `Adding "${child.name}" as a member would create a loop.`);
  if (db.run('INSERT OR IGNORE INTO group_includes (group_id, member_group_id) VALUES (?, ?)', g.id, child.id).changes) {
    audit(req.ctx.name, g, 'include.add', child.name, req.ctx.actor);
  }
  res.json({ includes: includeRows(g.id) });
});

router.delete('/groups/:id/includes/:childId', (req, res) => {
  const g = localGroup(req);
  const child = db.get('SELECT name FROM groups WHERE id = ?', Number(req.params.childId));
  if (db.run('DELETE FROM group_includes WHERE group_id = ? AND member_group_id = ?', g.id, Number(req.params.childId)).changes) {
    audit(req.ctx.name, g, 'include.remove', child ? child.name : req.params.childId, req.ctx.actor);
  }
  res.status(204).end();
});

/* ---------------------------------- People --------------------------------- */

// Look people up by username, email or a text search, to get the ids and usernames the routes above take.
router.get('/users', (req, res) => {
  const where = [];
  const params = [];
  for (const k of ['username', 'email']) {
    if (req.query[k] !== undefined) {
      if (typeof req.query[k] !== 'string') throw new ApiError(400, `${k} must be a single value.`);
      where.push(`${k} = ? COLLATE NOCASE`);
      params.push(req.query[k]);
    }
  }
  if (typeof req.query.q === 'string' && req.query.q) { where.push('(username LIKE ? OR display_name LIKE ? OR email LIKE ?)'); params.push(...Array(3).fill(`%${req.query.q}%`)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, offset } = page(req);
  const { n } = db.get(`SELECT COUNT(*) AS n FROM users ${w}`, ...params);
  res.json({ total: n, limit, offset, users: db.all(`SELECT id, username, display_name, email, active FROM users ${w} ORDER BY username LIMIT ? OFFSET ?`, ...params, limit, offset) });
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

module.exports = { router, BASE, createToken, listTokens, revokeToken };
