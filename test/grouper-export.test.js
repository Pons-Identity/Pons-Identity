process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const { buildModel, buildBundle, toGsh } = require('../src/grouper-export');
const { zip } = require('../src/zip');

seedAdmin();
const mkUser = (username, extra = {}) => Number(db.run(
  'INSERT INTO users (guid, username, password_hash, active, employee_id, email) VALUES (?,?,?,1,?,?)',
  newGuid(), username, hashPassword(`${username}-password`), extra.employee_id ?? '', extra.email ?? '').lastInsertRowid);
const mkGroup = (name, description = '', source = 'local') => Number(
  db.run('INSERT INTO groups (name, description, source) VALUES (?,?,?)', name, description, source).lastInsertRowid);

const alice = mkUser('alice', { employee_id: 'E1' });
const bob = mkUser('bob'); // no employee id
const eng = mkGroup('org:eng', "Eng's \"team\" $HOME\nline two");
const flat = mkGroup('flat');
const staff = mkGroup('org:staff');
const both = mkGroup('org:both');
const ref = mkGroup('ref:ops', '', 'grouper');
const dir = mkGroup('ad-group', '', 'directory');
db.run('INSERT INTO group_members (group_id, user_id, start_at, end_at) VALUES (?,?,?,?)', eng, alice, 1700000000, 1800000000);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', eng, bob);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', flat, alice);
db.run('INSERT INTO group_includes VALUES (?,?)', staff, eng);
db.run('INSERT INTO group_includes VALUES (?,?)', staff, dir);
db.run('INSERT INTO group_composites VALUES (?,?,?,?)', both, 'minus', eng, ref);
db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'user', ?, 'admin')", eng, alice);
db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'group', ?, 'read')", eng, staff);

test('model maps names, members, nesting, composites and privileges', () => {
  const m = buildModel({ subjectField: 'employee_id' });
  assert.deepStrictEqual(m.groups.map((g) => g.name).sort(), ['org:both', 'org:eng', 'org:staff', 'simpleidp:flat']);
  assert.deepStrictEqual(m.stems, ['org', 'simpleidp']);
  assert.deepStrictEqual(m.memberships.map((x) => [x.group, x.subject]), [['org:eng', 'E1'], ['simpleidp:flat', 'E1']]);
  assert.deepStrictEqual(m.includes, [{ group: 'org:staff', member_group: 'org:eng' }]);
  assert.deepStrictEqual(m.composites.map((c) => [c.group, c.grouper_op, c.left, c.right]), [['org:both', 'COMPLEMENT', 'org:eng', 'ref:ops']]);
  assert.deepStrictEqual(m.privileges.map((p) => [p.subject_type, p.subject, p.grouper_privilege]), [['user', 'E1', 'ADMIN'], ['group', 'org:staff', 'READ']]);
  // Bob has no employee id; the directory group is skipped along with the nesting that used it.
  assert.deepStrictEqual(m.unresolved.map((u) => u.username), ['bob']);
  assert.ok(m.warnings.some((w) => w.includes('ad-group') && w.includes('external directory')));
  assert.ok(m.warnings.some((w) => w.startsWith('Nested group dropped')));
});

test('the root folder and subject field are configurable and validated', () => {
  assert.ok(buildModel({ rootStem: 'imported' }).groups.some((g) => g.name === 'imported:flat'));
  assert.throws(() => buildModel({ subjectField: 'password_hash' }), /Subject field/);
  assert.throws(() => buildModel({ rootStem: "x'; drop" }), /folder/);
  const dupe = mkUser('twin', { employee_id: 'E1' });
  assert.ok(buildModel({ subjectField: 'employee_id' }).warnings.some((w) => w.includes('share')));
  db.run('DELETE FROM users WHERE id = ?', dupe);
});

test('GSH script is quoted safely and ordered', () => {
  const gsh = toGsh(buildModel({ subjectField: 'employee_id' }));
  assert.ok(gsh.includes(`assignDescription('Eng\\'s "team" $HOME\\nline two')`), 'single-quoted, no interpolation');
  const order = ['// 1.', '// 2.', '// 3.', '// 4.', '// 5.', '// 6.'].map((h) => gsh.indexOf(h));
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i >= 0));
  assert.ok(gsh.includes('CompositeType.COMPLEMENT'));
  assert.ok(gsh.includes('AccessPrivilege.ADMIN'));
  assert.ok(gsh.includes('1700000000000L'));
});

test('CSV files quote awkward values', () => {
  const { files } = buildBundle({ subjectField: 'employee_id' });
  assert.ok(files['groups.csv'].includes('"Eng\'s ""team"" $HOME\nline two"'));
  assert.match(files['memberships.csv'], /^group,subject,username,start,end\r\n/);
  assert.match(files['unresolved.csv'], /bob/);
  assert.match(files['README.txt'], /Employee \/ ID number/);
});

test('the ZIP is valid and round-trips', (t) => {
  const { files } = buildBundle({ subjectField: 'employee_id' });
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  const file = path.join(dirPath, 'x.zip');
  fs.writeFileSync(file, zip(files));
  let out;
  try { out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' }); } catch (e) {
    if (e.code === 'ENOENT') return t.skip('unzip not installed');
    throw e;
  }
  assert.match(out, /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', file, 'import.gsh'], { encoding: 'utf8' }), files['import.gsh']);
  fs.rmSync(dirPath, { recursive: true });
});

/* ------------------------------- Routes -------------------------------- */

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
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
    return { status: r.status, json, buf, type: r.headers.get('content-type') || '', disposition: r.headers.get('content-disposition') || '' };
  };
  api.login = async (u, pw) => {
    csrf = (await api('/api/session')).json.csrf;
    await api('/api/login', { method: 'POST', body: { username: u, password: pw } });
    csrf = (await api('/api/session')).json.csrf;
  };
  return api;
}

test('preview and download need Grouper and group permissions', async () => {
  const admin = client(); await admin.login('admin', 'adminpass123');
  const p = await admin('/api/admin/grouper/export/preview?subjectField=employee_id');
  assert.equal(p.status, 200);
  assert.equal(p.json.counts.groups, 4);
  assert.equal(p.json.unresolved[0].username, 'bob');
  assert.equal((await admin('/api/admin/grouper/export/preview?subjectField=nope')).status, 400);
  const dl = await admin('/api/admin/grouper/export/download?subjectField=employee_id');
  assert.equal(dl.status, 200);
  assert.equal(dl.type, 'application/zip');
  assert.match(dl.disposition, /attachment/);
  assert.equal(dl.buf.readUInt32LE(0), 0x04034b50, 'starts with a ZIP header');

  // A role holding only groups.view cannot export.
  const role = Number(db.run("INSERT INTO roles (key, name) VALUES ('custom-gv', 'GV')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'groups.view')", role);
  const viewer = mkUser('viewer');
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', viewer, role);
  const v = client(); await v.login('viewer', 'viewer-password');
  assert.equal((await v('/api/admin/grouper/export/preview')).status, 403);
});
