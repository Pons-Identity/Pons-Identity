process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const builder = require('../src/reports/builder');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const people = [
  ['ana', 'Sailing', 'Foreman', 1, '2026-01-10'],
  ['ben', 'Sailing', 'Apprentice', 1, '2026-02-03'],
  ['cy', 'History', 'Apprentice', 0, '2026-02-15'],
  ['dee', '', 'Staff', 1, '2026-03-01'],
];
for (const [name, department, title, active, created] of people) {
  db.run("INSERT INTO users (guid, username, password_hash, email, department, title, active, created_at) VALUES (?,?,?,?,?,?,?,?)",
    newGuid(), name, hashPassword(`${name}-password`), `${name}@x.net`, department, title, active, `${created} 09:00:00`);
}

const perms = (...list) => new Set(list);
const ALL = perms('users.view', 'groups.view', 'audit.view');

test('a definition is checked: source, operators by field type, measures, charts and sorting', () => {
  assert.match(builder.parse({ source: 'nope' }).errors.join(' '), /Choose a data source/);
  assert.match(builder.parse({ source: 'users', filters: [{ field: 'active', op: 'contains', value: 'x' }] }).errors.join(' '), /does not apply/);
  assert.match(builder.parse({ source: 'users', filters: [{ field: 'created_at', op: 'gte', value: 'October' }] }).errors.join(' '), /2026-10-01/);
  assert.match(builder.parse({ source: 'users', group_by: 'department', measures: [{ op: 'sum', field: 'title' }] }).errors.join(' '), /not a number/);
  assert.match(builder.parse({ source: 'users', view: 'bar' }).errors.join(' '), /needs a field to group by/);
  assert.match(builder.parse({ source: 'users', group_by: 'groups' }).errors.join(' '), /cannot be grouped/);
  assert.match(builder.parse({ source: 'users', measures: [{ op: 'count' }] }).errors.join(' '), /choose a field to group by/);
  assert.match(builder.parse({ source: 'users', group_by: 'department', measures: [{ op: 'count' }], sort: { by: 'surname' } }).errors.join(' '), /not a column or a measure/);
  assert.match(builder.parse({ source: 'signIns', options: { days: 400 } }).errors.join(' '), /Days must be/);
  const ok = builder.parse({ source: 'users', group_by: 'department', measures: [{ op: 'count' }], view: 'pie' });
  assert.deepEqual(ok.errors, []);
});

test('rows: filters keep the rows that match, columns and the limit shape the table', () => {
  const r = builder.run({ source: 'users', options: { active: true }, filters: [{ field: 'title', op: 'eq', value: 'apprentice' }], columns: ['username', 'department'], sort: { by: 'username', dir: 'desc' } }, { perms: ALL });
  assert.deepEqual(r.columns.map((c) => c.key), ['username', 'department']);
  assert.deepEqual(r.rows, [{ username: 'ben', department: 'Sailing' }]);
  const limited = builder.run({ source: 'users', columns: ['username'], limit: 2 }, { perms: ALL });
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.truncated, true);
  // The administrator account is a user too, so there are five.
  assert.equal(limited.total, 5);
});

test('grouped: counts, distinct values and averages per group, and a chart of the first measure', () => {
  const r = builder.run({ source: 'users', group_by: 'department', measures: [{ op: 'count' }, { op: 'distinct', field: 'title' }], sort: { by: 'm0', dir: 'desc' }, view: 'bar' }, { perms: ALL });
  // Sorted by the count, largest first.
  const counts = r.rows.map((x) => x.m0);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  const maths = r.rows.find((x) => x.group === 'Sailing');
  assert.equal(maths.m0, 2);
  assert.equal(maths.m1, 2);
  assert.equal(r.chart.type, 'bar');
  assert.equal(r.chart.labels.length, r.chart.values.length);
  assert.equal(r.chart.values[r.chart.labels.indexOf('Sailing')], 2);
  const bydate = builder.run({ source: 'users', group_by: 'created_at', bucket: 'month', measures: [{ op: 'count' }], view: 'line' }, { perms: ALL });
  // The administrator account was made today, so its month follows the seeded ones.
  assert.deepEqual(bydate.chart.labels.slice(0, 3), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(bydate.chart.values.slice(0, 3), [1, 2, 1]);
  assert.deepEqual(bydate.chart.labels, [...bydate.chart.labels].sort());
});

test('a source is read only with its permission, and the person is told which one is missing', () => {
  assert.throws(() => builder.run({ source: 'signIns', columns: ['time'] }, { perms: perms('users.view') }), /needs the "audit.view" permission/);
  const r = builder.run({ source: 'groups', group_by: 'source', measures: [{ op: 'sum', field: 'members' }], view: 'pie' }, { perms: perms('groups.view') });
  assert.equal(r.chart.type, 'pie');
});

test('the console can save, run and preview a builder report, which stores no script', async () => {
  const login = async () => {
    let cookie = '';
    const call = async (path, { method = 'GET', body } = {}) => {
      const headers = { cookie };
      if (method !== 'GET') { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf; }
      const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
      if (sc.length) cookie = sc.join('; ');
      const text = await r.text();
      return { status: r.status, json: text ? JSON.parse(text) : null };
    };
    await call('/api/session');
    await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
    return call;
  };
  const adm = await login();
  const meta = await adm('/api/admin/reports');
  assert.equal(meta.status, 200);
  assert.ok(meta.json.builder.sources.some((s) => s.key === 'users'));
  const definition = { source: 'users', group_by: 'department', measures: [{ op: 'count' }], sort: { by: 'm0', dir: 'desc' }, view: 'pie', limit: 10 };
  const saved = await adm('/api/admin/reports', { method: 'POST', body: { name: 'Users by dept', kind: 'builder', definition } });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.equal(saved.json.kind, 'builder');
  assert.equal(saved.json.definition.view, 'pie');
  const ran = await adm(`/api/admin/reports/${saved.json.id}/run`, { method: 'POST', body: {} });
  assert.equal(ran.json.status, 'ok', JSON.stringify(ran.json));
  assert.equal(ran.json.result.kind, 'builder');
  assert.equal(ran.json.result.chart.type, 'pie');
  const row = db.get('SELECT script, kind FROM reports WHERE id = ?', saved.json.id);
  assert.equal(row.script, '');
  assert.equal(row.kind, 'builder');
  const preview = await adm('/api/admin/reports/builder/preview', { method: 'POST', body: { definition: { source: 'users', columns: ['username'], limit: 1 } } });
  assert.equal(preview.json.result.rows.length, 1);
  const bad = await adm('/api/admin/reports/builder/preview', { method: 'POST', body: { definition: { source: 'users', filters: [{ field: 'nope', op: 'eq', value: 'x' }] } } });
  assert.equal(bad.status, 400);
});
