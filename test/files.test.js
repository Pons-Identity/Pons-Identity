process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { Client, utils: sshUtils } = require('ssh2');
const db = require('../src/db');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const files = require('../src/files/store');
const logStore = require('../src/files/logs');
const logging = require('../src/integrations/logging');
const accounts = require('../src/service-accounts');
const sftpServer = require('../src/files/sftp-server');
const { hashPassword } = require('../src/crypto');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { sftpServer.stop(); server.close(); });

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
test('sign in as the administrator', async () => { await admin.login('admin', 'adminpass123'); });

/* ------------------------------------ Store ----------------------------------- */

test('paths are absolute, made of plain names, and never climb out', () => {
  assert.equal(files.normalize('/exports//hr/people.csv'), '/exports/hr/people.csv');
  assert.equal(files.normalize('people.csv', '/integrations/integration-7'), '/integrations/integration-7/people.csv');
  assert.equal(files.normalize('/'), '/');
  for (const bad of ['/a/../b', '/.hidden', '/a/./b', '/a\u0000b', '/' + 'x'.repeat(101), '/a'.repeat(17), 42, '/-dash']) {
    assert.throws(() => files.normalize(bad), files.FileError, String(bad));
  }
});

test('writing creates folders; listings put folders first; files can be moved and removed', () => {
  files.write('/reports/2026/summary.txt', Buffer.from('one'), { by: 'test' });
  files.write('/reports/readme.txt', Buffer.from('hi'), { by: 'test' });
  files.mkdir('/reports/empty');
  assert.deepEqual(files.list('/reports').map((e) => [e.name, e.kind]), [['2026', 'dir'], ['empty', 'dir'], ['readme.txt', 'file']]);
  assert.equal(files.read('/reports/2026/summary.txt').toString(), 'one');
  files.write('/reports/readme.txt', Buffer.from(' more'), { append: true });
  assert.equal(files.read('/reports/readme.txt').toString(), 'hi more');
  files.rename('/reports/2026', '/archive/2026');
  assert.equal(files.stat('/reports/2026'), null);
  assert.equal(files.read('/archive/2026/summary.txt').toString(), 'one');
  assert.throws(() => files.remove('/archive'), /not empty/);
  assert.equal(files.remove('/archive', { recursive: true }), true);
  assert.equal(files.stat('/archive/2026/summary.txt'), null);
  assert.throws(() => files.write('/reports/readme.txt/x', Buffer.from('x')), /is a file/);
});

test('grants: read and write are separate, and folders above a grant show only the way to it', () => {
  const grants = [{ path: '/exports/hr', access: 'read' }, { path: '/drop', access: 'write' }, { path: '/both', access: 'readwrite' }];
  assert.equal(files.canRead(grants, '/exports/hr/x.csv'), true);
  assert.equal(files.canWrite(grants, '/exports/hr/x.csv'), false);
  assert.equal(files.canRead(grants, '/drop/x.csv'), false);
  assert.equal(files.canWrite(grants, '/drop/x.csv'), true);
  assert.equal(files.canRead(grants, '/both/deep/x.csv') && files.canWrite(grants, '/both/deep/x.csv'), true);
  assert.equal(files.canRead(grants, '/exports'), false);
  assert.equal(files.canList(grants, '/exports'), true);
  assert.equal(files.canSee(grants, '/'), true);
  assert.equal(files.canSee(grants, '/elsewhere'), false);
  const entries = [{ path: '/exports' }, { path: '/drop' }, { path: '/elsewhere' }];
  assert.deepEqual(files.visibleIn(grants, entries).map((e) => e.path), ['/exports', '/drop']);
  assert.equal(files.canRead([{ path: '/', access: 'readwrite' }], '/anything/at/all'), true);
});

