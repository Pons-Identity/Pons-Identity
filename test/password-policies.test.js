process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const policies = require('../src/policies');
const passwordRules = require('../src/password-rules');
const userService = require('../src/user-service');

seedAdmin();
const addUser = (name, extra = {}) => Number(db.run('INSERT INTO users (guid, username, password_hash, email, first_name, last_name) VALUES (?,?,?,?,?,?)',
  newGuid(), name, hashPassword(`${name}-password`), `${name}@x.com`, extra.first || '', extra.last || '').lastInsertRowid);
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

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

let n = 0;
const group = (...members) => {
  const id = Number(db.run('INSERT INTO groups (name) VALUES (?)', `pp-group-${++n}`).lastInsertRowid);
  for (const m of members) db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', id, m);
  return id;
};

// Creates a password policy through the API, a sign-in policy that uses it, and covers `userId` with it.
async function covered(admin, userId, rules) {
  // Minimums below the one every password must meet are accepted here, so the tests can set up rules that combine with others.
  const pp = await admin.call('/api/admin/password-policies', { method: 'POST', body: { name: `pp-${++n}`, accept_global_override: true, ...rules } });
  assert.equal(pp.status, 201, JSON.stringify(pp.json));
  const p = await admin.call('/api/admin/policies', { method: 'POST', body: { name: `sp-${++n}`, subject_type: 'group', subject_id: group(userId), password_policy_id: pp.json.id } });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  return pp.json;
}

const errorsFor = (id, pw) => policies.passwordErrors(id, pw);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').toUpperCase();

