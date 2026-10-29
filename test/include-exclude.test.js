process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const gm = require('../src/group-membership');
const ie = require('../src/group-include-exclude');
const { pipelineOf, rolesOf } = require('../src/group-pipeline');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

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
const makeGroup = async (name, extra = {}) => api('/api/admin/groups', { method: 'POST', body: { name, description: 'Test group', ...extra } });
const idOf = (name) => db.get('SELECT id FROM groups WHERE name = ?', name).id;
const effective = async (id) => (await api(`/api/admin/groups/${id}/effective-members`)).json.map((u) => u.username).sort();

test.before(async () => {
  csrf = (await api('/api/session')).json.csrf;
  const r = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  assert.equal(r.status, 200);
  csrf = (await api('/api/session')).json.csrf;
});

test('every new group is made with include and exclude groups, named after it', async () => {
  const made = await makeGroup('staff');
  assert.equal(made.status, 201);
  const pair = made.json.include_exclude;
  assert.deepEqual([pair.include.name, pair.exclude.name], ['staff:include', 'staff:exclude']);

  // The include group's members are members of staff; the exclude group's are not, even when they are direct members.
  const id = made.json.group.id;
  await api(`/api/admin/groups/${id}/members`, { method: 'POST', body: { user_ids: [bob, carol] } });
  await api(`/api/admin/groups/${pair.include.id}/members`, { method: 'POST', body: { user_ids: [alice] } });
  await api(`/api/admin/groups/${pair.exclude.id}/members`, { method: 'POST', body: { user_ids: [carol] } });
  assert.deepEqual(await effective(id), ['alice', 'bob']);
  assert.deepEqual(gm.membershipsOf(alice).find((g) => g.id === id).via.map((v) => v.name), ['staff:include']);
  assert.equal(gm.membershipsOf(carol).some((g) => g.id === id), false);
  assert.equal(gm.explainMembers(id).has(carol), false);
});

test('a group made before pairs existed gets them at startup, and pair groups get none of their own', async () => {
  const old = Number(db.run("INSERT INTO groups (name, description) VALUES ('legacy', 'Made before')").lastInsertRowid);
  assert.equal(ie.pairOf(old), null);
  const skipped = ie.ensureAll();
  assert.deepEqual(skipped, []);
  assert.ok(ie.pairOf(old));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE name LIKE 'legacy:%:%'").n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE name = 'legacy:include:include'").n, 0);
  // A second run finds nothing to do.
  ie.ensureAll();
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE name LIKE 'legacy:%'").n, 2);
});

