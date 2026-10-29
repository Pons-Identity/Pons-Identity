process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { verifyPassword } = require('../src/crypto');
const { createApp, seedAdmin } = require('../src/server');
const userApi = require('../src/user-api');
const scheduler = require('../src/user-scheduler');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const tokens = {
  all: userApi.createToken({ name: 'all', scopes: Object.keys(userApi.SCOPES), createdBy: 't' }).token,
  read: userApi.createToken({ name: 'read', scopes: ['users:read'], createdBy: 't' }).token,
  expired: userApi.createToken({ name: 'old', scopes: ['users:read'], expiresAt: new Date(Date.now() - 1000).toISOString(), createdBy: 't' }).token,
};
const call = async (token, path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text && r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
};
const inFuture = (s) => new Date(Date.now() + s * 1000).toISOString();

test('tokens are required, scoped and expire; only a hash is stored', async () => {
  assert.equal((await call(null, '/users')).status, 401);
  assert.equal((await call('uat_wrong', '/users')).status, 401);
  assert.equal((await call(tokens.expired, '/users')).status, 401);
  assert.equal((await call(tokens.read, '/users')).status, 200);
  assert.equal((await call(tokens.read, '/users', { method: 'POST', body: { username: 'x', password: 'xxxxxxxx1' } })).status, 403);
  assert.equal(JSON.stringify(db.all('SELECT * FROM user_api_tokens')).includes(tokens.all), false);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'token.auth_failure'"));
});

