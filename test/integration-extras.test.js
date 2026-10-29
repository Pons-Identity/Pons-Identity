process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const engine = require('../src/integrations/engine');
const files = require('../src/files/store');
const logStore = require('../src/files/logs');
const sftp = require('../src/integrations/sftp');
const logging = require('../src/integrations/logging');
const builtin = require('../src/integrations/builtin');
const integrations = require('../src/integrations');
const userApi = require('../src/user-api');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const call = async (path, { method = 'GET', body, headers: extra = {} } = {}) => {
    const headers = { cookie, ...extra };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const login = async (u, p) => {
    csrf = (await call('/api/session')).json.csrf;
    await call('/api/login', { method: 'POST', body: { username: u, password: p } });
    csrf = (await call('/api/session')).json.csrf;
  };
  return { call, login };
}

const admin = client();

// The console starts a run and answers at once; wait for it to end, as its page does.
const settled = async (id, runId) => {
  for (;;) {
    const r = (await admin.call(`/api/admin/integrations/${id}/runs/${runId}`)).json.run;
    if (r.status !== 'running') return r;
    await new Promise((x) => setTimeout(x, 10));
  }
};
const runNow = async (id, body) => settled(id, (await admin.call(`/api/admin/integrations/${id}/run`, { method: 'POST', body })).json.run.id);
const make = async (over = {}) => {
  const r = await admin.call('/api/admin/integrations', { method: 'POST', body: { name: `i${Math.random()}`, script: 'return 1;', scopes: [], ...over } });
  assert.equal(r.status, 201, r.text);
  return r.json;
};

test('sign in', async () => { await admin.login('admin', 'adminpass123'); });

test('csv.stringify and files: a script writes a CSV in its own folder and reads it back; formulas are quoted', async () => {
  const i = await make({ scopes: ['files'], script: `
    await files.write('out.csv', await csv.stringify([{ a: 'x,y', b: '=cmd()' }, { a: 'z', b: 2 }]));
    const text = await files.read('out.csv');
    await files.write('out.csv', 'more\\n', { append: true });
    return { text, list: (await files.list()).map((e) => e.path), parsed: await csv.parse(text) };` });
  const run = await runNow(i.id, {});
  assert.equal(run.status, 'ok', JSON.stringify(run.error));
  assert.equal(run.result.text, 'a,b\n"x,y",\'=cmd()\nz,2\n');
  assert.deepEqual(run.result.parsed[1], { a: 'z', b: '2' });
  assert.deepEqual(run.result.list, [`/integrations/integration-${i.id}/out.csv`]);
  assert.equal(files.read(`/integrations/integration-${i.id}/out.csv`).toString(), 'a,b\n"x,y",\'=cmd()\nz,2\nmore\n');
});

test('files need the scope, keep to valid paths, and respect limits', async () => {
  const i = await make({ scopes: [], script: "await files.write('a.csv', 'x');" });
  const run = await runNow(i.id, {});
  assert.match(run.error.message, /"files" scope/);
  assert.throws(() => files.normalize('/a/../etc/passwd'), files.FileError);
  assert.throws(() => files.normalize('/.hidden'), files.FileError);
  assert.throws(() => files.write(`/integrations/integration-${i.id}/big.bin`, Buffer.alloc(files.LIMITS.fileBytes + 1)), /at most/);
});

test('an integration reaches its own folder and the directories granted to it, and nothing else', async () => {
  const i = await make({ scopes: ['files'], file_dirs: [{ path: '/exports/hr', access: 'write' }], script: `
    await files.write('/exports/hr/people.csv', 'a');
    const denied = [];
    for (const p of ['/exports/hr/people.csv', '/elsewhere/x.csv']) {
      try { await files.read(p); } catch (e) { denied.push(e.message); }
    }
    try { await files.write('/elsewhere/x.csv', 'x'); } catch (e) { denied.push(e.message); }
    return denied;` });
  assert.deepEqual(i.file_dirs, [{ path: '/exports/hr', access: 'write' }]);
  assert.equal(i.files_folder, `/integrations/integration-${i.id}`);
  const run = await runNow(i.id, {});
  assert.equal(run.status, 'ok', JSON.stringify(run.error));
  assert.equal(run.result.length, 3);
  assert.match(run.result[0], /may not read \/exports\/hr\/people\.csv/);
  assert.match(run.result[1], /may not read \/elsewhere\/x\.csv/);
  assert.match(run.result[2], /may not change \/elsewhere\/x\.csv/);
  assert.equal(files.read('/exports/hr/people.csv').toString(), 'a');
  assert.equal((await admin.call('/api/admin/integrations', { method: 'POST', body: { name: 'bad dirs', script: '', scopes: [], file_dirs: [{ path: '/a/../b', access: 'read' }] } })).status, 400);
});

