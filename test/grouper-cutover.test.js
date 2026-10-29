process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const gm = require('../src/group-membership');

seedAdmin();
const mkUser = (username, employee_id) => Number(db.run(
  'INSERT INTO users (guid, username, password_hash, active, employee_id) VALUES (?,?,?,1,?)',
  newGuid(), username, hashPassword(`${username}-password`), employee_id).lastInsertRowid);
const mkGroup = (name) => Number(db.run('INSERT INTO groups (name) VALUES (?)', name).lastInsertRowid);
const member = (g, u, s = null, e = null) => db.run('INSERT INTO group_members (group_id, user_id, start_at, end_at) VALUES (?,?,?,?)', g, u, s, e);

const alice = mkUser('alice', 'E1'); const bob = mkUser('bob', 'E2'); const carol = mkUser('carol', ''); const dave = mkUser('dave', 'E4');
const clean = mkGroup('org:clean'); member(clean, alice); member(clean, bob);
const flat = mkGroup('flat'); member(flat, bob);
const ops = mkGroup('org:ops'); member(ops, alice);
const eng = mkGroup('org:eng'); member(eng, alice); member(eng, dave, null, 1000); // dave expired
const staff = mkGroup('org:staff'); member(staff, bob);
const both = mkGroup('org:both');
const withCarol = mkGroup('org:withcarol'); member(withCarol, carol);
const clash = mkGroup('clash'); db.run("INSERT INTO groups (name, source) VALUES ('simpleidp:clash', 'grouper')");
db.run('INSERT INTO group_includes VALUES (?,?)', staff, eng);
db.run('INSERT INTO group_composites VALUES (?,?,?,?)', both, 'union', staff, flat);
db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'user', ?, 'update')", staff, bob);
const adminRole = Number(db.run("INSERT INTO roles (key, name) VALUES ('custom-ops', 'Ops')").lastInsertRowid);
db.run('INSERT INTO grouper_role_map (group_name, role_id) VALUES (?, ?)', 'org:ops', adminRole);
const OPTS = { subjectField: 'employee_id' };

/* ---------------------------- Mock Grouper WS ----------------------------- */

const live = new Map(); // grouper group name -> [subject ids]
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.headers.authorization !== `Basic ${Buffer.from('wsuser:pw').toString('base64')}`) { res.writeHead(401); return res.end(); }
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url.replace('/grouper-ws/servicesRest/v2_5_000', '');
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json', 'x-grouper-resultcode': 'SUCCESS', 'x-grouper-success': 'T' }); res.end(JSON.stringify(o)); };
    if (path === '/subjects') {
      return send({ WsGetSubjectsResults: { wsSubjects: body.WsRestGetSubjectsRequest.wsSubjectLookups.map((l) => ({ id: `gid-${l.subjectId}`, sourceId: 'jdbc', resultCode: 'SUCCESS', success: 'T' })) } });
    }
    if (path === '/groups' && body.WsRestGetMembersRequest) {
      return send({ WsGetMembersResults: { results: body.WsRestGetMembersRequest.wsGroupLookups.map((l) => (live.has(l.groupName)
        ? { resultMetadata: { resultCode: 'SUCCESS', success: 'T' }, wsGroup: { name: l.groupName },
          wsSubjects: [{ id: 'GrouperSystem', sourceId: 'g:isa', success: 'T' }, ...live.get(l.groupName).map((id) => ({ id, sourceId: 'jdbc', success: 'T' }))] }
        : { resultMetadata: { resultCode: 'GROUP_NOT_FOUND', success: 'F' } })) } });
    }
    res.writeHead(404); return res.end();
  });
});
let wsBase; let server; let base;
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  wsBase = `http://127.0.0.1:${mock.address().port}/grouper-ws/servicesRest`;
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { mock.close(); server.close(); });

