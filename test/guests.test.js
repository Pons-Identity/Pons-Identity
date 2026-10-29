process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const roles = require('../src/roles');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

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
    return { status: r.status, json };
  };
  const login = async (username, password) => {
    csrf = (await call('/api/session')).json.csrf;
    const r = await call('/api/login', { method: 'POST', body: { username, password } });
    csrf = (await call('/api/session')).json.csrf;
    return r;
  };
  return { call, login };
}

const PW = 'Correct-horse-battery-9!';
const soon = (days = 7) => new Date(Date.now() + days * 86400000).toISOString();
const admin = client();
const host = client();
let usersRole; let groupsRole; let hostId; let hostGroup;

test('nobody may host until an administrator chooses a group', async () => {
  await admin.login('admin', 'adminpass123');
  const made = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'nina', first_name: 'Nina', last_name: 'N', email: 'nina@example.com', password: PW, active: true } });
  const nina = client();
  await nina.login('nina', PW);
  assert.equal((await nina.call('/api/my/guests', { method: 'POST', body: { username: 'zed', password: PW, expires_at: soon() } })).status, 403);
  assert.equal((await nina.call('/api/session')).json.me.hosts_guests, false);
  const group = (await admin.call('/api/admin/groups', { method: 'POST', body: { name: 'Guest hosts' } })).json.group;
  assert.ok(group.id, JSON.stringify(group));
  assert.equal((await admin.call('/api/admin/guest-policy', { method: 'PUT', body: { hostGroups: [{ id: 999 }] } })).status, 400);
  assert.equal((await admin.call('/api/admin/guest-policy', { method: 'PUT', body: { hostGroups: [{ id: group.id, maxGuests: 2 }] } })).status, 200);
  hostGroup = group.id;
  assert.equal((await nina.call('/api/my/guests', { method: 'POST', body: { username: 'zed', password: PW, expires_at: soon() } })).status, 403);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', group.id, made.json.id);
  assert.equal((await nina.call('/api/my/guests', { method: 'POST', body: { username: 'zed', password: PW, expires_at: soon() } })).status, 201);
  assert.equal((await nina.call('/api/session')).json.me.hosts_guests, true);
  // leaving the group keeps the guest visible and removable, but nothing can be added or changed
  db.run('DELETE FROM group_members WHERE user_id = ?', made.json.id);
  const list = await nina.call('/api/my/guests');
  assert.equal(list.json.can_host, false);
  assert.equal(list.json.guests.length, 1);
  assert.equal((await nina.call(`/api/my/guests/${list.json.guests[0].id}`, { method: 'PUT', body: { active: false } })).status, 403);
  assert.equal((await nina.call(`/api/my/guests/${list.json.guests[0].id}`, { method: 'DELETE' })).status, 204);
});

test('set up a host who can view users and groups', async () => {
  usersRole = (await admin.call('/api/admin/roles', { method: 'POST', body: { name: 'Users viewer', permissions: ['users.view'] } })).json.role;
  groupsRole = (await admin.call('/api/admin/roles', { method: 'POST', body: { name: 'Groups manager', permissions: ['groups.manage'] } })).json.role;
  const made = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'hana', first_name: 'Hana', last_name: 'Host', email: 'hana@example.com', password: PW, active: true, role_ids: [usersRole.id] } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  hostId = made.json.id;
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', hostGroup, hostId);
  assert.equal((await host.login('hana', PW)).status, 200);
});

