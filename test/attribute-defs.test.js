process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function admin() {
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
  await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  return call;
}

test('definitions are validated and typed values are checked on save', async () => {
  const call = await admin();
  assert.equal((await call('/api/admin/attribute-defs', { method: 'POST', body: { name: '1bad', type: 'text' } })).status, 400);
  assert.equal((await call('/api/admin/attribute-defs', { method: 'POST', body: { name: 'badge', type: 'enum', options: [] } })).status, 400);
  assert.equal((await call('/api/admin/attribute-defs', { method: 'POST', body: { name: 'floor', type: 'number', default_value: '3' } })).status, 201);
  assert.equal((await call('/api/admin/attribute-defs', { method: 'POST', body: { name: 'badge', label: 'Badge', type: 'enum', options: 'red\nblue', required: true } })).status, 201);
  assert.equal((await call('/api/admin/attribute-defs', { method: 'POST', body: { name: 'floor', type: 'text' } })).status, 400);

  const missing = await call('/api/admin/users', { method: 'POST', body: { username: 'una', password: 'unapass123abc', active: true } });
  assert.equal(missing.status, 400);
  assert.match(missing.json.errors[0], /Badge is required/);
  const wrong = await call('/api/admin/users', { method: 'POST', body: { username: 'una', password: 'unapass123abc', active: true, attributes: { badge: 'green' } } });
  assert.equal(wrong.status, 400);

  const ok = await call('/api/admin/users', { method: 'POST', body: { username: 'una', password: 'unapass123abc', active: true,
    attributes: { badge: 'red' }, custom: 'pet=cat\nbadge=blue' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.json.attributes, { badge: 'red', floor: '3' });
  assert.equal(ok.json.custom, 'pet=cat');

  // an update that does not mention the attribute leaves it alone
  const same = await call(`/api/admin/users/${ok.json.id}`, { method: 'PUT', body: { ...ok.json, password: '', attributes: undefined } });
  assert.equal(same.status, 200);
  assert.equal(same.json.attributes.badge, 'red');
  const bad = await call(`/api/admin/users/${ok.json.id}`, { method: 'PUT', body: { ...ok.json, password: '', attributes: { floor: 'high' } } });
  assert.equal(bad.status, 400);

  // deleting the definition leaves the value as a free-form attribute
  assert.equal((await call('/api/admin/attribute-defs/badge', { method: 'DELETE' })).status, 204);
  const after = await call(`/api/admin/users/${ok.json.id}`);
  assert.match(after.json.custom, /badge=red/);
  assert.ok(db.get("SELECT 1 FROM user_attributes WHERE name = 'badge'"));
});

test('defined attributes are on each person row, searched as text and matched by LDAP filters', async () => {
  const call = await admin();
  assert.equal((await call('/api/admin/attribute-defs', { method: 'POST', body: { name: 'room', label: 'Room', type: 'text' } })).status, 201);
  assert.equal((await call('/api/admin/users', { method: 'POST', body: { username: 'vera', password: 'verapass123abc', active: true, attributes: { room: 'r-204' } } })).status, 201);

  const byText = (await call('/api/admin/users?q=r-204')).json;
  assert.deepStrictEqual(byText.map((u) => [u.username, u.attributes.room, u.matched]), [['vera', 'r-204', ['attr:room']]]);

  const byFilter = (await call(`/api/admin/users?q=${encodeURIComponent('(room=r-2*)')}`)).json;
  assert.deepStrictEqual(byFilter.map((u) => u.username), ['vera']);
  assert.deepStrictEqual((await call(`/api/admin/users?q=${encodeURIComponent('(room=r-9*)')}`)).json, []);
});
