process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const gm = require('../src/group-membership');
const { expireMemberships, startExpiryJob } = require('../src/group-expiry');
const { buildModel, toGsh } = require('../src/grouper-export');
const push = require('../src/grouper-push');
const cutover = require('../src/grouper-cutover');

seedAdmin();
const mkUser = (username, employee_id = '') => Number(db.run(
  'INSERT INTO users (guid, username, password_hash, active, employee_id) VALUES (?,?,?,1,?)',
  newGuid(), username, hashPassword(`${username}-password`), employee_id).lastInsertRowid);
const mkGroup = (name, source = 'local') => Number(db.run('INSERT INTO groups (name, source) VALUES (?, ?)', name, source).lastInsertRowid);
const grant = (g, type, id, privilege) => db.run('INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?,?,?,?)', g, type, id, privilege);
const NOW = Math.floor(Date.now() / 1000);

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
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  api.login = async (u, pw) => {
    csrf = (await api('/api/session')).json.csrf;
    await api('/api/login', { method: 'POST', body: { username: u, password: pw } });
    csrf = (await api('/api/session')).json.csrf;
  };
  return api;
}

/* ------------------------------- Migration -------------------------------- */

const OLD_TABLE = (types, privs) => `
CREATE TABLE group_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN (${types})),
  subject_id INTEGER NOT NULL,
  privilege TEXT NOT NULL CHECK (privilege IN (${privs})),
  UNIQUE (group_id, subject_type, subject_id, privilege)
);`;
const TRIGGERS = `
CREATE TRIGGER group_admins_user_deleted AFTER DELETE ON users BEGIN DELETE FROM group_admins WHERE subject_type = 'user' AND subject_id = OLD.id; END;
CREATE TRIGGER group_admins_group_deleted AFTER DELETE ON groups BEGIN DELETE FROM group_admins WHERE subject_type = 'group' AND subject_id = OLD.id; END;`;

for (const [label, types, privs] of [
  ['the first release (four privileges)', "'user', 'group'", "'admin', 'update', 'read', 'view'"],
  ['the intermediate release (opt in/out, no everyone)', "'user', 'group'", "'admin', 'update', 'read', 'view', 'optin', 'optout'"],
]) {
  test(`an existing database from ${label} is upgraded in place`, () => {
    const g = mkGroup(`mig-${privs.length}`); const u = mkUser(`miguser-${privs.length}`);
    db.db.exec(`DROP TRIGGER group_admins_user_deleted; DROP TRIGGER group_admins_group_deleted; DROP TABLE group_admins; ${OLD_TABLE(types, privs)} ${TRIGGERS}`);
    grant(g, 'user', u, 'update');
    grant(g, 'group', g, 'read');
    assert.throws(() => grant(g, 'everyone', 0, 'optin'));

    assert.equal(db.migrateGroupAdmins(), true);
    assert.deepEqual(db.all('SELECT subject_type, privilege FROM group_admins ORDER BY id').map((r) => `${r.subject_type}:${r.privilege}`), ['user:update', 'group:read']);
    grant(g, 'everyone', 0, 'optin');
    assert.throws(() => grant(g, 'everyone', 0, 'admin'), 'everyone is limited to self-service');
    assert.equal(db.migrateGroupAdmins(), false, 'running again changes nothing');

    // The cleanup triggers survived the rebuild.
    db.run('DELETE FROM users WHERE id = ?', u);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM group_admins WHERE subject_type = 'user'").n, 0);
    db.run('DELETE FROM groups WHERE id = ?', g);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM group_admins WHERE group_id = ?', g).n, 0);
  });
}

/* --------------------------------- Expiry --------------------------------- */

