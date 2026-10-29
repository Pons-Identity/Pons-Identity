process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const { buildModel } = require('../src/grouper-export');
const { GrouperWs, parseTarget } = require('../src/grouper-ws');
const push = require('../src/grouper-push');

seedAdmin();
const mkUser = (username, employee_id) => Number(db.run(
  'INSERT INTO users (guid, username, password_hash, active, employee_id) VALUES (?,?,?,1,?)',
  newGuid(), username, hashPassword(`${username}-password`), employee_id).lastInsertRowid);
const mkGroup = (name, description = '') => Number(db.run('INSERT INTO groups (name, description) VALUES (?,?)', name, description).lastInsertRowid);

const alice = mkUser('alice', 'E1'); const bob = mkUser('bob', 'E2'); const ghost = mkUser('ghost', 'ghost-3');
const eng = mkGroup('org:eng', 'Engineering'); const staff = mkGroup('org:staff'); const all = mkGroup('org:all');
const bad = mkGroup('org:bad-group'); const both = mkGroup('org:both');
db.run('INSERT INTO group_members (group_id, user_id, start_at, end_at) VALUES (?,?,?,?)', eng, alice, 1700000000, 1800000000);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', eng, bob);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', eng, ghost);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', bad, alice);
db.run('INSERT INTO group_includes VALUES (?,?)', staff, eng);
db.run('INSERT INTO group_includes VALUES (?,?)', bad, eng);
db.run('INSERT INTO group_composites VALUES (?,?,?,?)', both, 'union', eng, staff);
db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'user', ?, 'update')", eng, bob);
db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'group', ?, 'read')", eng, staff);
db.run("INSERT INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, 'user', ?, 'admin')", bad, alice);
const OPTS = { subjectField: 'employee_id' };

/* ---------------------------- A mock Grouper WS ---------------------------- */

const PASSWORD = 's3cret-pass';
const requests = [];
let delayMs = 0;
let redirect = false;
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const expected = `Basic ${Buffer.from(`wsuser:${PASSWORD}`).toString('base64')}`;
    if (req.headers.authorization !== expected) { res.writeHead(401); return res.end(); }
    if (redirect) { res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }); return res.end(); }
    const path = req.url.replace('/grouper-ws/servicesRest/v2_5_000', '');
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, path: decodeURIComponent(path), body });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const send = (obj, code = 'SUCCESS') => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-grouper-resultcode': code, 'x-grouper-success': 'T' });
      res.end(JSON.stringify(obj));
    };
    const ghosty = (l) => String(l.subjectId || l.subjectIdentifier || '').startsWith('ghost');
    if (req.method === 'POST' && path === '/subjects') {
      return send({ WsGetSubjectsResults: { wsSubjects: body.WsRestGetSubjectsRequest.wsSubjectLookups.map((l) => (
        ghosty(l) ? { resultCode: 'SUBJECT_NOT_FOUND', success: 'F' } : { id: l.subjectId, resultCode: 'SUCCESS', success: 'T' })) } });
    }
    if (req.method === 'POST' && path === '/groups') {
      return send({ WsGroupSaveResults: { results: body.WsRestGroupSaveRequest.wsGroupToSaves.map((g) => (
        g.wsGroup.name.includes('bad-group')
          ? { resultMetadata: { resultCode: 'EXCEPTION', success: 'F' } }
          : { resultMetadata: { resultCode: 'SUCCESS_INSERT', success: 'T' }, wsGroup: { name: g.wsGroup.name, uuid: `uuid-${g.wsGroup.name}` } })) } }, 'SUCCESS');
    }
    if (req.method === 'PUT' && path.endsWith('/members')) {
      return send({ WsAddMemberResults: { results: body.WsRestAddMemberRequest.subjectLookups.map((l) => (
        ghosty(l) ? { resultMetadata: { resultCode: 'SUBJECT_NOT_FOUND', success: 'F' } } : { resultMetadata: { resultCode: 'SUCCESS', success: 'T' } })) } });
    }
    if (req.method === 'POST' && path === '/grouperPrivileges') {
      return send({ WsAssignGrouperPrivilegesResults: { results: body.WsRestAssignGrouperPrivilegesRequest.wsSubjectLookups.map(() => ({ resultMetadata: { resultCode: 'SUCCESS', success: 'T' } })) } });
    }
    res.writeHead(404); return res.end();
  });
});
let wsBase; let appServer; let appBase;
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  wsBase = `http://127.0.0.1:${mock.address().port}/grouper-ws/servicesRest`;
  appServer = createApp().listen(0);
  appBase = `http://localhost:${appServer.address().port}`;
});
test.after(() => { mock.close(); appServer.close(); });
const client = (password = PASSWORD) => new GrouperWs({ baseUrl: parseTarget(wsBase, 'v2_5_000'), username: 'wsuser', password });

