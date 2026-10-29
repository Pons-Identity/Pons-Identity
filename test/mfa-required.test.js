process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const addUser = (name) => Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)',
  newGuid(), name, hashPassword(`${name}-password`), `${name}@x.com`).lastInsertRowid);

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
  await call('/api/session');
  const csrf = (await call('/api/session')).json.csrf;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ username, password }) });
  const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
  if (sc.length) cookie = sc.join('; ');
  return { call };
}

test('the MFA lookup reports whether a group policy requires a second factor, for the people asked about', async () => {
  const admin = await session('admin', 'adminpass123');
  const staffed = addUser('mr-staffed');
  const other = addUser('mr-other');
  const gid = Number(db.run("INSERT INTO groups (name) VALUES ('mr Staff')").lastInsertRowid);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', gid, staffed);
  const pid = Number(db.run("INSERT INTO policies (name, require_mfa) VALUES ('mr Staff MFA', 1)").lastInsertRowid);
  db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', pid, gid);

  const r = await admin.call(`/api/admin/users/mfa-required?ids=${staffed},${other},999999`);
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json[staffed], { required: true, sources: ['mr Staff MFA'] });
  assert.deepStrictEqual(r.json[other], { required: false, sources: [] });
  assert.equal(r.json[999999], undefined, 'an unknown person is left out');

  // Ids that are not numbers are ignored, and the route is not taken for a person's id.
  const junk = await admin.call('/api/admin/users/mfa-required?ids=abc,');
  assert.deepStrictEqual(junk.json, {});
});
