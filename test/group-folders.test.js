process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const groupApi = require('../src/group-api');

seedAdmin();
const mkUser = (n) => Number(db.run('INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,1)', newGuid(), n, hashPassword(`pw-${n}`)).lastInsertRowid);
const [alice, bob] = ['alice', 'bob'].map(mkUser);

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

let cookie = ''; let csrf = '';
async function api(path, { method = 'GET', body } = {}) {
  const headers = { cookie };
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
async function ext(token, path, { method = 'GET', body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}/group-api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
const mkGroup = async (name) => (await api('/api/admin/groups', { method: 'POST', body: { name, description: 'Test group' } })).json.group.id;

test.before(async () => {
  csrf = (await api('/api/session')).json.csrf;
  assert.equal((await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })).status, 200);
  csrf = (await api('/api/session')).json.csrf;
});

/* ------------------------------ Console ------------------------------ */

test('folders nest, order, and reject loops and duplicate names', async () => {
  const mk = (body) => api('/api/admin/group-folders', { method: 'POST', body });
  const dept = (await mk({ name: 'Departments' })).json;
  const phys = (await mk({ name: 'Underwater Basket-Weaving', parent_id: dept.id })).json;
  assert.equal(phys.path, 'Departments/Underwater Basket-Weaving');
  assert.equal((await mk({ name: 'underwater basket-weaving', parent_id: dept.id })).status, 409);
  assert.equal((await mk({ name: 'a/b' })).status, 400);
  assert.equal((await mk({ name: 'x', parent_id: 9999 })).status, 404);
  assert.equal((await mk({ name: 'Underwater Basket-Weaving' })).status, 201, 'the same name is fine under a different parent');

  const loop = await api('/api/admin/group-folders/move', { method: 'POST', body: { type: 'folder', id: dept.id, parent_id: phys.id } });
  assert.equal(loop.status, 400);
  const self = await api('/api/admin/group-folders/move', { method: 'POST', body: { type: 'folder', id: dept.id, parent_id: dept.id } });
  assert.equal(self.status, 400);
});

test('dragging a group files it and orders it; deleting a folder keeps its contents', async () => {
  const mkF = async (name, parent_id) => (await api('/api/admin/group-folders', { method: 'POST', body: { name, parent_id } })).json;
  const outer = await mkF('Outer'); const inner = await mkF('Inner', outer.id);
  const [g1, g2, g3] = [await mkGroup('mv-a'), await mkGroup('mv-b'), await mkGroup('mv-c')];
  const move = (body) => api('/api/admin/group-folders/move', { method: 'POST', body });
  await move({ type: 'group', id: g1, parent_id: inner.id });
  await move({ type: 'group', id: g2, parent_id: inner.id });
  let r = await move({ type: 'group', id: g3, parent_id: inner.id, before_id: g1 });
  // Include and exclude groups are filed with their base; the lists below are the groups the test made.
  const mine = (ids) => r.json.groups.filter((g) => ids(g) && !g.name.includes(':')).map((g) => g.name);
  assert.deepEqual(mine((g) => g.folder_id === inner.id), ['mv-c', 'mv-a', 'mv-b']);
  assert.equal((await move({ type: 'group', id: g3, parent_id: outer.id, before_id: g1 })).status, 400, 'before_id must be in the destination');

  assert.equal((await api(`/api/admin/group-folders/${inner.id}`, { method: 'DELETE' })).status, 204);
  r = await api('/api/admin/group-folders/tree');
  assert.deepEqual(mine((g) => g.folder_id === outer.id).sort(), ['mv-a', 'mv-b', 'mv-c']);
  assert.ok(r.json.groups.every((g) => g.name.startsWith('mv-') ? g.folder_id === outer.id : true));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE name LIKE 'mv-%' AND name NOT LIKE '%:%'").n, 3, 'groups survive');
  const hist = (await api(`/api/admin/groups/${g1}/audit`)).json;
  assert.ok(hist.some((h) => h.action === 'move'));
});

test('filing is allowed for Grouper groups but renaming them still is not', async () => {
  const id = Number(db.run("INSERT INTO groups (name, source) VALUES ('ref:staff', 'grouper')").lastInsertRowid);
  const f = (await api('/api/admin/group-folders', { method: 'POST', body: { name: 'Filing' } })).json;
  assert.equal((await api('/api/admin/group-folders/move', { method: 'POST', body: { type: 'group', id, parent_id: f.id } })).status, 200);
  assert.equal(db.get('SELECT folder_id FROM groups WHERE id = ?', id).folder_id, f.id);
});

