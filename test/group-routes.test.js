process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const sps = require('../src/sps');

seedAdmin();
const mkUser = (n) => Number(db.run('INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,1)',
  newGuid(), n, hashPassword('pw-' + n)).lastInsertRowid);
const [alice, bob, carol] = ['alice', 'bob', 'carol'].map(mkUser);

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

let cookie = ''; let csrf = '';
async function api(path, { method = 'GET', body } = {}) {
  const headers = { cookie };
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
const group = async (name) => (await api('/api/admin/groups', { method: 'POST', body: { name, description: 'Test group' } })).json.group.id;

test.before(async () => {
  csrf = (await api('/api/session')).json.csrf;
  const r = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  assert.equal(r.status, 200);
  csrf = (await api('/api/session')).json.csrf;
});

test('nested groups give indirect members and counts', async () => {
  const eng = await group('eng'); const staff = await group('staff');
  await api(`/api/admin/groups/${eng}/members`, { method: 'POST', body: { user_ids: [alice] } });
  const r = await api(`/api/admin/groups/${staff}/includes`, { method: 'POST', body: { group_id: eng } });
  assert.equal(r.status, 200);
  assert.equal(r.json.effective_count, 1);
  assert.equal(r.json.includes[0].name, 'eng');
  const eff = (await api(`/api/admin/groups/${staff}/effective-members`)).json;
  assert.deepEqual(eff.map((u) => [u.username, u.direct]), [['alice', false]]);
  const list = (await api('/api/admin/groups')).json.find((g) => g.id === staff);
  assert.equal(list.member_count, 0);
  assert.equal(list.effective_count, 1);

  // A loop is refused, and removing the nesting removes the indirect member.
  const loop = await api(`/api/admin/groups/${eng}/includes`, { method: 'POST', body: { group_id: staff } });
  assert.equal(loop.status, 400);
  const rm = await api(`/api/admin/groups/${staff}/includes/${eng}`, { method: 'DELETE' });
  assert.equal(rm.json.effective_count, 0);
});

test('indirect membership grants SP access', async () => {
  const eng = await group('eng2'); const apps = await group('apps');
  await api(`/api/admin/groups/${eng}/members`, { method: 'POST', body: { user_ids: [bob] } });
  await api(`/api/admin/groups/${apps}/includes`, { method: 'POST', body: { group_id: eng } });
  const sp = { id: 'sp1', access_mode: 'groups' };
  db.run("INSERT INTO service_providers (id, name, sp_entity_id, access_mode, private_key_pem, cert_pem) VALUES ('sp1','SP','urn:sp1','groups','k','c')");
  db.run('INSERT INTO sp_access_groups (sp_id, group_id) VALUES (?, ?)', 'sp1', apps);
  assert.equal(sps.userHasAccess(sp, bob), true);
  assert.equal(sps.userHasAccess(sp, carol), false);
});

test('composites validate and compute', async () => {
  const a = await group('ca'); const b = await group('cb'); const c = await group('cc');
  await api(`/api/admin/groups/${a}/members`, { method: 'POST', body: { user_ids: [alice, bob] } });
  await api(`/api/admin/groups/${b}/members`, { method: 'POST', body: { user_ids: [bob] } });
  assert.equal((await api(`/api/admin/groups/${c}/composite`, { method: 'PUT', body: { op: 'nope', left_id: a, right_id: b } })).status, 400);
  assert.equal((await api(`/api/admin/groups/${c}/composite`, { method: 'PUT', body: { op: 'minus', left_id: a, right_id: a } })).status, 400);
  const ok = await api(`/api/admin/groups/${c}/composite`, { method: 'PUT', body: { op: 'minus', left_id: a, right_id: b } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.composite.op, 'minus');
  const eff = (await api(`/api/admin/groups/${c}/effective-members`)).json;
  assert.deepEqual(eff.map((u) => u.username), ['alice']);
  // Composites take no direct members or nested groups.
  assert.equal((await api(`/api/admin/groups/${c}/members`, { method: 'POST', body: { user_ids: [carol] } })).status, 400);
  assert.equal((await api(`/api/admin/groups/${c}/includes`, { method: 'POST', body: { group_id: b } })).status, 409);
  // A composite cannot use itself (via another composite) as a factor.
  const d = await group('cd');
  assert.equal((await api(`/api/admin/groups/${a}/composite`, { method: 'PUT', body: { op: 'union', left_id: c, right_id: d } })).status, 409);
  assert.equal((await api(`/api/admin/groups/${c}/composite`, { method: 'DELETE' })).json.composite, null);
});

test('membership windows are validated and applied', async () => {
  const g = await group('windowed');
  await api(`/api/admin/groups/${g}/members`, { method: 'POST', body: { user_ids: [carol] } });
  const past = Math.floor(Date.now() / 1000) - 60;
  assert.equal((await api(`/api/admin/groups/${g}/members/${carol}/window`, { method: 'PUT', body: { start_at: 'garbage' } })).status, 400);
  assert.equal((await api(`/api/admin/groups/${g}/members/${carol}/window`, { method: 'PUT', body: { start_at: past, end_at: past - 10 } })).status, 400);
  assert.equal((await api(`/api/admin/groups/${g}/members/${alice}/window`, { method: 'PUT', body: { end_at: past } })).status, 404);
  const ok = await api(`/api/admin/groups/${g}/members/${carol}/window`, { method: 'PUT', body: { end_at: past } });
  assert.equal(ok.status, 200);
  assert.equal((await api(`/api/admin/groups/${g}/effective-members`)).json.length, 0, 'expired member drops out');
});

test('external groups cannot be restructured; the audit trail records changes', async () => {
  const ext = Number(db.run("INSERT INTO groups (name, source) VALUES ('ref:ext', 'grouper')").lastInsertRowid);
  const loc = await group('local-parent');
  assert.equal((await api(`/api/admin/groups/${ext}/includes`, { method: 'POST', body: { group_id: loc } })).status, 409);
  // ...but can be nested into a local group.
  assert.equal((await api(`/api/admin/groups/${loc}/includes`, { method: 'POST', body: { group_id: ext } })).status, 200);

  const audit = (await api(`/api/admin/groups/${loc}/audit`)).json;
  // The base's include and exclude groups are made with it, and are logged on the base.
  assert.deepEqual(audit.map((e) => e.action), ['include.add', 'include-exclude.create', 'group.create']);
  assert.equal(audit[0].actor, 'admin');
  await api(`/api/admin/groups/${loc}`, { method: 'DELETE' });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM group_audit WHERE group_name = 'local-parent'").n, 4);
});

test('a new group can start with direct members and a query, and a bad query saves nothing', async () => {
  const bad = await api('/api/admin/groups', { method: 'POST', body: { name: 'bad-query', description: 'Test group', rule: { filter: '(shoeSize=9)', mode: 'ongoing' } } });
  assert.equal(bad.status, 400);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE name = 'bad-query'").n, 0);

  const made = await api('/api/admin/groups', { method: 'POST', body: { name: 'starter', description: 'Test group', user_ids: [bob], rule: { filter: '(uid=carol)', mode: 'ongoing' } } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.members.map((m) => [m.username, m.via_rule]), [['bob', 0], ['carol', 1]]);
  assert.equal(made.json.ran.added, 1);
  const rule = (await api(`/api/admin/groups/${made.json.group.id}/rule`)).json.rule;
  assert.equal(rule.mode, 'ongoing');
});

test('a new group can be formed as a composite of two groups, and invalid composites save nothing', async () => {
  const left = await group('comp-left'); const right = await group('comp-right');
  await api(`/api/admin/groups/${left}/members`, { method: 'POST', body: { user_ids: [alice, bob] } });
  await api(`/api/admin/groups/${right}/members`, { method: 'POST', body: { user_ids: [bob, carol] } });

  const extra = await api('/api/admin/groups', { method: 'POST', body: { name: 'comp-extra', description: 'Test group', user_ids: [alice], composite: { op: 'union', left_id: left, right_id: right } } });
  assert.equal(extra.status, 400);
  const badOp = await api('/api/admin/groups', { method: 'POST', body: { name: 'comp-op', description: 'Test group', composite: { op: 'nope', left_id: left, right_id: right } } });
  assert.equal(badOp.status, 400);
  const same = await api('/api/admin/groups', { method: 'POST', body: { name: 'comp-same', description: 'Test group', composite: { op: 'union', left_id: left, right_id: left } } });
  assert.equal(same.status, 400);
  const missing = await api('/api/admin/groups', { method: 'POST', body: { name: 'comp-missing', description: 'Test group', composite: { op: 'union', left_id: 99999, right_id: right } } });
  assert.equal(missing.status, 400);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE name LIKE 'comp-%' AND name NOT IN ('comp-left', 'comp-right') AND name NOT LIKE '%:include' AND name NOT LIKE '%:exclude'").n, 0);

  const made = await api('/api/admin/groups', { method: 'POST', body: { name: 'comp-minus', description: 'Test group', composite: { op: 'minus', left_id: left, right_id: right } } });
  assert.equal(made.status, 201);
  assert.deepEqual(db.get('SELECT op, left_id, right_id FROM group_composites WHERE group_id = ?', made.json.group.id), { op: 'minus', left_id: left, right_id: right });
  const eff = (await api(`/api/admin/groups/${made.json.group.id}/effective-members`)).json;
  assert.deepEqual(eff.map((u) => u.username), ['alice']);
});

test('a group that already depends on this one is not offered as a member, and adding it says why', async () => {
  const outer = await group('outer-loop'); const inner = await group('inner-loop');
  assert.equal((await api(`/api/admin/groups/${outer}/includes`, { method: 'POST', body: { group_id: inner } })).status, 200);
  const s = await api(`/api/admin/groups/${inner}/structure`);
  assert.ok(s.json.would_loop.includes(outer));
  const r = await api(`/api/admin/groups/${inner}/includes`, { method: 'POST', body: { group_id: outer } });
  assert.equal(r.status, 400);
  assert.match(r.json.errors[0], /"outer-loop" already depends on "inner-loop", so adding it as a member would make a loop/);
});
