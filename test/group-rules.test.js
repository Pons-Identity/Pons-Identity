process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.BASE_URL = 'https://idp.test';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const gm = require('../src/group-membership');
const rules = require('../src/group-rules');

const user = (n, department = '') => Number(db.run("INSERT INTO users (guid, username, password_hash, department) VALUES (?, ?, 'x', ?)", `r-${n}`, n, department).lastInsertRowid);
const group = (n) => Number(db.run('INSERT INTO groups (name) VALUES (?)', n).lastInsertRowid);
const members = (g) => db.all('SELECT u.username, m.via_rule FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.username', g).map((r) => `${r.username}${r.via_rule ? '*' : ''}`);

test('a filter is checked and previewed', () => {
  user('sam', 'Underwater Basket-Weaving');
  assert.equal(rules.preview('(department=Underwater Basket-Weaving)').matches, 1);
  assert.match(rules.preview('(department=Underwater Basket-Weaving').error, /Expected/);
  assert.match(rules.preview('(shoeSize=9)').error, /Unknown attribute/);
  assert.match(rules.preview('department=Underwater Basket-Weaving').error, /starts with/);
});

test('a snapshot query adds matching people once and tracks nothing afterwards', () => {
  const g = group('snap');
  const a = user('snap-a', 'Chem'); user('snap-b', 'Art');
  rules.save(g, rules.parse({ filter: '(department=Chem)', mode: 'snapshot' }, { id: g, source: 'local' }).data, 'admin');
  assert.deepEqual(rules.run(g, { force: true }), { matched: 1, added: 1, removed: 0 });
  assert.deepEqual(members(g), ['snap-a']);
  db.run("UPDATE users SET department = 'Art' WHERE id = ?", a);
  assert.deepEqual(rules.runAllOngoing(), 0);
  assert.deepEqual(members(g), ['snap-a']);
  assert.match(rules.run(g).error, /only when you ask/);
});

test('an ongoing query adds and removes only the people it added', () => {
  const g = group('live');
  const a = user('live-a', 'Bio'); const b = user('live-b', 'Bio'); const hand = user('live-hand', 'Law');
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', g, hand);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', g, b);
  rules.save(g, rules.parse({ filter: '(department=Bio)', mode: 'ongoing' }, { id: g, source: 'local' }).data, 'admin');
  assert.equal(rules.run(g).added, 1);
  assert.deepEqual(members(g), ['live-a*', 'live-b', 'live-hand']);
  db.run("UPDATE users SET department = 'Law' WHERE id IN (?, ?)", a, b);
  assert.equal(rules.run(g).removed, 1);
  assert.deepEqual(members(g), ['live-b', 'live-hand']);
  // Switching to a snapshot keeps what the query added; removing the rule keeps people too.
  db.run("UPDATE users SET department = 'Bio' WHERE id = ?", a);
  rules.run(g);
  rules.save(g, { filter: '(department=Bio)', mode: 'snapshot' }, 'admin');
  assert.deepEqual(members(g), ['live-a', 'live-b', 'live-hand']);
});

test('removing a rule can keep or drop its members; composites and external groups cannot have one', () => {
  const g = group('drop');
  user('drop-a', 'Zoo');
  rules.save(g, { filter: '(department=Zoo)', mode: 'ongoing' }, 'admin');
  rules.run(g);
  assert.equal(rules.remove(g, { keepMembers: false }).dropped, 1);
  assert.deepEqual(members(g), []);
  const c = group('comp');
  db.run('INSERT INTO group_composites VALUES (?,?,?,?)', c, 'union', g, g);
  assert.match(rules.unsuitable({ id: c, source: 'local' }), /composite/);
  assert.match(rules.unsuitable({ id: g, source: 'grouper' }), /outside/);
});

test('membership says whether a person is direct, indirect or both, and through what', () => {
  const u = user('how-u'); const inner = group('how-inner'); const outer = group('how-outer'); const both = group('how-both');
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', inner, u);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', both, u);
  db.run('INSERT INTO group_includes VALUES (?,?)', outer, inner);
  db.run('INSERT INTO group_includes VALUES (?,?)', both, inner);
  const how = (g) => gm.howLabel(gm.explainMembers(g).get(u));
  assert.equal(how(inner), 'Direct');
  assert.equal(how(outer), 'Indirect');
  assert.equal(how(both), 'Direct, Indirect');
  assert.deepEqual(gm.explainMembers(outer).get(u).via.map((g) => g.name), ['how-inner']);
  const mine = Object.fromEntries(gm.membershipsOf(u).map((g) => [g.name, g.how]));
  assert.deepEqual(mine, { 'how-both': 'Direct, Indirect', 'how-inner': 'Direct', 'how-outer': 'Indirect' });
});
