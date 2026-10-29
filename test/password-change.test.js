process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const userService = require('../src/user-service');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function session(username, password) {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  await call('/api/session');
  const login = await call('/api/login', { method: 'POST', body: { username, password } });
  return { call, login };
}

test('setPassword records who and how, and rejects an unknown source', () => {
  const id = Number(db.run('INSERT INTO users (guid, username, password_hash) VALUES (?,?,?)', newGuid(), 'pat', hashPassword('x')).lastInsertRowid);
  assert.equal(userService.passwordInfo(db.get('SELECT * FROM users WHERE id = ?', id)), null);
  assert.throws(() => userService.setPassword(id, 'newpassword1', { via: 'magic' }));
  userService.setPassword(id, 'newpassword1', { by: null, via: 'bulk' });
  const info = userService.passwordInfo(db.get('SELECT * FROM users WHERE id = ?', id));
  assert.equal(info.via, 'bulk');
  assert.equal(info.by, null);
  assert.ok(info.changed_at);
});

test('an admin-set password shows which admin, and a self change shows the user', async () => {
  const { call } = await session('admin', 'adminpass123');
  const created = await call('/api/admin/users', { method: 'POST', body: { username: 'quinn', password: 'quinnpass1abc', active: true } });
  assert.equal(created.status, 201);
  assert.equal(created.json.password_info.via, 'admin');
  assert.equal(created.json.password_info.by.username, 'admin');
  assert.equal(created.json.password_hash, undefined);

  const reset = await call(`/api/admin/users/${created.json.id}`, { method: 'PUT', body: { ...created.json, password: 'quinnpass2abc' } });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.password_info.by.username, 'admin');

  const quinn = await session('quinn', 'quinnpass2abc');
  const changed = await quinn.call('/api/account/password', { method: 'POST', body: { current_password: 'quinnpass2abc', new_password: 'quinnpass3abc' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.user.password.via, 'self');
  assert.equal(changed.json.user.password.by_self, true);

  const seen = await call(`/api/admin/users/${created.json.id}`);
  assert.equal(seen.json.password_info.via, 'self');
  assert.equal(seen.json.password_info.by.username, 'quinn');
});

test('a user can hold several emails with one primary, mirrored into users.email', async () => {
  const { call } = await session('admin', 'adminpass123');
  const made = await call('/api/admin/users', { method: 'POST', body: { username: 'riley', password: 'rileypass1abc', active: true,
    emails: [{ email: 'riley@a.net' }, { email: 'r.riley@b.net', primary: true }] } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.emails, [{ email: 'r.riley@b.net', primary: true }, { email: 'riley@a.net', primary: false }]);
  assert.equal(made.json.email, 'r.riley@b.net');

  // either address signs in
  assert.equal((await session('riley@a.net', 'rileypass1abc')).login.status, 200);

  // another user cannot claim one, and two primaries are refused
  const clash = await call('/api/admin/users', { method: 'POST', body: { username: 'sam', password: 'sampass123abc', active: true, emails: ['riley@a.net'] } });
  assert.equal(clash.status, 400);
  const two = await call(`/api/admin/users/${made.json.id}`, { method: 'PUT', body: { ...made.json, password: '', emails: [{ email: 'a@x.net', primary: true }, { email: 'b@x.net', primary: true }] } });
  assert.equal(two.status, 400);

  // switching the primary changes users.email; the old address stays as a secondary
  const swap = await call(`/api/admin/users/${made.json.id}`, { method: 'PUT', body: { ...made.json, password: '', emails: [{ email: 'riley@a.net', primary: true }, { email: 'r.riley@b.net' }] } });
  assert.equal(swap.status, 200);
  assert.equal(swap.json.email, 'riley@a.net');
  assert.equal(swap.json.emails.length, 2);
});

test('writers that only set users.email keep the email list in step', () => {
  const id = Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)', newGuid(), 'tess', 'x', 't@a.net').lastInsertRowid);
  assert.deepEqual(userService.emailsOf(id), [{ email: 't@a.net', primary: true }]);
  db.run('UPDATE users SET email = ? WHERE id = ?', 't2@a.net', id);
  assert.deepEqual(userService.emailsOf(id), [{ email: 't2@a.net', primary: true }, { email: 't@a.net', primary: false }]);
});