test('administrators browse, upload, download, make folders, move and delete files', async () => {
  const put = await admin.call('/api/admin/files/upload?path=/exports/people.csv', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'first_name,last_name\nSam,Rivera\n' });
  assert.equal(put.status, 200, put.text);
  const listed = (await admin.call('/api/admin/files/list?path=/exports')).json;
  assert.ok(listed.entries.some((e) => e.path === '/exports/people.csv' && e.kind === 'file'));
  const dl = await admin.call('/api/admin/files/download?path=/exports/people.csv');
  assert.equal(dl.text, 'first_name,last_name\nSam,Rivera\n');
  assert.equal((await admin.call('/api/admin/files/upload?path=/exports/..%2Fx', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })).status, 400);
  assert.equal((await admin.call('/api/admin/files/folder', { method: 'POST', body: { path: '/exports/archive/2026' } })).status, 201);
  assert.equal((await admin.call('/api/admin/files/move', { method: 'POST', body: { from: '/exports/people.csv', to: '/exports/archive/2026/people.csv' } })).status, 200);
  assert.equal((await admin.call('/api/admin/files/entry?path=/exports/archive', { method: 'DELETE' })).status, 400);
  assert.equal((await admin.call('/api/admin/files/entry?path=/exports/archive&recursive=true', { method: 'DELETE' })).json.removed, true);
  assert.equal(files.stat('/exports/archive'), null);
  assert.equal((await admin.call('/api/admin/files/list?path=/exports/people.csv')).status, 404);
});

test('sftp refuses a connection with no host fingerprint, no credentials or a non-public host', async () => {
  assert.throws(() => sftp.connectionOf({ host: 'h', username: 'u', password: 'p' }), /hostFingerprint/);
  assert.throws(() => sftp.connectionOf({ host: 'h', username: 'u' }), /password or a privateKey/);
  assert.equal(sftp.connectionOf({ host: 'h', username: 'u', password: 'p', hostFingerprint: 'SHA256:abc=' }).fingerprint, 'abc');
  await assert.rejects(sftp.list({ host: '127.0.0.1', username: 'u', password: 'p', hostFingerprint: 'SHA256:abc' }, '/'), /not public/);
  const i = await make({ scopes: ['sftp'], script: "await sftp.list({ host: '10.0.0.1', username: 'u', password: 'p', hostFingerprint: 'SHA256:abc' }, '/');" });
  const run = await runNow(i.id, {});
  assert.equal(run.status, 'error');
  assert.match(run.error.message, /not public/);
});

test('an integration can keep its own logging settings and retention', async () => {
  logging.save({ ...logging.DEFAULTS, saveLevel: 'off' });
  const own = await make({ script: 'log.warning("mine"); log.debug("quiet");', logging: { inherit: false, saveLevel: 'debug', saveOutput: false, retentionDays: 2 } });
  const other = await make({ script: 'log.warning("global");' });
  assert.equal(own.logging.inherit, false);
  assert.equal(other.logging.inherit, true);
  await runNow(own.id, {});
  await runNow(other.id, {});
  const saved = (await admin.call('/api/admin/integrations/logs')).json.lines;
  assert.deepEqual(saved.map((l) => l.text).sort(), ['mine', 'quiet']);
  // The lines are files in the files module, one a day for each integration.
  assert.ok(files.list(logStore.logDir(own.id)).every((e) => /^\d{4}-\d{2}-\d{2}\.log$/.test(e.name)));
  assert.equal(files.list(logStore.logDir(own.id)).length, 1);
  // Retention is by the settings that apply to each integration: a file older than its two days goes, today's stays.
  const old = `${logStore.logDir(own.id)}/2020-01-01.log`;
  files.write(old, Buffer.from('2020-01-01T00:00:00.000Z\t0\tlog\twarning\t\tancient\n'));
  assert.equal(logStore.prune(), 1);
  assert.equal(files.stat(old), null);
  assert.equal(files.list(logStore.logDir(own.id)).length, 1);
  assert.equal((await admin.call('/api/admin/integrations', { method: 'POST', body: { name: 'bad', script: '', scopes: [], logging: { inherit: false, saveLevel: 'debug', retentionDays: -1 } } })).status, 400);
  logging.save({ ...logging.DEFAULTS });
});

