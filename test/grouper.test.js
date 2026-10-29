process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const sps = require('../src/sps');
const attrs = require('../src/attributes');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { buildAttributes } = require('../src/saml/response');
const roles = require('../src/roles');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const addUser = (name) => {
  db.run('INSERT INTO users (guid, username, password_hash, email, active) VALUES (?,?,?,?,1)',
    newGuid(), name, hashPassword('password123'), `${name}@example.org`);
  return db.get('SELECT * FROM users WHERE username = ?', name);
};
const alice = addUser('alice');
const bob = addUser('bob');

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function adminApi() {
  let cookie = '';
  const call = async (path, { method = 'GET', body, csrf } = {}) => {
    const headers = { ...(cookie && { cookie }), ...(csrf && { 'x-csrf-token': csrf }) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const first = (await call('/api/session')).json.csrf;
  assert.equal((await call('/api/login', { method: 'POST', csrf: first, body: { username: 'admin', password: 'adminpass123' } })).status, 200);
  const csrf = (await call('/api/session')).json.csrf; // the session is regenerated at sign-in
  return (path, opts = {}) => call(path, { ...opts, csrf });
}

async function scimCall(token, path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/scim+json', ...(token && { authorization: `Bearer ${token}` }) };
  const r = await fetch(`${base}/scim/v2${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null, type: r.headers.get('content-type') };
}

const patch = (ops) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: ops });

let token;
let api;

test('SCIM is closed until an admin enables it with a token', async () => {
  api = await adminApi();
  assert.equal((await scimCall('anything', '/Groups')).status, 403);

  const noToken = await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf' } });
  assert.equal(noToken.status, 400);

  const made = await api('/api/admin/grouper/token', { method: 'POST' });
  token = made.json.token;
  assert.match(token, /^gpt_/);
  assert.equal(made.json.tokenSet, true);
  assert.equal(JSON.stringify(db.get("SELECT value FROM settings WHERE key = 'grouper'")).includes(token), false, 'token is stored hashed');

  const on = await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf' } });
  assert.equal(on.status, 200);
  assert.equal(on.json.token, undefined);

  assert.equal((await scimCall(null, '/Groups')).status, 401);
  assert.equal((await scimCall('wrong', '/Groups')).status, 401);
  const ok = await scimCall(token, '/Groups');
  assert.equal(ok.status, 200);
  assert.match(ok.type, /application\/scim\+json/);
});

test('attribute name is validated', async () => {
  for (const bad of ['', 'has space', '1abc', '<x>']) {
    const r = await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: bad } });
    assert.equal(r.status, 400, bad);
  }
  for (const good of ['memberOf', 'groups', 'urn:oid:1.3.6.1.4.1.5923.1.5.1.1', 'http://schemas.xmlsoap.org/claims/Group']) {
    assert.equal((await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: good } })).status, 200, good);
  }
  await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf' } });
});

test('Grouper creates a group, then adds and removes members', async () => {
  const created = await scimCall(token, '/Groups', {
    method: 'POST',
    body: { displayName: 'ref:staff', externalId: 'uuid-1', members: [{ value: alice.guid }, { value: 'nobody' }] },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.members.map((m) => m.display), ['alice']);
  const id = created.json.id;

  assert.equal((await scimCall(token, '/Groups', { method: 'POST', body: { displayName: 'ref:staff' } })).status, 409);

  const add = await scimCall(token, `/Groups/${id}`, {
    method: 'PATCH', body: patch([{ op: 'add', path: 'members', value: [{ value: bob.guid }, { value: 'alice' }] }]),
  });
  assert.deepEqual(add.json.members.map((m) => m.display), ['alice', 'bob']);

  const rm = await scimCall(token, `/Groups/${id}`, {
    method: 'PATCH', body: patch([{ op: 'remove', path: `members[value eq "${alice.guid}"]` }]),
  });
  assert.deepEqual(rm.json.members.map((m) => m.display), ['bob']);

  const rmBody = await scimCall(token, `/Groups/${id}`, {
    method: 'PATCH', body: patch([{ op: 'remove', path: 'members', value: [{ value: bob.guid }] }]),
  });
  assert.deepEqual(rmBody.json.members, []);

  const replaced = await scimCall(token, `/Groups/${id}`, {
    method: 'PATCH', body: patch([{ op: 'replace', path: 'members', value: [{ value: alice.guid }] },
      { op: 'replace', path: 'displayName', value: 'ref:employees' }]),
  });
  assert.equal(replaced.json.displayName, 'ref:employees');
  assert.deepEqual(replaced.json.members.map((m) => m.display), ['alice']);

  const put = await scimCall(token, `/Groups/${id}`, {
    method: 'PUT', body: { displayName: 'ref:employees', externalId: 'uuid-1', members: [{ value: bob.guid }] },
  });
  assert.deepEqual(put.json.members.map((m) => m.display), ['bob']);

  const found = await scimCall(token, '/Groups?filter=displayName%20eq%20%22ref%3Aemployees%22');
  assert.equal(found.json.totalResults, 1);
  assert.equal((await scimCall(token, '/Groups?filter=displayName%20co%20%22x%22')).status, 400);

  const users = await scimCall(token, '/Users?filter=userName%20eq%20%22ALICE%22');
  assert.equal(users.json.Resources[0].id, alice.guid);
  assert.equal(JSON.stringify(users.json).includes('password'), false);
  assert.equal((await scimCall(token, '/Users', { method: 'POST', body: { userName: 'x' } })).status, 501);

  assert.equal((await scimCall(token, `/Groups/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await scimCall(token, `/Groups/${id}`)).status, 404);
});