test('the expiry job audits and removes lapsed memberships once, and only in local groups', () => {
  const g = mkGroup('exp'); const ext = mkGroup('ref:exp', 'grouper');
  const [gone, open, future, current] = ['e-gone', 'e-open', 'e-future', 'e-current'].map((n) => mkUser(n));
  const add = (gid, uid, s, e) => db.run('INSERT INTO group_members (group_id, user_id, start_at, end_at) VALUES (?,?,?,?)', gid, uid, s, e);
  add(g, gone, null, NOW - 10); add(g, open, null, null); add(g, future, NOW + 3600, NOW + 7200); add(g, current, null, NOW + 3600);
  add(ext, gone, null, NOW - 10);

  assert.equal(expireMemberships(NOW), 1);
  assert.deepEqual(db.all('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY user_id', g).map((r) => r.user_id), [open, future, current]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', ext).n, 1, 'Grouper groups are left alone');
  const log = db.all("SELECT actor, action, detail FROM group_audit WHERE group_id = ?", g);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].actor, log[0].action], ['system', 'member.expire']);
  assert.match(log[0].detail, /^e-gone \(ended \d{4}-\d\d-\d\dT/);
  assert.equal(expireMemberships(NOW), 0, 'a second run finds nothing, so nothing is audited twice');
  assert.equal(expireMemberships(NOW + 7300), 2, 'later, the others lapse too');
});

test('the job runs once at start and can be stopped', () => {
  const g = mkGroup('exp-start'); const u = mkUser('e-start');
  db.run('INSERT INTO group_members (group_id, user_id, end_at) VALUES (?,?,?)', g, u, NOW - 5);
  const logs = [];
  const stop = startExpiryJob({ intervalMs: 3600 * 1000, log: { log: (m) => logs.push(m), error: (m) => logs.push(m) } });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', g).n, 0);
  assert.deepEqual(logs, ['Expired 1 group membership.']);
  stop();
});

/* ----------------------- Re-adding and editing members --------------------- */

test('re-adding a lapsed member renews them; a current member keeps their end date', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const g = mkGroup('renew'); const lapsed = mkUser('r-lapsed'); const current = mkUser('r-current');
  db.run('INSERT INTO group_members (group_id, user_id, end_at) VALUES (?,?,?)', g, lapsed, NOW - 60);
  db.run('INSERT INTO group_members (group_id, user_id, end_at) VALUES (?,?,?)', g, current, NOW + 3600);
  assert.equal((await admin(`/api/admin/groups/${g}/members`, { method: 'POST', body: { user_ids: [lapsed, current] } })).status, 200);
  const row = (u) => db.get('SELECT start_at, end_at FROM group_members WHERE group_id = ? AND user_id = ?', g, u);
  assert.deepEqual(row(lapsed), { start_at: null, end_at: null });
  assert.equal(row(current).end_at, NOW + 3600);
  assert.ok(gm.effectiveMembers(g).has(lapsed));
});