test('POST /users creates a user, with emails, attributes, groups and a generated password', async () => {
  db.run("INSERT INTO groups (name) VALUES ('Staff')");
  const r = await call(tokens.all, '/users', { method: 'POST', body: { username: 'sam', password: 'sampass123abc', first_name: 'Sam', emails: [{ email: 'sam@x.net', primary: true }, 's.rivera@y.org'], groups: ['Staff'], attributes: { pet: 'owl' } } });
  assert.equal(r.status, 201);
  assert.match(r.json.id, /^[0-9a-f-]{36}$/i);
  assert.equal(r.json.email, 'sam@x.net');
  assert.equal(r.json.emails.length, 2);
  assert.deepEqual(r.json.groups, ['Staff']);
  assert.equal(r.json.attributes.pet, 'owl');
  assert.equal(r.json.password_changed_via, 'api');
  assert.equal(r.json.password, undefined);
  assert.equal(r.headers.get('location'), r.json.location);
  assert.ok(verifyPassword('sampass123abc', db.get("SELECT password_hash FROM users WHERE username = 'sam'").password_hash));
  const audit = db.get("SELECT * FROM audit_log WHERE action = 'user.create' AND target_name = 'sam'");
  assert.equal(audit.actor_type, 'integration');

  assert.equal((await call(tokens.all, '/users', { method: 'POST', body: { username: 'sam', password: 'sampass123abc' } })).status, 409);
  const bad = await call(tokens.all, '/users', { method: 'POST', body: { username: 'bo', password: 'x', roles: ['admin'], groups: ['Nope'] } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.some((e) => /Unknown field: roles/.test(e)) || bad.json.errors.some((e) => /Password/.test(e)));

  const gen = await call(tokens.all, '/users', { method: 'POST', body: { username: 'gen', generate_password: true } });
  assert.equal(gen.status, 201);
  assert.ok(verifyPassword(gen.json.generated_password, db.get("SELECT password_hash FROM users WHERE username = 'gen'").password_hash));
});

test('a repeated Idempotency-Key does not create a second user and never repeats a generated password', async () => {
  const body = { username: 'idem', generate_password: true };
  const first = await call(tokens.all, '/users', { method: 'POST', body, headers: { 'idempotency-key': 'k1' } });
  const second = await call(tokens.all, '/users', { method: 'POST', body, headers: { 'idempotency-key': 'k1' } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replay'), 'true');
  assert.equal(second.json.id, first.json.id);
  assert.equal(second.json.generated_password, undefined);
  assert.equal(db.all("SELECT 1 FROM users WHERE username = 'idem'").length, 1);
  assert.equal((await call(tokens.all, '/users', { method: 'POST', body: { username: 'other' }, headers: { 'idempotency-key': 'k1' } })).status, 422);
});

test('GET, search and PATCH work; PATCH sets a password and ends sessions', async () => {
  const list = await call(tokens.read, '/users?email=s.rivera@y.org');
  assert.equal(list.json.total, 1);
  assert.equal(list.json.users[0].username, 'sam');
  const id = list.json.users[0].id;
  assert.equal((await call(tokens.read, `/users/${id}`)).json.username, 'sam');
  assert.equal((await call(tokens.read, '/users/not-a-guid')).status, 404);

  const p = await call(tokens.all, `/users/${id}`, { method: 'PATCH', body: { title: 'Director', active: false, password: 'newpass1234abc', attributes: { pet: null, mood: 'calm' } } });
  assert.equal(p.status, 200);
  assert.equal(p.json.title, 'Director');
  assert.equal(p.json.active, false);
  assert.deepEqual(p.json.attributes, { mood: 'calm' });
  assert.ok(verifyPassword('newpass1234abc', db.get("SELECT password_hash FROM users WHERE username = 'sam'").password_hash));
  assert.equal((await call(tokens.all, `/users/${id}`, { method: 'PATCH', body: { bogus: 1, email: 'bad' } })).status, 400);
});

test('administrators and directory-owned users cannot be changed through the API', async () => {
  const adminGuid = db.get("SELECT guid FROM users WHERE username = 'admin'").guid;
  for (const [method, body] of [['PATCH', { password: 'takeover123abc' }], ['DELETE']]) {
    assert.equal((await call(tokens.all, `/users/${adminGuid}`, { method, body })).status, 403);
  }
  assert.equal((await call(tokens.all, '/schedules', { method: 'POST', body: { action: 'deactivate', run_at: inFuture(60), user_id: adminGuid } })).status, 400);
  const dirId = Number(db.run("INSERT INTO directories (name, type) VALUES ('hr', 'api')").lastInsertRowid);
  db.run("INSERT INTO users (guid, username, password_hash, directory_id, external_id) VALUES ('11111111-1111-4111-8111-111111111111', 'dirguy', '', ?, 'e1')", dirId);
  assert.equal((await call(tokens.all, '/users/11111111-1111-4111-8111-111111111111', { method: 'DELETE' })).status, 409);
  assert.ok(db.get("SELECT 1 FROM users WHERE username = 'dirguy'"));
});

test('bulk and schedules work through the API and stop when the token is revoked', async () => {
  const dry = await call(tokens.all, '/users/bulk', { method: 'POST', body: { users: [{ username: 'b1', password: 'bulkpass12abc' }, { username: 'b1' }], dry_run: true } });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.json.rows.map((r) => r.status), ['valid', 'error']);
  const real = await call(tokens.all, '/users/bulk', { method: 'POST', body: { users: [{ username: 'b1', password: 'bulkpass12abc' }, { username: 'b2', generate_password: true }, { username: 'b3', password: 'bulkpass12abc' }] } });
  assert.equal(real.status, 201);
  assert.equal(real.json.summary.created, 2);
  assert.equal(db.get("SELECT password_changed_via AS v FROM users WHERE username = 'b1'").v, 'api');

  const b1 = db.get("SELECT guid FROM users WHERE username = 'b1'").guid;
  const s = await call(tokens.all, '/schedules', { method: 'POST', body: { action: 'deactivate', run_at: inFuture(60), user_id: b1 } });
  assert.equal(s.status, 201);
  assert.equal((await call(tokens.all, '/schedules')).json.length, 1);
  await scheduler.runDue(Math.floor(Date.now() / 1000) + 120);
  assert.equal(db.get("SELECT active FROM users WHERE username = 'b1'").active, 0);

  const t2 = userApi.createToken({ name: 'temp', scopes: ['schedules:write'], createdBy: 't' });
  const b3 = db.get("SELECT guid FROM users WHERE username = 'b3'").guid;
  const s2 = await call(t2.token, '/schedules', { method: 'POST', body: { action: 'delete', run_at: inFuture(60), user_id: b3 } });
  assert.equal(s2.status, 201);
  assert.equal((await call(tokens.all, `/schedules/${s2.json.id}`, { method: 'DELETE' })).status, 404);
  userApi.revokeToken(t2.id);
  await scheduler.runDue(Math.floor(Date.now() / 1000) + 120);
  assert.ok(db.get("SELECT 1 FROM users WHERE username = 'b3'"));
  assert.match(db.get('SELECT result FROM user_schedule WHERE id = ?', s2.json.id).result, /revoked/);
});

test('the console creates a token, shows it once, and revokes it', async () => {
  let cookie = '';
  const c = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf; }
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((x) => x.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return { status: r.status, json: await r.json() };
  };
  await c('/api/session');
  await c('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  assert.equal((await c('/api/admin/user-api/tokens', { method: 'POST', body: { name: 'x', scopes: ['nope'] } })).status, 400);
  assert.equal((await c('/api/admin/user-api/tokens', { method: 'POST', body: { name: 'all', scopes: ['users:read'] } })).status, 400);
  const made = await c('/api/admin/user-api/tokens', { method: 'POST', body: { name: 'hr', scopes: ['users:read'], expires_at: inFuture(3600) } });
  assert.equal(made.status, 201);
  assert.match(made.json.token, /^uat_/);
  assert.equal((await call(made.json.token, '/users')).status, 200);
  const id = made.json.tokens.find((t) => t.name === 'hr').id;
  assert.equal(JSON.stringify((await c('/api/admin/user-api')).json).includes(made.json.token), false);
  await c(`/api/admin/user-api/tokens/${id}`, { method: 'DELETE' });
  assert.equal((await call(made.json.token, '/users')).status, 401);
});

test('docs/openapi.yaml describes exactly the routes the API serves, with real scopes', async () => {
  const { parse } = require('yaml');
  const fs = require('node:fs');
  const spec = parse(fs.readFileSync(`${__dirname}/../docs/openapi.yaml`, 'utf8'));
  const documented = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
      documented.add(`${method.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ':$1')}`);
      for (const req of op.security || []) for (const scopes of Object.values(req)) for (const s of scopes) assert.ok(userApi.SCOPES[s], `${p} ${method}: unknown scope ${s}`);
      assert.ok(op.operationId && op.responses['401'], `${p} ${method} documents its operation id and 401`);
    }
  }
  const served = new Set();
  for (const layer of userApi.router.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) served.add(`${m.toUpperCase()} ${layer.route.path}`);
  }
  // The docs routes serve the description itself and are not part of it.
  for (const k of ['GET /openapi.yaml', 'GET /docs']) served.delete(k);
  assert.deepEqual([...documented].sort(), [...served].sort());
});