test('administrators manage password policies, and bad input is refused', async () => {
  const admin = await session('admin', 'adminpass123');
  const made = await admin.call('/api/admin/password-policies', { method: 'POST', body: { name: 'Strict', min_length: 14, restricted_words: 'Acme\ncompany', restricted_patterns: ['^\\d+$'], history_count: 5, zxcvbn_enabled: true, zxcvbn_min_score: 3 } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.restricted_words, ['acme', 'company']);
  assert.equal(made.json.zxcvbn_min_score, 3);
  assert.equal((await admin.call('/api/admin/password-policies')).json.password_policies.length, 1);

  for (const [body, pattern] of [
    [{ name: 'Strict' }, /already has that name/],
    [{ name: 'x', restricted_patterns: ['(unclosed'] }, /not a valid regular expression/],
    [{ name: 'x', restricted_patterns: ['(a+)+$'] }, /nested quantifiers/],
    [{ name: 'x', zxcvbn_enabled: true, zxcvbn_min_score: 9 }, /Minimum strength/],
    [{ name: 'x', history_count: 99 }, /Password history/],
    [{ name: '' }, /Name is required/],
  ]) {
    const r = await admin.call('/api/admin/password-policies', { method: 'POST', body });
    assert.equal(r.status, 400);
    assert.match(r.json.errors.join(' '), pattern);
  }

  // A sign-in policy must name one that exists, and a password policy in use cannot be deleted.
  const g = group();
  const bad = await admin.call('/api/admin/policies', { method: 'POST', body: { name: 'bad', subject_type: 'group', subject_id: g, password_policy_id: 9999 } });
  assert.equal(bad.status, 400);
  const used = await admin.call('/api/admin/policies', { method: 'POST', body: { name: 'uses it', subject_type: 'group', subject_id: g, password_policy_id: made.json.id } });
  assert.equal(used.json.password_policy_name, 'Strict');
  const del = await admin.call(`/api/admin/password-policies/${made.json.id}`, { method: 'DELETE' });
  assert.equal(del.status, 409);
  assert.match(del.json.errors[0], /uses it/);
  await admin.call(`/api/admin/policies/${used.json.id}`, { method: 'DELETE' });
  assert.equal((await admin.call(`/api/admin/password-policies/${made.json.id}`, { method: 'DELETE' })).status, 204);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'password_policy.delete'"));
});

test('length, complexity, restricted words, patterns and personal information', async () => {
  const admin = await session('admin', 'adminpass123');
  const id = addUser('rita', { first: 'Rita', last: 'Hayworth' });
  assert.deepEqual(await errorsFor(id, 'plainlowercase'), []); // no password policy yet
  await covered(admin, id, {
    min_length: 12, require_uppercase: true, require_digit: true, require_symbol: true, restricted_words: 'Acme', restricted_patterns: ['^[a-z]+\\d+$', '/qwerty/i'], block_personal_info: true,
  });
  assert.match((await errorsFor(id, 'Short1!'))[0], /at least 12/);
  const all = (await errorsFor(id, 'alllowercaseletters')).join(' ');
  assert.match(all, /uppercase/); assert.match(all, /digit/); assert.match(all, /symbol/);
  assert.match((await errorsFor(id, 'Welcome-to-ACME-9'))[0], /word that is not allowed/);
  assert.ok(!(await errorsFor(id, 'Welcome-to-ACME-9'))[0].includes('acme'), 'the restricted word is not revealed');
  assert.match((await errorsFor(id, 'My-QWERTY-Phrase-7!'))[0], /pattern that is not allowed/);
  assert.match((await errorsFor(id, 'Hayworth-Rocks-Loud-1!')).join(' '), /name, username or email/);
  assert.deepEqual(await errorsFor(id, 'Blue-Heron-Window-42!'), []);
  assert.match((await errorsFor(id, 'x'.repeat(300)))[0], /at most 256/);
});

test('character classes count lowercase, uppercase, digits and symbols', async () => {
  const admin = await session('admin', 'adminpass123');
  const id = addUser('cleo');
  await covered(admin, id, { min_character_classes: 3 });
  assert.match((await errorsFor(id, 'onlylowercase'))[0], /at least 3 of/);
  assert.deepEqual(await errorsFor(id, 'Lower and UPPER 1'), []);
});

test('password history: remembers the last N, or every password with "never reuse"', async () => {
  const admin = await session('admin', 'adminpass123');
  const id = addUser('hank');
  const set = (pw) => userService.setPassword(id, pw, { by: id, via: 'self' });
  const pp = await covered(admin, id, { history_count: 2 });
  assert.match((await errorsFor(id, 'hank-password'))[0], /last 2 passwords/); // the current password counts
  set('Second-Password-1'); set('Third-Password-2');
  assert.match((await errorsFor(id, 'Third-Password-2'))[0], /last 2/);
  assert.match((await errorsFor(id, 'Second-Password-1'))[0], /last 2/);
  assert.deepEqual(await errorsFor(id, 'hank-password'), []); // fell out of the window (and predates history being kept)

  await admin.call(`/api/admin/password-policies/${pp.id}`, { method: 'PUT', body: { name: pp.name, history_forbid_all: true } });
  assert.match((await errorsFor(id, 'Second-Password-1'))[0], /never used/); // out of the window of 2, but never reusable now
  assert.deepEqual(await errorsFor(id, 'Brand-New-Password-3'), []);
  assert.equal(db.get('SELECT history_count FROM password_policies WHERE id = ?', pp.id).history_count, 0);
});

test('history keeps only the newest HISTORY_LIMIT hashes', () => {
  const id = addUser('olga');
  for (let i = 0; i < passwordRules.HISTORY_LIMIT + 3; i++) userService.setPasswordHash(id, `hash-${i}`, { via: 'self' });
  assert.equal(db.get('SELECT COUNT(*) AS c FROM password_history WHERE user_id = ?', id).c, passwordRules.HISTORY_LIMIT);
});

test('HaveIBeenPwned: blocks breached passwords, sends only a hash prefix, and chooses fail-open or fail-closed', async () => {
  const admin = await session('admin', 'adminpass123');
  const open = addUser('pia'); const closed = addUser('quin');
  await covered(admin, open, { hibp_enabled: true });
  await covered(admin, closed, { hibp_enabled: true, hibp_block_on_error: true });

  const real = passwordRules.hibp.fetch;
  const seen = [];
  const breached = 'Correct-Horse-Battery-9';
  passwordRules.hibp.fetch = async (url) => {
    seen.push(url);
    const h = sha1(breached);
    return new Response(`${h.slice(5)}:4821\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0\n`, { status: 200 });
  };
  try {
    assert.match((await errorsFor(open, breached))[0], /known data breach/);
    assert.deepEqual(await errorsFor(open, 'Unlisted-Heron-Window-42'), []);
    assert.ok(seen.every((u) => /\/range\/[0-9A-F]{5}$/.test(u)), 'only a five-character prefix is sent');
    assert.ok(!seen.some((u) => u.includes(sha1(breached).slice(5))));

    passwordRules.hibp.fetch = async () => { throw new Error('offline'); };
    const quiet = console.error; console.error = () => {};
    try {
      assert.deepEqual(await errorsFor(open, breached), []);
      assert.match((await errorsFor(closed, breached))[0], /cannot be checked/);
    } finally { console.error = quiet; }

    // A password that already fails another rule is never sent out.
    passwordRules.hibp.fetch = async () => { throw new Error('should not be called'); };
    assert.match((await errorsFor(open, 'short'))[0], /at least 12/);
  } finally { passwordRules.hibp.fetch = real; }
});

test('zxcvbn: a threshold refuses weak passwords, a zero threshold only measures', async () => {
  const admin = await session('admin', 'adminpass123');
  const strict = addUser('sam'); const lenient = addUser('tess');
  await covered(admin, strict, { zxcvbn_enabled: true, zxcvbn_min_score: 3 });
  await covered(admin, lenient, { zxcvbn_enabled: true, zxcvbn_min_score: 0 });
  assert.match((await errorsFor(strict, 'password1234'))[0], /too easy to guess/);
  assert.deepEqual(await errorsFor(strict, 'tangerine-orbit-velvet-quarry'), []);
  assert.deepEqual(await errorsFor(lenient, 'password1234'), []);
  assert.deepEqual(policies.passwordGuidance(lenient).strength, { min_score: 0 });
  // Switching it off removes the meter and the threshold together.
  const off = addUser('uma');
  await covered(admin, off, { zxcvbn_enabled: false, zxcvbn_min_score: 4 });
  assert.equal(policies.passwordGuidance(off).strength, null);
  assert.deepEqual(await errorsFor(off, 'password1234'), []);
});

test('when several password policies apply, the strictest value of each rule wins', async () => {
  const admin = await session('admin', 'adminpass123');
  const id = addUser('vera');
  await covered(admin, id, { min_length: 10, require_digit: true, restricted_words: 'alpha', history_count: 3, zxcvbn_enabled: true, zxcvbn_min_score: 1 });
  await covered(admin, id, { min_length: 14, require_symbol: true, restricted_words: 'beta', history_forbid_all: true, hibp_enabled: true, zxcvbn_enabled: true, zxcvbn_min_score: 3 });
  const { password: r, minPasswordLength } = policies.effectivePolicy(id);
  assert.equal(minPasswordLength, 14);
  assert.deepEqual([r.requireDigit, r.requireSymbol, r.history.all, r.zxcvbn.minScore, Boolean(r.hibp)], [true, true, true, 3, true]);
  assert.deepEqual(r.restrictedWords.sort(), ['alpha', 'beta']);
});

test('people see the rules, never the restricted words, and the change-password route enforces them', async () => {
  const admin = await session('admin', 'adminpass123');
  const id = addUser('walt');
  await covered(admin, id, { min_length: 12, require_digit: true, restricted_words: 'secretword', zxcvbn_enabled: true, zxcvbn_min_score: 2 });
  const me = await session('walt', 'walt-password');
  const rules = await me.call('/api/account/password-rules');
  assert.equal(rules.status, 200);
  assert.equal(rules.json.min_length, 12);
  assert.deepEqual(rules.json.strength, { min_score: 2 });
  assert.ok(!JSON.stringify(rules.json).includes('secretword'));

  const weak = await me.call('/api/account/password', { method: 'POST', body: { current_password: 'walt-password', new_password: 'secretword-secretword' } });
  assert.equal(weak.status, 400);
  assert.ok(weak.json.errors.length >= 2);
  assert.match(weak.json.error, /digit/);
  const ok = await me.call('/api/account/password', { method: 'POST', body: { current_password: 'walt-password', new_password: 'Velvet-Orbit-Quarry-17' } });
  assert.equal(ok.status, 200);

  // An administrator setting the password is held to the same rules, and can read them.
  const guide = await admin.call(`/api/admin/users/${id}/password-rules`);
  assert.equal(guide.json.min_length, 12);
  const put = await admin.call(`/api/admin/users/${id}`, { method: 'PUT', body: { username: 'walt', email: 'walt@x.com', active: true, password: 'tooshort1' } });
  assert.equal(put.status, 400);
  assert.match(put.json.errors.join(' '), /at least 12/);
});

// New accounts have no id yet, so the policies they get come from the groups they are created in. Each path must check them.
const named = (name) => Number(db.run('INSERT INTO groups (name) VALUES (?)', name).lastInsertRowid);
async function coverGroup(admin, groupId, rules) {
  const pp = await admin.call('/api/admin/password-policies', { method: 'POST', body: { name: `pp-${++n}`, ...rules } });
  assert.equal(pp.status, 201, JSON.stringify(pp.json));
  const sp = await admin.call('/api/admin/policies', { method: 'POST', body: { name: `sp-${++n}`, subject_type: 'group', subject_id: groupId, password_policy_id: pp.json.id } });
  assert.equal(sp.status, 201, JSON.stringify(sp.json));
  return pp.json;
}

test('the console creates new accounts under the policy of the groups they are put in', async () => {
  const admin = await session('admin', 'adminpass123');
  const pilot = named('Pilot');
  await coverGroup(admin, pilot, { min_length: 14, require_symbol: true, restricted_words: 'springfield' });

  const short = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'nora', email: 'nora@x.com', password: 'Hello-World1', group_ids: [pilot] } });
  assert.equal(short.status, 400);
  assert.match(short.json.errors.join(' '), /at least 14/);
  const noSymbol = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'nora', email: 'nora@x.com', password: 'HelloWorld1234', group_ids: [pilot] } });
  assert.match(noSymbol.json.errors.join(' '), /symbol/);
  const restricted = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'nora', email: 'nora@x.com', password: 'Springfield-Hill-99', group_ids: [pilot] } });
  assert.match(restricted.json.errors.join(' '), /not allowed/);
  assert.doesNotMatch(JSON.stringify(restricted.json), /springfield/i);
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'nora'"), undefined);

  // The same password is fine for an account in no group, since no policy applies to it.
  const outside = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'otto', email: 'otto@x.com', password: 'Hello-World1' } });
  assert.equal(outside.status, 201, JSON.stringify(outside.json));
  const inside = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'nora', email: 'nora@x.com', password: 'Maple-Crossing-42', group_ids: [pilot] } });
  assert.equal(inside.status, 201, JSON.stringify(inside.json));
});

