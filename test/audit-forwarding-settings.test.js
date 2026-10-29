process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const appSettings = require('../src/app-settings');
const forward = require('../src/audit-forward');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { server.close(); forward.stop(); });

async function signIn(username, password) {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    return { status: r.status, text, json: text ? JSON.parse(text) : null };
  };
  await call('/api/session');
  const r = await call('/api/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200);
  return call;
}

const SYSLOG = { enabled: true, url: 'tls://logs.example.net:6514', facility: 'local4', appName: 'idp', caFile: '' };
// Port 1 refuses connections at once, so forwarding fails quickly without reaching a real server.
const HTTP = { enabled: true, url: 'http://127.0.0.1:1/ingest', format: 'splunk-hec', authToken: 'tok-123' };

test('log forwarding is set in the console, and the access token stays on the server', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const admin = await signIn('admin', 'adminpass123');

    const saved = await admin('/api/admin/settings/audit-forwarding', { method: 'PUT', body: { syslog: SYSLOG, http: HTTP } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.http.tokenSet, true);
    assert.ok(!saved.text.includes('tok-123'), 'the token must not be returned to the browser');

    const view = await admin('/api/admin/settings/audit-forwarding');
    assert.equal(view.json.syslog.url, SYSLOG.url);
    assert.equal(view.json.http.format, 'splunk-hec');
    assert.ok(!view.text.includes('tok-123'));

    const sinks = appSettings.auditForwardingSinks();
    assert.equal(sinks.auditSyslog.url, SYSLOG.url);
    assert.equal(sinks.auditHttp.authToken, 'tok-123');
    assert.deepEqual(forward.status().map((s) => s.sink).sort(), ['http', 'syslog']);

    // A blank token keeps the one already saved.
    const kept = await admin('/api/admin/settings/audit-forwarding', { method: 'PUT', body: { syslog: SYSLOG, http: { ...HTTP, authToken: '' } } });
    assert.equal(kept.status, 200);
    assert.equal(appSettings.auditForwardingSinks().auditHttp.authToken, 'tok-123');

    // Turning syslog off stops that destination; the audit record names what changed, never the values.
    const off = await admin('/api/admin/settings/audit-forwarding', { method: 'PUT', body: { syslog: { ...SYSLOG, enabled: false }, http: HTTP } });
    assert.equal(off.status, 200);
    assert.deepEqual(forward.status().map((s) => s.sink), ['http']);
    const record = db.get("SELECT detail FROM audit_log WHERE action = 'settings.audit_forwarding' ORDER BY id DESC LIMIT 1");
    assert.deepEqual(JSON.parse(record.detail).changed, ['syslog.enabled']);
    assert.ok(!record.detail.includes('tok-123'));
  } finally {
    console.error = orig;
    forward.stop();
  }
});

test('invalid log forwarding settings are refused and nothing is saved', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const before = appSettings.forwarding();
  const r = await admin('/api/admin/settings/audit-forwarding', { method: 'PUT', body: {
    syslog: { ...SYSLOG, url: 'http://not-syslog' }, http: { ...HTTP, url: 'ftp://siem', format: 'xml' },
  } });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.some((m) => /Syslog server/.test(m)));
  assert.ok(r.json.errors.some((m) => /SIEM URL/.test(m)));
  assert.deepEqual(appSettings.forwarding(), before);
});

test('viewing the audit log is not enough to change log forwarding', async () => {
  const id = Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)',
    newGuid(), 'auditor', hashPassword('auditor-password'), 'auditor@x.com').lastInsertRowid);
  const admin = await signIn('admin', 'adminpass123');
  const role = await admin('/api/admin/roles', { method: 'POST', body: { name: 'Auditors', description: 'Read only', permissions: ['audit.view'], user_ids: [id] } });
  assert.equal(role.status, 201);

  const auditor = await signIn('auditor', 'auditor-password');
  assert.equal((await auditor('/api/admin/settings/audit-forwarding')).status, 403);
  assert.equal((await auditor('/api/admin/settings/audit-forwarding', { method: 'PUT', body: { syslog: { enabled: false }, http: { enabled: false } } })).status, 403);
});
