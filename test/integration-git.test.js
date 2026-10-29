process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-git-test-'));
process.env.INTEGRATIONS_GIT_DIR = path.join(work, 'repo');
const db = require('../src/db');
const { createApp, seedAdmin } = require('../src/server');
const gitRepo = require('../src/integrations/git');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(work, { recursive: true, force: true }); });

function client() {
  let cookie = ''; let csrf = '';
  const call = async (p, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const login = async (u, p) => { csrf = (await call('/api/session')).json.csrf; await call('/api/login', { method: 'POST', body: { username: u, password: p } }); csrf = (await call('/api/session')).json.csrf; };
  return { call, login };
}
const admin = client();
const git = (...args) => execFileSync('git', args, { cwd: process.env.INTEGRATIONS_GIT_DIR, encoding: 'utf8' });

test('sign in and make an integration, a function and two variables', async () => {
  await admin.login('admin', 'adminpass123');
  const made = await admin.call('/api/admin/integrations', { method: 'POST', body: { name: 'HR feed', description: 'Nightly', script: 'return 1;', scopes: ['users:read'], timeout_seconds: 10 } });
  assert.equal(made.status, 201, made.text);
  db.run("INSERT INTO integration_variables (name, value, secret) VALUES ('HR_URL', 'https://hr.example.net/api', 0), ('HR_TOKEN', 'sekrit-value', 1)");
});

test('before the first commit there is no repository, and everything counts as new', async () => {
  const s = await admin.call('/api/admin/integrations/git');
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.available, true);
  assert.equal(s.json.initialized, false);
  assert.ok(s.json.changes.some((c) => c.path === 'integrations/hr-feed/script.js'));
  assert.ok(!fs.existsSync(process.env.INTEGRATIONS_GIT_DIR), 'status alone does not create anything');
});

test('committing initialises the repository and writes readable files, without secrets', async () => {
  const none = await admin.call('/api/admin/integrations/git/commit', { method: 'POST', body: { message: '  ', branch: 'main' } });
  assert.equal(none.status, 400);
  const bad = await admin.call('/api/admin/integrations/git/commit', { method: 'POST', body: { message: 'x', branch: '--upload-pack=evil' } });
  assert.equal(bad.status, 400);
  const c = await admin.call('/api/admin/integrations/git/commit', { method: 'POST', body: { message: 'First snapshot', branch: 'main' } });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.created, true);
  assert.equal(c.json.status.initialized, true);
  assert.equal(c.json.status.changes.length, 0);
  assert.equal(c.json.status.last.subject, 'First snapshot');
  assert.equal(git('symbolic-ref', '--short', 'HEAD').trim(), 'main');
  assert.equal(git('log', '-1', '--format=%an').trim(), 'Admin User');
  const files = git('ls-files').split('\n').filter(Boolean);
  assert.ok(files.includes('integrations/hr-feed/integration.json') && files.includes('integrations/hr-feed/script.js') && files.includes('variables.json'));
  const all = files.map((f) => fs.readFileSync(path.join(process.env.INTEGRATIONS_GIT_DIR, f), 'utf8')).join('\n');
  assert.ok(all.includes('https://hr.example.net/api'), 'plain variable values are kept');
  assert.ok(!all.includes('sekrit-value'), 'secret values never are');
  assert.equal(fs.readFileSync(path.join(process.env.INTEGRATIONS_GIT_DIR, 'integrations/hr-feed/script.js'), 'utf8'), 'return 1;\n');
});

test('a second commit with nothing changed is refused; an edit shows up as a change and a deletion as a removal', async () => {
  assert.equal((await admin.call('/api/admin/integrations/git/commit', { method: 'POST', body: { message: 'again', branch: 'main' } })).status, 409);
  const id = db.get("SELECT id FROM integrations WHERE name = 'HR feed'").id;
  db.run('UPDATE integrations SET script = ? WHERE id = ?', 'return 2;', id);
  const s = (await admin.call('/api/admin/integrations/git')).json;
  assert.deepEqual(s.changes.map((c) => c.path), ['integrations/hr-feed/script.js']);
  assert.equal(s.unpushed, 1);
  const c = await admin.call('/api/admin/integrations/git/commit', { method: 'POST', body: { message: 'Edit script', branch: 'main' } });
  assert.equal(c.status, 201);
  assert.match(git('show', 'HEAD', '--', 'integrations/hr-feed/script.js'), /-return 1;\n\+return 2;/);
  db.run('DELETE FROM integrations WHERE id = ?', id);
  await admin.call('/api/admin/integrations/git/commit', { method: 'POST', body: { message: 'Remove it', branch: 'main' } });
  assert.ok(!git('ls-files').includes('hr-feed'));
});

