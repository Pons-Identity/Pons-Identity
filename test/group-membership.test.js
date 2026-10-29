process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.BASE_URL = 'https://idp.test';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const gm = require('../src/group-membership');

const user = (n) => db.run("INSERT INTO users (guid, username, password_hash) VALUES (?, ?, 'x')", `g-${n}`, n).lastInsertRowid;
const group = (n) => Number(db.run('INSERT INTO groups (name) VALUES (?)', n).lastInsertRowid);
const add = (g, u, s = null, e = null) => db.run('INSERT INTO group_members (group_id, user_id, start_at, end_at) VALUES (?,?,?,?)', g, u, s, e);
const names = (u) => gm.effectiveGroupsOf(Number(u)).map((g) => g.name);

test('direct, nested and indirect membership', () => {
  const a = Number(user('a1')); const staff = group('staff'); const eng = group('eng'); const all = group('all');
  add(eng, a);
  db.run('INSERT INTO group_includes VALUES (?,?)', staff, eng);
  db.run('INSERT INTO group_includes VALUES (?,?)', all, staff);
  assert.deepStrictEqual(names(a), ['all', 'eng', 'staff']);
});

test('membership windows are honoured', () => {
  const u = Number(user('w1')); const g = group('windowed'); const now = 1000;
  add(g, u, now + 10, null);
  assert.ok(!gm.effectiveMembers(g, now).has(u));
  assert.ok(gm.effectiveMembers(g, now + 10).has(u));
  const h = group('expiring'); add(h, u, null, now);
  assert.ok(gm.effectiveMembers(h, now - 1).has(u));
  assert.ok(!gm.effectiveMembers(h, now).has(u));
});

test('composites: union, intersect, minus', () => {
  const [x, y, z] = ['cx', 'cy', 'cz'].map((n) => Number(user(n)));
  const l = group('left'); const r = group('right');
  add(l, x); add(l, y); add(r, y); add(r, z);
  const mk = (name, op) => { const c = group(name); db.run('INSERT INTO group_composites VALUES (?,?,?,?)', c, op, l, r); return gm.effectiveMembers(c); };
  assert.deepStrictEqual([...mk('u', 'union')].sort(), [x, y, z].sort());
  assert.deepStrictEqual([...mk('i', 'intersect')], [y]);
  assert.deepStrictEqual([...mk('m', 'minus')], [x]);
});

test('cycles terminate and are detected', () => {
  const p = group('cyc-p'); const q = group('cyc-q'); const u = Number(user('cu'));
  add(p, u);
  db.run('INSERT INTO group_includes VALUES (?,?)', p, q);
  assert.ok(gm.wouldCycle(q, p));
  assert.ok(!gm.wouldCycle(p, q));
  db.run('INSERT INTO group_includes VALUES (?,?)', q, p);
  assert.ok(gm.effectiveMembers(p).has(u));
  assert.ok(gm.effectiveMembers(q).has(u));
});