test('a new account is refused a password that contains its own name, judged from the details it is created with', async () => {
  const admin = await session('admin', 'adminpass123');
  const ops = named('Ops');
  await coverGroup(admin, ops, { min_length: 12, block_personal_info: true });
  const r = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'jordan', email: 'jordan.k@x.com', first_name: 'Jordan', last_name: 'Kim', password: 'Jordan-Heights-77', group_ids: [ops] } });
  assert.equal(r.status, 400);
  assert.match(r.json.errors.join(' '), /must not contain your name/);
});

test('an account inherits the policies of groups that contain the groups it is put in', async () => {
  const admin = await session('admin', 'adminpass123');
  const parent = named('Parent Ops');
  const child = named('Child Ops');
  db.run('INSERT INTO group_includes (group_id, member_group_id) VALUES (?, ?)', parent, child);
  await coverGroup(admin, parent, { min_length: 20 });
  assert.equal(policies.draftPolicy({ groupIds: [child] }).minPasswordLength, 20);
  assert.equal(policies.draftPolicy({ groupIds: [] }).minPasswordLength, policies.DEFAULT_MIN_PASSWORD);
});

test('bulk imports check each row against its own groups, and generated passwords meet the policy', async () => {
  const admin = await session('admin', 'adminpass123');
  const bulk = require('../src/bulk-users');
  const pilot = named('Bulk Pilot');
  await coverGroup(admin, pilot, { min_length: 14, require_symbol: true });

  const rows = await bulk.prepare([
    { username: 'quinn', password: 'Hello-World1', groups: 'Bulk Pilot' },
    { username: 'ruth', password: 'Maple-Crossing-42', groups: 'Bulk Pilot' },
    { username: 'wren', password: 'Hello-World1' },
  ], { canGroups: true, hash: false });
  assert.deepEqual(rows.map((r) => r.status), ['error', 'valid', 'valid']);
  assert.match(rows[0].errors.join(' '), /at least 14/);

  const [gen] = await bulk.prepare([{ username: 'vale', groups: 'Bulk Pilot' }], { canGroups: true, generatePasswords: true, hash: false });
  assert.equal(gen.status, 'valid', JSON.stringify(gen.errors));
  assert.ok(gen.generated.length >= 14);
  assert.deepEqual(await policies.draftPasswordErrors({ groupIds: [pilot] }, gen.generated, { username: 'tess' }), []);
  assert.equal(gen.spec.plain, gen.generated);
});