/* --------------------------------- Units ---------------------------------- */

test('the target URL and version are validated', () => {
  assert.equal(parseTarget('https://g.example.net/grouper-ws/servicesRest/', 'v2_5_000'), 'https://g.example.net/grouper-ws/servicesRest/v2_5_000');
  assert.throws(() => parseTarget('http://g.example.net/x', 'v2_5_000'), /https/);
  assert.throws(() => parseTarget('https://u:p@g.example.net/x', 'v2_5_000'), /username or password in the URL/);
  assert.throws(() => parseTarget('https://169.254.169.254/latest', 'v2_5_000'), /not allowed/);
  assert.throws(() => parseTarget('ftp://g.example.net', 'v2_5_000'), /https/);
  assert.throws(() => parseTarget('https://g.example.net/x', '2.5'), /API version/);
  assert.doesNotThrow(() => parseTarget('http://localhost:8092/grouper-ws/servicesRest', 'v2_5_000'));
});

test('membership dates use Grouper\'s format in the chosen zone', () => {
  assert.equal(push.formatTime(1700000000, 'UTC'), '2023/11/14 22:13:20.000');
  assert.equal(push.formatTime(1700000000, 'America/New_York'), '2023/11/14 17:13:20.000');
  assert.ok(push.parseOptions({ timeZone: 'Mars/Base' }).errors.length);
});

/* -------------------------------- The push -------------------------------- */

test('preflight reports people Grouper cannot find', async () => {
  requests.length = 0;
  const r = await push.preflight(client(), buildModel(OPTS), {});
  assert.equal(r.checked, 3);
  assert.equal(r.found, 2);
  assert.deepEqual(r.notFound.map((n) => [n.subject, n.code]), [['ghost-3', 'SUBJECT_NOT_FOUND']]);
  assert.ok(requests.every((q) => q.path === '/subjects'), 'preflight only reads');
});

test('a full run creates groups, members, nesting and privileges in order', async () => {
  requests.length = 0;
  const calls = [];
  const report = await push.run(client(), buildModel(OPTS), { timeZone: 'UTC' }, { progress: (p) => calls.push(p) });
  assert.equal(report.state, 'done');

  const kinds = requests.map((q) => `${q.method} ${q.path.split('/').slice(0, 2).join('/')}`);
  assert.deepEqual([...new Set(kinds)], ['POST /groups', 'PUT /groups', 'POST /grouperPrivileges']);
  assert.deepEqual([...new Set(calls)], ['groups', 'members', 'nested', 'privileges']);

  const save = requests[0].body.WsRestGroupSaveRequest.wsGroupToSaves.find((g) => g.wsGroup.name === 'org:eng');
  assert.deepEqual(save, {
    wsGroup: { name: 'org:eng', extension: 'eng', displayExtension: 'eng', description: 'Engineering' },
    wsGroupLookup: { groupName: 'org:eng' }, saveMode: 'INSERT_OR_UPDATE', createParentStemsIfNotExist: 'T',
  });

  const adds = requests.filter((q) => q.method === 'PUT' && q.path === '/groups/org:eng/members').map((q) => q.body.WsRestAddMemberRequest);
  const dated = adds.find((a) => a.enabledTime);
  assert.deepEqual(dated.subjectLookups, [{ subjectId: 'E1' }]);
  assert.equal(dated.enabledTime, '2023/11/14 22:13:20.000');
  assert.equal(dated.disabledTime, '2027/01/15 08:00:00.000');
  assert.equal(dated.replaceAllExisting, 'F');
  const plain = adds.find((a) => !a.enabledTime);
  assert.deepEqual(plain.subjectLookups.map((l) => l.subjectId), ['E2', 'ghost-3']);

  const nested = requests.find((q) => q.path === '/groups/org:staff/members').body.WsRestAddMemberRequest;
  assert.deepEqual(nested.subjectLookups, [{ subjectSourceId: 'g:gsa', subjectId: 'uuid-org:eng' }]);

  const privs = requests.filter((q) => q.path === '/grouperPrivileges').map((q) => q.body.WsRestAssignGrouperPrivilegesRequest);
  assert.ok(privs.some((p) => p.privilegeNames[0] === 'read' && p.wsSubjectLookups[0].subjectIdentifier === 'org:staff' && p.wsSubjectLookups[0].subjectSourceId === 'g:gsa'));
  assert.ok(privs.some((p) => p.privilegeNames[0] === 'update' && p.wsSubjectLookups[0].subjectId === 'E2' && p.wsGroupLookup.groupName === 'org:eng'));
  assert.ok(privs.every((p) => p.allowed === 'T' && p.privilegeType === 'access'));

  // The failed group's dependents are skipped, a missing person is reported, and composites are left for GSH.
  assert.equal(report.phases.groups.failed, 1);
  assert.equal(report.groupCodes.SUCCESS_INSERT, 4);
  assert.ok(!requests.some((q) => q.path === '/groups/org:bad-group/members'));
  const f = report.failures.map((x) => `${x.phase}|${x.target}|${x.code}`);
  assert.ok(f.includes('groups|org:bad-group|EXCEPTION'));
  assert.ok(f.includes('members|org:eng: ghost|SUBJECT_NOT_FOUND'));
  assert.ok(f.includes('members|org:bad-group: alice|group was not created'));
  assert.ok(f.includes('privileges|org:bad-group: admin to E1|group was not created'));
  assert.deepEqual(report.notPushed.composites.map((c) => [c.group, c.type]), [['org:both', 'UNION']]);
  assert.ok(!requests.some((q) => JSON.stringify(q.body).includes('org:both') && q.path !== '/groups'), 'composite groups get no members');
});

