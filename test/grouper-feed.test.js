process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');

// Async on purpose: the server under test runs in this process, so a blocking spawn would starve it.
const sh = (args, options) => new Promise((resolve) => {
  execFile('sh', args, { encoding: 'utf8', ...options }, (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
});
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const mkUser = (username, employee_id) => Number(db.run(
  'INSERT INTO users (guid, username, password_hash, active, employee_id) VALUES (?,?,?,1,?)',
  newGuid(), username, hashPassword(`${username}-password`), employee_id).lastInsertRowid);
const mkGroup = (name, description = '') => Number(db.run('INSERT INTO groups (name, description) VALUES (?,?)', name, description).lastInsertRowid);

const alice = mkUser('alice', 'E1'); const bob = mkUser('bob', 'E2'); const carol = mkUser('carol', ''); const dave = mkUser('dave', 'E4');
const eng = mkGroup('org:eng', 'Engineers, "all" of them'); const staff = mkGroup('org:staff'); const flat = mkGroup('flat');
const both = mkGroup('org:both'); const ext = mkGroup('ref:x');
db.run("UPDATE groups SET source = 'grouper' WHERE id = ?", ext);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', eng, alice);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', eng, carol); // no employee id
db.run('INSERT INTO group_members (group_id, user_id, end_at) VALUES (?,?,?)', eng, dave, 1000); // expired
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', staff, bob);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', flat, bob);
db.run('INSERT INTO group_includes VALUES (?,?)', staff, eng);
db.run('INSERT INTO group_composites VALUES (?,?,?,?)', both, 'intersect', staff, flat);

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const api = async (p, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString()); } catch { /* not JSON */ }
    return { status: r.status, json, text: buf.toString(), buf, headers: r.headers };
  };
  api.login = async (u, pw) => {
    csrf = (await api('/api/session')).json.csrf;
    await api('/api/login', { method: 'POST', body: { username: u, password: pw } });
    csrf = (await api('/api/session')).json.csrf;
  };
  return api;
}
const feedGet = (p, token) => fetch(`${base}/feed/grouper/v1/${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const L = '/api/admin/grouper/loader';

test('the feed needs a valid token, and revoking it closes the feed', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  assert.equal((await feedGet('memberships.csv')).status, 401);
  const made = await admin(`${L}/token`, { method: 'POST' });
  assert.equal(made.status, 201);
  assert.match(made.json.token, /^gft_/);
  assert.equal((await feedGet('memberships.csv', 'gft_wrong')).status, 401);
  assert.equal((await feedGet('memberships.csv', made.json.token)).status, 200);
  const stored = db.get("SELECT value FROM settings WHERE key = 'grouper_feed'").value;
  assert.ok(!stored.includes(made.json.token), 'only a hash is stored');
  assert.ok(!JSON.stringify((await admin(L)).json).includes(made.json.token));
  test.token = made.json.token;

  await admin(`${L}/token`, { method: 'DELETE' });
  assert.equal((await feedGet('memberships.csv', made.json.token)).status, 401);
  const again = await admin(`${L}/token`, { method: 'POST' });
  test.token = again.json.token;
});

test('memberships are effective: nested, composite, unexpired, with a subject id', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  assert.equal((await admin(`${L}`, { method: 'PUT', body: { subjectField: 'employee_id' } })).status, 200);
  const r = await feedGet('memberships.csv', test.token);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const lines = (await r.text()).trim().split('\r\n');
  assert.equal(lines[0], 'group_name,subject_id');
  // carol has no employee id and dave's membership expired; bob reaches "both" through staff and flat.
  assert.deepEqual(lines.slice(1), ['org:both,E2', 'org:eng,E1', 'org:staff,E1', 'org:staff,E2', 'simpleidp:flat,E2']);
});

test('groups.csv quotes values; the Grouper-sourced group is not served; JSON matches', async () => {
  const g = (await (await feedGet('groups.csv', test.token)).text()).trim().split('\r\n');
  assert.equal(g[0], 'group_name,group_display_name,group_description');
  assert.ok(g.includes('org:eng,org:eng,"Engineers, ""all"" of them"'));
  assert.ok(!g.some((l) => l.startsWith('ref:x')));
  const j = await (await feedGet('memberships.json', test.token)).json();
  assert.ok(j.every((m) => m.group_name && m.subject_id));
  assert.ok(!j.some((m) => m.subject_id === ''));
});

test('options validate, the subject column and source are honoured, and the console needs permissions', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  assert.equal((await admin(L, { method: 'PUT', body: { subjectColumn: 'password' } })).status, 400);
  assert.equal((await admin(L, { method: 'PUT', body: { rootStem: "a b'" } })).status, 400);
  const ok = await admin(L, { method: 'PUT', body: { subjectColumn: 'subject_identifier', subjectSourceId: 'ldap' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.counts.skipped, 1, 'carol has no employee id');
  const head = (await (await feedGet('memberships.csv', test.token)).text()).split('\r\n')[0];
  assert.equal(head, 'group_name,subject_identifier,subject_source_id');
  assert.ok(ok.json.lastFetchAt);

  const role = Number(db.run("INSERT INTO roles (key, name) VALUES ('custom-gv', 'GV')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'groups.view')", role);
  const viewer = mkUser('viewer', 'E9');
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', viewer, role);
  const v = client(); await v.login('viewer', 'viewer-password');
  assert.equal((await v(L)).status, 403);
  assert.equal((await v(`${L}/token`, { method: 'POST' })).status, 403);
  await admin(L, { method: 'PUT', body: { subjectColumn: 'subject_id', subjectSourceId: '' } });
});

test('the bundle has the staging tables, a safe sync script and per-folder loader settings, without the token', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const r = await admin(`${L}/bundle`);
  assert.equal(r.status, 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-'));
  try {
    fs.writeFileSync(path.join(dir, 'b.zip'), r.buf);
    const read = (n) => execFileSync('unzip', ['-p', path.join(dir, 'b.zip'), n], { encoding: 'utf8' });
    const files = Object.fromEntries(['README.txt', 'staging.sql', 'sync.sh', 'loader-settings.txt'].map((n) => [n, read(n)]));
    assert.match(files['staging.sql'], /CREATE TABLE IF NOT EXISTS simpleidp_memberships/);
    assert.match(files['staging.sql'], /PRIMARY KEY \(group_name, subject_id\)/);
    assert.match(files['loader-settings.txt'], /SQL_GROUP_LIST/);
    for (const stem of ['org', 'simpleidp']) {
      assert.ok(files['loader-settings.txt'].includes(`where group_name like '${stem}:%'`));
      assert.ok(files['loader-settings.txt'].includes(`Groups like:        ${stem}:%`));
    }
    assert.ok(!Object.values(files).some((f) => f.includes(test.token)));
    assert.ok(files['sync.sh'].includes('SIMPLEIDP_FEED_TOKEN:?'));

    // The script parses, and refuses an empty feed or a sharp drop without touching the database.
    const script = path.join(dir, 'sync.sh');
    fs.writeFileSync(script, files['sync.sh'], { mode: 0o755 });
    assert.equal((await sh(['-n', script])).status, 0);

    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const log = path.join(dir, 'psql.log');
    fs.writeFileSync(path.join(bin, 'psql'), `#!/bin/sh\nif [ "$2" = "-c" ] || [ "$3" = "-c" ]; then echo "$PSQL_COUNT"; else cat >> "${log}"; fi\n`, { mode: 0o755 });
    const run = (env) => sh([script], {
      env: { PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: 'x', SIMPLEIDP_FEED_URL: `${base}/feed/grouper/v1`, PSQL_COUNT: '0', ...env },
    });
    const bad = await run({ SIMPLEIDP_FEED_TOKEN: 'gft_wrong' });
    assert.notEqual(bad.status, 0);
    assert.equal(fs.existsSync(log), false, 'a rejected fetch loads nothing');
    const good = await run({ SIMPLEIDP_FEED_TOKEN: test.token });
    assert.equal(good.status, 0, good.stderr);
    assert.match(fs.readFileSync(log, 'utf8'), /BEGIN;[\s\S]*\\copy simpleidp_memberships \(group_name, subject_id\)[\s\S]*COMMIT;/);
    fs.rmSync(log);
    const shrink = await run({ SIMPLEIDP_FEED_TOKEN: test.token, PSQL_COUNT: '1000' });
    assert.notEqual(shrink.status, 0);
    assert.match(shrink.stderr, /refusing to load/);
    assert.equal(fs.existsSync(log), false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