test('an administrator can overwrite the built-in minimum length, within limits, and put it back', async () => {
  const admin = await session('admin', 'adminpass123');
  const put = (min_length) => admin.call('/api/admin/global-password-policy', { method: 'PUT', body: { min_length } });
  assert.equal(policies.minimumPasswordLength(), policies.DEFAULT_MIN_PASSWORD);
  try {
    assert.equal((await put(9)).json.min_length, 9);
    assert.equal(policies.draftPolicy({ groupIds: [] }).minPasswordLength, 9);
    assert.equal(policies.minimumPasswordLength(), 9);

    const refused = await put(policies.MIN_PASSWORD_FLOOR - 1);
    assert.equal(refused.status, 400);
    assert.match(refused.json.errors.join(' '), /at least 8/);
    assert.equal(policies.minimumPasswordLength(), 9);

    // Zero keeps the built-in minimum.
    assert.equal((await put(0)).status, 200);
    assert.equal(policies.minimumPasswordLength(), policies.DEFAULT_MIN_PASSWORD);
  } finally {
    await admin.call('/api/admin/global-password-policy', { method: 'DELETE' });
  }
  assert.equal(policies.draftPolicy({ groupIds: [] }).minPasswordLength, policies.DEFAULT_MIN_PASSWORD);
});

