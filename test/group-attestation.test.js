process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const att = require('../src/group-attestation');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const mkUser = (n) => Number(db.run('INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,1)',
  newGuid(), n, hashPassword(`${n}-password`)).lastInsertRowid);
const mona = mkUser('mona'); const nell = mkUser('nell'); const omar = mkUser('omar');

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const api = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  api.login = async (username, password) => {
    csrf = (await api('/api/session')).json.csrf;
    assert.equal((await api('/api/login', { method: 'POST', body: { username, password } })).status, 200);
    csrf = (await api('/api/session')).json.csrf;
  };
  return api;
}

const admin = client(); const m = client(); const n = client();
test.before(async () => {
  await admin.login('admin', 'adminpass123');
  await m.login('mona', 'mona-password');
  await n.login('nell', 'nell-password');
});
const mk = async (name) => (await admin('/api/admin/groups', { method: 'POST', body: { name, description: 'Test group' } })).json.group.id;
const day = 24 * 3600;

test('periods add whole months and clamp to the end of a shorter month', () => {
  const at = (s, f) => new Date(att.addPeriod(Date.parse(s) / 1000, f) * 1000).toISOString();
  assert.equal(at('2026-01-31T10:00:00Z', 'monthly'), '2026-02-28T10:00:00.000Z');
  assert.equal(at('2026-11-15T00:00:00Z', 'quarterly'), '2027-02-15T00:00:00.000Z');
  assert.equal(at('2024-02-29T00:00:00Z', 'annually'), '2025-02-28T00:00:00.000Z');
  const now = 1_000_000;
  assert.equal(att.statusOf(now - 1, now), 'overdue');
  assert.equal(att.statusOf(now + 3 * day, now), 'due_soon');
  assert.equal(att.statusOf(now + 60 * day, now), 'ok');
});

test('an administrator assigns managers, who then manage the group and see it under My groups', async () => {
  const g = await mk('payroll');
  assert.equal((await m(`/api/my/groups/${g}/structure`)).status, 404);

  const r = await admin(`/api/admin/groups/${g}/managers`, { method: 'POST', body: { user_id: mona } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.managers.map((x) => x.username), ['mona']);
  assert.equal((await admin(`/api/admin/groups/${g}/managers`, { method: 'POST', body: { user_id: 99999 } })).status, 400);

  const mine = (await m('/api/my/groups')).json;
  assert.deepEqual(mine.map((x) => [x.name, x.privilege, x.manager]), [['payroll', 'update', true]]);
  assert.equal((await m(`/api/my/groups/${g}/members`, { method: 'POST', body: { user_ids: [nell] } })).status, 200);
  // A manager changes members, not who manages.
  assert.equal((await m(`/api/my/groups/${g}/managers`, { method: 'POST', body: { user_id: omar } })).status, 403);
  assert.equal((await m(`/api/my/groups/${g}/attestation`, { method: 'PUT', body: { frequency: 'monthly' } })).status, 403);

  assert.equal((await admin(`/api/admin/groups/${g}/managers/${mona}`, { method: 'DELETE' })).json.managers.length, 0);
  assert.equal((await m(`/api/my/groups/${g}/structure`)).status, 404, 'access ends with the role');
});

test('a person with the group admin privilege can assign managers and a schedule', async () => {
  const g = await mk('legal-hold');
  db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'user', ?, 'admin')", g, nell);
  assert.equal((await n(`/api/my/groups/${g}/managers`, { method: 'POST', body: { user_id: mona } })).status, 201);
  const s = await n(`/api/my/groups/${g}/attestation`, { method: 'PUT', body: { frequency: 'quarterly' } });
  assert.equal(s.status, 200);
  assert.equal(s.json.schedule.frequency, 'quarterly');
  assert.equal(s.json.schedule.status, 'ok');
  assert.equal(s.json.can_configure, true);
});

test('scheduling validates the frequency and date, and can be removed', async () => {
  const g = await mk('sched');
  const put = (body) => admin(`/api/admin/groups/${g}/attestation`, { method: 'PUT', body });
  assert.equal((await put({ frequency: 'weekly' })).status, 400);
  assert.equal((await put({ frequency: 'monthly', first_due: 'not a date' })).status, 400);
  const due = Math.floor(Date.now() / 1000) + 5 * day;
  const ok = await put({ frequency: 'monthly', first_due: due });
  assert.equal(ok.json.schedule.next_due, due);
  assert.equal(ok.json.schedule.status, 'due_soon');
  assert.equal((await admin(`/api/admin/groups/${g}/attestation`, { method: 'DELETE' })).json.schedule, null);
});

test('only a manager (or group admin) can attest; attesting snapshots members and moves the due date on', async () => {
  const g = await mk('finance-ops');
  await admin(`/api/admin/groups/${g}/members`, { method: 'POST', body: { user_ids: [omar, nell] } });
  await admin(`/api/admin/groups/${g}/managers`, { method: 'POST', body: { user_id: mona } });
  const past = Math.floor(Date.now() / 1000) - day;
  await admin(`/api/admin/groups/${g}/attestation`, { method: 'PUT', body: { frequency: 'quarterly', first_due: past } });
  assert.equal((await m(`/api/my/groups/${g}/attestation`)).json.schedule.status, 'overdue');

  // A reader who is not a manager may look but not attest.
  db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'user', ?, 'read')", g, omar);
  const o = client(); await o.login('omar', 'omar-password');
  assert.equal((await o(`/api/my/groups/${g}/attestation`)).status, 200);
  assert.equal((await o(`/api/my/groups/${g}/attest`, { method: 'POST', body: {} })).status, 403);

  const r = await m(`/api/my/groups/${g}/attest`, { method: 'POST', body: { note: 'Reviewed with HR' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.last.attested_by, 'mona');
  assert.equal(r.json.last.member_count, 2);
  assert.equal(r.json.schedule.status, 'ok');
  assert.ok(r.json.schedule.next_due > Date.now() / 1000 + 80 * day);

  const hist = (await m(`/api/my/groups/${g}/attestations`)).json;
  assert.deepEqual(hist[0].members, ['nell', 'omar']);
  assert.equal(hist[0].note, 'Reviewed with HR');
  const log = (await m(`/api/my/groups/${g}/audit`)).json.map((e) => e.action);
  assert.ok(log.includes('attestation.complete'));
});

test('the administrator overview lists scheduled groups, most urgent first', async () => {
  const rows = (await admin('/api/admin/groups/attestations')).json;
  assert.ok(rows.length >= 2);
  assert.deepEqual(rows.map((r) => r.next_due), [...rows.map((r) => r.next_due)].sort((a, b) => a - b));
  assert.ok(rows.every((r) => ['ok', 'due_soon', 'overdue'].includes(r.status)));
  assert.ok(rows.find((r) => r.name === 'finance-ops').managers.includes('mona'));
  assert.equal((await n('/api/admin/groups/attestations')).status, 403);
});

test('deleting a manager removes the assignment', async () => {
  const g = await mk('tmp-mgr');
  const t = mkUser('tempmgr');
  await admin(`/api/admin/groups/${g}/managers`, { method: 'POST', body: { user_id: t } });
  db.run('DELETE FROM users WHERE id = ?', t);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_managers WHERE user_id = ?', t).n, 0);
});