function client() {
  let cookie = ''; let csrf = '';
  const api = async (p, { method = 'GET', body, headers: extra } = {}) => {
    const headers = { cookie, ...extra };
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
const C = '/api/admin/grouper/cutover';
const conn = () => ({ url: wsBase, version: 'v2_5_000', username: 'wsuser', password: 'pw' });
const row = (rows, name) => rows.find((r) => r.name === name);

test('the plan shows renames, structure, roles and conflicts', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const plan = (await admin(`${C}/plan`, { method: 'POST', body: { options: OPTS } })).json;
  const p = (n) => row(plan.groups, n);
  assert.equal(p('flat').grouper_name, 'simpleidp:flat');
  assert.equal(p('flat').renamed, true);
  assert.equal(p('org:clean').renamed, false);
  assert.equal(p('org:staff').nested, 1);
  assert.equal(p('org:staff').effective, 2, 'bob plus alice through eng; expired dave is out');
  assert.equal(p('org:staff').delegations, 1);
  assert.equal(p('org:both').composite, true);
  assert.equal(p('org:ops').carries_role, true);
  assert.match(p('clash').conflict, /already named/);
  assert.ok(plan.groups.every((g) => g.verification === 'unverified'));
});

test('verify compares members with Grouper and flags people who were never pushed', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  live.set('org:clean', ['gid-E1', 'gid-E2']);
  live.set('simpleidp:flat', ['gid-E2']);
  live.set('org:ops', ['gid-E1']);
  live.set('org:eng', ['gid-E1', 'gid-extra']);
  live.set('org:staff', ['gid-E2']); // missing alice (nested)
  live.set('org:withcarol', []);
  // org:both and simpleidp:clash are absent from Grouper.
  const bad = await admin(`${C}/verify`, { method: 'POST', body: { connection: { ...conn(), password: 'no' }, options: OPTS } });
  assert.equal(bad.status, 400);

  const v = await admin(`${C}/verify`, { method: 'POST', body: { connection: conn(), options: OPTS } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const r = (n) => row(v.json.rows, n);
  assert.equal(r('org:clean').status, 'match');
  assert.equal(r('flat').status, 'match');
  assert.equal(r('org:ops').status, 'match');
  assert.equal(r('org:eng').status, 'differs');
  assert.equal(r('org:eng').extraCount, 1);
  assert.deepEqual(r('org:staff').missing, ['alice']);
  assert.equal(r('org:both').status, 'missing');
  assert.equal(r('org:withcarol').status, 'differs');
  assert.deepEqual(r('org:withcarol').unpushed, ['carol']);
  assert.equal(v.json.summary.match, 3);

  const plan = (await admin(`${C}/plan`, { method: 'POST', body: { options: OPTS } })).json;
  assert.equal(row(plan.groups, 'flat').verification, 'match');
  assert.equal(row(plan.groups, 'org:eng').verification, 'differs');
});

test('apply needs confirmation, refuses unverified groups and name clashes, and permissions', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const body = (groupIds, extra = {}) => ({ options: OPTS, groupIds, confirm: true, ...extra });
  assert.equal((await admin(`${C}/apply`, { method: 'POST', body: { options: OPTS, groupIds: [flat] } })).status, 400);
  const unverified = await admin(`${C}/apply`, { method: 'POST', body: body([eng]) });
  assert.equal(unverified.status, 409);
  assert.match(unverified.json.errors[0], /org:eng/);
  const clashed = await admin(`${C}/apply`, { method: 'POST', body: body([clash], { force: true }) });
  assert.equal(clashed.status, 409);
  assert.equal((await admin(`${C}/apply`, { method: 'POST', body: body([999999]) })).status, 400);
  assert.equal(db.get('SELECT source FROM groups WHERE id = ?', eng).source, 'local', 'nothing changed');

  const role = Number(db.run("INSERT INTO roles (key, name) VALUES ('custom-g', 'G')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'grouper.manage')", role);
  const u = mkUser('onlygrouper', 'E8'); db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', u, role);
  const c = client(); await c.login('onlygrouper', 'onlygrouper-password');
  assert.equal((await c(`${C}/plan`, { method: 'POST', body: { options: OPTS } })).status, 403);
});

test('cutover renames, flattens structure, keeps access, pins role members, and SCIM adopts the group', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const before = gm.effectiveGroupsOf(bob).map((g) => g.name);
  assert.ok(before.includes('org:staff') && before.includes('org:both'));

  const res = await admin(`${C}/apply`, { method: 'POST', body: { options: OPTS, groupIds: [flat, ops, staff, both, eng, clean], confirm: true, force: true } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.converted, 6);
  assert.equal(res.json.renamed, 1);
  assert.equal(res.json.pinned, 1, 'the one member of the role-carrying group');

  const g = (id) => db.get('SELECT name, source, external_id FROM groups WHERE id = ?', id);
  assert.deepEqual(g(flat), { name: 'simpleidp:flat', source: 'grouper', external_id: '' });
  // Nesting and the composite were flattened into direct members, so access is unchanged.
  const names = (u) => gm.effectiveGroupsOf(u).map((x) => x.name).sort();
  assert.deepEqual(names(bob), ['org:both', 'org:clean', 'org:staff', 'simpleidp:flat']);
  assert.deepEqual(names(alice), ['org:both', 'org:clean', 'org:eng', 'org:ops', 'org:staff']);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_includes WHERE group_id = ?', staff).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_composites').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_admins WHERE group_id = ?', staff).n, 0);
  // Grouper provides the members now, expired dave is gone, and only the role group's members are pinned.
  const m = (gid) => db.all('SELECT user_id, via_grouper, pinned, start_at, end_at FROM group_members WHERE group_id = ?', gid);
  assert.ok(m(staff).every((x) => x.via_grouper === 1 && x.pinned === 0 && x.start_at === null));
  assert.deepEqual(m(eng).map((x) => x.user_id), [alice]);
  assert.deepEqual(m(ops).map((x) => [x.user_id, x.pinned]), [[alice, 1]]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM group_audit WHERE action = 'cutover'").n, 6);

  // Grouper's provisioner finds the renamed group by name and takes it over, keeping its id.
  const token = (await admin('/api/admin/grouper/token', { method: 'POST' })).json.token;
  await admin('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf' } });
  const scim = await fetch(`${base}/scim/v2/Groups`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
    body: JSON.stringify({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'simpleidp:flat', externalId: 'uuid-flat', members: [{ value: db.get('SELECT guid FROM users WHERE id = ?', bob).guid }] }),
  });
  assert.equal(scim.status, 201);
  assert.equal((await scim.json()).id, String(flat));
  assert.equal(db.get('SELECT external_id FROM groups WHERE id = ?', flat).external_id, 'uuid-flat');
});

