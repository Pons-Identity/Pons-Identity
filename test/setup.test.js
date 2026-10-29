process.env.DB_PATH = ':memory:';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { createApp } = require('../src/server');
const setup = require('../src/setup');

// No seedAdmin(): the database starts with nobody in it, which is what opens the wizard.
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const call = async (path, { method = 'GET', body, headers: extra = {} } = {}) => {
    const headers = { cookie, ...extra };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const init = async () => { csrf = (await call('/api/session')).json.csrf; };
  const login = async (u, p) => { await init(); await call('/api/login', { method: 'POST', body: { username: u, password: p } }); await init(); };
  return { call, init, login };
}

const ADMIN = { username: 'root', first_name: 'Rita', last_name: 'Root', email: 'rita@example.net', password: 'correct horse battery staple 42!', confirm: 'correct horse battery staple 42!' };
const anon = client();
let token;

test('with no users the console is told to open the wizard, and the wizard needs its token', async () => {
  await anon.init();
  assert.equal((await anon.call('/api/session')).json.setupRequired, true);
  assert.equal((await anon.call('/api/setup/status')).json.required, true);
  token = setup.issueToken({ print: false });
  assert.equal((await anon.call('/api/setup/defaults')).status, 401);
  assert.equal((await anon.call('/api/setup/defaults', { headers: { 'x-setup-token': 'nope' } })).status, 401);
  const ok = await anon.call('/api/setup/defaults', { headers: { 'x-setup-token': token } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.mode, 'initial');
});

test('wrong guesses are throttled, even for the right token afterwards', async () => {
  const other = client();
  await other.init();
  let last;
  for (let i = 0; i < 12; i++) last = await other.call('/api/setup/verify', { method: 'POST', headers: { 'x-setup-token': `wrong-${i}` } });
  assert.equal(last.status, 429);
  assert.equal((await other.call('/api/setup/verify', { method: 'POST', headers: { 'x-setup-token': token } })).status, 429);
  db.run("DELETE FROM auth_failures WHERE scope = 'setup'");
});

test('the first administrator must pass the password rules and the form must be complete', async () => {
  const h = { 'x-setup-token': token };
  const weak = await anon.call('/api/setup/complete', { method: 'POST', headers: h, body: { admin: { ...ADMIN, password: 'short', confirm: 'short' } } });
  assert.equal(weak.status, 400);
  assert.match(weak.json.errors.join(' '), /at least/);
  const mismatch = await anon.call('/api/setup/complete', { method: 'POST', headers: h, body: { admin: { ...ADMIN, confirm: 'different' } } });
  assert.equal(mismatch.status, 400);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 0);
});

test('completing creates the administrator, applies the settings and shuts the wizard', async () => {
  const h = { 'x-setup-token': token };
  const done = await anon.call('/api/setup/complete', { method: 'POST', headers: h, body: {
    admin: ADMIN, branding: { appName: 'Campus ID', primaryColor: '#225588' }, session: { sessionHours: 6, idleMinutes: 20 } } });
  assert.equal(done.status, 200, done.text);
  assert.equal(db.get("SELECT username FROM users WHERE username = 'root'").username, 'root');
  assert.equal(require('../src/app-settings').branding().appName, 'Campus ID');
  assert.equal(require('../src/security-settings').get().sessionHours, 6);
  // Disabled: the same token gets nothing, and the status says so.
  assert.equal((await anon.call('/api/setup/defaults', { headers: h })).status, 404);
  assert.equal((await anon.call('/api/setup/complete', { method: 'POST', headers: h, body: { admin: { ...ADMIN, username: 'evil' } } })).status, 404);
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'evil'"), undefined);
  assert.equal((await anon.call('/api/session')).json.setupRequired, false);
  assert.equal((await anon.call('/api/setup/status')).json.required, false);
  assert.equal(setup.state().via, 'initial');
});

test('a person without setup.run cannot reopen it; a person with it can, without the administrator step', async () => {
  const helpdesk = db.get("SELECT id FROM roles WHERE key = 'helpdesk'");
  const { hashPassword } = require('../src/crypto');
  const { newGuid } = require('../src/guid');
  const u = db.run("INSERT INTO users (guid, username, password_hash, display_name, email) VALUES (?, 'help', ?, 'Help', 'h@example.net')", newGuid(), hashPassword('Another long passphrase 77!'));
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', Number(u.lastInsertRowid), helpdesk.id);
  const low = client();
  await low.login('help', 'Another long passphrase 77!');
  assert.equal((await low.call('/api/setup/defaults')).status, 404);
  assert.equal((await low.call('/api/setup/status')).json.canRerun, false);

  const root = client();
  await root.login('root', ADMIN.password);
  assert.equal((await root.call('/api/setup/status')).json.canRerun, true);
  const d = await root.call('/api/setup/defaults');
  assert.equal(d.json.mode, 'rerun');
  const r = await root.call('/api/setup/complete', { method: 'POST', body: { admin: { username: 'ignored' }, branding: { appName: 'Campus ID 2', primaryColor: '#225588' } } });
  assert.equal(r.status, 200, r.text);
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'ignored'"), undefined);
  assert.equal(require('../src/app-settings').branding().appName, 'Campus ID 2');
  assert.equal(setup.state().via, 'rerun');
  assert.equal(setup.state().runs, 2);
});

test('if the database is cleared of users the wizard opens again, with a new token', async () => {
  db.run('DELETE FROM users');
  assert.equal(setup.required(), true);
  const fresh = client();
  await fresh.init();
  assert.equal((await fresh.call('/api/setup/status')).json.required, true);
  assert.equal((await fresh.call('/api/setup/defaults', { headers: { 'x-setup-token': token } })).status, 401, 'the old token no longer works');
  const t2 = setup.issueToken({ print: false });
  assert.equal((await fresh.call('/api/setup/defaults', { headers: { 'x-setup-token': t2 } })).status, 200);
});