test('local groups are invisible to SCIM and Grouper groups are read-only in the console', async () => {
  db.run("INSERT INTO groups (name) VALUES ('local-team')");
  const local = db.get("SELECT id FROM groups WHERE name = 'local-team'");
  assert.equal((await scimCall(token, `/Groups/${local.id}`)).status, 404);
  assert.equal((await scimCall(token, `/Groups/${local.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await scimCall(token, '/Groups', { method: 'POST', body: { displayName: 'local-team' } })).status, 409);

  const g = await scimCall(token, '/Groups', { method: 'POST', body: { displayName: 'ref:ro', members: [{ value: alice.guid }] } });
  const gid = g.json.id;
  assert.equal((await api(`/api/admin/groups/${gid}`, { method: 'PUT', body: { name: 'x' } })).status, 409);
  // Removing a member Grouper provides does nothing; only pinned members can be removed here.
  const del = await api(`/api/admin/groups/${gid}/members/${alice.id}`, { method: 'DELETE' });
  assert.deepEqual(del.json.members.map((m) => m.username), ['alice']);

  // Saving a user in the console must not drop Grouper memberships or add to Grouper groups.
  const detail = (await api(`/api/admin/users/${alice.id}`)).json;
  const saved = await api(`/api/admin/users/${alice.id}`, { method: 'PUT', body: { ...detail, group_ids: [local.id, Number(gid) + 100, ] } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.group_ids.sort(), [local.id, Number(gid)].sort());
  const saved2 = await api(`/api/admin/users/${bob.id}`, { method: 'PUT', body: { ...(await api(`/api/admin/users/${bob.id}`)).json, group_ids: [Number(gid)] } });
  assert.deepEqual(saved2.json.group_ids, []);
});

test('pinned members cannot be removed or overwritten by Grouper', async () => {
  const t = (await api('/api/admin/grouper/token', { method: 'POST' })).json.token;
  await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf' } });
  const carol = addUser('carol');
  const g = (await scimCall(t, '/Groups', { method: 'POST', body: { displayName: 'ref:pin', externalId: 'p1', members: [{ value: alice.guid }] } })).json;
  const members = async () => (await api(`/api/admin/groups/${g.id}`)).json.members.map((m) => `${m.username}${m.pinned ? '*' : ''}`);

  const pinned = await api(`/api/admin/groups/${g.id}/members`, { method: 'POST', body: { user_ids: [carol.id, alice.id] } });
  assert.equal(pinned.status, 200);
  assert.deepEqual(await members(), ['alice*', 'carol*']);

  // Grouper replaces the membership with nobody, then removes alice explicitly: pinned users stay.
  await scimCall(t, `/Groups/${g.id}`, { method: 'PUT', body: { displayName: 'ref:pin', externalId: 'p1', members: [] } });
  assert.deepEqual(await members(), ['alice*', 'carol*']);
  const view = await scimCall(t, `/Groups/${g.id}`);
  assert.deepEqual(view.json.members, [], 'Grouper only sees what it provided');
  await scimCall(t, `/Groups/${g.id}`, { method: 'PATCH', body: patch([{ op: 'add', path: 'members', value: [{ value: alice.guid }] }]) });
  await scimCall(t, `/Groups/${g.id}`, { method: 'PATCH', body: patch([{ op: 'remove', path: 'members', value: [{ value: alice.guid }] }]) });
  assert.deepEqual(await members(), ['alice*', 'carol*']);

  // Unpinning drops the membership unless Grouper also provides it.
  await scimCall(t, `/Groups/${g.id}`, { method: 'PATCH', body: patch([{ op: 'add', path: 'members', value: [{ value: alice.guid }] }]) });
  await api(`/api/admin/groups/${g.id}/members/${alice.id}`, { method: 'DELETE' });
  await api(`/api/admin/groups/${g.id}/members/${carol.id}`, { method: 'DELETE' });
  assert.deepEqual(await members(), ['alice']);

  // A group deleted by Grouper survives while it has pinned members, and is taken back when Grouper recreates it.
  await api(`/api/admin/groups/${g.id}/members`, { method: 'POST', body: { user_ids: [carol.id] } });
  assert.equal((await scimCall(t, `/Groups/${g.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await members(), ['carol*']);
  const again = await scimCall(t, '/Groups', { method: 'POST', body: { displayName: 'ref:pin', externalId: 'p2', members: [{ value: bob.guid }] } });
  assert.equal(again.status, 201);
  assert.equal(again.json.id, g.id);
  assert.deepEqual(await members(), ['bob', 'carol*']);
});

test('a pinned member keeps a mapped role through a Grouper wipe', async () => {
  const t = (await api('/api/admin/grouper/token', { method: 'POST' })).json.token;
  await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf' } });
  db.run("INSERT INTO roles (key, name) VALUES ('custom-lock', 'Lockout guard')");
  const rid = db.get("SELECT id FROM roles WHERE key = 'custom-lock'").id;
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'users.view')", rid);
  const dave = addUser('dave');
  await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf', roleMappings: [{ group_name: 'ref:lockout', role_id: rid }] } });
  const g = (await scimCall(t, '/Groups', { method: 'POST', body: { displayName: 'ref:lockout', members: [{ value: dave.guid }] } })).json;
  await api(`/api/admin/groups/${g.id}/members`, { method: 'POST', body: { user_ids: [dave.id] } });
  await scimCall(t, `/Groups/${g.id}`, { method: 'PUT', body: { displayName: 'ref:lockout', members: [] } });
  assert.equal(roles.permissionsOf(dave.id).has('users.view'), true);
  await scimCall(t, `/Groups/${g.id}`, { method: 'DELETE' });
  assert.equal(roles.permissionsOf(dave.id).has('users.view'), true, 'still granted after Grouper deletes the group');
});

test('groups are released under the configured attribute name, per service provider', async () => {
  const { data } = sps.parseForm({ name: 'App', acs_url: 'https://app.example.org/acs', nameid_format: 'emailAddress', nameid_source: 'email', grouper_groups: true });
  const sp = sps.getSp(sps.createSp(data));
  assert.equal(sp.grouper_groups, 1);
  const user = db.get('SELECT * FROM users WHERE id = ?', alice.id);
  const ctx = { groups: attrs.userGroups(user.id), custom: {} };

  const values = (name, s = sp) => buildAttributes(s, user, ctx, ['pwd']).find((a) => a.name === name)?.values;
  assert.deepEqual(values('isMemberOf'), ['ref:ro'], 'only Grouper groups, not local-team');

  await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'memberOf' } });
  assert.deepEqual(values('memberOf'), ['ref:ro']);
  assert.equal(values('isMemberOf'), undefined);

  assert.equal(values('memberOf', { ...sp, grouper_groups: 0 }), undefined, 'off unless the app opts in');

  await api('/api/admin/grouper', { method: 'PUT', body: { enabled: false, attributeName: 'memberOf' } });
  assert.equal(values('memberOf'), undefined, 'nothing released while the integration is disabled');
});