test('saving a user in the console keeps their membership dates and skips composite groups', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const a = mkGroup('keep-a'); const b = mkGroup('keep-b'); const comp = mkGroup('keep-comp');
  db.run('INSERT INTO group_composites VALUES (?,?,?,?)', comp, 'union', a, b);
  const u = mkUser('keeper');
  db.run('INSERT INTO group_members (group_id, user_id, end_at) VALUES (?,?,?)', a, u, NOW + 5000);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', b, u);
  const detail = (await admin(`/api/admin/users/${u}`)).json;
  const res = await admin(`/api/admin/users/${u}`, { method: 'PUT', body: { ...detail, group_ids: [a, comp] } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const rows = db.all('SELECT group_id, end_at FROM group_members WHERE user_id = ? ORDER BY group_id', u);
  assert.deepEqual(rows, [{ group_id: a, end_at: NOW + 5000 }], 'dated membership kept, b removed, composite not given a direct member');
});

/* ------------------------------- Self-service ------------------------------ */

test('self-service: joining and leaving, by grant to everyone, a group or a person', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const open = mkGroup('club'); const staffOnly = mkGroup('staff-club'); const personal = mkGroup('just-ann'); const leaveOnly = mkGroup('leave-only');
  const staff = mkGroup('staff');
  const ann = mkUser('ann'); const ben = mkUser('ben');
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', staff, ann);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', leaveOnly, ben);

  // Granting goes through the console like any other privilege, and is audited.
  assert.equal((await admin(`/api/admin/groups/${open}/admins`, { method: 'POST', body: { subject_type: 'everyone', subject_id: 0, privilege: 'optin' } })).status, 201);
  await admin(`/api/admin/groups/${open}/admins`, { method: 'POST', body: { subject_type: 'everyone', privilege: 'optout' } });
  await admin(`/api/admin/groups/${staffOnly}/admins`, { method: 'POST', body: { subject_type: 'group', subject_id: staff, privilege: 'optin' } });
  await admin(`/api/admin/groups/${personal}/admins`, { method: 'POST', body: { subject_type: 'user', subject_id: ann, privilege: 'optin' } });
  await admin(`/api/admin/groups/${leaveOnly}/admins`, { method: 'POST', body: { subject_type: 'everyone', privilege: 'optout' } });
  assert.equal((await admin(`/api/admin/groups/${open}/admins`, { method: 'POST', body: { subject_type: 'everyone', privilege: 'admin' } })).status, 400);
  const rows = (await admin(`/api/admin/groups/${open}/admins`)).json;
  assert.deepEqual(rows.map((r) => [r.subject_type, r.subject_name, r.privilege]), [['everyone', 'Everyone', 'optin'], ['everyone', 'Everyone', 'optout']]);

  const annC = client(); await annC.login('ann', 'ann-password');
  const benC = client(); await benC.login('ben', 'ben-password');
  const names = async (c) => (await c('/api/my/groups/available')).json.map((g) => g.name);
  assert.deepEqual(await names(annC), ['club', 'just-ann', 'staff-club']);
  assert.deepEqual(await names(benC), ['club', 'leave-only'], 'ben is not staff, and leave-only shows because he is in it');
  assert.equal((await annC('/api/session')).json.me.self_service, true);

  const joined = await annC(`/api/my/groups/${open}/join`, { method: 'POST' });
  assert.equal(joined.status, 200);
  assert.deepEqual([joined.json.member, joined.json.direct, joined.json.can_join, joined.json.can_leave], [true, true, false, true]);
  assert.ok(gm.effectiveMembers(open).has(ann));
  assert.equal((await annC(`/api/my/groups/${open}/join`, { method: 'POST' })).status, 409, 'already a member');

  // No grant, no joining; a group grant needs membership of that group; leaving needs an optout grant.
  assert.equal((await benC(`/api/my/groups/${staffOnly}/join`, { method: 'POST' })).status, 403);
  assert.equal((await benC(`/api/my/groups/${personal}/join`, { method: 'POST' })).status, 403);
  assert.equal((await annC(`/api/my/groups/${personal}/leave`, { method: 'POST' })).status, 403);
  assert.equal((await benC(`/api/my/groups/${leaveOnly}/join`, { method: 'POST' })).status, 403, 'optout alone does not allow joining');
  assert.equal((await benC(`/api/my/groups/${leaveOnly}/leave`, { method: 'POST' })).status, 200);
  assert.ok(!gm.effectiveMembers(leaveOnly).has(ben));
  assert.equal((await benC(`/api/my/groups/${leaveOnly}/leave`, { method: 'POST' })).status, 409);
  assert.deepEqual(await names(benC), ['club'], 'no longer listed once out and unable to rejoin');

  const log = db.all("SELECT actor, action, detail FROM group_audit WHERE group_name = 'club' AND action LIKE 'member.%'");
  assert.deepEqual(log.map((l) => [l.actor, l.action, l.detail]), [['ann', 'member.join', '']]);
  assert.ok(db.all("SELECT detail FROM group_audit WHERE action = 'admin.grant' AND group_name = 'club'").every((l) => l.detail.endsWith('to everyone')));

  // Revoking the grant closes the door at once.
  const optin = rows.find((r) => r.privilege === 'optin');
  await admin(`/api/admin/groups/${open}/admins/${optin.id}`, { method: 'DELETE' });
  assert.equal((await benC(`/api/my/groups/${open}/join`, { method: 'POST' })).status, 403);
});

