process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { createApp, seedAdmin } = require('../src/server');
const builtin = require('../src/integrations/builtin');

seedAdmin();
builtin.seed();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const login = async (username, password) => {
    csrf = (await call('/api/session')).json.csrf;
    await call('/api/login', { method: 'POST', body: { username, password } });
    csrf = (await call('/api/session')).json.csrf;
  };
  return { call, login };
}

const admin = client();
const LOCKDOWN = 'compromised-account-lockdown';
const lockdownRow = () => db.get('SELECT * FROM integrations WHERE builtin = ?', LOCKDOWN);
test('sign in as the administrator', async () => { await admin.login('admin', 'adminpass123'); });

test('the lockdown integration cannot be deleted, but can be turned off', async () => {
  const row = lockdownRow();
  const view = (await admin.call(`/api/admin/integrations/${row.id}`)).json;
  assert.equal(view.deletable, false);
  const refused = await admin.call(`/api/admin/integrations/${row.id}`, { method: 'DELETE' });
  assert.equal(refused.status, 409);
  assert.match(refused.json.errors[0], /cannot be deleted/);
  assert.ok(lockdownRow(), 'it is still there');

  const off = await admin.call(`/api/admin/integrations/${row.id}`, { method: 'PUT', body: { name: view.name, description: view.description, script: view.script, scopes: view.scopes, inputs: view.inputs, enabled: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(lockdownRow().enabled, 0, 'turning it off is allowed');
});

test('the original code of a built-in integration can be restored, and its own settings are kept', async () => {
  const row = lockdownRow();
  const original = builtin.find(LOCKDOWN);
  // Change its code, its name and its schedule-free settings, then restore.
  const changed = await admin.call(`/api/admin/integrations/${row.id}`, { method: 'PUT', body: { name: 'Lockdown (edited)', description: 'changed', script: 'return 1;', scopes: [], inputs: [], enabled: false } });
  assert.equal(changed.status, 200, changed.text);
  const restored = await admin.call(`/api/admin/integrations/${row.id}/restore`, { method: 'POST' });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.name, original.name);
  assert.equal(restored.json.script, original.script);
  assert.equal(restored.json.description, original.description);
  assert.deepEqual([...restored.json.scopes].sort(), [...original.scopes].sort());
  assert.equal(restored.json.enabled, false, 'whether it is turned on is left as the administrator set it');
});

test('restoring is refused while another integration holds the original name', async () => {
  const row = lockdownRow();
  const original = builtin.find(LOCKDOWN);
  const renamed = await admin.call(`/api/admin/integrations/${row.id}`, { method: 'PUT', body: { name: 'Lockdown (renamed)', script: 'return 1;', scopes: [], inputs: [], enabled: false } });
  assert.equal(renamed.status, 200, renamed.text);
  const squatter = await admin.call('/api/admin/integrations', { method: 'POST', body: { name: original.name, script: 'return 1;', scopes: [] } });
  assert.equal(squatter.status, 201, squatter.text);
  const clash = await admin.call(`/api/admin/integrations/${row.id}/restore`, { method: 'POST' });
  assert.equal(clash.status, 400);
  assert.match(clash.json.errors.join(' '), /already exists/);
  assert.equal(lockdownRow().script, 'return 1;', 'nothing changed');
});

test('other built-in integrations can still be deleted, and only built-ins can be restored', async () => {
  const pr = db.get("SELECT id FROM integrations WHERE builtin = 'password-reset'");
  assert.equal((await admin.call(`/api/admin/integrations/${pr.id}`, { method: 'DELETE' })).status, 200);

  const plain = await admin.call('/api/admin/integrations', { method: 'POST', body: { name: 'Plain', script: 'return 1;', scopes: [] } });
  assert.equal((await admin.call(`/api/admin/integrations/${plain.json.id}/restore`, { method: 'POST' })).status, 409);
  assert.equal((await admin.call(`/api/admin/integrations/${plain.json.id}`, { method: 'DELETE' })).status, 200);
});
