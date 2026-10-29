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
const ids = { eve: addUser('eve'), fay: addUser('fay'), gus: addUser('gus') };

// Stub the Duo Auth API check; everything else goes to the real network stack.
const realFetch = globalThis.fetch;
const duoCheck = { ok: true };
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://api-test.duosecurity.com/')) return realFetch(url, opts);
  return new Response(JSON.stringify(duoCheck.ok ? { stat: 'OK', response: { time: 1 } } : { stat: 'FAIL', code: 40101, message: 'Invalid integration key' }),
    { headers: { 'content-type': 'application/json' } });
};

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function signIn(username, password) {
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
  // Prime the session cookie, then sign in.
  await call('/api/session');
  const r = await call('/api/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200);
  return call;
}

test('roles can be created by permission and people added to them', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const catalog = await admin('/api/admin/roles');
  assert.ok(catalog.json.permissions.some((p) => p.key === 'duo.manage'));
  const builtin = catalog.json.roles.find((r) => r.builtin);
  assert.deepEqual(new Set(builtin.permissions), new Set(catalog.json.permissions.map((p) => p.key)));

  const created = await admin('/api/admin/roles', { method: 'POST', body: { name: 'Help desk', description: 'Resets', permissions: ['users.manage'], user_ids: [ids.eve] } });
  assert.equal(created.status, 201);
  // "manage" brings its "view" along.
  assert.deepEqual(new Set(created.json.role.permissions), new Set(['users.manage', 'users.view']));
  assert.deepEqual(created.json.members.map((m) => m.username), ['eve']);

  const eve = await signIn('eve', 'eve-password');
  const session = (await eve('/api/session')).json.me;
  assert.equal(session.is_admin, true);
  assert.equal((await eve('/api/admin/users')).status, 200);
  // Only what the role grants.
  assert.equal((await eve('/api/admin/groups')).status, 403);
  assert.equal((await eve('/api/admin/settings/duo')).status, 403);
  assert.equal((await eve('/api/admin/roles')).status, 403);

  // Changing the role's permissions takes effect immediately.
  const updated = await admin(`/api/admin/roles/${created.json.role.id}`, { method: 'PUT', body: { name: 'Help desk', permissions: ['groups.view'], user_ids: [ids.eve, ids.fay] } });
  assert.equal(updated.status, 200);
  assert.equal((await eve('/api/admin/users')).status, 403);
  assert.equal((await eve('/api/admin/groups')).status, 200);

  const dup = await admin('/api/admin/roles', { method: 'POST', body: { name: 'help DESK', permissions: [] } });
  assert.equal(dup.status, 400);

  assert.equal((await admin(`/api/admin/roles/${created.json.role.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await eve('/api/admin/groups')).status, 403);
});

test('the Administrator role cannot be edited or deleted, but its members can change', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const role = (await admin('/api/admin/roles')).json.roles.find((r) => r.builtin);
  assert.equal((await admin(`/api/admin/roles/${role.id}`, { method: 'DELETE' })).status, 400);

  const renamed = await admin(`/api/admin/roles/${role.id}`, { method: 'PUT', body: { name: 'Nope', permissions: [], user_ids: [1, ids.gus] } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.role.name, 'Administrator');
  assert.equal(renamed.json.role.permissions.length, (await admin('/api/admin/roles')).json.permissions.length);
  assert.equal((await (await signIn('gus', 'gus-password'))('/api/admin/settings/duo')).status, 200);

  // Admins cannot remove themselves.
  const self = await admin(`/api/admin/roles/${role.id}`, { method: 'PUT', body: { user_ids: [ids.gus] } });
  assert.equal(self.status, 400);
  await admin(`/api/admin/roles/${role.id}`, { method: 'PUT', body: { user_ids: [1] } });
});

test('role managers cannot grant permissions they do not hold or edit more powerful users', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const mgr = (await admin('/api/admin/roles', { method: 'POST', body: { name: 'Role manager', permissions: ['roles.manage', 'users.manage'], user_ids: [ids.fay] } })).json.role;
  const fay = await signIn('fay', 'fay-password');

  const grab = await fay('/api/admin/roles', { method: 'POST', body: { name: 'Sneaky', permissions: ['duo.manage'], user_ids: [ids.fay] } });
  assert.equal(grab.status, 400);
  const own = await fay(`/api/admin/roles/${mgr.id}`, { method: 'PUT', body: { name: 'Role manager', permissions: ['roles.manage', 'users.manage', 'duo.manage'], user_ids: [ids.fay] } });
  assert.equal(own.status, 400);
  // Cannot give herself the Administrator role through the user form either.
  const adminRoleId = (await admin('/api/admin/roles')).json.roles.find((r) => r.builtin).id;
  const viaUser = await fay(`/api/admin/users/${ids.fay}`, { method: 'PUT', body: { username: 'fay', active: true, role_ids: [mgr.id, adminRoleId] } });
  assert.equal(viaUser.status, 400);
  // Cannot reset or delete an administrator.
  assert.equal((await fay('/api/admin/users/1/reset-totp', { method: 'POST' })).status, 403);
  assert.equal((await fay('/api/admin/users/1', { method: 'PUT', body: { username: 'admin', active: true, password: 'hijacked-pass' } })).status, 403);
  assert.equal((await fay('/api/admin/users/1', { method: 'DELETE' })).status, 403);
  // Cannot drop her own access by deleting the role.
  assert.equal((await fay(`/api/admin/roles/${mgr.id}`, { method: 'DELETE' })).status, 400);
  await admin(`/api/admin/roles/${mgr.id}`, { method: 'DELETE' });
});

test('without roles.manage, role and group lists on a user record are ignored', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const adminRoleId = (await admin('/api/admin/roles')).json.roles.find((r) => r.builtin).id;
  const role = (await admin('/api/admin/roles', { method: 'POST', body: { name: 'Users only', permissions: ['users.manage'], user_ids: [ids.eve] } })).json.role;
  const eve = await signIn('eve', 'eve-password');
  const r = await eve(`/api/admin/users/${ids.gus}`, { method: 'PUT', body: { username: 'gus', first_name: 'Gus', active: true, role_ids: [role.id, adminRoleId] } });
  // gus is an administrator-equivalent target? he is not (removed above), so the edit applies but roles stay untouched.
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.role_ids, []);
  assert.equal(r.json.first_name, 'Gus');
  await admin(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
});

test('Duo settings: secret is never returned, enabling needs Duo to accept the keys', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const before = await admin('/api/admin/settings/duo');
  assert.equal(before.json.enabled, false);
  assert.equal(before.json.secretSet, false);

  const badHost = await admin('/api/admin/settings/duo', { method: 'PUT', body: { enabled: true, apiHost: 'internal.example', integrationKey: 'DI1', secretKey: 's' } });
  assert.equal(badHost.status, 400);
  const missing = await admin('/api/admin/settings/duo', { method: 'PUT', body: { enabled: true, apiHost: 'api-test.duosecurity.com', integrationKey: 'DI1' } });
  assert.equal(missing.status, 400);

  duoCheck.ok = false;
  const rejected = await admin('/api/admin/settings/duo', { method: 'PUT', body: { enabled: true, apiHost: 'api-test.duosecurity.com', integrationKey: 'DI1', secretKey: 'sekrit' } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.errors[0], /Invalid integration key/);
  assert.equal((await admin('/api/admin/settings/duo')).json.enabled, false);

  duoCheck.ok = true;
  const saved = await admin('/api/admin/settings/duo', { method: 'PUT', body: { enabled: true, apiHost: 'API-test.duosecurity.com', integrationKey: 'DI1', secretKey: 'sekrit' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.enabled, true);
  assert.equal(saved.json.secretSet, true);
  assert.equal(JSON.stringify(saved.json).includes('sekrit'), false);
  assert.equal((await admin('/api/session')).json.config.duoEnabled, true);

  // A blank secret keeps the stored one; disabling needs no check.
  duoCheck.ok = false;
  const off = await admin('/api/admin/settings/duo', { method: 'PUT', body: { enabled: false, apiHost: 'api-test.duosecurity.com', integrationKey: 'DI2', secretKey: '' } });
  assert.equal(off.status, 200);
  assert.equal(off.json.enabled, false);
  assert.equal(off.json.secretSet, true);
  assert.equal((await admin('/api/session')).json.config.duoEnabled, false);
});

test('branding is public through the session, validated, and needs branding.manage to change', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const anon = await (await fetch(`${base}/api/session`)).json();
  assert.equal(anon.branding.appName, 'Pons Identity');

  for (const body of [
    { appName: 'Acme', primaryColor: 'red' },
    { appName: 'Acme', primaryColor: '#112233', headerColor: 'url(x)' },
    { appName: 'Acme', primaryColor: '#112233;}</style><script>', headerColor: '' },
    { appName: 'Acme', primaryColor: '#112233', logo: 'https://evil.test/x.png' },
    { appName: 'Acme', primaryColor: '#112233', logo: 'data:text/html;base64,PHNjcmlwdD4=' },
  ]) assert.equal((await admin('/api/admin/settings/branding', { method: 'PUT', body })).status, 400, JSON.stringify(body));

  // A blank product name is allowed and means the default.
  const blank = await admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: '', primaryColor: '#112233' } });
  assert.equal(blank.status, 200);
  assert.equal(blank.json.appName, 'Pons Identity');

  const ok = await admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#AA3300', headerColor: '', logo: 'data:image/png;base64,iVBORw0KGgo=', loginMessage: 'Use your Acme account.' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.primaryColor, '#aa3300');
  const after = await (await fetch(`${base}/api/session`)).json();
  assert.equal(after.branding.appName, 'Acme ID');
  assert.equal(after.branding.productName, 'Acme ID');

  // Name propagation off: the admin's name stays on the branding, and everything else keeps the default name.
  const off = await admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#AA3300', namePropagation: false } });
  assert.equal(off.json.namePropagation, false);
  const unpropagated = await (await fetch(`${base}/api/session`)).json();
  assert.equal(unpropagated.branding.appName, 'Acme ID');
  assert.equal(unpropagated.branding.productName, 'Pons Identity');
  assert.equal((await admin('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'Acme ID', primaryColor: '#AA3300', namePropagation: true } })).json.namePropagation, true);

  // Server-rendered pages pick it up, escaped.
  const page = await (await fetch(`${base}/saml/nope/metadata`)).text();
  assert.match(page, /Acme ID/);
  assert.match(page, /#aa3300/);

  const eve = db.run("INSERT INTO roles (key, name) VALUES ('custom-t', 'Users')");
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'users.manage')", Number(eve.lastInsertRowid));
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', ids.eve, Number(eve.lastInsertRowid));
  const asEve = await signIn('eve', 'eve-password');
  assert.equal((await asEve('/api/admin/settings/branding', { method: 'PUT', body: { appName: 'X', primaryColor: '#000000' } })).status, 403);
});
