process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const groupCalc = require('../src/group-calculator');
const policyCalc = require('../src/policy-calculator');

seedAdmin();
const addUser = (name) => Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)',
  newGuid(), name, hashPassword(`${name}-password`), `${name}@x.com`).lastInsertRowid);
const group = (name, ...members) => {
  const gid = Number(db.run('INSERT INTO groups (name) VALUES (?)', name).lastInsertRowid);
  for (const m of members) db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', gid, m);
  return gid;
};
// A sign-in policy for one group, given as the INSERT for the policy itself.
const groupPolicy = (insert, gid) => db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', Number(db.run(insert).lastInsertRowid), gid);
const nest = (parent, child) => db.run('INSERT INTO group_includes (group_id, member_group_id) VALUES (?, ?)', parent, child);
const composite = (name, op, left, right) => {
  const gid = group(name);
  db.run('INSERT INTO group_composites (group_id, op, left_id, right_id) VALUES (?,?,?,?)', gid, op, left, right);
  return gid;
};
const idOf = (name) => db.get('SELECT id FROM groups WHERE name = ?', name).id;

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function session(username, password) {
  let cookie = '';
  const call = async (path) => {
    const r = await fetch(base + path, { headers: { cookie } });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const post = async (path, body) => {
    const csrf = (await call('/api/session')).json.csrf;
    const r = await fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return r.status;
  };
  await call('/api/session');
  await post('/api/login', { username, password });
  return { call };
}

/* ------------------------------ Group calculator ------------------------------ */

test('group calculator: every route into a group, and what builds it', () => {
  const ann = addUser('gc-ann');
  const eng = group('gc-eng', ann);
  const ops = group('gc-ops', ann);
  const staff = group('gc-staff');
  nest(staff, eng);
  nest(staff, ops);
  const both = composite('gc-both', 'intersect', eng, ops);
  const only = composite('gc-only-eng', 'minus', eng, ops);

  const staffRoutes = groupCalc.calculate({ userId: ann, groupId: staff });
  assert.strictEqual(staffRoutes.routes.length, 2, 'two nested groups are two routes');
  assert.deepStrictEqual(staffRoutes.routes.map((r) => r.text).sort(), [
    'direct member of "gc-eng" → nested in "gc-staff"', 'direct member of "gc-ops" → nested in "gc-staff"']);

  const inBoth = groupCalc.calculate({ userId: ann, groupId: both });
  assert.strictEqual(inBoth.member, true);
  assert.match(inBoth.routes[0].notes[0], /also in "gc-ops"/);

  const notOnly = groupCalc.calculate({ userId: ann, groupId: only });
  assert.strictEqual(notOnly.member, false);
  assert.match(notOnly.text, /which the difference "gc-only-eng" removes/);

  const built = groupCalc.calculate({ groupId: staff });
  assert.match(built.text, /Nested group: gc-eng/);
  assert.match(built.text, /Nested group: gc-ops/);
  assert.ok(built.mermaid.startsWith('flowchart LR'));
  assert.ok(built.graph.links[`g${eng}`] === `/admin/groups/${eng}`);

  const all = groupCalc.calculate({ userId: ann });
  assert.ok(all.groups.some((g) => g.group.name === 'gc-both'));
});

test('group calculator: ended memberships, include and exclude groups, and queries', () => {
  const bob = addUser('gc-bob');
  const old = group('gc-old');
  db.run('INSERT INTO group_members (group_id, user_id, end_at) VALUES (?,?,?)', old, bob, 100);
  const lapsed = groupCalc.calculate({ userId: bob, groupId: old });
  assert.strictEqual(lapsed.member, false);
  assert.match(lapsed.text, /membership in "gc-old" ended/);

  const base = group('gc-base', bob);
  const inc = group('gc-base:include');
  const exc = group('gc-base:exclude', bob);
  db.run('INSERT INTO group_include_exclude (group_id, include_id, exclude_id) VALUES (?,?,?)', base, inc, exc);
  const removed = groupCalc.calculate({ userId: bob, groupId: base });
  assert.strictEqual(removed.member, false);
  assert.match(removed.text, /removes them: they are in its exclude group "gc-base:exclude"/);

  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', inc, bob);
  db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', exc, bob);
  const included = groupCalc.calculate({ userId: bob, groupId: base });
  assert.strictEqual(included.member, true);
  assert.ok(included.routes.some((r) => /include group of "gc-base"/.test(r.text)));

  const queried = group('gc-queried');
  db.run('INSERT INTO group_members (group_id, user_id, via_rule) VALUES (?,?,1)', queried, bob);
  db.run("INSERT INTO group_rules (group_id, filter, mode, set_by, set_at) VALUES (?, '(department=x)', 'ongoing', 'test', 0)", queried);
  assert.match(groupCalc.calculate({ userId: bob, groupId: queried }).routes[0].text, /added by the query of "gc-queried"/);
  assert.match(groupCalc.calculate({ groupId: queried }).text, /Ongoing query \(department=x\)/);
});

test('group calculator: loops and bad input do not break it', () => {
  const a = group('gc-loop-a'); const b = group('gc-loop-b');
  nest(a, b); nest(b, a);
  const loop = groupCalc.calculate({ groupId: a });
  assert.match(loop.text, /loops back/);
  assert.ok(groupCalc.calculate({}).error);
  assert.ok(groupCalc.calculate({ groupId: 99999 }).error);
  assert.ok(groupCalc.calculate({ userId: 99999 }).error);
});

test('mermaid labels cannot break out of their quotes', () => {
  const g = group('say "hi" <b>&</b>');
  const out = groupCalc.calculate({ groupId: g });
  assert.ok(!/say "hi"/.test(out.mermaid));
  assert.ok(out.mermaid.includes('#quot;hi#quot;') && out.mermaid.includes('#lt;b#gt;'));
});

/* ------------------------------ Policy calculator ------------------------------ */

test('policy calculator: policies by role and group, strictest value wins, with sources', () => {
  const cy = addUser('pc-cy');
  const eng = group('pc-eng', cy);
  const staff = group('pc-staff');
  nest(staff, eng);
  groupPolicy("INSERT INTO policies (name, require_mfa) VALUES ('pc Staff MFA', 1)", staff);
  groupPolicy("INSERT INTO policies (name, require_phishing_resistant, remember_mfa_hours) VALUES ('pc Eng strict', 1, 4)", eng);
  const rid = Number(db.run("INSERT INTO roles (key, name) VALUES ('pc-r', 'pc Role')").lastInsertRowid);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)', cy, rid);
  db.run("INSERT INTO policies (name, role_id, remember_mfa_hours) VALUES ('pc Role short', ?, 1)", rid);

  const out = policyCalc.calculate({ userId: cy });
  assert.deepStrictEqual(out.sign_in.applied.map((p) => p.name).sort(), ['pc Eng strict', 'pc Role short', 'pc Staff MFA']);
  const rule = (key) => out.sign_in.rules.find((r) => r.key === key);
  assert.strictEqual(rule('mfa').value, 'Required');
  assert.deepStrictEqual(rule('mfa').sources, ['pc Eng strict', 'pc Staff MFA']);
  assert.strictEqual(rule('remember').value, '1 hour');
  assert.deepStrictEqual(rule('remember').sources, ['pc Role short']);
  const staffPolicy = out.sign_in.applied.find((p) => p.name === 'pc Staff MFA');
  assert.match(staffPolicy.because[0], /direct member of "pc-eng" → nested in "pc-staff"/);
  assert.match(out.text, /ENFORCED SIGN-IN RULES/);
  assert.ok(out.mermaid.includes('Enforced sign-in rules<br/>• Second factor: Required'), 'the result box lists what the rules yielded');
  assert.ok(out.mermaid.includes('pc Role short<br/>• remembers a second factor: 1 hour'), 'a policy box lists what it requires');
  assert.ok(out.mermaid.includes('sets remember a second factor'), 'an edge says what the policy contributed');

  // The calculator agrees with what sign-in enforces.
  const real = require('../src/policies').effectivePolicy(cy);
  assert.strictEqual(real.requireMfa, true);
  assert.strictEqual(real.rememberMfaHours, 1);
});