test('only people in an allowed group can run an integration, and not edit it', async () => {
  const gid = Number(db.run("INSERT INTO groups (name) VALUES ('Help desk')").lastInsertRowid);
  const other = Number(db.run("INSERT INTO groups (name) VALUES ('Other')").lastInsertRowid);
  const add = (name, g) => {
    const id = Number(db.run("INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,1)", newGuid(), name, hashPassword('desk-password-1')).lastInsertRowid);
    if (g) db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', g, id);
  };
  add('rowan', gid); add('casey', other);
  const i = await make({ name: 'Greeter', script: 'output("hello " + who); return { hi: who };', inputs: [{ name: 'who', variable: 'who' }], run_groups: [gid] });
  assert.deepEqual(i.run_groups.map((g) => g.name), ['Help desk']);

  const rowan = client(); await rowan.login('rowan', 'desk-password-1');
  assert.equal((await rowan.call('/api/session')).json.me.runs_integrations, true);
  const mine = (await rowan.call('/api/my/integrations')).json;
  assert.deepEqual(mine.map((x) => x.name), ['Greeter']);
  const ran = await rowan.call(`/api/my/integrations/${i.id}/run`, { method: 'POST', body: { input: { who: 'Sam' } } });
  assert.equal(ran.json.run.status, 'ok');
  assert.deepEqual(ran.json.run.result, { hi: 'Sam' });
  assert.equal(ran.json.run.output[0].text, 'hello Sam');
  assert.equal((await rowan.call(`/api/admin/integrations/${i.id}/run`, { method: 'POST', body: {} })).status, 403);

  const casey = client(); await casey.login('casey', 'desk-password-1');
  assert.equal((await casey.call('/api/session')).json.me.runs_integrations, false);
  assert.deepEqual((await casey.call('/api/my/integrations')).json, []);
  assert.equal((await casey.call(`/api/my/integrations/${i.id}/run`, { method: 'POST', body: {} })).status, 404);
});

test('built-in integrations are created once and a password reset works', async () => {
  const made = builtin.seed();
  assert.deepEqual(made.sort(), builtin.BUILTIN.map((b) => b.key).sort());
  assert.deepEqual(builtin.seed(), []);
  const row = db.get("SELECT * FROM integrations WHERE builtin = 'password-reset'");
  assert.ok(row);
  // Deleting one is allowed and it stays deleted.
  db.run('DELETE FROM integrations WHERE builtin = ?', 'deactivate-user');
  assert.deepEqual(builtin.seed(), []);

  const id = Number(db.run("INSERT INTO users (guid, username, password_hash, active, email, first_name) VALUES (?,?,?,1,?,?)", newGuid(), 'pat', hashPassword('old-password-123'), 'pat@example.net', 'Pat').lastInsertRowid);
  let sent = null;
  require('../src/messaging').send = async (channel, to, msg) => { sent = { channel, to, msg }; };
  const messaging = require('../src/messaging');
  const orig = messaging.send;
  const res = { json: { run: await runNow(row.id, { input: { username: 'pat' } }) } };
  assert.equal(res.json.run.status, 'ok', JSON.stringify(res.json.run.error));
  assert.equal(res.json.run.result.sentTo, 'pat@example.net');
  assert.ok(sent && /new password is:/.test(sent.msg.text));
  const pw = /is:\n\n(\S+)\n/.exec(sent.msg.text)[1];
  assert.ok(require('../src/crypto').verifyPassword(pw, db.get('SELECT password_hash FROM users WHERE id = ?', id).password_hash));
  messaging.send = orig;
  // The password itself never appears in the stored run.
  assert.ok(!JSON.stringify(res.json.run).includes(pw));
});