test('Grouper group membership grants mapped roles', async () => {
  // A token and enabled integration are needed for grants; recreate them (the last test revokes them).
  const t = (await api('/api/admin/grouper/token', { method: 'POST' })).json.token;
  await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf' } });
  db.run("INSERT INTO roles (key, name) VALUES ('custom-ops', 'Ops')");
  const role = db.get("SELECT id FROM roles WHERE key = 'custom-ops'");
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'users.view')", role.id);

  const bad = await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf', roleMappings: [{ group_name: 'ref:ops', role_id: 99999 }] } });
  assert.equal(bad.status, 400);
  const put = await api('/api/admin/grouper', { method: 'PUT', body: { enabled: true, attributeName: 'isMemberOf', roleMappings: [{ group_name: 'Ref:Ops', role_id: role.id }] } });
  assert.equal(put.status, 200);
  assert.equal(put.json.roleMappings[0].role_name, 'Ops');

  assert.equal(roles.permissionsOf(bob.id).has('users.view'), false);
  const g = await scimCall(t, '/Groups', { method: 'POST', body: { displayName: 'ref:ops', members: [{ value: bob.guid }] } });
  assert.equal(roles.permissionsOf(bob.id).has('users.view'), true, 'granted by membership, name matched case-insensitively');
  assert.deepEqual(roles.roleIds(bob.id), [], 'not stored as a manual assignment');

  // Saving the user in the console must not turn the grant into a permanent assignment.
  const detail = (await api(`/api/admin/users/${bob.id}`)).json;
  assert.deepEqual(detail.grouper_role_ids, [role.id]);
  await api(`/api/admin/users/${bob.id}`, { method: 'PUT', body: detail });
  assert.deepEqual(roles.roleIds(bob.id), []);

  await scimCall(t, `/Groups/${g.json.id}`, { method: 'PATCH', body: patch([{ op: 'remove', path: 'members', value: [{ value: bob.guid }] }]) });
  assert.equal(roles.permissionsOf(bob.id).has('users.view'), false, 'revoked when Grouper removes the member');

  await scimCall(t, `/Groups/${g.json.id}`, { method: 'PATCH', body: patch([{ op: 'add', path: 'members', value: [{ value: bob.guid }] }]) });
  await api('/api/admin/grouper', { method: 'PUT', body: { enabled: false, attributeName: 'isMemberOf' } });
  assert.equal(roles.permissionsOf(bob.id).has('users.view'), false, 'nothing granted while disabled');
});

test('removing the token disables the integration', async () => {
  const r = await api('/api/admin/grouper/token', { method: 'DELETE' });
  assert.equal(r.json.tokenSet, false);
  assert.equal(r.json.enabled, false);
  assert.equal((await scimCall(token, '/Groups')).status, 403);
});