test('revert restores names, structure and windows, and skips groups that changed', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const history = (await admin(`${C}/history`)).json;
  assert.equal(history.length, 1);
  assert.equal(history[0].groups, 6);
  assert.equal((await admin(`${C}/history/${history[0].id}/revert`, { method: 'POST', body: {} })).status, 400, 'needs confirm');

  // One group is renamed meanwhile, so it cannot be restored safely.
  db.run("UPDATE groups SET source = 'local' WHERE id = ?", clean);
  const r = await admin(`${C}/history/${history[0].id}/revert`, { method: 'POST', body: { confirm: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.reverted, 5);
  assert.deepEqual(r.json.skipped.map((s) => s.name), ['org:clean']);

  assert.equal(db.get('SELECT name FROM groups WHERE id = ?', flat).name, 'flat');
  assert.equal(db.get('SELECT source FROM groups WHERE id = ?', flat).source, 'local');
  assert.deepEqual(db.all('SELECT member_group_id FROM group_includes WHERE group_id = ?', staff).map((x) => x.member_group_id), [eng]);
  assert.equal(db.get('SELECT op FROM group_composites WHERE group_id = ?', both).op, 'union');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_admins WHERE group_id = ?', staff).n, 1);
  // Materialized members are gone again; dave's expired membership is back with its window.
  assert.deepEqual(db.all('SELECT user_id FROM group_members WHERE group_id = ?', staff).map((x) => x.user_id), [bob]);
  assert.deepEqual(db.all('SELECT user_id, end_at FROM group_members WHERE group_id = ? ORDER BY user_id', eng).map((x) => [x.user_id, x.end_at]), [[alice, null], [dave, 1000]]);
  assert.deepEqual(db.all('SELECT pinned, via_grouper FROM group_members WHERE group_id = ?', ops), [{ pinned: 0, via_grouper: 0 }]);
  assert.deepEqual(gm.effectiveGroupsOf(bob).map((g) => g.name).sort(), ['flat', 'org:both', 'org:clean', 'org:staff']);

  assert.equal((await admin(`${C}/history/${history[0].id}/revert`, { method: 'POST', body: { confirm: true } })).status, 409, 'only once');
});
