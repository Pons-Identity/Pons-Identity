process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
process.env.ALLOW_PRIVATE_FETCH = 'true';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const { hashPassword, verifyPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const messaging = require('../src/messaging');
const msgSettings = require('../src/messaging/settings');
const recovery = require('../src/recovery');
const totp = require('../src/totp');
const userApi = require('../src/user-api');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
const sent = [];
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { const j = JSON.parse(body); sent.push({ to: j.personalizations[0].to[0].email, subject: j.subject, text: j.content[0].value }); res.end('{}'); });
});
test.before(() => new Promise((r) => provider.listen(0, r)));
test.after(() => { server.close(); provider.close(); });

async function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf; }
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  await call('/api/session');
  return call;
}
const login = async (u, p) => { const call = await client(); const r = await call('/api/login', { method: 'POST', body: { username: u, password: p } }); return { call, r }; };
const mkUser = (name, extra = {}) => {
  const id = Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)', newGuid(), name, hashPassword(`${name}-password`), `${name}@corp.net`).lastInsertRowid);
  if (extra.personal) db.run('UPDATE users SET personal_email = ?, personal_email_verified = 1 WHERE id = ?', extra.personal, id);
  return id;
};
// Delivery runs after the HTTP answer, so wait for it.
const delivered = async (n) => { for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
const settle = async () => new Promise((r) => setTimeout(r, 60));
const tokenOf = (m) => /recover\/([\w-]+)/.exec(m.text)[1];

test.beforeEach(() => { sent.length = 0; messaging.resetRateLimits(); require('../src/routes/recovery').resetIpLimits(); });

function enable(over = {}) {
  const { data } = msgSettings.parse({ email: { provider: 'sendgrid', from: 'idp@corp.net', sendgrid: { apiKey: 'k', apiUrl: `http://localhost:${provider.address().port}` } } }, msgSettings.messaging());
  msgSettings.save(data);
  recovery.save({ enabled: true, allowAdmins: false, ...over });
}

test('recovery is off until enabled, and cannot be enabled without email delivery', async () => {
  const call = await client();
  assert.equal((await call('/api/recover', { method: 'POST', body: { identifier: 'x' } })).status, 404);
  assert.equal((await call('/api/session')).json.config.passwordRecovery, false);
  assert.ok(recovery.parse({ enabled: true }, msgSettings.parse({}, msgSettings.messaging()).data).errors.length);
  enable();
  assert.equal((await call('/api/session')).json.config.passwordRecovery, true);
});

test('a personal address is added with the password and confirmed with a code', async () => {
  enable();
  mkUser('ana');
  const { call } = await login('ana', 'ana-password');
  assert.equal((await call('/api/account/personal-email', { method: 'POST', body: { email: 'ana@home.org', current_password: 'wrong' } })).status, 400);
  const same = await call('/api/account/personal-email', { method: 'POST', body: { email: 'ana@corp.net', current_password: 'ana-password' } });
  assert.equal(same.status, 400);
  assert.match(same.json.error, /different/);
  const add = await call('/api/account/personal-email', { method: 'POST', body: { email: 'ana@home.org', current_password: 'ana-password' } });
  assert.equal(add.status, 200);
  assert.equal(add.json.sent_to, 'a**@home.org');
  assert.equal(db.get("SELECT personal_email FROM users WHERE username = 'ana'").personal_email, ''); // not saved yet
  const code = /code is (\d{6})/.exec(sent[0].text)[1];
  assert.equal((await call('/api/account/personal-email/verify', { method: 'POST', body: { code: code === '000000' ? '111111' : '000000' } })).status, 401);
  const ok = await call('/api/account/personal-email/verify', { method: 'POST', body: { code } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.personal_email, { hint: 'a**@home.org', verified: true });
  const rm = await call('/api/account/personal-email', { method: 'DELETE', body: { current_password: 'ana-password' } });
  assert.equal(rm.json.personal_email, null);
  await delivered(2);
  assert.ok(sent.some((m) => /removed/.test(m.subject)));
});

test('a reset link goes only to a verified personal address; the answer is the same for every request', async () => {
  enable();
  mkUser('ben', { personal: 'ben@home.org' });
  mkUser('cat'); // no personal address
  const adminish = mkUser('dee', { personal: 'dee@home.org' });
  db.run("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = 'admin'", adminish);
  const dir = Number(db.run("INSERT INTO directories (name, type) VALUES ('ldapish', 'ldap')").lastInsertRowid);
  db.run("UPDATE users SET directory_id = ? WHERE id = ?", dir, mkUser('eli', { personal: 'eli@home.org' }));
  mkUser('fay', { personal: 'fay@home.org' });
  db.run('UPDATE users SET active = 0 WHERE username = ?', 'fay');

  const call = await client();
  const answers = [];
  for (const who of ['ben', 'cat', 'dee', 'eli', 'fay', 'nobody-at-all', 'ben@corp.net']) {
    const r = await call('/api/recover', { method: 'POST', body: { identifier: who } });
    answers.push(JSON.stringify([r.status, r.json]));
  }
  await delivered(2);
  await settle();
  assert.equal(new Set(answers).size, 1);
  assert.deepEqual(sent.map((m) => m.to), ['ben@home.org', 'ben@home.org']);
  const reasons = db.all("SELECT actor_name, detail FROM audit_log WHERE action = 'recovery.request' AND outcome = 'failure'").map((r) => `${r.actor_name}:${JSON.parse(r.detail).reason}`);
  for (const want of ['cat:no_personal_email', 'dee:administrator', 'eli:directory_account', 'fay:inactive', 'nobody-at-all:unknown_user']) assert.ok(reasons.includes(want), want);
});

test('the link sets a new password once, enforces policy, ends sessions and tells the owner', async () => {
  enable();
  const id = mkUser('gus', { personal: 'gus@home.org' });
  const signedIn = await login('gus', 'gus-password');
  assert.equal((await signedIn.call('/api/session')).json.me.username, 'gus');

  const call = await client();
  await call('/api/recover', { method: 'POST', body: { identifier: 'gus' } });
  await delivered(1);
  const token = tokenOf(sent[0]);
  assert.equal(JSON.stringify(db.all('SELECT * FROM recovery_tokens')).includes(token), false);
  assert.equal((await call(`/api/recover/${token}`)).json.username, 'gus');
  assert.equal((await call(`/api/recover/${token}x`)).status, 404);

  assert.equal((await call('/api/recover/reset', { method: 'POST', body: { token, new_password: 'short' } })).status, 400);
  const done = await call('/api/recover/reset', { method: 'POST', body: { token, new_password: 'a-brand-new-pass' } });
  assert.equal(done.status, 200);
  assert.equal((await call('/api/recover/reset', { method: 'POST', body: { token, new_password: 'another-new-pass' } })).status, 404);
  assert.equal((await call(`/api/recover/${token}`)).status, 404);

  const u = db.get('SELECT * FROM users WHERE id = ?', id);
  assert.ok(verifyPassword('a-brand-new-pass', u.password_hash));
  assert.equal(u.password_changed_via, 'recovery');
  assert.equal(u.password_changed_by, id);
  assert.equal((await signedIn.call('/api/session')).json.me, null);
  assert.equal((await login('gus', 'gus-password')).r.status, 401);
  assert.equal((await login('gus', 'a-brand-new-pass')).r.status, 200);
  await delivered(2);
  assert.ok(sent.some((m) => /was changed/.test(m.subject) && m.to === 'gus@home.org'));
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'recovery.complete'"));
});

test('recovery does not skip the second factor', async () => {
  enable();
  const id = mkUser('hal', { personal: 'hal@home.org' });
  const secret = totp.generateSecret();
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', secret, id);
  const call = await client();
  await call('/api/recover', { method: 'POST', body: { identifier: 'hal' } });
  await delivered(1);
  await call('/api/recover/reset', { method: 'POST', body: { token: tokenOf(sent[0]), new_password: 'hal-new-password' } });
  const r = await login('hal', 'hal-new-password');
  assert.equal(r.r.json.mfa, 'totp');
  assert.equal((await r.call('/api/session')).json.me, null);
});

test('only the newest link works, requests are throttled, links expire, and a password change voids them', async () => {
  enable();
  const id = mkUser('ivy', { personal: 'ivy@home.org' });
  const call = await client();
  await call('/api/recover', { method: 'POST', body: { identifier: 'ivy' } });
  await delivered(1);
  messaging.resetRateLimits();
  await call('/api/recover', { method: 'POST', body: { identifier: 'ivy' } });
  await delivered(2);
  const [first, second] = sent.map(tokenOf);
  assert.equal((await call(`/api/recover/${first}`)).status, 404);
  assert.equal((await call(`/api/recover/${second}`)).status, 200);

  messaging.resetRateLimits();
  await call('/api/recover', { method: 'POST', body: { identifier: 'ivy' } });
  await delivered(3);
  await call('/api/recover', { method: 'POST', body: { identifier: 'ivy' } }); // a fourth within the hour
  await settle();
  assert.equal(sent.length, 3);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'recovery.request' AND detail LIKE '%throttled%'"));

  const third = tokenOf(sent[2]);
  db.run('UPDATE recovery_tokens SET expires_at = expires_at - 7200');
  assert.equal((await call(`/api/recover/${third}`)).status, 404);

  db.run('UPDATE recovery_tokens SET expires_at = expires_at + 9000');
  assert.equal((await call(`/api/recover/${third}`)).status, 200);
  const me = await login('ivy', 'ivy-password');
  await me.call('/api/account/password', { method: 'POST', body: { current_password: 'ivy-password', new_password: 'ivy-changed-pass' } });
  assert.equal((await call(`/api/recover/${third}`)).status, 404);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM recovery_tokens WHERE user_id = ?', id).n, 0);
});

test('a policy can turn recovery off for a group; administrators can be allowed in the settings', async () => {
  enable();
  const gid = Number(db.run("INSERT INTO groups (name) VALUES ('No recovery')").lastInsertRowid);
  const pid = Number(db.run("INSERT INTO policies (name, disable_password_recovery) VALUES ('No recovery', 1)").lastInsertRowid);
  db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', pid, gid);
  const jo = mkUser('jo', { personal: 'jo@home.org' });
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', gid, jo);
  const call = await client();
  await call('/api/recover', { method: 'POST', body: { identifier: 'jo' } });
  await settle();
  assert.equal(sent.length, 0);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'recovery.request' AND detail LIKE '%disabled_by_policy%'"));
  db.run('DELETE FROM policies');

  const kim = mkUser('kim', { personal: 'kim@home.org' });
  db.run("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = 'admin'", kim);
  recovery.save({ enabled: true, allowAdmins: true });
  await call('/api/recover', { method: 'POST', body: { identifier: 'kim' } });
  await delivered(1);
  assert.equal(sent[0].to, 'kim@home.org');
});

test('administrators, bulk import and the API can set a recovery address', async () => {
  enable();
  const adm = (await login('admin', 'adminpass123')).call;
  const made = await adm('/api/admin/users', { method: 'POST', body: { username: 'lee', password: 'leepassword1', active: true, personal_email: 'lee@home.org' } });
  assert.equal(made.status, 201);
  assert.equal(made.json.personal_email, 'lee@home.org');
  assert.equal(made.json.personal_email_verified, 1);
  assert.equal((await adm('/api/admin/users', { method: 'POST', body: { username: 'mia', password: 'miapassword1', active: true, email: 'mia@corp.net', personal_email: 'mia@corp.net' } })).status, 400);
  const upd = await adm(`/api/admin/users/${made.json.id}`, { method: 'PUT', body: { ...made.json, password: '', personal_email: '' } });
  assert.equal(upd.json.personal_email, '');

  const bulk = await adm('/api/admin/users/bulk', { method: 'POST', body: { csv: 'username,password,personal_email\nnat,natpassword1,nat@home.org\nolf,olfpassword1,not-an-address', on_error: 'skip' } });
  assert.deepEqual(bulk.json.rows.map((r) => r.status), ['created', 'error']);
  assert.equal(db.get("SELECT personal_email_verified AS v FROM users WHERE username = 'nat'").v, 1);

  const token = userApi.createToken({ name: 'rec', scopes: ['users:write', 'users:read'], createdBy: 't' }).token;
  const api = (path, method, body) => fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const c = await api('/users', 'POST', { username: 'pip', password: 'pippassword1', personal_email: 'pip@home.org' });
  assert.equal(c.status, 201);
  assert.equal(c.json.personal_email, 'pip@home.org');
  const p = await api(`/users/${c.json.id}`, 'PATCH', { personal_email: '' });
  assert.equal(p.json.personal_email, null);
});

test('the settings API and policy flag are validated and audited', async () => {
  const adm = (await login('admin', 'adminpass123')).call;
  enable();
  const put = await adm('/api/admin/settings/recovery', { method: 'PUT', body: { enabled: true, allowAdmins: true } });
  assert.equal(put.status, 200);
  assert.equal(put.json.allowAdmins, true);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'settings.recovery'"));
  const gid = Number(db.run("INSERT INTO groups (name) VALUES ('Pol')").lastInsertRowid);
  const p = await adm('/api/admin/policies', { method: 'POST', body: { name: 'NoRec', subject_type: 'group', subject_id: gid, disable_password_recovery: true } });
  assert.equal(p.status, 201);
  assert.equal(p.json.disable_password_recovery, true);
  db.run('DELETE FROM policies');
});
