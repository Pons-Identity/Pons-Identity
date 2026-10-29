process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword, verifyPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const scheduler = require('../src/user-scheduler');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function admin(username = 'admin', password = 'adminpass123') {
  let cookie = '';
  const call = async (path, { method = 'GET', body, raw } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    return { status: r.status, json: !raw && text ? JSON.parse(text) : null, text };
  };
  await call('/api/session');
  await call('/api/login', { method: 'POST', body: { username, password } });
  return call;
}
const mkGroup = (name) => Number(db.run('INSERT INTO groups (name) VALUES (?)', name).lastInsertRowid);
const mkUser = (name) => Number(db.run('INSERT INTO users (guid, username, password_hash) VALUES (?,?,?)', newGuid(), name, hashPassword(`${name}-password`)).lastInsertRowid);
const inFuture = (s) => new Date(Date.now() + s * 1000).toISOString();

test('a dry run reports every problem and writes nothing', async () => {
  const call = await admin();
  mkGroup('Staff');
  const csv = ['username,password,first_name,email,groups', 'ann,annpass123abc,Ann,ann@x.net,Staff', 'ann,annpass123abc,Dup,,', 'bob,short,Bob,not-an-email,Nope', ',annpass123abc,,,'].join('\n');
  const r = await call('/api/admin/users/bulk', { method: 'POST', body: { csv, dry_run: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.dry_run, true);
  assert.deepEqual(r.json.rows.map((x) => x.status), ['valid', 'error', 'error', 'error']);
  assert.match(r.json.rows[1].errors[0], /repeats row 2/);
  assert.equal(r.json.rows[0].row, 2);
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'ann'"), undefined);
  assert.equal((await call('/api/admin/users/bulk', { method: 'POST', body: { csv: 'username,bogus\nx,y' } })).status, 400);
});

test('skip mode creates the good rows; abort mode creates nothing; passwords can be generated once', async () => {
  const call = await admin();
  const csv = ['username,password,email,emails,groups,active,attr.pet', 'cara,carapass123abc,cara@x.net,c2@x.net;c3@x.net,Staff,true,cat', 'dan,,dan@x.net,,,false,', 'eve,short,,,,,'].join('\n');

  const aborted = await call('/api/admin/users/bulk', { method: 'POST', body: { csv, on_error: 'abort', generate_passwords: true } });
  assert.deepEqual(aborted.json.rows.map((x) => x.status), ['skipped', 'skipped', 'error']);
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'cara'"), undefined);

  const r = await call('/api/admin/users/bulk', { method: 'POST', body: { csv, generate_passwords: true } });
  assert.deepEqual(r.json.rows.map((x) => x.status), ['created', 'created', 'error']);
  assert.equal(r.json.generated.length, 1);
  const dan = db.get("SELECT * FROM users WHERE username = 'dan'");
  assert.equal(dan.active, 0);
  assert.ok(verifyPassword(r.json.generated[0].password, dan.password_hash));
  assert.equal(dan.password_changed_via, 'bulk');

  const cara = (await call(`/api/admin/users/${r.json.rows[0].id}`)).json;
  assert.equal(cara.emails.length, 3);
  assert.equal(cara.email, 'cara@x.net');
  assert.equal(cara.custom, 'pet=cat');
  assert.equal(db.all('SELECT * FROM group_members WHERE user_id = ?', cara.id).length, 1);

  const job = await call(`/api/admin/users/bulk/${r.json.job_id}`);
  assert.equal(job.json.summary.created, 2);
  assert.equal(JSON.stringify(job.json).includes(r.json.generated[0].password), false);
  const errs = await call(`/api/admin/users/bulk/${r.json.job_id}?format=csv`, { raw: true });
  assert.match(errs.text, /eve/);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'user.bulk_create'"));
});

test('bulk import cannot assign groups without groups.manage', async () => {
  const rid = Number(db.run("INSERT INTO roles (key, name) VALUES ('t-um', 'Users only')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'users.manage')", rid);
  const uid = mkUser('helper');
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', uid, rid);
  const call = await admin('helper', 'helper-password');
  const r = await call('/api/admin/users/bulk', { method: 'POST', body: { users: [{ username: 'fay', password: 'faypass123abc', groups: 'Staff' }], dry_run: true } });
  assert.match(r.json.rows[0].errors[0], /permission to assign groups/);
  assert.equal((await call('/api/admin/schedules')).status, 403);
});

test('a scheduled create runs when due, once, and a scheduled deactivation ends sessions', async () => {
  const call = await admin();
  const s = await call('/api/admin/schedules', { method: 'POST', body: { action: 'create', run_at: inFuture(3600), rows: [{ username: 'gus', password: 'guspass123abc', email: 'gus@x.net' }] } });
  assert.equal(s.status, 201);
  assert.equal(JSON.stringify(db.get('SELECT payload FROM user_schedule WHERE id = ?', s.json.id)).includes('guspass123abc'), false);
  assert.equal((await call('/api/admin/schedules', { method: 'POST', body: { action: 'create', run_at: inFuture(60), rows: [{ username: 'admin', password: 'guspass123abc' }] } })).status, 400);
  assert.equal(await scheduler.runDue(), 0);
  assert.equal(await scheduler.runDue(Math.floor(Date.now() / 1000) + 7200), 1);
  assert.equal(await scheduler.runDue(Math.floor(Date.now() / 1000) + 7200), 0);
  const gus = db.get("SELECT * FROM users WHERE username = 'gus'");
  assert.ok(verifyPassword('guspass123abc', gus.password_hash));

  const { json: later } = await call('/api/admin/schedules', { method: 'POST', body: { action: 'deactivate', run_at: inFuture(60), user_id: gus.id } });
  const gusCall = await admin('gus', 'guspass123abc');
  assert.equal((await gusCall('/api/session')).json.me.username, 'gus');
  assert.equal(await scheduler.runDue(Math.floor(Date.now() / 1000) + 120), 1);
  assert.equal(db.get('SELECT status FROM user_schedule WHERE id = ?', later.id).status, 'done');
  assert.equal(db.get('SELECT active FROM users WHERE id = ?', gus.id).active, 0);
  assert.equal((await gusCall('/api/session')).json.me, null);
});

test('group deprovisioning acts on members at run time and skips protected accounts', async () => {
  const call = await admin();
  const g = mkGroup('Leavers');
  const a = mkUser('leaver1'); const b = mkUser('leaver2');
  const adminId = db.get("SELECT id FROM users WHERE username = 'admin'").id;
  for (const id of [a, adminId]) db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', g, id);
  const s = await call('/api/admin/schedules', { method: 'POST', body: { action: 'deactivate', run_at: inFuture(60), group_id: g } });
  assert.equal(s.status, 201);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', g, b); // joins after scheduling
  assert.equal((await call('/api/admin/schedules', { method: 'POST', body: { action: 'delete', run_at: inFuture(60), group_id: g } })).status, 400);
  assert.equal((await call('/api/admin/schedules', { method: 'POST', body: { action: 'deactivate', run_at: inFuture(60), user_id: adminId } })).status, 400);
  await scheduler.runDue(Math.floor(Date.now() / 1000) + 120);
  assert.equal(db.get('SELECT active FROM users WHERE id = ?', a).active, 0);
  assert.equal(db.get('SELECT active FROM users WHERE id = ?', b).active, 0);
  assert.equal(db.get('SELECT active FROM users WHERE id = ?', adminId).active, 1);
  assert.match(db.get('SELECT result FROM user_schedule WHERE id = ?', s.json.id).result, /Deactivated 2 of 3/);
});

test('a cancelled schedule does not run, and one whose owner lost access fails', async () => {
  const call = await admin();
  const u = mkUser('cancelme');
  const s = await call('/api/admin/schedules', { method: 'POST', body: { action: 'delete', run_at: inFuture(60), user_id: u } });
  assert.equal((await call(`/api/admin/schedules/${s.json.id}`, { method: 'DELETE' })).json.status, 'cancelled');
  await scheduler.runDue(Math.floor(Date.now() / 1000) + 120);
  assert.ok(db.get('SELECT 1 FROM users WHERE id = ?', u));
  assert.equal((await call(`/api/admin/schedules/${s.json.id}`, { method: 'DELETE' })).status, 400);

  const t = await call('/api/admin/schedules', { method: 'POST', body: { action: 'delete', run_at: inFuture(60), user_id: u } });
  db.run('UPDATE users SET active = 0 WHERE username = ?', 'admin');
  await scheduler.runDue(Math.floor(Date.now() / 1000) + 120);
  db.run("UPDATE users SET active = 1 WHERE username = 'admin'");
  assert.equal(db.get('SELECT status FROM user_schedule WHERE id = ?', t.json.id).status, 'failed');
  assert.ok(db.get('SELECT 1 FROM users WHERE id = ?', u));
});