test('grants from a form are checked: paths, access and duplicates', () => {
  assert.deepEqual(files.parseGrants([{ path: '/exports/', access: 'read' }]), { grants: [{ path: '/exports', access: 'read' }], errors: [] });
  assert.equal(files.parseGrants([{ path: '/a', access: 'delete' }]).errors.length, 1);
  assert.equal(files.parseGrants([{ path: '/a/../b', access: 'read' }]).errors.length, 1);
  assert.match(files.parseGrants([{ path: '/a', access: 'read' }, { path: '/a', access: 'write' }]).errors[0], /more than once/);
  assert.equal(files.parseGrants('nope').errors.length, 1);
});

/* ------------------------------------ Logs ------------------------------------ */

test('saved log lines are a file a day, keep their text exactly, and can be searched', () => {
  logging.save({ ...logging.DEFAULTS, saveLevel: 'debug', saveOutput: true, retentionDays: 30 });
  const day = new Date().toISOString().slice(0, 10);
  const saved = logStore.saveRun({
    integrationId: 77, runId: 5,
    logs: [{ level: 'warning', text: 'tab\there\nnew line \\ slash', color: '', time: `${day}T10:00:00.000Z` }, { level: 'debug', text: 'quiet', color: 'grey', time: `${day}T10:00:01.000Z` }],
    output: [{ text: 'printed', color: 'green', time: `${day}T10:00:02.000Z` }],
  });
  assert.equal(saved, 3);
  assert.deepEqual(files.list(logStore.logDir(77)).map((e) => e.name), [`${day}.log`]);
  const lines = logStore.query({ integration: 77 }).lines;
  assert.equal(lines.length, 3);
  assert.equal(lines[2].text, 'tab\there\nnew line \\ slash');
  assert.equal(lines[2].stream, 'log');
  assert.equal(lines.find((l) => l.stream === 'output').color, 'green');
  assert.equal(logStore.query({ integration: 77, level: 'error' }).lines.filter((l) => l.stream === 'log').length, 0);
  assert.equal(logStore.query({ integration: 77, q: 'PRINTED' }).lines.length, 1);
  assert.equal(logStore.query({ integration: 77, run: 6 }).lines.length, 0);
  assert.equal(logStore.query({ integration: 77, stream: 'log', limit: 1 }).more, true);
  assert.equal(logStore.clear(77), 1);
  assert.equal(logStore.query({ integration: 77 }).lines.length, 0);
});

test('a day that outgrows one file (10 MB) goes on into the next part of the day, and no line is lost', () => {
  logging.save({ ...logging.DEFAULTS, saveLevel: 'debug', retentionDays: 30 });
  const day = new Date().toISOString().slice(0, 10);
  const text = 'x'.repeat(1000);
  const logs = Array.from({ length: 11000 }, (_, n) => ({ level: 'normal', text: `${n} ${text}`, color: '', time: `${day}T12:00:00.000Z` }));
  assert.equal(logStore.saveRun({ integrationId: 82, runId: 1, logs, output: [] }), 11000);
  assert.deepEqual(files.list(logStore.logDir(82)).map((e) => e.name).sort(), [`${day}-2.log`, `${day}.log`]);
  assert.equal(logStore.query({ integration: 82, limit: 1000 }).more, true);
  assert.equal(logStore.query({ integration: 82, q: '10999 ' }).lines.length, 1);
  logStore.clear(82);
  logging.save({ ...logging.DEFAULTS });
});

test('saving keeps only the levels chosen, and output only when asked', () => {
  logging.save({ ...logging.DEFAULTS, saveLevel: 'error', saveOutput: false, retentionDays: 30 });
  const day = new Date().toISOString().slice(0, 10);
  const n = logStore.saveRun({ integrationId: 78, runId: 1, logs: [{ level: 'warning', text: 'no', time: `${day}T01:00:00.000Z` }, { level: 'error', text: 'yes', time: `${day}T01:00:01.000Z` }], output: [{ text: 'out', time: `${day}T01:00:02.000Z` }] });
  assert.equal(n, 1);
  assert.deepEqual(logStore.query({ integration: 78 }).lines.map((l) => l.text), ['yes']);
  logStore.clear(78);
  logging.save({ ...logging.DEFAULTS });
});