test('global password rules apply to every account, and a policy may relax them only with an accepted override', async () => {
  const admin = await session('admin', 'adminpass123');
  const ann = addUser('ann');
  const put = (body) => admin.call('/api/admin/global-password-policy', { method: 'PUT', body });
  try {
    const set = await put({ min_length: 12, require_symbol: true, restricted_words: 'Acme', history_forbid_all: true });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.equal(set.json.require_symbol, true);
    assert.deepEqual(set.json.restricted_words, ['acme']);
    assert.match((await policies.passwordErrors(ann, 'Helloworld12')).join(' '), /symbol/);
    assert.match((await policies.passwordErrors(ann, 'Hello-acme-12')).join(' '), /word that is not allowed/);

    // A group policy with no password rules is less strict than the global rules: refused until accepted.
    const relaxed = { name: 'Relaxed passwords', subject_type: 'group', subject_id: group(ann) };
    const refused = await admin.call('/api/admin/policies', { method: 'POST', body: relaxed });
    assert.equal(refused.status, 400);
    assert.match(refused.json.errors.join(' '), /Password rules/);
    const saved = await admin.call('/api/admin/policies', { method: 'POST', body: { ...relaxed, accept_global_override: true } });
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.global_override.active, ['password']);
    assert.deepEqual(await policies.passwordErrors(ann, 'Helloworld12'), []);

    assert.equal((await admin.call('/api/admin/password-policies')).json.global.require_symbol, true);
    assert.equal((await admin.call(`/api/admin/policies/${saved.json.id}`, { method: 'DELETE' })).status, 204);
  } finally {
    await admin.call('/api/admin/global-password-policy', { method: 'DELETE' });
  }
  assert.equal((await admin.call('/api/admin/password-policies')).json.global, null);
});