test('viewers can read the tree but not change it', async () => {
  const uid = mkUser('viewer');
  const role = Number(db.run("INSERT INTO roles (key, name) VALUES ('gv', 'Group viewer')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'groups.view')", role);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', uid, role);
  const saved = { cookie, csrf };
  cookie = ''; csrf = (await api('/api/session')).json.csrf;
  await api('/api/login', { method: 'POST', body: { username: 'viewer', password: 'pw-viewer' } });
  csrf = (await api('/api/session')).json.csrf;
  assert.equal((await api('/api/admin/group-folders/tree')).status, 200);
  assert.equal((await api('/api/admin/group-folders', { method: 'POST', body: { name: 'nope' } })).status, 403);
  assert.equal((await api('/api/admin/group-api')).status, 403);
  ({ cookie, csrf } = saved);
});

/* -------------------------------- API --------------------------------- */

test('tokens: created in the console, hashed at rest, scoped, revocable', async () => {
  const r = await api('/api/admin/group-api/tokens', { method: 'POST', body: { name: 'sync', scope: 'write' } });
  assert.equal(r.status, 201);
  assert.match(r.json.token, /^gat_/);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM group_api_tokens')).includes(r.json.token));
  assert.equal((await api('/api/admin/group-api/tokens', { method: 'POST', body: { name: '', scope: 'admin' } })).status, 400);
  assert.equal((await ext('nope', '/tree')).status, 401);
  assert.equal((await ext(r.json.token, '/tree')).status, 200);
  assert.equal((await api(`/api/admin/group-api/tokens/${r.json.tokens[0].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await ext(r.json.token, '/tree')).status, 401);
});

test('a read-only token cannot write', async () => {
  const { token } = groupApi.createToken({ name: 'ro', scope: 'read' });
  assert.equal((await ext(token, '/groups')).status, 200);
  const r = await ext(token, '/folders', { method: 'POST', body: { name: 'x' } });
  assert.equal(r.status, 403);
});

test('the API manages folders, groups, members and nesting', async () => {
  const { token } = groupApi.createToken({ name: 'bot', scope: 'write' });
  const top = (await ext(token, '/folders', { method: 'POST', body: { name: 'Teams' } })).json;
  const sub = (await ext(token, '/folders', { method: 'POST', body: { name: 'Eng', parent_id: top.id } })).json;
  assert.equal(sub.path, 'Teams/Eng');

  const g = await ext(token, '/groups', { method: 'POST', body: { name: 'api-eng', description: 'd', folder_id: sub.id } });
  assert.equal(g.status, 201);
  assert.equal(g.json.folder_path, 'Teams/Eng');
  assert.equal((await ext(token, '/groups', { method: 'POST', body: { name: 'API-ENG', description: 'Test group' } })).status, 409);
  assert.equal((await ext(token, '/groups', { method: 'POST', body: { name: 'z', bogus: 1 } })).status, 400);

  const add = await ext(token, `/groups/${g.json.id}/members`, { method: 'POST', body: { users: ['alice', bob, 'ghost'] } });
  assert.deepEqual(add.json.added.sort(), ['alice', 'bob']);
  assert.deepEqual(add.json.unknown, ['ghost']);
  assert.equal((await ext(token, `/groups/${g.json.id}/members/alice`, { method: 'DELETE' })).status, 204);
  assert.deepEqual((await ext(token, `/groups/${g.json.id}/members`)).json.members.map((m) => m.username), ['bob']);

  const parent = (await ext(token, '/groups', { method: 'POST', body: { name: 'api-all', description: 'Test group' } })).json;
  assert.equal((await ext(token, `/groups/${parent.id}/includes`, { method: 'POST', body: { group_id: g.json.id } })).status, 200);
  assert.equal((await ext(token, `/groups/${g.json.id}/includes`, { method: 'POST', body: { group_id: parent.id } })).status, 400, 'loop');
  assert.deepEqual((await ext(token, `/groups/${parent.id}/effective-members`)).json.members.map((m) => m.username), ['bob']);

  const moved = await ext(token, `/groups/${g.json.id}`, { method: 'PATCH', body: { folder_id: null, name: 'api-eng2' } });
  assert.equal(moved.json.folder_path, '');
  assert.equal(moved.json.name, 'api-eng2');
  const tree = (await ext(token, '/tree')).json;
  assert.deepEqual(tree.folders.find((f) => f.id === top.id).folders[0].groups, []);

  assert.equal((await ext(token, `/folders/${top.id}`, { method: 'PATCH', body: { parent_id: sub.id } })).status, 400, 'loop');
  assert.equal((await ext(token, `/folders/${top.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await ext(token, `/folders/${sub.id}`)).json.parent_id, null, 'subfolder moved up');
  assert.equal((await ext(token, `/groups/${g.json.id}`, { method: 'DELETE' })).status, 204);

  const grouper = Number(db.run("INSERT INTO groups (name, source) VALUES ('ref:x', 'grouper')").lastInsertRowid);
  assert.equal((await ext(token, `/groups/${grouper}/members`, { method: 'POST', body: { users: ['alice'] } })).status, 409);
  assert.equal((await ext(token, `/groups/${grouper}`, { method: 'PATCH', body: { name: 'new' } })).status, 409);
  assert.equal((await ext(token, `/groups/${grouper}`, { method: 'PATCH', body: { folder_id: sub.id } })).status, 200);

  const log = db.all("SELECT actor FROM group_audit WHERE actor LIKE 'api:%'");
  assert.ok(log.length >= 3 && log.every((l) => l.actor === 'api:bot'));
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'group.folder.create' AND actor_name = 'group-api:bot'"));
});

/* ------------------------------ SQL views ----------------------------- */

const sql = (s, ...p) => { try { db.run(s, ...p); return null; } catch (e) { return e.message; } };

test('SQL views create, file, nest and remove, with the same rules and an audit trail', () => {
  assert.equal(sql("INSERT INTO ext_group_folders (name) VALUES ('SqlRoot')"), null);
  const root = db.get("SELECT id FROM ext_group_folders WHERE name = 'SqlRoot'").id;
  assert.equal(sql("INSERT INTO ext_group_folders (name, parent_id) VALUES ('Child', ?)", root), null);
  const child = db.get("SELECT id, path FROM ext_group_folders WHERE name = 'Child'");
  assert.equal(child.path, 'SqlRoot/Child');
  assert.match(sql('UPDATE ext_group_folders SET parent_id = ? WHERE id = ?', child.id, root), /subfolders/);
  assert.match(sql("INSERT INTO ext_group_folders (name) VALUES ('')"), /needs a name/);

  assert.equal(sql("INSERT INTO ext_groups (name, folder_id) VALUES ('sql-a', ?)", child.id), null);
  assert.equal(sql("INSERT INTO ext_groups (name) VALUES ('sql-b')"), null);
  assert.match(sql("INSERT INTO ext_groups (name) VALUES ('SQL-A')"), /UNIQUE/);
  assert.equal(db.get("SELECT folder_path FROM ext_groups WHERE name = 'sql-a'").folder_path, 'SqlRoot/Child');

  assert.equal(sql("INSERT INTO ext_group_members (group_name, username) VALUES ('sql-a', 'alice')"), null);
  assert.match(sql("INSERT INTO ext_group_members (group_name, username) VALUES ('sql-a', 'nobody')"), /No such user/);
  assert.equal(db.all("SELECT username, active FROM ext_group_members WHERE group_name = 'sql-a'").length, 1);

  assert.equal(sql("INSERT INTO ext_group_includes (group_name, member_group_name) VALUES ('sql-b', 'sql-a')"), null);
  assert.match(sql("INSERT INTO ext_group_includes (group_name, member_group_name) VALUES ('sql-a', 'sql-b')"), /loop/);

  const gm = require('../src/group-membership');
  const b = db.get("SELECT id FROM groups WHERE name = 'sql-b'").id;
  assert.equal(gm.effectiveMembers(b).size, 1, 'the console sees what SQL wrote');

  const ro = db.get("SELECT id FROM groups WHERE name = 'ref:x'").id;
  assert.match(sql('UPDATE ext_groups SET name = ? WHERE id = ?', 'renamed', ro), /managed outside/);
  assert.equal(sql('UPDATE ext_groups SET folder_id = ? WHERE id = ?', root, ro), null);
  assert.match(sql('DELETE FROM ext_groups WHERE id = ?', ro), /managed outside/);

  assert.equal(sql("DELETE FROM ext_group_members WHERE group_name = 'sql-a' AND username = 'alice'"), null);
  assert.equal(sql("DELETE FROM ext_groups WHERE name = 'sql-a'"), null);
  assert.equal(sql('DELETE FROM ext_group_folders WHERE id = ?', root), null);
  assert.equal(db.get('SELECT parent_id FROM ext_group_folders WHERE id = ?', child.id).parent_id, null);

  const hist = db.all("SELECT action FROM group_audit WHERE actor = 'sql-interface'").map((r) => r.action);
  for (const a of ['group.create', 'member.add', 'member.remove', 'include.add', 'group.delete']) assert.ok(hist.includes(a), a);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'group.folder.delete' AND actor_name = 'sql-interface'"));
});

test('SQL writes are refused on a connection with foreign keys off, and composites take no members', () => {
  db.db.exec('PRAGMA foreign_keys = OFF');
  try { assert.match(sql("INSERT INTO ext_groups (name) VALUES ('fk-off')"), /foreign_keys/); } finally { db.db.exec('PRAGMA foreign_keys = ON'); }
  const [l, r, c] = ['cl', 'cr', 'cc'].map((n) => Number(db.run('INSERT INTO groups (name) VALUES (?)', n).lastInsertRowid));
  db.run("INSERT INTO group_composites (group_id, op, left_id, right_id) VALUES (?, 'union', ?, ?)", c, l, r);
  assert.match(sql("INSERT INTO ext_group_members (group_name, username) VALUES ('cc', 'alice')"), /composite/);
  assert.equal(db.get('SELECT op FROM ext_group_composites WHERE group_name = ?', 'cc').op, 'union');
  assert.deepEqual(Object.keys(db.get('SELECT * FROM ext_users LIMIT 1')).sort(), ['active', 'display_name', 'email', 'guid', 'id', 'username']);
});