test('retention removes saved files older than the integration\'s own days, or the global days', () => {
  logging.save({ ...logging.DEFAULTS, retentionDays: 10 });
  files.write(`${logStore.logDir(79)}/2000-01-01.log`, Buffer.from('a\tb\tlog\tnormal\t\told\n'));
  files.write(`${logStore.logDir(80)}/2000-01-01.log`, Buffer.from('a\tb\tlog\tnormal\t\told\n'));
  db.run('INSERT OR REPLACE INTO integrations (id, name, script, scopes, created_at, updated_at, logging) VALUES (80, ?, ?, ?, ?, ?, ?)', 'kept-long', '', '', new Date().toISOString(), new Date().toISOString(), JSON.stringify({ saveLevel: 'debug', saveOutput: false, retentionDays: 0 }));
  assert.equal(logStore.prune(), 1);
  assert.equal(files.stat(`${logStore.logDir(79)}/2000-01-01.log`), null);
  assert.ok(files.stat(`${logStore.logDir(80)}/2000-01-01.log`));
  logStore.clear(79); logStore.clear(80);
  db.run('DELETE FROM integrations WHERE id = 80');
  logging.save({ ...logging.DEFAULTS });
});

test('lines an earlier version kept in integration_logs move into the files module, once', () => {
  db.db.exec(`CREATE TABLE integration_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, integration_id INTEGER NOT NULL, run_id INTEGER NOT NULL DEFAULT 0, stream TEXT NOT NULL DEFAULT 'log', level TEXT NOT NULL DEFAULT 'normal', color TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', time TEXT NOT NULL)`);
  db.run("INSERT INTO integration_logs (integration_id, run_id, stream, level, color, text, time) VALUES (81, 3, 'log', 'warning', '', 'carried', '2026-10-01T09:00:00.000Z')");
  db.run("INSERT INTO integration_logs (integration_id, run_id, stream, level, color, text, time) VALUES (81, 3, 'output', 'normal', '', 'printed', '2026-10-02T09:00:00.000Z')");
  assert.equal(logStore.migrateLegacy(), 2);
  assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = 'integration_logs'"), undefined);
  assert.deepEqual(logStore.query({ integration: 81 }).lines.map((l) => [l.stream, l.text]), [['output', 'printed'], ['log', 'carried']]);
  assert.equal(logStore.migrateLegacy(), 0);
  logStore.clear(81);
});

/* -------------------------------- Service accounts ---------------------------- */

