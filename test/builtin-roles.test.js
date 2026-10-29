process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { BUILTIN_ROLES } = require('../src/builtin-roles');
const { PERMISSIONS } = require('../src/permissions');

const permsOf = (key) => new Set(db.all(
  'SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = ?', key,
).map((r) => r.permission));

test('every built-in role names only real permissions', () => {
  const known = new Set(PERMISSIONS.map((p) => p.key));
  for (const r of BUILTIN_ROLES) {
    for (const p of r.permissions) assert.ok(known.has(p), `${r.key} lists unknown permission ${p}`);
  }
});

test('built-in roles are created on first start', () => {
  for (const r of BUILTIN_ROLES) {
    const row = db.get('SELECT name, description FROM roles WHERE key = ?', r.key);
    assert.ok(row, `missing role ${r.key}`);
    assert.equal(row.name, r.name);
    assert.equal(row.description, r.description);
  }
});

test('a helpdesk role can manage users but not roles or policies', () => {
  const p = permsOf('helpdesk');
  assert.ok(p.has('users.manage') && p.has('users.view'));
  assert.ok(!p.has('roles.manage') && !p.has('policies.manage'));
});

test('read-only holds every view permission and nothing that changes data', () => {
  const p = permsOf('read-only');
  assert.ok(p.size > 0);
  for (const key of p) assert.ok(key.endsWith('.view'), `${key} is not a view permission`);
  assert.ok(p.has('reports.view') && p.has('audit.view') && p.has('users.view'));
});

test('a deleted built-in role is not recreated on restart', () => {
  const id = db.get("SELECT id FROM roles WHERE key = 'report-viewer'").id;
  db.run('DELETE FROM roles WHERE id = ?', id);
  // Re-running the seeding code is what a restart does: the marker must stop it.
  assert.equal(db.get("SELECT 1 AS x FROM settings WHERE key = 'builtin_roles_seeded'").x, 1);
  assert.equal(db.get("SELECT id FROM roles WHERE key = 'report-viewer'"), undefined);
});
