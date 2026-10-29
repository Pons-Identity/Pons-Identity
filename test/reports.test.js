process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const roles = require('../src/roles');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const call = async (path, { method = 'GET', body, headers: extra = {} } = {}) => {
    const headers = { cookie, ...extra };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: r.status, json };
  };
  const login = async (u, p) => {
    csrf = (await call('/api/session')).json.csrf;
    await call('/api/login', { method: 'POST', body: { username: u, password: p } });
    csrf = (await call('/api/session')).json.csrf;
  };
  return { call, login };
}

const admin = client();
const API = '/api/admin/reports';

// A signed-in person who holds exactly `permissions`.
async function person(name, permissions) {
  const id = Number(db.run('INSERT INTO users (guid, username, password_hash) VALUES (?, ?, ?)', newGuid(), name, hashPassword('personpass1')).lastInsertRowid);
  const roleId = Number(db.run('INSERT INTO roles (key, name) VALUES (?, ?)', `r-${name}`, name).lastInsertRowid);
  roles.setRolePermissions(roleId, permissions);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', id, roleId);
  const c = client();
  await c.login(name, 'personpass1');
  return c;
}
const make = async (c, script, over = {}) => (await c.call(API, { method: 'POST', body: { name: `r${Math.random()}`, script, ...over } })).json;
const runIt = async (c, id, input) => (await c.call(`${API}/${id}/run`, { method: 'POST', body: { input } })).json;

test('sign in as the administrator', async () => {
  await admin.login('admin', 'adminpass123');
  db.run('INSERT INTO users (guid, username, password_hash, department, active, mfa_enabled) VALUES (?, ?, ?, ?, 1, 1)', newGuid(), 'sam', 'x', 'Math');
  db.run('INSERT INTO users (guid, username, password_hash, department, active, mfa_enabled) VALUES (?, ?, ?, ?, 0, 0)', newGuid(), 'bob', 'x', 'Art');
  db.run("INSERT INTO groups (name) VALUES ('Empty')");
});

test('a custom report reads data and returns rows', async () => {
  const r = await make(admin, 'const u = await report.users({ active: true }); log("n", u.length); return u.map((x) => ({ username: x.username, mfa: x.mfa_required, source: x.source }));');
  const out = await runIt(admin, r.id, null);
  assert.equal(out.status, 'ok');
  assert.ok(out.result.some((x) => x.username === 'sam' && x.mfa === true && x.source === 'local'));
  assert.ok(!out.result.some((x) => x.username === 'bob'));
  assert.equal(out.logs[0].text.startsWith('n '), true);
  const withInput = await runIt(admin, (await make(admin, 'return { got: input.days };')).id, { days: 3 });
  assert.deepEqual(withInput.result, { got: 3 });
  // Rows never carry credentials.
  const all = await runIt(admin, (await make(admin, 'return await report.users();')).id);
  assert.ok(!JSON.stringify(all.result).includes('password_hash') && !JSON.stringify(all.result).includes('totp'));
});

test('reports are read-only and cannot reach integration variables or the network', async () => {
  db.run("INSERT OR REPLACE INTO integration_variables (name, value, secret, updated_at) VALUES ('KEY', 'topsecretvalue', 1, '')");
  const r = await runIt(admin, (await make(admin, 'return { keys: Object.keys(vars), key: vars.get("KEY", "none") };')).id);
  assert.deepEqual(r.result, { keys: [], key: 'none' });
  for (const script of [
    'await idp.users.create({ username: "mallory" });',
    'await idp.users.search({});',
    'await idp.groups.addMember("Empty", "sam");',
    'await http.get("https://example.com");',
    'await mail.send({ to: "a@b.c", text: "x" });',
  ]) {
    const out = await runIt(admin, (await make(admin, script)).id);
    assert.equal(out.status, 'error', script);
    assert.match(out.error.message, /scope/);
  }
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'mallory'"), undefined);
});

test('a report sees only what the person running it may see', async () => {
  const writer = await person('writer', ['reports.manage']);
  const audits = await make(writer, 'return await report.audit({ days: 1 });');
  const denied = await runIt(writer, audits.id);
  assert.equal(denied.status, 'error');
  assert.match(denied.error.message, /audit\.view/);
  assert.equal((await runIt(writer, (await make(writer, 'return await report.users();')).id)).status, 'error');

  // The same report run by someone with the access works; writing it grants nothing.
  const auditor = await person('auditor', ['reports.view', 'audit.view']);
  const ok = await runIt(auditor, audits.id);
  assert.equal(ok.status, 'ok');
  assert.ok(Array.isArray(ok.result));

  // last_sign_in is only filled in for someone who holds audit.view.
  const hr = await person('hr', ['reports.view', 'users.view']);
  const rows = (await runIt(hr, (await make(admin, 'return await report.users();')).id)).result;
  assert.ok(rows.length && rows.every((u) => u.last_sign_in === null));
});