test('service accounts: created with a password or a key, granted directories, and disabled or reset', async () => {
  const made = await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'hr-export', description: 'Nightly feed', grants: [{ path: '/exports/hr', access: 'read' }], generate: true } });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.account.has_password, true);
  const pw = made.json.generated_password;
  assert.ok(pw.length >= 12);
  assert.ok(accounts.authenticate('hr-export', pw));
  assert.equal(accounts.authenticate('hr-export', 'wrong-password-here'), null);
  assert.equal((await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'hr-export', grants: [{ path: '/x', access: 'read' }], generate: true } })).status, 400);
  assert.equal((await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'nogrant', grants: [], generate: true } })).status, 400);
  assert.equal((await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'nopw', grants: [{ path: '/x', access: 'read' }] } })).status, 400);

  const pair = sshUtils.generateKeyPairSync('ed25519');
  const keyed = await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'keyed', grants: [{ path: '/drop', access: 'write' }], public_keys: pair.public } });
  assert.equal(keyed.status, 201, keyed.text);
  assert.equal(keyed.json.account.has_password, false);
  assert.equal(keyed.json.account.key_labels.length, 1);
  assert.equal((await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'badkey', grants: [{ path: '/x', access: 'read' }], public_keys: 'not a key' } })).status, 400);

  const id = made.json.account.id;
  const off = await admin.call(`/api/admin/service-accounts/${id}`, { method: 'PUT', body: { username: 'hr-export', grants: [{ path: '/exports/hr', access: 'read' }], enabled: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(accounts.authenticate('hr-export', pw), null);
  const reset = await admin.call(`/api/admin/service-accounts/${id}/password`, { method: 'POST' });
  assert.ok(accounts.authenticate('hr-export', reset.json.generated_password) === null, 'a disabled account stays disabled');
  assert.deepEqual((await admin.call('/api/admin/service-accounts')).json.accounts.map((a) => a.username).sort(), ['hr-export', 'keyed']);
  assert.equal((await admin.call(`/api/admin/service-accounts/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin.call(`/api/admin/service-accounts/${id}`, { method: 'DELETE' })).status, 404);
  const audited = db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'service_account.%'").n;
  assert.ok(audited >= 4);
});

/* ----------------------------------- SFTP ------------------------------------ */

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

test('the SFTP server: a password account reads and writes its directories, and is refused elsewhere', async () => {
  const port = await freePort();
  const made = await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'feed', grants: [{ path: '/exports/feed', access: 'readwrite' }, { path: '/incoming', access: 'write' }], generate: true } });
  const pw = made.json.generated_password;
  files.write('/exports/feed/people.csv', Buffer.from('a,b\n1,2\n'), { by: 'test' });
  const status = await admin.call('/api/admin/files/sftp', { method: 'PUT', body: { enabled: true, port, bindAddress: '127.0.0.1' } });
  assert.equal(status.status, 200, status.text);
  assert.match(status.json.fingerprint, /^SHA256:/);
  assert.equal(status.json.running, true, status.json.error);

  const { sftp, client } = await connect(port, { username: 'feed', password: pw });
  try {
    const top = await op((cb) => sftp.readdir('/', cb));
    assert.deepEqual(top.map((e) => e.filename).sort(), ['exports', 'incoming']);
    const feed = await op((cb) => sftp.readdir('/exports/feed', cb));
    assert.deepEqual(feed.map((e) => e.filename), ['people.csv']);
    assert.equal((await op((cb) => sftp.readFile('/exports/feed/people.csv', cb))).toString(), 'a,b\n1,2\n');
    await op((cb) => sftp.writeFile('/exports/feed/report.csv', Buffer.from('x,y\n'), cb));
    assert.equal(files.read('/exports/feed/report.csv').toString(), 'x,y\n');
    await op((cb) => sftp.mkdir('/exports/feed/sub', cb));
    await op((cb) => sftp.rename('/exports/feed/report.csv', '/exports/feed/sub/report.csv', cb));
    assert.ok(files.stat('/exports/feed/sub/report.csv'));
    await op((cb) => sftp.unlink('/exports/feed/sub/report.csv', cb));
    await op((cb) => sftp.writeFile('/incoming/from-partner.csv', Buffer.from('ok'), cb));
    assert.equal(files.read('/incoming/from-partner.csv').toString(), 'ok');
    // Write-only: the drop box can be written but not read or listed.
    await assert.rejects(op((cb) => sftp.readFile('/incoming/from-partner.csv', cb)), /may not use that path/);
    await assert.rejects(op((cb) => sftp.readdir('/incoming', cb)), /may not use that path/);
    // Outside its grants.
    await assert.rejects(op((cb) => sftp.writeFile('/elsewhere/x.csv', Buffer.from('x'), cb)), /may not use that path/);
    await assert.rejects(op((cb) => sftp.readFile('/exports/other.csv', cb)), /may not use that path|No such/);
  } finally {
    client.end();
  }

  const wrong = await connect(port, { username: 'feed', password: 'not-the-password' }).then(() => 'connected', (e) => e.message);
  assert.notEqual(wrong, 'connected');
  const audit = db.all("SELECT outcome, detail FROM audit_log WHERE action = 'service_account.sftp_login' ORDER BY id DESC LIMIT 1");
  assert.equal(audit[0].outcome, 'failure');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'service_account.file'"), 'file changes over SFTP are audited');
  sftpServer.save({ enabled: false, port, bindAddress: '127.0.0.1' });
});

test('the SFTP server accepts a public key, and a disabled account is refused at once', async () => {
  const port = await freePort();
  const pair = sshUtils.generateKeyPairSync('ed25519');
  const keyed = await admin.call('/api/admin/service-accounts', { method: 'POST', body: { username: 'signer', grants: [{ path: '/keys', access: 'readwrite' }], public_keys: pair.public } });
  assert.equal(keyed.status, 201, keyed.text);
  sftpServer.save({ enabled: true, port, bindAddress: '127.0.0.1' });
  const { sftp, client } = await connect(port, { username: 'signer', privateKey: pair.private });
  try {
    await op((cb) => sftp.writeFile('/keys/by-key.txt', Buffer.from('signed'), cb));
    assert.equal(files.read('/keys/by-key.txt').toString(), 'signed');
    // Disabling the account ends what it can do at its next request, with no restart.
    await admin.call(`/api/admin/service-accounts/${keyed.json.account.id}`, { method: 'PUT', body: { username: 'signer', grants: [{ path: '/keys', access: 'readwrite' }], public_keys: pair.public, enabled: false } });
    await assert.rejects(op((cb) => sftp.readdir('/keys', cb)));
  } finally {
    client.end();
  }
  await assert.rejects(connect(port, { username: 'signer', privateKey: pair.private }));
  sftpServer.save({ enabled: false, port, bindAddress: '127.0.0.1' });
});

test('the SFTP settings are checked, and a port in use is reported rather than crashing the server', async () => {
  const bad = await admin.call('/api/admin/files/sftp', { method: 'PUT', body: { enabled: false, port: 70000, bindAddress: 'not-an-address' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors.length, 2);
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  const taken = await admin.call('/api/admin/files/sftp', { method: 'PUT', body: { enabled: true, port, bindAddress: '127.0.0.1' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(taken.status, 200);
  const now = (await admin.call('/api/admin/files/sftp')).json;
  assert.equal(now.running, false);
  assert.match(now.error, /already in use/);
  blocker.close();
  sftpServer.save({ enabled: false, port, bindAddress: '127.0.0.1' });
});

test('administrators and people without integration access see the right things', async () => {
  const viewer = client();
  const pw = 'viewer-password-123';
  db.run('INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,1)', newGuid(), 'nobody', hashPassword(pw));
  await viewer.login('nobody', pw);
  assert.equal((await viewer.call('/api/admin/files/list?path=/')).status, 403);
  assert.equal((await viewer.call('/api/admin/service-accounts')).status, 403);
  assert.equal((await admin.call('/api/admin/files/list?path=/')).status, 200);
});

test('a small plain-text file can be viewed as text; binary, large and missing files cannot', async () => {
  files.write('/exports/people.csv', Buffer.from('name,email\nsam,sam@example.net\n'), { by: 'test' });
  files.write('/exports/data.bin', Buffer.from([0x50, 0x00, 0x4b]), { by: 'test' });
  files.write('/exports/big.txt', Buffer.alloc(300 * 1024, 'a'), { by: 'test' });
  const listed = await admin.call('/api/admin/files/list?path=/exports');
  assert.equal(listed.json.viewBytes, files.LIMITS.viewBytes);
  const csv = await admin.call('/api/admin/files/view?path=/exports/people.csv');
  assert.equal(csv.status, 200);
  assert.equal(csv.json.text, 'name,email\nsam,sam@example.net\n');
  assert.equal((await admin.call('/api/admin/files/view?path=/exports/data.bin')).status, 415);
  assert.equal((await admin.call('/api/admin/files/view?path=/exports/big.txt')).status, 413);
  assert.equal((await admin.call('/api/admin/files/view?path=/exports/none.txt')).status, 404);
});
