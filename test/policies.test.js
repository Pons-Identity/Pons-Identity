process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const policies = require('../src/policies');

seedAdmin();
const addUser = (name) => Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)',
  newGuid(), name, hashPassword(`${name}-password`), `${name}@x.com`).lastInsertRowid);
const ids = { hal: addUser('hal'), ivy: addUser('ivy'), jon: addUser('jon') };

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// Returns { call, login } so tests can look at a refused sign-in as well as a successful one.
async function session(username, password) {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  await call('/api/session');
  const login = await call('/api/login', { method: 'POST', body: { username, password } });
  return { call, login };
}

const role = (name) => Number(db.run('INSERT INTO roles (key, name) VALUES (?, ?)', `t-${name}`, name).lastInsertRowid);
const group = (name, ...members) => {
  const gid = Number(db.run('INSERT INTO groups (name) VALUES (?)', name).lastInsertRowid);
  for (const m of members) db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', gid, m);
  return gid;
};
const body = (extra) => ({ name: 'P', subject_type: 'group', subject_id: 1, block_sign_in: false, require_mfa: false, ...extra });

test('policies need their own permission', async () => {
  const rid = role('Policy reader');
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'policies.view')", rid);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', ids.jon, rid);
  const { call } = await session('jon', 'jon-password');
  assert.equal((await call('/api/admin/policies')).status, 200);
  assert.equal((await call('/api/admin/policies', { method: 'POST', body: body({ name: 'X' }) })).status, 403);
  db.run('DELETE FROM user_roles WHERE user_id = ?', ids.jon);
});

