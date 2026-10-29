process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const mkUser = (n) => Number(db.run('INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,1)',
  newGuid(), n, hashPassword(`${n}-password`)).lastInsertRowid);
const dana = mkUser('dana'); const erin = mkUser('erin'); const frank = mkUser('frank');

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const api = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  api.login = async (username, password) => {
    csrf = (await api('/api/session')).json.csrf;
    assert.equal((await api('/api/login', { method: 'POST', body: { username, password } })).status, 200);
    csrf = (await api('/api/session')).json.csrf;
  };
  return api;
}

const admin = client(); const d = client();
test.before(async () => {
  await admin.login('admin', 'adminpass123');
  await d.login('dana', 'dana-password');
});
const mk = async (name) => (await admin('/api/admin/groups', { method: 'POST', body: { name, description: 'Test group' } })).json.group.id;
const grant = (gid, type, id, privilege) => admin(`/api/admin/groups/${gid}/admins`, { method: 'POST', body: { subject_type: type, subject_id: id, privilege } });

test('without a grant, a signed-in person manages nothing', async () => {
  const g = await mk('finance');
  assert.deepEqual((await d('/api/my/groups')).json, []);
  assert.equal((await d(`/api/my/groups/${g}/structure`)).status, 404);
  assert.equal((await d('/api/admin/groups')).status, 403);
  assert.equal((await d('/api/session')).json.me.manages_groups, false);
});

test('an update grant allows member changes and nothing structural', async () => {
  const g = await mk('hr'); const other = await mk('hr-other');
  assert.equal((await grant(g, 'user', dana, 'update')).status, 201);

  const mine = (await d('/api/my/groups')).json;
  assert.deepEqual(mine.map((x) => [x.name, x.privilege]), [['hr', 'update']]);
  assert.equal((await d('/api/session')).json.me.manages_groups, true);

  const cands = (await d(`/api/my/groups/${g}/candidates?q=eri`)).json;
  assert.deepEqual(cands.map((u) => u.username), ['erin']);
  assert.equal((await d(`/api/my/groups/${g}/members`, { method: 'POST', body: { user_ids: [erin] } })).json.effective_count, 1);
  assert.equal((await d(`/api/my/groups/${g}/members/${erin}/window`, { method: 'PUT', body: { end_at: null } })).status, 200);
  assert.equal((await d(`/api/my/groups/${g}/members/${erin}`, { method: 'DELETE' })).json.effective_count, 0);

  assert.equal((await d(`/api/my/groups/${g}/includes`, { method: 'POST', body: { group_id: other } })).status, 403);
  assert.equal((await d(`/api/my/groups/${g}/admins`)).status, 403);
  assert.equal((await d(`/api/my/groups/${other}/structure`)).status, 404, 'other groups stay hidden');

  const log = (await d(`/api/my/groups/${g}/audit`)).json.map((e) => [e.actor, e.action]);
  assert.deepEqual(log.slice(0, 3), [['dana', 'member.remove'], ['dana', 'member.window'], ['dana', 'member.add']]);
});

test('a view grant lists the group but reveals nothing else', async () => {
  const g = await mk('legal');
  await grant(g, 'user', dana, 'view');
  assert.ok((await d('/api/my/groups')).json.some((x) => x.name === 'legal'));
  assert.equal((await d(`/api/my/groups/${g}/structure`)).status, 403);
});

test('an admin grant through a group works by effective membership, and can delegate further', async () => {
  const g = await mk('ops'); const team = await mk('ops-leads'); const inner = await mk('ops-inner');
  await admin(`/api/admin/groups/${inner}/members`, { method: 'POST', body: { user_ids: [dana] } });
  await admin(`/api/admin/groups/${team}/includes`, { method: 'POST', body: { group_id: inner } });
  await grant(g, 'group', team, 'admin');

  const s = await d(`/api/my/groups/${g}/structure`);
  assert.equal(s.json.privilege, 'admin');
  const rows = (await d(`/api/my/groups/${g}/admins`, {})).json;
  assert.deepEqual(rows.map((r) => [r.subject_type, r.subject_name, r.privilege]), [['group', 'ops-leads', 'admin']]);

  // Dana can delegate to Erin, but cannot nest a group she cannot see.
  assert.equal((await d(`/api/my/groups/${g}/admins`, { method: 'POST', body: { subject_type: 'user', subject_id: erin, privilege: 'read' } })).status, 201);
  const hidden = await mk('board');
  assert.equal((await d(`/api/my/groups/${g}/includes`, { method: 'POST', body: { group_id: hidden } })).status, 400);
  assert.equal((await d(`/api/my/groups/${g}/includes`, { method: 'POST', body: { group_id: inner } })).status, 400, 'no privilege on it yet');
  await grant(inner, 'user', dana, 'view');
  assert.equal((await d(`/api/my/groups/${g}/includes`, { method: 'POST', body: { group_id: inner } })).status, 200);

  // Erin, a reader, sees the group but cannot change it.
  const e = client(); await e.login('erin', 'erin-password');
  assert.equal((await e(`/api/my/groups/${g}/structure`)).status, 200);
  assert.equal((await e(`/api/my/groups/${g}/members`, { method: 'POST', body: { user_ids: [frank] } })).status, 403);

  // Revoking removes the access immediately.
  const row = rows[0];
  assert.equal((await d(`/api/my/groups/${g}/admins/${row.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await d(`/api/my/groups/${g}/structure`)).status, 404);
});

test('external groups stay read-only for delegates; deleting a person removes their grants', async () => {
  const ext = Number(db.run("INSERT INTO groups (name, source) VALUES ('ref:x', 'grouper')").lastInsertRowid);
  db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'user', ?, 'admin')", ext, dana);
  assert.equal((await d(`/api/my/groups/${ext}/members`, { method: 'POST', body: { user_ids: [erin] } })).status, 409);
  assert.equal((await d(`/api/my/groups/${ext}/structure`)).status, 200);

  const tmp = mkUser('temp');
  db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'user', ?, 'read')", ext, tmp);
  db.run('DELETE FROM users WHERE id = ?', tmp);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM group_admins WHERE subject_type = 'user' AND subject_id = ?", tmp).n, 0);
});

test('admin privileges validate their input', async () => {
  const g = await mk('val');
  assert.equal((await grant(g, 'robot', 1, 'admin')).status, 400);
  assert.equal((await grant(g, 'user', dana, 'owner')).status, 400);
  assert.equal((await grant(g, 'user', 99999, 'admin')).status, 400);
});

test('group admins can search people to delegate to', async () => {
  const g = await mk('searchable');
  await grant(g, 'user', dana, 'admin');
  assert.deepEqual((await d(`/api/my/groups/${g}/people?q=fran`)).json.map((u) => u.username), ['frank']);
  const reader = await mk('searchable-ro');
  await grant(reader, 'user', dana, 'update');
  assert.equal((await d(`/api/my/groups/${reader}/people?q=fran`)).status, 403);
});