test('runaway and invalid scripts are stopped or refused', async () => {
  const slow = await make(admin, 'while (true) {}', { timeout_seconds: 1 });
  assert.equal((await runIt(admin, slow.id)).status, 'timeout');
  const bad = await admin.call(API, { method: 'POST', body: { name: 'bad', script: 'return (' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errors[0], /Script error/);
  assert.equal((await admin.call(API, { method: 'POST', body: { name: 'x', script: '', timeout_seconds: 999 } })).status, 400);
  assert.equal((await admin.call(`${API}/check`, { method: 'POST', body: { script: 'return (' } })).json.ok, false);
  // Reports may return far more than an integration (a few MB), but not without limit.
  const big = await make(admin, 'return Array.from({ length: 10000 }, (_, i) => ({ i, text: "x".repeat(200) }));');
  assert.equal((await runIt(admin, big.id)).status, 'ok');
  const huge = await runIt(admin, (await make(admin, 'return Array.from({ length: 30000 }, (_, i) => ({ i, text: "x".repeat(200) }));')).id);
  assert.equal(huge.status, 'error');
  assert.match(huge.error.message, /too much data/);
});

test('pre-built reports run, honour permissions, and can take input', async () => {
  const list = (await admin.call(API)).json;
  assert.ok(list.builtin.length >= 5 && list.builtin.every((b) => b.runnable && b.script === undefined));
  for (const b of list.builtin) {
    const out = (await admin.call(`${API}/builtin/${b.key}/run`, { method: 'POST', body: {} })).json;
    assert.equal(out.status, 'ok', `${b.key}: ${JSON.stringify(out.error)}`);
    assert.ok(Array.isArray(out.result), b.key);
  }
  const noMfa = (await admin.call(`${API}/builtin/users-without-mfa/run`, { method: 'POST', body: {} })).json.result;
  assert.ok(noMfa.every((r) => r.username !== 'sam'));
  assert.ok((await admin.call(`${API}/builtin/stale-passwords/run`, { method: 'POST', body: { input: { days: 0.0001 } } })).json.result.length >= 1);
  assert.match((await admin.call(`${API}/builtin/group-sizes`)).json.script, /report\.groups/);

  const hr = await person('hr2', ['reports.view', 'users.view']);
  const seen = (await hr.call(API)).json.builtin;
  assert.equal(seen.find((b) => b.key === 'users-without-mfa').runnable, true);
  assert.equal(seen.find((b) => b.key === 'failed-sign-ins').runnable, false);
  assert.equal((await hr.call(`${API}/builtin/failed-sign-ins/run`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await admin.call(`${API}/builtin/nope/run`, { method: 'POST', body: {} })).status, 404);
});

test('permissions: viewers run but cannot write; nobody else can use reports; changes are audited', async () => {
  const mine = await make(admin, 'return 1;');
  const viewer = await person('viewer', ['reports.view']);
  assert.equal((await viewer.call(API)).status, 200);
  assert.equal((await viewer.call(`${API}/${mine.id}`)).json.script, 'return 1;');
  assert.equal((await runIt(viewer, mine.id)).result, 1);
  assert.equal((await viewer.call(API, { method: 'POST', body: { name: 'n', script: '' } })).status, 403);
  assert.equal((await viewer.call(`${API}/${mine.id}`, { method: 'PUT', body: { name: 'n', script: '' } })).status, 403);
  assert.equal((await viewer.call(`${API}/${mine.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await viewer.call(`${API}/check`, { method: 'POST', body: { script: '' } })).status, 403);

  const other = await person('other', ['users.view']);
  assert.equal((await other.call(API)).status, 403);
  assert.equal((await runIt(other, mine.id)).errors, undefined);
  assert.equal((await other.call(`${API}/${mine.id}/run`, { method: 'POST', body: {} })).status, 403);

  const upd = await admin.call(`${API}/${mine.id}`, { method: 'PUT', body: { name: mine.name, script: 'return 2;' } });
  assert.equal(upd.status, 200);
  assert.equal((await admin.call(`${API}/${mine.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin.call(`${API}/${mine.id}`)).status, 404);
  const actions = db.all("SELECT action, detail FROM audit_log WHERE action LIKE 'report.%'").map((r) => r.action);
  for (const a of ['report.create', 'report.update', 'report.delete', 'report.run']) assert.ok(actions.includes(a), a);
  assert.ok(!db.all("SELECT detail FROM audit_log WHERE action LIKE 'report.%'").some((r) => r.detail.includes('return 2')));
});

test('reports.manage implies reports.view and the permissions are listed', () => {
  const { normalize, ALL } = require('../src/permissions');
  assert.deepEqual([...normalize(['reports.manage'])].sort(), ['reports.manage', 'reports.view']);
  assert.ok(ALL.includes('reports.view'));
});
