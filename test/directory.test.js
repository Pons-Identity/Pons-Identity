process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const ldap = require('../src/ldap');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

/* A tiny in-memory LDAP server standing in for ldapts. */
const people = {
  alice: { dn: 'CN=Alice Adams,OU=Staff,DC=example,DC=com', password: 'alice-secret', attrs: {
    sAMAccountName: 'alice', givenName: 'Alice', sn: 'Adams', mail: 'alice@example.com', department: 'Underwater Basket-Weaving',
    memberOf: ['CN=Weavers,OU=Groups,DC=example,DC=com', 'CN=Local Group,OU=Groups,DC=example,DC=com'] } },
  bob: { dn: 'CN=Bob Brown,OU=Staff,DC=example,DC=com', password: 'bob-secret', attrs: { sAMAccountName: 'bob', mail: 'bob@example.com' } },
  admin: { dn: 'CN=Evil,OU=Staff,DC=example,DC=com', password: 'evil', attrs: { sAMAccountName: 'admin' } },
};
const searches = [];
let ldapDown = false;
ldap.setClientFactory(() => ({
  async startTLS() {},
  async bind(dn, pw) {
    if (ldapDown) throw new Error('connect ECONNREFUSED');
    if (dn === 'CN=svc,DC=example,DC=com' && pw === 'svc-pass') return;
    const p = Object.values(people).find((x) => x.dn === dn);
    if (p && pw === p.password && pw !== '') return;
    throw Object.assign(new Error('Invalid credentials'), { name: 'InvalidCredentialsError', code: 49 });
  },
  async search(baseDn, opts) {
    searches.push(opts.filter);
    const m = /\(sAMAccountName=((?:\\[0-9a-f]{2}|[^)\\])*)\)/.exec(opts.filter);
    if (!m) return { searchEntries: [] };
    const name = m[1].replace(/\\([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (opts.scope === 'base') return { searchEntries: [{ dn: baseDn }] };
    const p = people[name];
    return { searchEntries: p ? [{ dn: p.dn, ...p.attrs }] : [] };
  },
  async unbind() {},
}));

async function session(username, password) {
  let cookie = '';
  const call = async (path, { method = 'GET', body, csrf } = {}) => {
    const headers = { ...(cookie && { cookie }), ...(csrf && { 'x-csrf-token': csrf }) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const first = (await call('/api/session')).json.csrf;
  const login = await call('/api/login', { method: 'POST', csrf: first, body: { username, password } });
  const csrf = (await call('/api/session')).json.csrf;
  return { login, call: (path, opts = {}) => call(path, { ...opts, csrf }) };
}

async function rest(token, path, { method = 'GET', body } = {}) {
  const headers = { ...(token && { authorization: `Bearer ${token}` }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}/directory/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null, headers: r.headers };
}

const adForm = (over = {}) => ({
  name: 'Office AD', type: 'ad', enabled: true,
  config: { url: 'ldaps://dc.example.com', baseDn: 'DC=example,DC=com', bindDn: 'CN=svc,DC=example,DC=com', bindPassword: 'svc-pass',
    userFilter: '(&(objectCategory=person)(sAMAccountName={username}))',
    attributeMap: { username: 'sAMAccountName', first_name: 'givenName', last_name: 'sn', email: 'mail', department: 'department' },
    groupAttribute: 'memberOf', ...over },
});

let admin;
let adId;
let adToken;
let hrId;
let hrToken;

test('console: directory settings are validated and secrets never come back', async () => {
  admin = await session('admin', 'adminpass123');
  assert.equal(admin.login.status, 200);

  const insecure = await admin.call('/api/admin/directories', { method: 'POST', body: adForm({ url: 'ldap://dc.example.com' }) });
  assert.equal(insecure.status, 400);
  assert.match(insecure.json.errors.join(' '), /unencrypted/);
  const noToken = await admin.call('/api/admin/directories', { method: 'POST', body: adForm({ userFilter: '(sAMAccountName=x)' }) });
  assert.match(noToken.json.errors.join(' '), /\{username\}/);
  assert.equal((await admin.call('/api/admin/directories', { method: 'POST', body: { ...adForm(), name: '' } })).status, 400);

  const made = await admin.call('/api/admin/directories', { method: 'POST', body: adForm() });
  assert.equal(made.status, 201);
  adId = made.json.id;
  assert.equal(made.json.enabled, false, 'new directories start disabled');
  assert.equal(made.json.config.bindPassword, undefined);
  assert.equal(made.json.config.bindPasswordSet, true);
  assert.equal((await admin.call('/api/admin/directories', { method: 'POST', body: adForm() })).status, 400, 'duplicate name');

  const tok = await admin.call(`/api/admin/directories/${adId}/token`, { method: 'POST' });
  adToken = tok.json.token;
  assert.match(adToken, /^dpt_/);
  assert.equal(JSON.stringify(db.get('SELECT * FROM directories WHERE id = ?', adId)).includes(adToken), false, 'token stored hashed');
  assert.equal((await admin.call(`/api/admin/directories/${adId}`)).json.token, undefined);

  // A blank bind password on save keeps the stored one.
  const saved = await admin.call(`/api/admin/directories/${adId}`, { method: 'PUT', body: adForm({ bindPassword: '' }) });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.enabled, true);
  assert.equal(db.get('SELECT config FROM directories WHERE id = ?', adId).config.includes('svc-pass'), true);

  const ok = await admin.call(`/api/admin/directories/${adId}/test`, { method: 'POST', body: { username: 'alice' } });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.attributes.email, 'alice@example.com');
  assert.deepEqual(ok.json.groups, ['Weavers', 'Local Group']);
  assert.equal((await admin.call(`/api/admin/directories/${adId}/test`, { method: 'POST', body: { username: 'nobody' } })).json.ok, false);
});

test('console: managing directories needs its own permission', async () => {
  db.run("INSERT INTO roles (key, name) VALUES ('viewer', 'Viewer')");
  db.run("INSERT INTO role_permissions (role_id, permission) SELECT id, 'users.view' FROM roles WHERE key = 'viewer'");
  db.run('INSERT INTO users (guid, username, password_hash) VALUES (?, ?, ?)', newGuid(), 'viewer', hashPassword('viewerpass1'));
  db.run("INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username = 'viewer' AND r.key = 'viewer'");
  const v = await session('viewer', 'viewerpass1');
  assert.equal((await v.call('/api/admin/directories')).status, 403);
});

test('LDAP: first sign-in creates the user, later sign-ins refresh it', async () => {
  db.run("INSERT INTO groups (name, description) VALUES ('Local Group', '')");
  const first = await session('alice', 'alice-secret');
  assert.equal(first.login.status, 200);
  const u = db.get("SELECT * FROM users WHERE username = 'alice'");
  assert.equal(u.directory_id, adId);
  assert.equal(u.email, 'alice@example.com');
  assert.equal(u.department, 'Underwater Basket-Weaving');
  assert.equal(u.distinguished_name, people.alice.dn);
  assert.equal(u.password_hash, '', 'no local password is kept');
  const groups = db.all('SELECT g.name, g.source FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name', u.id);
  assert.deepEqual(groups, [{ name: 'Weavers', source: 'directory' }], 'a name held by a local group is skipped');

  people.alice.attrs.mail = 'alice.new@example.com';
  people.alice.attrs.memberOf = [];
  assert.equal((await session('alice', 'alice-secret')).login.status, 200);
  assert.equal(db.get('SELECT email FROM users WHERE id = ?', u.id).email, 'alice.new@example.com');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?', u.id).n, 0);

  // Signing in by e-mail finds the same account.
  assert.equal((await session('alice.new@example.com', 'alice-secret')).login.status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users WHERE username = 'alice'").n, 1);
});

test('LDAP: wrong, empty and local passwords are refused', async () => {
  assert.equal((await session('alice', 'wrong')).login.status, 401);
  assert.equal((await session('alice', '')).login.status, 401);
  assert.equal((await session('bob', '')).login.status, 401);
  assert.equal(db.get("SELECT 1 AS x FROM users WHERE username = 'bob'"), undefined, 'failed sign-in creates nothing');
  assert.equal((await session('nobody', 'x')).login.status, 401);
  assert.equal((await session('', 'x')).login.status, 401);
});

test('LDAP: usernames are escaped in the search filter', async () => {
  searches.length = 0;
  await session('*)(objectClass=*', 'x');
  assert.ok(searches.length, 'searched');
  assert.ok(searches.every((f) => !f.includes('(objectClass=*') && f.includes('\\2a\\29\\28objectClass=\\2a')), searches.join(' | '));
});

test('LDAP: a directory user cannot take over an existing local account', async () => {
  const r = await session('admin', 'evil');
  assert.equal(r.login.status, 401);
  assert.equal(db.get("SELECT directory_id FROM users WHERE username = 'admin'").directory_id, null);
  assert.equal((await session('admin', 'adminpass123')).login.status, 200, 'local password still works');
});

test('LDAP: outage fails closed, and a disabled directory refuses its users', async () => {
  ldapDown = true;
  assert.equal((await session('alice', 'alice-secret')).login.status, 503);
  assert.equal((await session('bob', 'bob-secret')).login.status, 503);
  ldapDown = false;

  const off = await admin.call(`/api/admin/directories/${adId}`, { method: 'PUT', body: { ...adForm({ bindPassword: '' }), enabled: false } });
  assert.equal(off.json.enabled, false);
  assert.equal((await session('alice', 'alice-secret')).login.status, 401);
  assert.equal((await session('bob', 'bob-secret')).login.status, 401);
  await admin.call(`/api/admin/directories/${adId}`, { method: 'PUT', body: adForm({ bindPassword: '' }) });
});

test('LDAP: autoProvision off only allows users that already exist', async () => {
  await admin.call(`/api/admin/directories/${adId}`, { method: 'PUT', body: adForm({ bindPassword: '', autoProvision: false }) });
  assert.equal((await session('bob', 'bob-secret')).login.status, 401);
  assert.equal((await session('alice', 'alice-secret')).login.status, 200);
  await admin.call(`/api/admin/directories/${adId}`, { method: 'PUT', body: adForm({ bindPassword: '' }) });
  assert.equal((await session('bob', 'bob-secret')).login.status, 200);
});

test('console: a federated user cannot be given a local password, and their groups are read-only', async () => {
  const u = db.get("SELECT id FROM users WHERE username = 'bob'");
  const detail = await admin.call(`/api/admin/users/${u.id}`);
  assert.deepEqual(detail.json.directory, { id: adId, name: 'Office AD', federated: true });
  const put = await admin.call(`/api/admin/users/${u.id}`, { method: 'PUT', body: { ...detail.json, password: 'new-password-1' } });
  assert.equal(put.status, 400);
  assert.match(put.json.errors.join(' '), /managed there/);

  const g = db.get("SELECT id FROM groups WHERE source = 'directory'");
  assert.equal((await admin.call(`/api/admin/groups/${g.id}`, { method: 'PUT', body: { name: 'x' } })).status, 409);
  assert.equal((await admin.call(`/api/admin/groups/${g.id}/members`, { method: 'POST', body: { user_ids: [u.id] } })).status, 409);
});

/* ------------------------------- REST API --------------------------------- */

test('REST: needs a valid token for an enabled directory', async () => {
  assert.equal((await rest(null, '/users')).status, 401);
  assert.equal((await rest('dpt_wrong', '/users')).status, 401);
  const ok = await rest(adToken, '/users');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.users.map((x) => x.username).sort(), ['alice', 'bob'], 'only its own users');
  assert.equal(ok.json.users[0].password_hash, undefined);
  assert.equal(ok.json.users[0].totp_secret, undefined);
});

test('REST: create, read, update, replace and delete a user', async () => {
  const hr = await admin.call('/api/admin/directories', { method: 'POST', body: { name: 'HR system', type: 'ldap', config: {} } });
  assert.equal(hr.status, 201);
  hrId = hr.json.id;
  hrToken = (await admin.call(`/api/admin/directories/${hrId}/token`, { method: 'POST' })).json.token;
  assert.equal((await rest(hrToken, '/users')).status, 403, 'disabled until switched on');
  await admin.call(`/api/admin/directories/${hrId}`, { method: 'PUT', body: { name: 'HR system', type: 'ldap', enabled: true, config: {} } });

  const created = await rest(hrToken, '/users', { method: 'POST', body: {
    username: 'carol', first_name: 'Carol', last_name: 'Cole', email: 'carol@example.com', external_id: 'E-100',
    attributes: { costCenter: 'CC-7' }, groups: ['HR staff'], password: 'carol-password',
  } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.id;
  assert.match(created.headers.get('location'), new RegExp(`/directory/v1/users/${id}$`));
  assert.equal(created.json.display_name, '', 'unset fields stay empty');
  assert.deepEqual(created.json.attributes, { costCenter: 'CC-7' });
  assert.deepEqual(created.json.groups, ['HR staff']);
  assert.equal(created.json.active, true);
  assert.equal(db.get('SELECT directory_id FROM users WHERE guid = ?', id).directory_id, hrId);
  assert.equal(db.get("SELECT source FROM groups WHERE name = 'HR staff'").source, 'directory');
  assert.equal((await session('carol', 'carol-password')).login.status, 200, 'a REST-only directory can hold passwords');

  assert.equal((await rest(hrToken, `/users?external_id=E-100`)).json.total, 1);
  assert.equal((await rest(hrToken, `/users?username=CAROL`)).json.users[0].id, id);

  const patched = await rest(hrToken, `/users/${id}`, { method: 'PATCH', body: { title: 'Director', active: false, groups: [] } });
  assert.equal(patched.json.title, 'Director');
  assert.equal(patched.json.first_name, 'Carol', 'PATCH keeps what it does not mention');
  assert.equal(patched.json.active, false);
  assert.deepEqual(patched.json.groups, []);
  assert.equal((await session('carol', 'carol-password')).login.status, 401, 'deactivated');

  const replaced = await rest(hrToken, `/users/${id}`, { method: 'PUT', body: { username: 'carol', last_name: 'Cole-Reed' } });
  assert.equal(replaced.json.last_name, 'Cole-Reed');
  assert.equal(replaced.json.first_name, '', 'PUT clears fields it leaves out');
  assert.equal(replaced.json.email, '');
  assert.deepEqual(replaced.json.attributes, { costCenter: 'CC-7' }, 'attributes only change when sent');
  assert.equal(replaced.json.active, false, 'PUT does not reactivate');

  assert.equal((await rest(hrToken, `/users/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await rest(hrToken, `/users/${id}`)).status, 404);
});

test('REST: a directory can only touch the identities it owns', async () => {
  const local = db.get("SELECT guid FROM users WHERE username = 'admin'").guid;
  const alice = db.get("SELECT guid FROM users WHERE username = 'alice'").guid;
  for (const guid of [local, alice]) {
    assert.equal((await rest(hrToken, `/users/${guid}`)).status, 404);
    assert.equal((await rest(hrToken, `/users/${guid}`, { method: 'PATCH', body: { active: false } })).status, 404);
    assert.equal((await rest(hrToken, `/users/${guid}`, { method: 'DELETE' })).status, 404);
  }
  assert.equal(db.get("SELECT active FROM users WHERE username = 'admin'").active, 1);
  const dup = await rest(hrToken, '/users', { method: 'POST', body: { username: 'ADMIN' } });
  assert.equal(dup.status, 409);
  const groupClash = await rest(hrToken, '/users', { method: 'POST', body: { username: 'dave', groups: ['Weavers'] } });
  assert.equal(groupClash.status, 409, 'cannot join another directory\'s group');
  assert.equal(db.get("SELECT 1 AS x FROM users WHERE username = 'dave'"), undefined, 'and nothing is left behind');
});

test('REST: bodies are validated, and roles cannot be set', async () => {
  const bad = await rest(hrToken, '/users', { method: 'POST', body: { username: 'eve', role_ids: [1], is_admin: true, email: 'nope', password: 'short', active: 'yes' } });
  assert.equal(bad.status, 400);
  const msg = bad.json.errors.join(' | ');
  assert.match(msg, /Unknown field "role_ids"/);
  assert.match(msg, /Unknown field "is_admin"/);
  assert.match(msg, /email/);
  assert.match(msg, /password/);
  assert.match(msg, /active/);
  assert.equal((await rest(hrToken, '/users', { method: 'POST', body: {} })).status, 400);
  assert.equal((await rest(hrToken, '/users', { method: 'POST', body: [] })).status, 400);
  assert.equal((await rest(hrToken, '/users/not-a-guid')).status, 404);
  const r = await fetch(`${base}/directory/v1/users`, { method: 'POST', headers: { authorization: `Bearer ${hrToken}`, 'content-type': 'application/json' }, body: '{' });
  assert.equal(r.status, 400);
});

test('REST: an LDAP-backed directory cannot set passwords', async () => {
  const r = await rest(adToken, '/users', { method: 'POST', body: { username: 'frank', password: 'long-enough-1' } });
  assert.equal(r.status, 400);
  assert.match(r.json.errors.join(' '), /LDAP/);
  const ok = await rest(adToken, '/users', { method: 'POST', body: { username: 'frank' } });
  assert.equal(ok.status, 201, 'a user can be pre-created and will sign in against LDAP once it knows them');
});

test('console: revoking a token and deleting a directory', async () => {
  await admin.call(`/api/admin/directories/${hrId}/token`, { method: 'DELETE' });
  assert.equal((await rest(hrToken, '/users')).status, 401);

  assert.equal((await admin.call(`/api/admin/directories/${adId}`, { method: 'DELETE' })).status, 204);
  assert.equal(db.get("SELECT directory_id FROM users WHERE username = 'alice'").directory_id, null, 'users are kept');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE source = 'directory' AND name = 'Weavers'").n, 0, 'its groups go');
  assert.equal((await session('alice', 'alice-secret')).login.status, 401, 'no longer federated, and has no local password');
});

test('ldap helpers', () => {
  assert.equal(ldap.escapeFilterValue('a*b(c)d\\e'), 'a\\2ab\\28c\\29d\\5ce');
  assert.deepEqual(ldap.groupNames({ memberOf: ['CN=Staff\\, Senior,OU=G,DC=x', 'cn=Plain,DC=x', 'Raw'] }, { groupAttribute: 'memberof' }),
    ['Staff, Senior', 'Plain', 'Raw']);
});

test('REST create is held to the password policy of the directory groups it names', async () => {
  const root = await session('admin', 'adminpass123');
  const dir = await root.call('/api/admin/directories', { method: 'POST', body: { name: 'Contractor feed', type: 'ldap', config: {} } });
  const id = dir.json.id;
  const token = (await root.call(`/api/admin/directories/${id}/token`, { method: 'POST' })).json.token;
  await root.call(`/api/admin/directories/${id}`, { method: 'PUT', body: { name: 'Contractor feed', type: 'ldap', enabled: true, config: {} } });
  const group = Number(db.run("INSERT INTO groups (name, description, source, directory_id) VALUES ('Contractors', '', 'directory', ?)", id).lastInsertRowid);
  const pp = await root.call('/api/admin/password-policies', { method: 'POST', body: { name: 'Contractor rules', min_length: 16, require_symbol: true } });
  assert.equal(pp.status, 201, JSON.stringify(pp.json));
  await root.call('/api/admin/policies', { method: 'POST', body: { name: 'Contractor policy', subject_type: 'group', subject_id: group, password_policy_id: pp.json.id } });

  const weak = await rest(token, '/users', { method: 'POST', body: { username: 'dana', password: 'carol-password', groups: ['Contractors'] } });
  assert.equal(weak.status, 400);
  assert.match(weak.json.errors.join(' '), /at least 16/);
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'dana'"), undefined);
  const ok = await rest(token, '/users', { method: 'POST', body: { username: 'dana', password: 'dana-Password-2026', groups: ['Contractors'] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
});