test('policy calculator: blocking, the global policy and an overridden rule', () => {
  const di = addUser('pc-di');
  const blocked = group('pc-blocked', di);
  groupPolicy("INSERT INTO policies (name, block_sign_in) VALUES ('pc Block', 1)", blocked);
  const out = policyCalc.calculate({ userId: di });
  assert.strictEqual(out.sign_in.rules.find((r) => r.key === 'block').value, 'Blocked');
  assert.deepStrictEqual(out.sign_in.rules.find((r) => r.key === 'block').sources, ['pc Block']);
});

test('policy calculator: an application, alone and with a person', () => {
  const ed = addUser('pc-ed'); const fay = addUser('pc-fay');
  const team = group('pc-team', ed);
  db.run("INSERT INTO apps (id, protocol, name, client_id, access_mode) VALUES ('pc-app','oidc','pc Payroll','pc-client','groups')");
  db.run("INSERT INTO app_access_groups (app_id, group_id) VALUES ('pc-app', ?)", team);
  db.run("INSERT INTO app_policies (name, require_phishing_resistant) VALUES ('pc App strict', 1)");
  const policyId = db.get("SELECT id FROM app_policies WHERE name = 'pc App strict'").id;
  db.run("INSERT INTO app_policy_apps (policy_id, app_id) VALUES (?, 'pc-app')", policyId);

  const appOnly = policyCalc.calculate({ kind: 'app', appId: 'pc-app' });
  assert.strictEqual(appOnly.scenario, 'app');
  assert.deepStrictEqual(appOnly.app_policies.policies.map((p) => p.name), ['pc App strict']);
  assert.strictEqual(appOnly.access.people, 1);

  const refused = policyCalc.calculate({ userId: fay, kind: 'app', appId: 'pc-app' });
  assert.strictEqual(refused.outcome.status, 'refused');
  assert.match(refused.text, /may NOT use it/);

  const noFactor = policyCalc.calculate({ userId: ed, kind: 'app', appId: 'pc-app' });
  assert.strictEqual(noFactor.access.allowed, true);
  assert.strictEqual(noFactor.outcome.status, 'refused', 'a phishing-resistant factor is required and ed has none');
  assert.match(noFactor.outcome.reasons.join(' '), /phishing-resistant/);

  db.run("UPDATE users SET totp_enabled = 1, totp_secret = 'x' WHERE id = ?", ed);
  require('../src/factors/settings');
  assert.ok(policyCalc.calculate({ userId: ed, kind: 'app', appId: 'pc-app' }).outcome);

  assert.ok(policyCalc.calculate({ kind: 'sp', appId: 'nope' }).error);
  assert.ok(policyCalc.calculate({}).error);
});