test('the user API can run an integration that is open to it, and no other', async () => {
  const open = await make({ name: 'Open one', script: 'output("x"); return input;', api_enabled: true });
  const closed = await make({ name: 'Closed one' });
  const { token } = userApi.createToken({ name: 'runner', scopes: ['integrations:run'], createdBy: 'test' });
  const noScope = userApi.createToken({ name: 'reader', scopes: ['users:read'], createdBy: 'test' }).token;
  const call = (t, path, opts = {}) => fetch(`${base}/api/v1${path}`, { method: opts.method || 'GET', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) }).then(async (r) => ({ status: r.status, json: await r.json(), location: r.headers.get('location') }));

  const list = await call(token, '/integrations');
  assert.deepEqual(list.json.integrations.map((x) => x.name), ['Open one']);
  const ran = await call(token, `/integrations/${open.id}/runs`, { method: 'POST', body: { input: { n: 1 } } });
  assert.equal(ran.status, 201, JSON.stringify(ran.json));
  assert.deepEqual(ran.json.result, { n: 1 });
  assert.deepEqual(ran.json.output, ['x']);
  assert.equal(ran.json.trigger, 'api');
  const again = await call(token, `/integrations/${open.id}/runs/${ran.json.id}`);
  assert.equal(again.json.id, ran.json.id);
  assert.equal((await call(token, `/integrations/${closed.id}/runs`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await call(noScope, `/integrations/${open.id}/runs`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await call(token, `/integrations/${open.id}/runs`, { method: 'POST', body: { bogus: 1 } })).status, 400);
  assert.ok(engine && integrations);
});

test('the password reset integration signs the person out of browsers and ends their OAuth tokens', async () => {
  const apps = require('../src/apps');
  const row = db.get("SELECT * FROM integrations WHERE builtin = 'password-reset'");
  const id = Number(db.run('INSERT INTO users (guid, username, password_hash, active, email, first_name) VALUES (?,?,?,1,?,?)', newGuid(), 'quinn', hashPassword('old-password-456'), 'quinn@example.net', 'Quinn').lastInsertRowid);
  db.run('INSERT INTO sessions (sid, data, expires) VALUES (?,?,?)', 'browser-sid', JSON.stringify({ userId: id }), Date.now() + 3600000);
  const app = { id: apps.createApp({ name: 'Portal', description: '', protocol: 'oidc', access_mode: 'all', access_groups: [], maps: [], redirect_uris: ['https://portal.example.net/cb'], post_logout_uris: [], confidential: false, require_pkce: 1, grant_types: ['authorization_code', 'refresh_token'], scopes: ['openid', 'offline_access'], subject_source: 'guid', access_token_ttl: 3600 }).id };
  apps.issueGrant({ kind: 'refresh', app, userId: id, ttl: 3600, scope: 'openid' });
  const other = apps.issueGrant({ kind: 'access', app, userId: Number(db.run('INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,1)', newGuid(), 'robin', '').lastInsertRowid), ttl: 3600 });
  require('../src/messaging').send = async () => {};

  const res = { json: { run: await runNow(row.id, { input: { username: 'quinn' } }) } };
  assert.equal(res.json.run.status, 'ok', JSON.stringify(res.json.run.error));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions WHERE data LIKE ?', `%"userId":${id}%`).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM app_grants WHERE user_id = ?', id).n, 0);
  assert.ok(apps.findGrant('access', other), 'another person\'s token is left alone');
  const ended = db.get("SELECT detail FROM audit_log WHERE action = 'user.sessions_end' ORDER BY id DESC LIMIT 1");
  assert.ok(ended && /"ended":1/.test(ended.detail));
});
