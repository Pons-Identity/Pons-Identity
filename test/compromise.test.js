process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword, verifyPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const compromise = require('../src/compromise');
const userApi = require('../src/user-api');
const builtin = require('../src/integrations/builtin');
const messaging = require('../src/messaging');
const { eventOf } = require('../src/integrations/events');

seedAdmin();
builtin.seed();
const sent = [];
messaging.send = async (channel, to, msg) => { sent.push({ channel, to, msg }); };

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const addUser = (name, extra = {}) => Number(db.run('INSERT INTO users (guid, username, password_hash, email, first_name, active, mfa_enabled) VALUES (?,?,?,?,?,?,?)',
  newGuid(), name, hashPassword(`${name}-password`), `${name}@example.net`, name, extra.active ?? 1, extra.mfa ?? 0).lastInsertRowid);

const user = (id) => db.get('SELECT * FROM users WHERE id = ?', id);
const guid = (id) => user(id).guid;
const roleOf = (name) => Number(db.run('INSERT INTO roles (key, name) VALUES (?, ?)', `c-${name}`, name).lastInsertRowid);

// A console session, as an administrator signs in.
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
    const r = await call('/api/login', { method: 'POST', body: { username, password } });
    csrf = (await call('/api/session')).json.csrf;
    return r;
  };
  return { call, login };
}

const admin = client();
test('sign in as the administrator', async () => { assert.equal((await admin.login('admin', 'adminpass123')).status, 200); });