/* --------------------------------- Routes ---------------------------------- */

test('policy calculator: a turned-off account is warned about in the diagram', () => {
  const off = addUser('pc-off');
  db.run('UPDATE users SET active = 0 WHERE id = ?', off);
  const out = policyCalc.calculate({ userId: off });
  assert.match(out.text, /account is turned off/);
  assert.ok(out.mermaid.includes('⚠ account is turned off'), 'the person box says the account is turned off');
  assert.strictEqual(out.graph.nodes.find((n) => n.id === `u${off}`).cls, 'bad');
  const on = addUser('pc-on');
  assert.ok(!policyCalc.calculate({ userId: on }).mermaid.includes('turned off'));
});

test('calculators draw a vertical diagram as well as the horizontal one', () => {
  const ann = addUser('pc-td');
  const g = group('pc-td-group', ann);
  assert.ok(policyCalc.calculate({ userId: ann }).mermaid_vertical.startsWith('flowchart TD'));
  assert.ok(groupCalc.calculate({ groupId: g }).mermaid_vertical.startsWith('flowchart TD'));
});

test('calculator routes need the matching permissions', async () => {
  const user = addUser('pc-viewer');
  const rid = Number(db.run("INSERT INTO roles (key, name) VALUES ('pc-viewer', 'pc Viewer')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'policies.view')", rid);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)', user, rid);
  const viewer = await session('pc-viewer', 'pc-viewer-password');
  const eng = idOf('pc-eng');
  assert.strictEqual((await viewer.call(`/api/admin/calculators/policy?user_id=${user}`)).status, 403, 'a person needs users.view');
  assert.strictEqual((await viewer.call('/api/admin/calculators/group?group_id=1')).status, 403, 'groups need groups.view');
  assert.strictEqual((await viewer.call('/api/admin/calculators/policy?kind=app&app_id=pc-app')).status, 403, 'an application needs sps.view');
  assert.strictEqual((await viewer.call('/api/admin/calculators/policy')).status, 400);

  const admin = await session('admin', 'adminpass123');
  const ok = await admin.call(`/api/admin/calculators/group?group_id=${eng}`);
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.json.text && ok.json.mermaid);
  const pol = await admin.call(`/api/admin/calculators/policy?user_id=${user}&kind=app&app_id=pc-app`);
  assert.strictEqual(pol.status, 200);
  assert.strictEqual((await admin.call('/api/admin/calculators/group?user_id=abc')).status, 400);
});