test('policies by group and by role combine, strictest wins', async () => {
  const { call } = await session('admin', 'adminpass123');
  const staff = group('Staff', ids.hal);
  const helpers = role('Helpers');
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', ids.hal, helpers);

  const pp = async (name, min_length) => (await call('/api/admin/password-policies', { method: 'POST', body: { name, min_length } })).json.id;
  const a = await call('/api/admin/policies', { method: 'POST', body: body({ name: 'Staff rules', subject_id: staff, require_mfa: true, password_policy_id: await pp('Fourteen', 14) }) });
  assert.equal(a.status, 201);
  assert.equal(a.json.subject_name, 'Staff');
  const b = await call('/api/admin/policies', { method: 'POST', body: body({ name: 'Helper rules', subject_type: 'role', subject_id: helpers, password_policy_id: await pp('Sixteen', 16) }) });
  assert.equal(b.status, 201);

  const { password, ...effective } = policies.effectivePolicy(ids.hal);
  assert.deepEqual(effective, { blockSignIn: false, requireMfa: true, allowedFactors: null, disablePasswordRecovery: false, riskMediumAction: '', riskHighAction: '', requirePhishingResistant: false, rememberMfaHours: 0, minPasswordLength: 16, sources: ['Helper rules', 'Staff rules'] });
  assert.equal(password.zxcvbn, null); // no password policy is attached, so none of the extra rules apply
  assert.equal(policies.effectivePolicy(ids.ivy).minPasswordLength, 12);

  // Names are unique.
  assert.equal((await call('/api/admin/policies', { method: 'POST', body: body({ name: 'Staff rules', subject_id: group('Other') }) })).status, 400);
  assert.equal((await call('/api/admin/policies', { method: 'POST', body: body({ name: 'Bad', subject_id: group('Third'), password_policy_id: 9999 }) })).status, 400);

  const updated = await call(`/api/admin/policies/${a.json.id}`, { method: 'PUT', body: body({ name: 'Staff rules', subject_id: staff }) });
  assert.equal(updated.status, 200);
  assert.equal(policies.effectivePolicy(ids.hal).requireMfa, false);
  assert.equal((await call(`/api/admin/users/${ids.hal}/policy`)).json.minPasswordLength, 16);

  assert.equal((await call(`/api/admin/policies/${b.json.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(policies.effectivePolicy(ids.hal).minPasswordLength, 12);
});

test('require MFA forces enrollment and password length is enforced', async () => {
  const { call } = await session('admin', 'adminpass123');
  const team = group('MFA team', ids.ivy);
  assert.equal((await call('/api/admin/policies', { method: 'POST', body: body({ name: 'MFA team', subject_id: team, require_mfa: true,
    password_policy_id: (await call('/api/admin/password-policies', { method: 'POST', body: { name: 'Fourteen for MFA team', min_length: 14 } })).json.id }) })).status, 201);

  const ivy = await session('ivy', 'ivy-password');
  assert.equal(ivy.login.status, 200);
  assert.equal(ivy.login.json.mfa, 'totp');
  assert.equal(ivy.login.json.enroll, true);

  // Admin-set and self-service passwords honor the minimum.
  const short = await call(`/api/admin/users/${ids.ivy}`, { method: 'PUT', body: { username: 'ivy', active: true, password: 'twelve-chars' } });
  assert.equal(short.status, 400);
  assert.match(short.json.errors.join(' '), /at least 14/);
});

test('blocking sign-in stops login and SSO but never locks out admins or yourself', async () => {
  const { call } = await session('admin', 'adminpass123');
  const blocked = group('Blocked', ids.jon);
  const made = await call('/api/admin/policies', { method: 'POST', body: body({ name: 'Blocked', subject_id: blocked, block_sign_in: true }) });
  assert.equal(made.status, 201);

  const jon = await session('jon', 'jon-password');
  assert.equal(jon.login.status, 403);

  // Cannot block the Administrator role, nor a group the acting admin belongs to.
  const adminRole = db.get("SELECT id FROM roles WHERE key = 'admin'").id;
  const r1 = await call('/api/admin/policies', { method: 'POST', body: body({ name: 'No admins', subject_type: 'role', subject_id: adminRole, block_sign_in: true }) });
  assert.equal(r1.status, 400);
  assert.match(r1.json.errors.join(' '), /Administrators|your own/);
  const me = db.get("SELECT id FROM users WHERE username = 'admin'").id;
  const mine = group('Includes admin', me);
  const r2 = await call('/api/admin/policies', { method: 'POST', body: body({ name: 'No me', subject_id: mine, block_sign_in: true }) });
  assert.equal(r2.status, 400);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM policies WHERE name IN (?, ?)', 'No admins', 'No me').n, 0);

  // Removing the policy restores access.
  assert.equal((await call(`/api/admin/policies/${made.json.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await session('jon', 'jon-password')).login.status, 200);
});

test('deleting a role or group removes its policy', () => {
  const gid = group('Ephemeral');
  const pid = Number(db.run('INSERT INTO policies (name, require_mfa) VALUES (?, 1)', 'Ephemeral').lastInsertRowid);
  db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', pid, gid);
  db.run('DELETE FROM groups WHERE id = ?', gid);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM policies WHERE name = 'Ephemeral'").n, 0);
});

test('a global policy applies to everyone; a sign-in policy may weaken a rule only when an administrator accepts that', async () => {
  const { call } = await session('admin', 'adminpass123');
  const kai = addUser('kai');
  const relaxed = group('Relaxed MFA', ids.hal);
  const put = (body) => call('/api/admin/global-policy', { method: 'PUT', body });
  const policyBody = { name: 'Relaxed MFA rules', subject_type: 'group', subject_id: relaxed, require_mfa: false, disable_password_recovery: false, risk_high_action: '' };
  try {
    assert.equal((await put({ require_mfa: true, disable_password_recovery: true, risk_high_action: 'require_mfa' })).status, 200);
    assert.equal(policies.effectivePolicy(kai).requireMfa, true);

    // The console can ask what a rule set would weaken before anything is saved.
    const preview = await call('/api/admin/policies/preview', { method: 'POST', body: policyBody });
    assert.deepEqual(preview.json.weakens.sort(), ['mfa', 'recovery', 'risk_high']);

    const refused = await call('/api/admin/policies', { method: 'POST', body: policyBody });
    assert.equal(refused.status, 400);
    assert.match(refused.json.errors.join(' '), /less secure than the global policy/);
    assert.match(refused.json.errors.join(' '), /Require a second factor/);

    const saved = await call('/api/admin/policies', { method: 'POST', body: { ...policyBody, accept_global_override: true } });
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.global_override.active.sort(), ['mfa', 'recovery', 'risk_high']);
    assert.deepEqual(saved.json.global_override.needs_acceptance, []);
    assert.equal(saved.json.global_override.accepted_by, 'admin');

    // The override reaches only the people the policy covers.
    assert.equal(policies.effectivePolicy(ids.hal).requireMfa, false);
    assert.equal(policies.effectivePolicy(ids.hal).disablePasswordRecovery, false);
    assert.equal(policies.effectivePolicy(kai).requireMfa, true);

    // Changing a global value an override was accepted against ends that override: the stricter global rule applies again
    // and the policy is flagged for review. Overrides on unchanged rules stay in force.
    assert.equal((await put({ require_phishing_resistant: true, disable_password_recovery: true, risk_high_action: 'require_mfa' })).status, 200);
    const review = (await call('/api/admin/policies')).json.policies.find((p) => p.id === saved.json.id);
    assert.deepEqual(review.global_override.needs_acceptance.sort(), ['mfa', 'phishing']);
    assert.deepEqual(review.global_override.active.sort(), ['recovery', 'risk_high']);
    assert.equal(policies.effectivePolicy(ids.hal).requireMfa, true);
    assert.equal(policies.effectivePolicy(ids.hal).requirePhishingResistant, true);

    // A global password policy is overridden the same way.
    const floor = (await call('/api/admin/password-policies', { method: 'POST', body: { name: 'Global floor', min_length: 14 } })).json.id;
    assert.equal((await put({ password_policy_id: floor })).status, 200);
    assert.equal(policies.effectivePolicy(kai).minPasswordLength, 14);
    const noRules = { name: 'No password rules', subject_type: 'group', subject_id: group('Relaxed password', kai) };
    assert.match((await call('/api/admin/policies', { method: 'POST', body: noRules })).json.errors.join(' '), /Password rules/);
    assert.equal((await call('/api/admin/policies', { method: 'POST', body: { ...noRules, accept_global_override: true } })).status, 201);
    assert.equal(policies.effectivePolicy(kai).minPasswordLength, 12);
    const inUse = await call(`/api/admin/password-policies/${floor}`, { method: 'DELETE' });
    assert.equal(inUse.status, 409);
    assert.match(inUse.json.errors.join(' '), /Global policy/);

    // A global policy cannot block sign-in.
    assert.equal((await put({ block_sign_in: true })).status, 400);

    assert.equal((await call('/api/admin/global-policy', { method: 'DELETE' })).status, 204);
    assert.equal(policies.effectivePolicy(kai).minPasswordLength, 12);
    assert.equal(policies.effectivePolicy(kai).requireMfa, false);
    assert.equal((await call(`/api/admin/password-policies/${floor}`, { method: 'DELETE' })).status, 204);
  } finally {
    await call('/api/admin/global-policy', { method: 'DELETE' });
  }
});

test('a sign-in policy can name several groups, and goes when the last one is deleted', async () => {
  const { call } = await session('admin', 'adminpass123');
  const one = group('Multi one');
  const two = group('Multi two');
  const made = await call('/api/admin/policies', { method: 'POST', body: { name: 'Multi', subject_type: 'group', group_ids: [one, two], require_mfa: true } });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual(made.json.group_ids.sort(), [one, two].sort());
  assert.equal(made.json.subject_name, 'Multi one, Multi two');
  assert.equal((await call('/api/admin/policies', { method: 'POST', body: { name: 'Nobody', subject_type: 'group', group_ids: [] } })).status, 400);

  const trimmed = await call(`/api/admin/policies/${made.json.id}`, { method: 'PUT', body: { name: 'Multi', subject_type: 'group', group_ids: [two], require_mfa: true } });
  assert.equal(trimmed.status, 200, trimmed.text);
  assert.deepEqual(trimmed.json.group_ids, [two]);

  db.run('DELETE FROM groups WHERE id = ?', one);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM policies WHERE id = ?', made.json.id).n, 1, 'still has a group');
  db.run('DELETE FROM groups WHERE id = ?', two);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM policies WHERE id = ?', made.json.id).n, 0, 'gone with its last group');
});