let guestId;
test('a new guest has a login and no permissions', async () => {
  const r = await host.call('/api/my/guests', { method: 'POST', body: { username: 'gus', first_name: 'Gus', last_name: 'Guest', email: 'gus@example.com', password: PW, expires_at: soon() } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  guestId = r.json.id;
  assert.deepEqual(r.json.permissions, []);
  assert.equal(db.get('SELECT host_id FROM users WHERE id = ?', guestId).host_id, hostId);
  const g = client();
  assert.equal((await g.login('gus', PW)).status, 200);
  const me = (await g.call('/api/session')).json.me;
  assert.equal(me.is_admin, false);
  assert.equal(me.host.username, 'hana');
  assert.equal((await g.call('/api/admin/users')).status, 403);
});

test('a host can give a guest only roles within their own access', async () => {
  const bad = await host.call(`/api/my/guests/${guestId}`, { method: 'PUT', body: { role_ids: [groupsRole.id] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errors[0], /Groups manager/);
  const ok = await host.call(`/api/my/guests/${guestId}`, { method: 'PUT', body: { role_ids: [usersRole.id] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.permissions, ['users.view']);
  const g = client();
  await g.login('gus', PW);
  assert.equal((await g.call('/api/admin/users')).status, 200);
  assert.equal((await g.call('/api/admin/groups')).status, 403);
});

test('a guest never exceeds the host, even when roles were assigned elsewhere', async () => {
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', guestId, groupsRole.id);
  assert.deepEqual([...roles.permissionsOf(guestId)].sort(), ['users.view']);
  db.run('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', guestId, groupsRole.id);
  // the host losing a permission takes it from the guest too
  db.run('DELETE FROM user_roles WHERE user_id = ?', hostId);
  assert.deepEqual([...roles.permissionsOf(guestId)], []);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', hostId, usersRole.id);
});

test('guests cannot host guests or touch other hosts\' guests', async () => {
  const g = client();
  await g.login('gus', PW);
  assert.equal((await g.call('/api/my/guests', { method: 'POST', body: { username: 'x', password: PW, expires_at: soon() } })).status, 403);
  const other = client();
  const olga = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'olga', first_name: 'Olga', last_name: 'O', email: 'olga@example.com', password: PW, active: true } });
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', hostGroup, olga.json.id);
  await other.login('olga', PW);
  assert.equal((await other.call(`/api/my/guests/${guestId}`, { method: 'PUT', body: { active: false } })).status, 404);
  assert.equal((await other.call(`/api/my/guests/${guestId}`, { method: 'DELETE' })).status, 404);
});

test('a guest cannot sign in while the host is inactive', async () => {
  db.run('UPDATE users SET active = 0 WHERE id = ?', hostId);
  assert.equal((await client().login('gus', PW)).status, 401);
  db.run('UPDATE users SET active = 1 WHERE id = ?', hostId);
  assert.equal((await client().login('gus', PW)).status, 200);
});

test('a host can deactivate and delete a guest; deleting the host removes their guests', async () => {
  assert.equal((await host.call(`/api/my/guests/${guestId}`, { method: 'PUT', body: { active: false } })).json.active, false);
  assert.equal((await client().login('gus', PW)).status, 401);
  assert.equal((await host.call(`/api/my/guests/${guestId}`, { method: 'DELETE' })).status, 204);
  const again = await host.call('/api/my/guests', { method: 'POST', body: { username: 'gail', password: PW, expires_at: soon() } });
  assert.equal(again.status, 201);
  db.run('DELETE FROM users WHERE id = ?', hostId);
  assert.equal(db.get('SELECT 1 FROM users WHERE username = ?', 'gail'), undefined);
});

test('guests need an expiry within the allowed time, and stop working when it passes', async () => {
  const h = client();
  const owner = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'ed', first_name: 'Ed', last_name: 'E', email: 'ed@example.com', password: PW, active: true } });
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', hostGroup, owner.json.id);
  await h.login('ed', PW);
  const make = (extra) => h.call('/api/my/guests', { method: 'POST', body: { username: 'exp', password: PW, ...extra } });
  assert.match((await make({})).json.errors[0], /expires/);
  assert.match((await make({ expires_at: new Date(Date.now() - 1000).toISOString() })).json.errors[0], /future/);
  assert.match((await make({ expires_at: soon(15) })).json.errors[0], /at most 14 days/);
  assert.equal((await admin.call('/api/admin/guest-policy', { method: 'PUT', body: { hostGroups: [{ id: hostGroup, maxGuests: 2 }], maxDays: 0 } })).status, 400);
  const made = await make({ expires_at: soon(1) });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const g = client();
  assert.equal((await g.login('exp', PW)).status, 200);
  // time passes
  db.run('UPDATE users SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), made.json.id);
  assert.equal((await g.call('/api/session')).json.me, null);
  assert.equal((await client().login('exp', PW)).status, 401);
  assert.deepEqual([...roles.permissionsOf(made.json.id)], []);
  assert.equal(require('../src/guests').expireGuests(), 1);
  assert.equal(db.get('SELECT active FROM users WHERE id = ?', made.json.id).active, 0);
  // extending turns it back on
  const ext = await h.call(`/api/my/guests/${made.json.id}`, { method: 'PUT', body: { expires_at: soon(3) } });
  assert.equal(ext.status, 200);
  assert.equal(ext.json.active, true);
  assert.equal((await client().login('exp', PW)).status, 200);
});

test('the number of guests a host may have is capped by their groups, the largest limit winning', async () => {
  const guestsMod = require('../src/guests');
  const h = client();
  const owner = await admin.call('/api/admin/users', { method: 'POST', body: { username: 'cap', first_name: 'Cap', last_name: 'C', email: 'cap@example.com', password: PW, active: true } });
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', hostGroup, owner.json.id);
  await h.login('cap', PW);
  const make = (n) => h.call('/api/my/guests', { method: 'POST', body: { username: `cap-g${n}`, password: PW, expires_at: soon() } });
  assert.equal((await make(1)).status, 201);
  assert.equal((await make(2)).status, 201);
  const refused = await make(3);
  assert.equal(refused.status, 400);
  assert.match(refused.json.errors[0], /at most 2 guests/);
  assert.equal((await h.call('/api/my/guests')).json.limit, 2);
  // a second group with a larger limit raises it; a bad limit is refused
  const big = (await admin.call('/api/admin/groups', { method: 'POST', body: { name: 'Big hosts' } })).json.group;
  const put = (hostGroups) => admin.call('/api/admin/guest-policy', { method: 'PUT', body: { hostGroups } });
  assert.equal((await put([{ id: hostGroup, maxGuests: 2 }, { id: big.id, maxGuests: 0 }])).status, 400);
  assert.equal((await put([{ id: hostGroup, maxGuests: 2 }, { id: big.id, maxGuests: 5 }])).status, 200);
  assert.equal(guestsMod.guestLimit(db.get('SELECT * FROM users WHERE id = ?', owner.json.id)), 2);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', big.id, owner.json.id);
  assert.equal(guestsMod.guestLimit(db.get('SELECT * FROM users WHERE id = ?', owner.json.id)), 5);
  assert.equal((await make(3)).status, 201);
  // lowering the limit below what they have keeps their guests but allows no more
  assert.equal((await put([{ id: hostGroup, maxGuests: 1 }, { id: big.id, maxGuests: 1 }])).status, 200);
  assert.equal((await make(4)).status, 400);
  assert.equal((await h.call('/api/my/guests')).json.guests.length, 3);
});