test('bad credentials stop the run at once without echoing them', async () => {
  requests.length = 0;
  const report = await push.run(client('wrong-password'), buildModel(OPTS), {});
  assert.equal(report.state, 'failed');
  assert.match(report.error, /rejected the username or password/);
  assert.ok(!JSON.stringify(report).includes('wrong-password'));
  assert.equal(requests.length, 0);
});

test('redirects are not followed', async () => {
  redirect = true;
  try {
    await assert.rejects(() => client().getSubjects([{ subjectId: 'x' }]), /could not be reached|unexpected/);
  } finally { redirect = false; }
});

/* --------------------------------- Routes --------------------------------- */

function http_() {
  let cookie = ''; let csrf = '';
  const api = async (p, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(appBase + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null, text };
  };
  api.login = async (u, pw) => {
    csrf = (await api('/api/session')).json.csrf;
    await api('/api/login', { method: 'POST', body: { username: u, password: pw } });
    csrf = (await api('/api/session')).json.csrf;
  };
  return api;
}
const form = (extra = {}) => ({
  connection: { url: wsBase, version: 'v2_5_000', username: 'wsuser', password: PASSWORD, ...extra.connection },
  options: { ...OPTS, ...extra.options },
});
const E = '/api/admin/grouper/export';

test('the push routes validate input, need confirmation and permissions', async () => {
  const admin = http_(); await admin.login('admin', 'adminpass123');
  const bad = await admin(`${E}/push/preflight`, { method: 'POST', body: form({ connection: { url: 'http://example.com/x' } }) });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errors[0], /https/);
  assert.equal((await admin(`${E}/push/preflight`, { method: 'POST', body: form({ connection: { password: 'nope' } }) })).status, 400);
  assert.equal((await admin(`${E}/push`, { method: 'POST', body: form() })).status, 400, 'needs confirm');

  const pre = await admin(`${E}/push/preflight`, { method: 'POST', body: form() });
  assert.equal(pre.status, 200);
  assert.equal(pre.json.notFoundCount, 1);
  assert.equal(pre.json.counts.groups, 5);
  assert.equal(pre.json.notPushed.composites, 1);

  const viewerId = mkUser('viewer', 'E9');
  const role = Number(db.run("INSERT INTO roles (key, name) VALUES ('custom-gv', 'GV')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'groups.view')", role);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', viewerId, role);
  const v = http_(); await v.login('viewer', 'viewer-password');
  assert.equal((await v(`${E}/push/preflight`, { method: 'POST', body: form() })).status, 403);
  assert.equal((await v(`${E}/push`, { method: 'POST', body: { ...form(), confirm: true } })).status, 403);
});

test('a confirmed push runs in the background, one at a time, and never stores the password', async () => {
  const admin = http_(); await admin.login('admin', 'adminpass123');
  requests.length = 0;
  delayMs = 40;
  try {
    const started = await admin(E + '/push', { method: 'POST', body: { ...form(), confirm: true } });
    assert.equal(started.status, 202);
    assert.equal(started.json.state, 'running');
    assert.equal(started.json.actor, 'admin');
    const second = await admin(E + '/push', { method: 'POST', body: { ...form(), confirm: true } });
    assert.equal(second.status, 409);

    let st;
    for (let i = 0; i < 100; i += 1) {
      st = (await admin(`${E}/push/status`)).json;
      if (st.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(st.state, 'done');
    assert.equal(st.report.phases.groups.ok, 4);
    assert.equal(st.report.failureCount > 0, true);
  } finally { delayMs = 0; }

  const saved = db.get("SELECT value FROM settings WHERE key = 'grouper_push_last'").value;
  assert.ok(!saved.includes(PASSWORD) && !saved.includes('wsuser'), 'credentials are never saved');
  assert.ok(!JSON.stringify((await admin(`${E}/push/status`)).json).includes(PASSWORD));
});