test('the description is served without a token, and the rendered page has a locked-down CSP', async () => {
  const yaml = await call(null, '/openapi.yaml');
  assert.equal(yaml.status, 200);
  const page = await fetch(`${base}/api/v1/docs`);
  if (require('node:fs').existsSync(`${__dirname}/../docs/api.html`)) {
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.doesNotMatch(await page.text(), /<script src=/);
  } else {
    assert.equal(page.status, 404);
  }
});

test('POST /users is held to the password policy of the groups it names, and a generated password meets it', async () => {
  const policies = require('../src/policies');
  const group = Number(db.run("INSERT INTO groups (name) VALUES ('Auditors')").lastInsertRowid);
  const pp = Number(db.run("INSERT INTO password_policies (name, min_length, require_symbol) VALUES ('Auditor rules', 16, 1)").lastInsertRowid);
  const pid = Number(db.run("INSERT INTO policies (name, password_policy_id) VALUES ('Auditor policy', ?)", pp).lastInsertRowid);
  db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', pid, group);

  const weak = await call(tokens.all, '/users', { method: 'POST', body: { username: 'bea', password: 'sampass123abc', groups: ['Auditors'] } });
  assert.equal(weak.status, 400);
  assert.match(weak.json.errors.join(' '), /at least 16/);
  assert.match(weak.json.errors.join(' '), /symbol/);
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'bea'"), undefined);

  const ok = await call(tokens.all, '/users', { method: 'POST', body: { username: 'bea', password: 'Ledger-Audit-2026', groups: ['Auditors'] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));

  const gen = await call(tokens.all, '/users', { method: 'POST', body: { username: 'cy', generate_password: true, groups: ['Auditors'] } });
  assert.equal(gen.status, 201, JSON.stringify(gen.json));
  const id = db.get('SELECT id FROM users WHERE guid = ?', gen.json.id).id;
  assert.deepEqual(await policies.passwordErrors(id, gen.json.generated_password), []);
});