test('remote URLs must be public https without credentials', async () => {
  for (const url of ['http://example.com/r.git', 'git@github.com:a/b.git', 'file:///etc', 'https://user:pw@example.com/r.git', 'https://example.com/r.git?x=1', 'https://127.0.0.1/r.git', 'ext::sh -c evil', '']) {
    await assert.rejects(() => gitRepo.cleanRemote(url), gitRepo.GitError, url);
  }
  assert.equal(await gitRepo.cleanRemote('https://93.184.216.34/team/repo.git'), 'https://93.184.216.34/team/repo.git');
  const r = await admin.call('/api/admin/integrations/git/push', { method: 'POST', body: { remoteUrl: 'https://localhost/x.git', branch: 'main', token: 't' } });
  assert.equal(r.status, 400);
});

test('push sends the branch with the token only through the environment, and reports failures without leaking it', async () => {
  const seen = path.join(work, 'askpass-seen');
  // A fake git that records its environment and pretends the push worked or failed, so no network is needed.
  const fake = path.join(work, 'fake-git.sh');
  fs.writeFileSync(fake, `#!/bin/sh
case " $* " in
  *" push "*) echo "$PONS_IDENTITY_GIT_TOKEN|$GIT_ASKPASS|$*" > "${seen}"; if [ "$PONS_IDENTITY_GIT_TOKEN" = "bad" ]; then echo "fatal: Authentication failed for 'https://93.184.216.34/team/repo.git' using bad" >&2; exit 128; fi; echo "To https://93.184.216.34/team/repo.git"; exit 0 ;;
esac
exec git "$@"
`, { mode: 0o755 });
  process.env.GIT_BIN = fake;
  try {
    // The first commit already happened with the real git (GIT_BIN was unset); now push through the fake.
    db.run("INSERT INTO integration_variables (name, value) VALUES ('X', '1') ON CONFLICT(name) DO NOTHING");
    await admin.call('/api/admin/integrations/git/commit', { method: 'POST', body: { message: 'Add var', branch: 'main' } });
    const ok = await admin.call('/api/admin/integrations/git/push', { method: 'POST', body: { remoteUrl: 'https://93.184.216.34/team/repo.git', branch: 'main', token: 'ghp_secret123' } });
    assert.equal(ok.status, 200, ok.text);
    const line = fs.readFileSync(seen, 'utf8');
    assert.ok(line.startsWith('ghp_secret123|'), 'the token reaches git through its environment');
    assert.ok(!line.split('|').slice(2).join('|').includes('ghp_secret123'), 'and is not on the command line');
    assert.match(line, /push --porcelain origin HEAD:refs\/heads\/main/);
    assert.ok(!ok.text.includes('ghp_secret123'));
    assert.equal(git('remote', 'get-url', 'origin').trim(), 'https://93.184.216.34/team/repo.git');
    assert.ok(!fs.readFileSync(path.join(process.env.INTEGRATIONS_GIT_DIR, '.git', 'config'), 'utf8').includes('ghp_secret123'), 'not in the repository config either');
    assert.ok(!JSON.stringify(db.all('SELECT * FROM settings')).includes('ghp_secret123'), 'not stored');
    assert.ok(!JSON.stringify(db.all('SELECT * FROM audit_log')).includes('ghp_secret123'), 'not audited');

    const bad = await admin.call('/api/admin/integrations/git/push', { method: 'POST', body: { remoteUrl: 'https://93.184.216.34/team/repo.git', branch: 'main', token: 'bad' } });
    assert.equal(bad.status, 401);
    assert.ok(!bad.text.includes('using bad'));
    assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'integration.git.push' AND outcome = 'failure'"));
  } finally { delete process.env.GIT_BIN; }
});

test('only people who manage integrations can commit or push; viewers can see status', async () => {
  const { hashPassword } = require('../src/crypto');
  const { newGuid } = require('../src/guid');
  const rid = Number(db.run("INSERT INTO roles (key, name) VALUES ('iv', 'IV')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'integrations.view')", rid);
  const u = db.run("INSERT INTO users (guid, username, password_hash, display_name, email) VALUES (?, 'viewer', ?, 'V', 'v@example.net')", newGuid(), hashPassword('Viewer long passphrase 9!'));
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', Number(u.lastInsertRowid), rid);
  const v = client();
  await v.login('viewer', 'Viewer long passphrase 9!');
  assert.equal((await v.call('/api/admin/integrations/git')).status, 200);
  assert.equal((await v.call('/api/admin/integrations/git/commit', { method: 'POST', body: { message: 'x', branch: 'main' } })).status, 403);
  assert.equal((await v.call('/api/admin/integrations/git/push', { method: 'POST', body: { remoteUrl: 'https://93.184.216.34/r.git', branch: 'main' } })).status, 403);
});
