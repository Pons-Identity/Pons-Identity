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
db.run('INSERT INTO users (guid, username, password_hash, first_name, last_name, active) VALUES (?,?,?,?,?,1)',
  newGuid(), 'bob', hashPassword('bobpassword'), 'Bob', 'Builder');

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// Minimal cookie-keeping client for the API.
function client() {
  let cookie = '';
  return async function api(path, { method = 'GET', body, csrf } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
    const r = await fetch(base + path, { method, headers, redirect: 'manual',
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text, type: r.headers.get('content-type') || '' };
  };
}

async function csrfOf(api) {
  return (await api('/api/session')).json.csrf;
}

test('session bootstrap is anonymous until login', async () => {
  const api = client();
  const r = await api('/api/session');
  assert.equal(r.status, 200);
  assert.equal(r.json.me, null);
  assert.match(r.json.csrf, /^[0-9a-f]+$/);
});

test('JSON write without a CSRF token is rejected with JSON', async () => {
  const api = client();
  const r = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  assert.equal(r.status, 403);
  assert.match(r.type, /application\/json/);
  assert.ok(Array.isArray(r.json.errors));
});

test('wrong password returns 401 JSON', async () => {
  const api = client();
  const csrf = await csrfOf(api);
  const r = await api('/api/login', { method: 'POST', csrf, body: { username: 'admin', password: 'nope' } });
  assert.equal(r.status, 401);
  assert.match(r.json.error, /Invalid username or password/);
});

test('malformed JSON body returns 400 JSON, not HTML', async () => {
  const api = client();
  const csrf = await csrfOf(api);
  const r = await api('/api/login', { method: 'POST', csrf, body: '{not json' });
  assert.equal(r.status, 400);
  assert.match(r.type, /application\/json/);
});

test('unknown API paths return JSON 404', async () => {
  const api = client();
  const r = await api('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.match(r.type, /application\/json/);
});

test('admin API requires sign-in, and admin rights for admin routes', async () => {
  const anon = client();
  assert.equal((await anon('/api/admin/users')).status, 401);

  const bob = client();
  const csrfB = await csrfOf(bob);
  const login = await bob('/api/login', { method: 'POST', csrf: csrfB, body: { username: 'bob', password: 'bobpassword' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.mfa, null);
  assert.equal((await bob('/api/admin/users')).status, 403);
  assert.equal((await bob('/api/apps')).status, 200);
});

test('admin can manage users through the API', async () => {
  const api = client();
  const csrf0 = await csrfOf(api);
  const login = await api('/api/login', { method: 'POST', csrf: csrf0, body: { username: 'admin', password: 'adminpass123' } });
  assert.equal(login.status, 200);
  const csrf = await csrfOf(api);

  const bad = await api('/api/admin/users', { method: 'POST', csrf, body: { username: '', password: 'short' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.length >= 2);

  const created = await api('/api/admin/users', { method: 'POST', csrf,
    body: { username: 'carol', password: 'carolpassword', first_name: 'Carol', last_name: 'Danvers', active: true, custom: 'badge=42' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.username, 'carol');
  assert.equal(created.json.password_hash, undefined);
  assert.equal(created.json.custom, 'badge=42');

  const dup = await api('/api/admin/users', { method: 'POST', csrf, body: { username: 'carol', password: 'carolpassword' } });
  assert.equal(dup.status, 400);
  assert.deepEqual(dup.json.errors, ['That username already exists.']);

  const id = created.json.id;
  const updated = await api(`/api/admin/users/${id}`, { method: 'PUT', csrf,
    body: { username: 'carol', first_name: 'Carol', last_name: 'Jones', active: true } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.display_name, 'Carol Jones');

  const self = await api('/api/admin/users/1', { method: 'PUT', csrf, body: { username: 'admin', active: false } });
  assert.equal(self.status, 400);

  const del = await api(`/api/admin/users/${id}`, { method: 'DELETE', csrf });
  assert.equal(del.status, 204);
});

test('admin can create and validate a service provider through the API', async () => {
  const api = client();
  const csrf0 = await csrfOf(api);
  await api('/api/login', { method: 'POST', csrf: csrf0, body: { username: 'admin', password: 'adminpass123' } });
  const csrf = await csrfOf(api);

  const bad = await api('/api/admin/sps', { method: 'POST', csrf, body: { name: '', acs_url: [], nameid_format: 'emailAddress' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.some((e) => /Name is required/.test(e)));

  const created = await api('/api/admin/sps', { method: 'POST', csrf, body: {
    name: 'Portal', sp_entity_id: 'urn:portal', acs_url: ['https://portal.test/acs'], nameid_format: 'emailAddress',
    nameid_source: 'email', signature_algorithm: 'sha256', sign_response: true, sign_assertion: true,
    map_idp: ['email'], map_saml: ['mail'], static_name: [], static_value: [],
  } });
  assert.equal(created.status, 201);
  assert.equal(created.json.sp.name, 'Portal');
  assert.equal(created.json.sp.private_key_pem, undefined);
  assert.match(created.json.fingerprints.sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.match(created.json.metadata, /EntityDescriptor/);
  assert.equal(created.json.sp.maps[0].saml_name, 'mail');
});

test('there is no JSON sign-out; sign-out stays a form POST to /logout', async () => {
  const api = client();
  const r = await api('/api/logout', { method: 'POST', csrf: await csrfOf(api), body: {} });
  assert.equal(r.status, 404);
});

test('users can be assigned the Administrator role, which grants admin access', async () => {
  const api = client();
  await api('/api/login', { method: 'POST', csrf: await csrfOf(api), body: { username: 'admin', password: 'adminpass123' } });
  const csrf = await csrfOf(api);

  const seeded = await api('/api/admin/users/1');
  assert.equal(seeded.json.is_admin, true);
  const { roles } = (await api('/api/admin/options')).json;
  const adminRole = roles.find((r) => r.name === 'Administrator');
  assert.ok(adminRole);
  assert.deepEqual(seeded.json.role_ids, [adminRole.id]);

  const dana = await api('/api/admin/users', { method: 'POST', csrf,
    body: { username: 'dana', password: 'danapassword', active: true, role_ids: [adminRole.id] } });
  assert.equal(dana.json.is_admin, true);

  const asDana = client();
  await asDana('/api/login', { method: 'POST', csrf: await csrfOf(asDana), body: { username: 'dana', password: 'danapassword' } });
  assert.equal((await asDana('/api/session')).json.me.is_admin, true);
  assert.equal((await asDana('/api/admin/users')).status, 200);

  // Removing the role revokes access; admins cannot strip their own role.
  const revoked = await api(`/api/admin/users/${dana.json.id}`, { method: 'PUT', csrf,
    body: { username: 'dana', active: true, role_ids: [] } });
  assert.equal(revoked.json.is_admin, false);
  assert.equal((await asDana('/api/admin/users')).status, 403);

  const self = await api('/api/admin/users/1', { method: 'PUT', csrf, body: { username: 'admin', active: true, role_ids: [] } });
  assert.equal(self.status, 400);
});
