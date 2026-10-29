process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { Client, utils: sshUtils } = require('ssh2');
const db = require('../src/db');
const { createApp, seedAdmin } = require('../src/server');
const sftpServer = require('../src/files/sftp-server');
const accounts = require('../src/service-accounts');

seedAdmin();
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
test('sign in as the administrator', async () => { await admin.login('admin', 'adminpass123'); });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function connect(port, auth) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => c.sftp((err, sftp) => (err ? reject(err) : resolve({ sftp, client: c }))));
    c.on('error', reject);
    c.connect({ host: '127.0.0.1', port, username: auth.username, password: auth.password, privateKey: auth.privateKey, readyTimeout: 5000 });
  });
}
const op = (fn) => new Promise((resolve, reject) => fn((err, out) => (err ? reject(err) : resolve(out))));
const closed = (c) => new Promise((resolve) => c.on('close', resolve));

test('locking down a service account closes its open connection, refuses new ones, and suspends its keys and password', async () => {
  const port = await freePort();
  const pair = sshUtils.generateKeyPairSync('ed25519');
  const made = await admin.call('/api/admin/service-accounts', { method: 'POST', body: {
    username: 'partner', grants: [{ path: '/exports', access: 'read' }], generate: true, public_keys: pair.public,
  } });
  assert.equal(made.status, 201, made.text);
  const { id } = made.json.account;
  const pw = made.json.generated_password;
  sftpServer.save({ enabled: true, port, bindAddress: '127.0.0.1' });

  const { sftp, client: open } = await connect(port, { username: 'partner', password: pw });
  const gone = closed(open);
  // The connection is live and in use before the lockdown.
  assert.ok(Array.isArray(await op((cb) => sftp.readdir('/', cb))));

  const r = await admin.call(`/api/admin/service-accounts/${id}/lockdown`, { method: 'POST' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.account.locked_down, true);
  assert.equal(r.json.account.enabled, false);
  assert.equal(r.json.account.key_labels.length, 0, 'the keys are suspended');
  assert.equal(r.json.account.lockdown.keys_suspended, 1);
  assert.equal(accounts.authenticate('partner', pw), null, 'the old password no longer works');
  assert.equal(accounts.enabledByName('partner'), null);

  await gone;
  await assert.rejects(connect(port, { username: 'partner', password: pw }));
  await assert.rejects(connect(port, { username: 'partner', privateKey: pair.private }), 'the key no longer works');

  const row = db.get("SELECT * FROM audit_log WHERE action = 'service_account.lockdown' AND target_id = ?", String(id));
  assert.ok(row, 'the lockdown is audited');
  assert.equal(JSON.parse(row.detail).connections_closed, 1);

  // Once locked down, neither an edit nor a second lockdown can undo it.
  const turnOn = await admin.call(`/api/admin/service-accounts/${id}`, { method: 'PUT', body: { username: 'partner', grants: [{ path: '/exports', access: 'read' }], enabled: true } });
  assert.equal(turnOn.status, 409);
  const giveKey = await admin.call(`/api/admin/service-accounts/${id}`, { method: 'PUT', body: { username: 'partner', grants: [{ path: '/exports', access: 'read' }], enabled: false, public_keys: pair.public } });
  assert.equal(giveKey.status, 409);
  assert.equal((await admin.call(`/api/admin/service-accounts/${id}/lockdown`, { method: 'POST' })).status, 409);
  sftpServer.save({ enabled: false, port, bindAddress: '127.0.0.1' });
});

test('ending a lockdown turns the account back on, restores keys only when asked, and does not restore the password', async () => {
  const pair = sshUtils.generateKeyPairSync('ed25519');
  const made = await admin.call('/api/admin/service-accounts', { method: 'POST', body: {
    username: 'courier', grants: [{ path: '/out', access: 'write' }], generate: true, public_keys: pair.public,
  } });
  const { id } = made.json.account;
  const oldPassword = made.json.generated_password;
  await admin.call(`/api/admin/service-accounts/${id}/lockdown`, { method: 'POST' });

  // Keys are discarded unless asked for.
  const ended = await admin.call(`/api/admin/service-accounts/${id}/lockdown`, { method: 'DELETE', body: {} });
  assert.equal(ended.status, 200, ended.text);
  assert.equal(ended.json.account.locked_down, false);
  assert.equal(ended.json.account.enabled, true, 'it was enabled before, so it is on again');
  assert.equal(ended.json.account.key_labels.length, 0, 'keys were discarded, not restored');
  assert.equal(accounts.authenticate('courier', oldPassword), null, 'the old password is not restored');
  assert.equal((await admin.call(`/api/admin/service-accounts/${id}/lockdown`, { method: 'DELETE', body: {} })).status, 409);

  // Restoring keys is possible for another lockdown, when the administrator asks.
  const again = await admin.call('/api/admin/service-accounts', { method: 'POST', body: {
    username: 'keeper', grants: [{ path: '/out', access: 'write' }], public_keys: pair.public,
  } });
  const keeperId = again.json.account.id;
  await admin.call(`/api/admin/service-accounts/${keeperId}/lockdown`, { method: 'POST' });
  const restored = await admin.call(`/api/admin/service-accounts/${keeperId}/lockdown`, { method: 'DELETE', body: { restore_keys: true } });
  assert.equal(restored.json.account.key_labels.length, 1, 'the key comes back');
});

test('an account that was disabled before its lockdown stays disabled when the lockdown ends', async () => {
  const made = await admin.call('/api/admin/service-accounts', { method: 'POST', body: {
    username: 'parked', grants: [{ path: '/x', access: 'read' }], generate: true, enabled: false,
  } });
  const { id } = made.json.account;
  await admin.call(`/api/admin/service-accounts/${id}/lockdown`, { method: 'POST' });
  const ended = await admin.call(`/api/admin/service-accounts/${id}/lockdown`, { method: 'DELETE', body: {} });
  assert.equal(ended.json.account.enabled, false);
});

test('only people who manage users can lock down a service account', async () => {
  const outsider = client();
  const made = await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'guarded', grants: [{ path: '/g', access: 'read' }], generate: true } });
  const { id } = made.json.account;
  // Not signed in at all: refused by the console's own session check, never reaching the lockdown.
  const anon = await outsider.call(`/api/admin/service-accounts/${id}/lockdown`, { method: 'POST' });
  assert.notEqual(anon.status, 200);
  assert.equal(db.get('SELECT locked_down FROM service_accounts WHERE id = ?', id).locked_down, 0);
});