test('a password policy below the minimum for every password is refused until accepted', async () => {
  const admin = await session('admin', 'adminpass123');
  const create = (body) => admin.call('/api/admin/password-policies', { method: 'POST', body });
  // With no global minimum the built-in one applies, so it is the one a shorter policy is measured against.
  assert.equal(policies.minimumPasswordLength(), policies.DEFAULT_MIN_PASSWORD);
  try {
    const short = { name: 'Short passwords', min_length: 8 };
    const refused = await create(short);
    assert.equal(refused.status, 400);
    assert.match(refused.json.errors.join(' '), /lowers the minimum length to 8, below the minimum for every password \(12\)/);
    assert.ok(!(await admin.call('/api/admin/password-policies')).json.password_policies.some((p) => p.name === short.name));

    const saved = await create({ ...short, accept_global_override: true });
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    assert.equal((await admin.call(`/api/admin/password-policies/${saved.json.id}`, { method: 'DELETE' })).status, 204);

    // A minimum at or above the built-in one, or none, needs no acceptance.
    assert.equal((await create({ name: 'Same as global', min_length: 12 })).status, 201);
    assert.equal((await create({ name: 'No minimum', min_length: 0 })).status, 201);
  } finally {
    await admin.call('/api/admin/global-password-policy', { method: 'DELETE' });
  }
});

test('a rule change leaves current passwords alone by default (attrition) and forces a new one when enforced immediately', async () => {
  const admin = await session('admin', 'adminpass123');
  const lazy = addUser('attr-lazy');
  const strict = addUser('attr-strict');
  const pp = await covered(admin, lazy, { min_length: 12 });
  db.run('INSERT INTO group_members (group_id, user_id) SELECT group_id, ? FROM group_members WHERE user_id = ?', strict, lazy);
  const rules = (extra) => ({ name: pp.name, accept_global_override: true, min_length: 20, ...extra });

  // Default: nobody is asked to change.
  const quiet = await admin.call(`/api/admin/password-policies/${pp.id}`, { method: 'PUT', body: rules({}) });
  assert.equal(quiet.status, 200, JSON.stringify(quiet.json));
  assert.equal(quiet.json.enforced, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM users WHERE password_change_required = 1').n, 0);
  assert.equal((await session('attr-lazy', 'attr-lazy-password')).login.status, 200);

  // Enforced: everyone the policy covers must change, and nothing else works for them until they do.
  const loud = await admin.call(`/api/admin/password-policies/${pp.id}`, { method: 'PUT', body: rules({ min_length: 24, enforce_immediately: true }) });
  assert.equal(loud.json.enforced, 2);
  const them = await session('attr-strict', 'attr-strict-password');
  assert.equal((await them.call('/api/session')).json.me.password_change_required, true);
  const blocked = await them.call('/api/account/mfa/forget', { method: 'POST', body: {} });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.password_change_required, true);
  assert.equal((await them.call('/api/admin/password-policies')).status, 403);
  const weak = await them.call('/api/account/password', { method: 'POST', body: { current_password: 'attr-strict-password', new_password: 'short-but-ok-ish' } });
  assert.equal(weak.status, 400);
  const ok = await them.call('/api/account/password', { method: 'POST', body: { current_password: 'attr-strict-password', new_password: 'a-much-longer-passphrase-here-1' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await them.call('/api/session')).json.me.password_change_required, false);
  assert.equal(db.get('SELECT password_change_required AS r FROM users WHERE id = ?', strict).r, 0);
  assert.equal(db.get('SELECT password_change_required AS r FROM users WHERE id = ?', lazy).r, 1);

  // Global rules can enforce on everyone.
  const global = await admin.call('/api/admin/global-password-policy', { method: 'PUT', body: { min_length: 14, enforce_immediately: true } });
  assert.equal(global.status, 200, JSON.stringify(global.json));
  assert.ok(global.json.enforced >= 3);
  await admin.call('/api/admin/global-password-policy', { method: 'DELETE' });
});
