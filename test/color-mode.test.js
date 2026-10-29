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
const addUser = (name) => Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)',
  newGuid(), name, hashPassword(`${name}-password`), `${name}@x.com`).lastInsertRowid);
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

test('a new account follows the system color theme until the person chooses one', async () => {
  addUser('cm-new');
  const me = await session('cm-new', 'cm-new-password');
  assert.equal(me.login.status, 200);
  const s = await me.call('/api/session');
  assert.equal(s.json.me.color_mode, 'system');
});

test('the signed-in person saves their color theme, and it comes back in the session', async () => {
  addUser('cm-save');
  const me = await session('cm-save', 'cm-save-password');
  const saved = await me.call('/api/account/color-mode', { method: 'POST', body: { color_mode: 'dark' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { color_mode: 'dark' });
  assert.equal((await me.call('/api/session')).json.me.color_mode, 'dark');
  assert.equal(db.get('SELECT color_mode FROM users WHERE username = ?', 'cm-save').color_mode, 'dark');
});

test('only light, dark or system are accepted', async () => {
  addUser('cm-bad');
  const me = await session('cm-bad', 'cm-bad-password');
  const r = await me.call('/api/account/color-mode', { method: 'POST', body: { color_mode: 'purple' } });
  assert.equal(r.status, 400);
  assert.equal((await me.call('/api/session')).json.me.color_mode, 'system');
});

test('the color theme cannot be saved without signing in', async () => {
  const anon = await session('nobody-here', 'wrong');
  const r = await anon.call('/api/account/color-mode', { method: 'POST', body: { color_mode: 'dark' } });
  assert.equal(r.status, 401);
});