test('self-service skips composite, external and still-nested cases and never lends management rights', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const a = mkGroup('ss-a'); const b = mkGroup('ss-b'); const comp = mkGroup('ss-comp'); const ext = mkGroup('ref:ss', 'grouper');
  db.run('INSERT INTO group_composites VALUES (?,?,?,?)', comp, 'union', a, b);
  for (const g of [a, comp, ext]) grant(g, 'everyone', 0, 'optin');
  grant(a, 'everyone', 0, 'optout');
  const cat = mkUser('cat'); const parent = mkGroup('ss-parent');
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', parent, cat);
  db.run('INSERT INTO group_includes VALUES (?,?)', a, parent); // cat is in a through parent
  const c = client(); await c.login('cat', 'cat-password');

  const list = (await c('/api/my/groups/available')).json;
  assert.deepEqual(list.map((g) => g.name), ['ss-a'], 'composite and Grouper groups are not offered');
  assert.deepEqual([list[0].member, list[0].direct, list[0].can_join, list[0].can_leave], [true, false, true, false]);
  assert.equal((await c(`/api/my/groups/${comp}/join`, { method: 'POST' })).status, 403);
  assert.equal((await c(`/api/my/groups/${ext}/join`, { method: 'POST' })).status, 403);
  assert.equal((await c(`/api/my/groups/${a}/leave`, { method: 'POST' })).status, 409, 'only a direct membership can be left');
  assert.equal((await c('/api/my/groups')).json.length, 0, 'opt-in grants do not make someone a manager');
  assert.equal((await c(`/api/my/groups/${a}/structure`)).status, 404);
  assert.equal((await c('/api/session')).json.me.manages_groups, false);

  // A lapsed row does not block rejoining.
  db.run('INSERT INTO group_members (group_id, user_id, end_at) VALUES (?,?,?)', b, cat, NOW - 1);
  grant(b, 'user', cat, 'optin');
  assert.equal((await c(`/api/my/groups/${b}/join`, { method: 'POST' })).status, 200);
  assert.equal(db.get('SELECT end_at FROM group_members WHERE group_id = ? AND user_id = ?', b, cat).end_at, null);
});

/* ----------------------- Export, push and cutover -------------------------- */

test('opt-in and opt-out grants to everyone carry into the export, the push and a cutover revert', async () => {
  const g = mkGroup('exp:club'); const u = mkUser('xu', 'X1');
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', g, u);
  grant(g, 'everyone', 0, 'optin'); grant(g, 'user', u, 'optout');
  const model = buildModel({ subjectField: 'employee_id' });
  const privs = model.privileges.filter((p) => p.group === 'exp:club').map((p) => [p.subject_type, p.subject, p.grouper_privilege]);
  assert.deepEqual(privs, [['everyone', 'GrouperAll', 'OPTIN'], ['user', 'X1', 'OPTOUT']]);
  const gsh = toGsh(model);
  assert.ok(gsh.includes("grp('exp:club').grantPriv(s, AccessPrivilege.OPTIN, false)"));
  assert.ok(gsh.includes('s = SubjectFinder.findAllSubject();'));

  const calls = [];
  const ws = {
    saveGroups: async (gs) => gs.map((x) => ({ ok: true, code: 'SUCCESS_INSERT', uuid: `u-${x.name}` })),
    addMembers: async (_, l) => l.map(() => ({ ok: true, code: 'SUCCESS' })),
    assignPrivileges: async (group, lookups, names) => { calls.push({ group, lookups, names }); return { ok: true, code: 'SUCCESS' }; },
  };
  await push.run(ws, model, {});
  const forClub = calls.filter((c) => c.group === 'exp:club');
  assert.deepEqual(forClub.find((c) => c.names[0] === 'optin').lookups, [{ subjectSourceId: 'g:isa', subjectId: 'GrouperAll' }]);
  assert.equal(forClub.find((c) => c.names[0] === 'optout').lookups[0].subjectId, 'X1');

  // Handing the group to Grouper drops the grants (Grouper owns them); reverting brings them back.
  const plan = cutover.buildPlan({ subjectField: 'employee_id' });
  const applied = cutover.apply({ groupIds: [g], exportOptions: { subjectField: 'employee_id' }, actor: 'admin', force: true });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_admins WHERE group_id = ?', g).n, 0);
  cutover.revert(applied.id, 'admin');
  assert.deepEqual(db.all('SELECT subject_type, subject_id, privilege FROM group_admins WHERE group_id = ? ORDER BY id', g),
    [{ subject_type: 'everyone', subject_id: 0, privilege: 'optin' }, { subject_type: 'user', subject_id: u, privilege: 'optout' }]);
  assert.ok(plan.groups.some((x) => x.id === g));
});