const token = (scopes) => userApi.createToken({ name: `t-${Math.random()}`, scopes, createdBy: 'test' }).token;
const api = (t, path, { method = 'GET', body } = {}) => fetch(`${base}/api/v1${path}`, {
  method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('networks: addresses and networks are read, mapped IPv4 is compared as IPv4, and nonsense is refused', () => {
  const ok = compromise.parseNetworks('10.0.0.0/8, 2001:db8::/32\n192.0.2.7');
  assert.deepEqual(ok.networks, ['10.0.0.0/8', '2001:db8::/32', '192.0.2.7']);
  assert.deepEqual(ok.errors, []);
  const bad = compromise.parseNetworks('10.0.0.0/33 nope 1.2.3.4/8/9');
  assert.equal(bad.errors.length, 3);
  assert.equal(compromise.inList('10.9.8.7', ['10.0.0.0/8']), true);
  assert.equal(compromise.inList('11.0.0.1', ['10.0.0.0/8']), false);
  assert.equal(compromise.inList('::ffff:10.1.1.1', ['10.0.0.0/8']), true, 'a mapped IPv4 address matches an IPv4 network');
  assert.equal(compromise.inList('2001:db8::5', ['2001:db8::/32']), true);
  assert.equal(compromise.inList(undefined, ['10.0.0.0/8']), false, 'an unknown address matches nothing');
  // Every list must match; a restriction with no lists allows everything.
  assert.equal(compromise.allowedFrom({ networks: JSON.stringify([['10.0.0.0/8'], ['192.0.2.0/24']]) }, '10.1.1.1'), false);
  assert.equal(compromise.allowedFrom({ networks: '[]' }, '203.0.113.9'), true);
});

test('policies: one Everyone policy, one per role or group, names unique, and the steps merge strictest-wins', async () => {
  const everyone = await admin.call('/api/admin/compromise-policies', { method: 'POST', body: { name: 'Default', subject_type: 'everyone', forget_remembered: false, notify_user: false, rotate_mfa: false, restrict_networks: '' } });
  assert.equal(everyone.status, 201, everyone.text);
  assert.equal((await admin.call('/api/admin/compromise-policies', { method: 'POST', body: { name: 'Second', subject_type: 'everyone' } })).status, 400, 'only one Everyone policy');

  const staff = roleOf('Staff');
  const sensitive = await admin.call('/api/admin/compromise-policies', { method: 'POST', body: {
    name: 'Payroll', subject_type: 'role', subject_id: staff, rotate_mfa: true, restrict_networks: ['10.0.0.0/8', '192.0.2.0/24'],
  } });
  assert.equal(sensitive.status, 201, sensitive.text);
  assert.deepEqual(sensitive.json.restrict_networks, ['10.0.0.0/8', '192.0.2.0/24']);
  assert.equal((await admin.call('/api/admin/compromise-policies', { method: 'POST', body: { name: 'Again', subject_type: 'role', subject_id: staff } })).status, 400, 'one policy per role');
  assert.equal((await admin.call('/api/admin/compromise-policies', { method: 'POST', body: { name: 'Payroll', subject_type: 'everyone' } })).status, 400, 'names are unique');
  assert.equal((await admin.call('/api/admin/compromise-policies', { method: 'POST', body: { name: 'Bad net', subject_type: 'everyone', restrict_networks: 'banana' } })).status, 400);

  const member = addUser('cp-member');
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', member, staff);
  const plan = compromise.effectiveFor(member);
  assert.equal(plan.steps.rotate_mfa, true, 'the role policy adds a step the default does not run');
  assert.equal(plan.steps.notify_user, false, 'the default turns notifying off, and nothing adds it');
  assert.equal(plan.steps.end_sessions, true);
  assert.deepEqual(plan.networks, [['10.0.0.0/8', '192.0.2.0/24']]);
  assert.deepEqual(plan.sources, ['Default', 'Payroll']);

  const other = addUser('cp-other');
  assert.equal(compromise.effectiveFor(other).steps.rotate_mfa, false, 'without the role, only the default applies');

  // Editing and deleting.
  const id = sensitive.json.id;
  const edited = await admin.call(`/api/admin/compromise-policies/${id}`, { method: 'PUT', body: { name: 'Payroll', subject_type: 'role', subject_id: staff, rotate_mfa: false } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.rotate_mfa, false);
  assert.equal((await admin.call(`/api/admin/compromise-policies/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await admin.call(`/api/admin/compromise-policies/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await admin.call('/api/admin/compromise-policies')).json.policies.length, 1);
  // Remove the Everyone policy too, so the lockdowns below run the built-in default.
  const everyoneId = everyone.json.id;
  assert.equal((await admin.call(`/api/admin/compromise-policies/${everyoneId}`, { method: 'DELETE' })).status, 204);
});

test('the console locks an account down: credentials, MFA and the account change, the lockdown is recorded, and ending it turns the account back on', async () => {
  const victim = addUser('victim', { mfa: 1 });
  db.run("INSERT INTO user_factors (user_id, type, label, credential) VALUES (?, 'webauthn', 'Key', '{}')", victim);
  const before = user(victim).password_hash;

  const r = await admin.call(`/api/admin/users/${victim}/lockdown`, { method: 'POST' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.compromise.lockdown.locked_account, true);
  assert.equal(r.json.compromise.lockdown.started_by, 'admin');
  const after = user(victim);
  assert.equal(after.active, 0, 'the account is turned off');
  assert.equal(verifyPassword('victim-password', after.password_hash), false, 'the old password no longer works');
  assert.notEqual(after.password_hash, before);
  assert.equal(after.mfa_enabled, 1, 'the person must set up a sign-in method again');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM user_factors WHERE user_id = ?', victim).n, 0, 'every sign-in method is removed');
  assert.equal(sent.at(-1).to, 'victim@example.net', 'the person is told');
  assert.doesNotMatch(sent.at(-1).msg.text, /password/i, 'the email holds no credential');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'user.lockdown' AND target_id = ?", String(victim)), 'the call is audited');

  const ended = await admin.call(`/api/admin/users/${victim}/lockdown`, { method: 'DELETE' });
  assert.equal(ended.status, 200);
  assert.equal(ended.json.compromise.lockdown, null);
  assert.equal(user(victim).active, 1, 'ending the lockdown turns the account back on');
  assert.equal((await admin.call(`/api/admin/users/${victim}/lockdown`, { method: 'DELETE' })).status, 404);
});

test('a lockdown refuses sign-in from outside its networks, and allows it from inside', async () => {
  addUser('roamer');
  const roamer = db.get("SELECT id FROM users WHERE username = 'roamer'").id;
  // The test server sees a loopback address, so a network that excludes it refuses sign-in.
  compromise.restrict(roamer, { networks: [['10.0.0.0/8']], lock: false });
  const refused = await client().login('roamer', 'roamer-password');
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, 'Sign-in is not permitted for this account.', 'the reply does not say why');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'login.failure' AND detail LIKE '%compromise_lockdown%'"));

  compromise.restrict(roamer, { networks: [['127.0.0.0/8', '::1/128']], lock: false });
  const allowed = await client().login('roamer', 'roamer-password');
  assert.notEqual(allowed.status, 403, 'a network that includes the address lets the person sign in');
  compromise.endLockdown(roamer);
});

test('the REST endpoint locks an account down, records the call, and the lockdown event fires from that call', async () => {
  const t = token(['users:read', 'users:write']);
  const target = addUser('apivictim');
  const r = await api(t, `/users/${guid(target)}/lockdown`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.user.active, false);
  assert.equal(r.json.lockdown.locked_account, true);
  assert.ok(Number.isInteger(r.json.run.id));
  assert.equal(r.json.run.status, 'ok');

  const row = db.get("SELECT * FROM audit_log WHERE action = 'user.lockdown' AND target_id = ?", String(target));
  assert.ok(row, 'the call is audited');
  assert.match(row.actor_name, /^user-api:/);
  assert.equal(eventOf(row), 'user.locked_down', 'the call is what fires the integration event');

  const again = await api(t, `/users/${guid(target)}`, { method: 'GET' });
  assert.equal(again.json.username, 'apivictim');
  const ended = await api(t, `/users/${guid(target)}/lockdown`, { method: 'DELETE' });
  assert.equal(ended.status, 200);
  assert.equal(ended.json.active, true);
  assert.equal((await api(t, `/users/${guid(target)}/lockdown`, { method: 'DELETE' })).status, 404);
});

test('the REST endpoint needs users:write, and refuses while the integration is off or the account is an administrator', async () => {
  const target = addUser('apiother');
  assert.equal((await api(token(['users:read']), `/users/${guid(target)}/lockdown`, { method: 'POST' })).status, 403);

  const row = db.get("SELECT id FROM integrations WHERE builtin = 'compromised-account-lockdown'");
  db.run('UPDATE integrations SET enabled = 0 WHERE id = ?', row.id);
  const off = await api(token(['users:write']), `/users/${guid(target)}/lockdown`, { method: 'POST' });
  assert.equal(off.status, 409);
  assert.match(off.json.error, /Turn on the Compromised account lockdown integration/);
  db.run('UPDATE integrations SET enabled = 1 WHERE id = ?', row.id);

  const adminUser = db.get("SELECT guid FROM users WHERE username = 'admin'");
  assert.equal((await api(token(['users:write']), `/users/${adminUser.guid}/lockdown`, { method: 'POST' })).status, 403, 'administrative access is refused, as the rest of the API does');
});

test('the lockdown integration is seeded with its own procedure, which a developer can read and change', () => {
  const b = builtin.BUILTIN.find((x) => x.key === 'compromised-account-lockdown');
  assert.ok(b, 'the built-in lockdown is listed');
  assert.deepEqual(b.scopes.sort(), ['groups:write', 'messaging', 'users:read', 'users:write']);
  assert.match(b.script, /idp\.compromise\.plan/);
  assert.match(b.script, /idp\.compromise\.restrict/);
  assert.match(b.script, /idp\.groups\.addMember/);
  assert.ok(db.get("SELECT 1 FROM integrations WHERE builtin = 'compromised-account-lockdown'"));
});

test('the console refuses to lock down your own account or one with administrative access', async () => {
  const me = db.get("SELECT id FROM users WHERE username = 'admin'").id;
  assert.equal((await admin.call(`/api/admin/users/${me}/lockdown`, { method: 'POST' })).status, 409);
});

test('"Add to a group" needs a group before the policy is saved, and the lockdown adds the person to it', async () => {
  const finance = Number(db.run("INSERT INTO groups (name) VALUES ('Finance')").lastInsertRowid);
  const quarantine = Number(db.run("INSERT INTO groups (name) VALUES ('Quarantine')").lastInsertRowid);
  const external = Number(db.run("INSERT INTO groups (name, source) VALUES ('Synced', 'grouper')").lastInsertRowid);
  const url = '/api/admin/compromise-policies';
  const base = { name: 'Finance lockdown', subject_type: 'group', subject_id: finance, add_to_group: true };

  const missing = await admin.call(url, { method: 'POST', body: base });
  assert.equal(missing.status, 400, 'no group chosen');
  assert.match(missing.json.errors[0], /Choose the group/);
  assert.equal((await admin.call(url, { method: 'POST', body: { ...base, add_to_group_id: 99999 } })).status, 400, 'the group must exist');
  assert.equal((await admin.call(url, { method: 'POST', body: { ...base, add_to_group_id: external } })).status, 400, 'a provisioned group cannot be changed');
  const off = await admin.call(url, { method: 'POST', body: { ...base, name: 'Off', subject_id: quarantine, add_to_group: false } });
  assert.equal(off.status, 201, 'the group is not needed while the step is off');
  await admin.call(`${url}/${off.json.id}`, { method: 'DELETE' });

  const saved = await admin.call(url, { method: 'POST', body: { ...base, add_to_group_id: quarantine } });
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.json.add_to_group_name, 'Quarantine');

  const t = token(['users:read', 'users:write']);
  const target = addUser('groupvictim');
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', finance, target);
  const plan = compromise.effectiveFor(target);
  assert.equal(plan.steps.add_to_group, true);
  assert.deepEqual(plan.groups.map((g) => g.name), ['Quarantine']);
  assert.equal(compromise.effectiveFor(addUser('groupbystander')).steps.add_to_group, false, 'only the people the policy applies to');

  const r = await api(t, `/users/${guid(target)}/lockdown`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(db.get('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', quarantine, target), 'added to the group');
});