test('a name whose include or exclude group name is taken is refused, and a legacy group with a clash is reported', async () => {
  db.run("INSERT INTO groups (name, description) VALUES ('offices:exclude', 'Taken')");
  const clash = await makeGroup('offices');
  assert.equal(clash.status, 409);
  assert.match(clash.json.errors[0], /offices:exclude already exists/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE name = 'offices'").n, 0);

  const legacy = Number(db.run("INSERT INTO groups (name, description) VALUES ('labs', 'Legacy')").lastInsertRowid);
  db.run("INSERT INTO groups (name, description) VALUES ('labs:include', 'Taken')");
  assert.deepEqual(ie.ensureAll(), ['labs']);
  assert.equal(ie.pairOf(legacy), null);
});

test('names follow the rules: a description is optional, and reserved suffixes and multi-line names are refused', async () => {
  const noDescription = await api('/api/admin/groups', { method: 'POST', body: { name: 'undescribed' } });
  assert.equal(noDescription.status, 201);
  const reserved = await makeGroup('hand-made:include');
  assert.equal(reserved.status, 400);
  assert.match(reserved.json.errors.join(' '), /reserved/);
  const multiline = await makeGroup('two\nlines');
  assert.equal(multiline.status, 400);
});

test('renaming a group renames its include and exclude groups; a taken name is refused', async () => {
  const made = await makeGroup('depts');
  const id = made.json.group.id;
  assert.equal((await api(`/api/admin/groups/${id}`, { method: 'PUT', body: { name: 'departments', description: 'Test group' } })).status, 200);
  assert.ok(db.get("SELECT 1 FROM groups WHERE name = 'departments:include'"));
  assert.ok(db.get("SELECT 1 FROM groups WHERE name = 'departments:exclude'"));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM groups WHERE name LIKE 'depts:%'").n, 0);
  // A pair group's own description can be edited, though its name is reserved.
  const inc = idOf('departments:include');
  assert.equal((await api(`/api/admin/groups/${inc}`, { method: 'PUT', body: { name: 'departments:include', description: 'Members added by hand' } })).status, 200);
});

test('include and exclude groups cannot be deleted alone; deleting the base removes them', async () => {
  const made = await makeGroup('clubs');
  const { include, exclude } = made.json.include_exclude;
  const alone = await api(`/api/admin/groups/${include.id}`, { method: 'DELETE' });
  assert.equal(alone.status, 409);
  assert.match(alone.json.errors[0], /Delete clubs/);
  assert.equal((await api(`/api/admin/groups/${made.json.group.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM groups WHERE id IN (?, ?)', include.id, exclude.id).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_include_exclude WHERE include_id = ? OR exclude_id = ?', include.id, exclude.id).n, 0);
});

test('a pair cannot make a loop: a group nested under the include group is refused', async () => {
  const x = await makeGroup('loopy');
  const inc = x.json.include_exclude.include.id;
  const y = await makeGroup('loopy-parent');
  await api(`/api/admin/groups/${y.json.group.id}/includes`, { method: 'POST', body: { group_id: x.json.group.id } });
  const loop = await api(`/api/admin/groups/${inc}/includes`, { method: 'POST', body: { group_id: y.json.group.id } });
  assert.equal(loop.status, 400);
});

test('roles: basis feeds, reference feeds and is fed, application is fed by nothing else', async () => {
  const src = await makeGroup('roles-src');
  const mid = await makeGroup('roles-mid');
  const top = await makeGroup('roles-top');
  await api(`/api/admin/groups/${mid.json.group.id}/includes`, { method: 'POST', body: { group_id: src.json.group.id } });
  await api(`/api/admin/groups/${top.json.group.id}/includes`, { method: 'POST', body: { group_id: mid.json.group.id } });
  const roles = rolesOf();
  assert.equal(roles.get(src.json.include_exclude.include.id), 'basis');
  assert.equal(roles.get(src.json.group.id), 'reference');
  assert.equal(roles.get(mid.json.group.id), 'reference');
  assert.equal(roles.get(top.json.group.id), 'application');
  const roleOf = (await api(`/api/admin/groups/${mid.json.group.id}`)).json.role;
  assert.equal(roleOf, 'reference');
  const list = (await api('/api/admin/groups')).json.find((g) => g.name === 'roles-top');
  assert.equal(list.role, 'application');
});

test('the pipeline runs basis groups first, then references, and the group last', async () => {
  const top = idOf('roles-top');
  const pipe = pipelineOf(top);
  const names = pipe.steps.map((s) => s.name);
  assert.equal(names[names.length - 1], 'roles-top');
  assert.ok(names.indexOf('roles-src:include') < names.indexOf('roles-src'));
  assert.ok(names.indexOf('roles-src') < names.indexOf('roles-mid'));
  assert.ok(names.indexOf('roles-mid') < names.indexOf('roles-top'));
  const last = pipe.steps[pipe.steps.length - 1];
  assert.equal(last.count, gm.effectiveMembers(top).size);
  assert.ok(last.inputs.some((i) => i.relation === 'nested' && i.group.name === 'roles-mid'));
  assert.ok(last.inputs.some((i) => i.relation === 'include' && i.group.name === 'roles-top:include'));
  // An include group says which group it serves, so it needs no pair of its own.
  assert.deepEqual(pipelineOf(idOf('roles-top:include')).part_of, { id: top, name: 'roles-top', kind: 'include' });
  assert.equal(pipelineOf(top).part_of, null);
});

test('an access grant to a basis group is refused; a reference group is accepted', () => {
  const sps = require('../src/sps');
  const basisId = idOf('roles-src:include');
  const refId = idOf('roles-src');
  const refused = sps.parseForm({ access_groups: [String(basisId)] }, { draft: true });
  assert.match(refused.errors.join(' '), /roles-src:include is a basis group/);
  const allowed = sps.parseForm({ access_groups: [String(refId)] }, { draft: true });
  assert.equal(allowed.errors.filter((e) => /basis group/.test(e)).length, 0);
});
