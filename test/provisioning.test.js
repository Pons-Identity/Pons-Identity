process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
process.env.ALLOW_PRIVATE_FETCH = 'true';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const provisioning = require('../src/provisioning');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
let source; // a stand-in for the HR system's export endpoint
let sourceBody = '';
let sourceAuth = '';
test.before(() => new Promise((r) => { source = http.createServer((req, res) => { sourceAuth = req.headers['x-feed-key'] || ''; res.end(sourceBody); }).listen(0, r); }));
test.after(() => { server.close(); source.close(); });

async function session() {
  let cookie = '';
  const call = async (path, { method = 'GET', body, csrf } = {}) => {
    const headers = { ...(cookie && { cookie }), ...(csrf && { 'x-csrf-token': csrf }) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const first = (await call('/api/session')).json.csrf;
  await call('/api/login', { method: 'POST', csrf: first, body: { username: 'admin', password: 'adminpass123' } });
  const csrf = (await call('/api/session')).json.csrf;
  return (path, opts = {}) => call(path, { ...opts, csrf });
}

async function push(token, body, { type = 'text/csv', query = '' } = {}) {
  const r = await fetch(`${base}/directory/v1/feed${query}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

// Column names are deliberately not ours, and one has a space, as a real ERP export would.
const RULES = `external_id = attr("Employee ID")
first_name = attr("Legal First Name")
last_name = attr("Legal Last Name")
username = lower(concat(first_name, ".", last_name))
email = lower(attr("Work Email"))
department = attr("Department")
active = extract(attr("Status"), "^(Active|Leave)$")
start_date = attr("Hire Date")
end_date = attr("Termination Date")
groups = concat("dept-", lower(department))
groups = "Employees"
groups = extract(attr("Worker Type"), "^(Contractor)$")
custom:badge = attr("Badge")
`;
const HEADER = 'Employee ID,Legal First Name,Legal Last Name,Work Email,Department,Status,Hire Date,Termination Date,Worker Type,Badge';
const csv = (...rows) => [HEADER, ...rows].join('\n');
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

let admin;
let dirId;
let token;
const userOf = (ext) => db.get('SELECT * FROM users WHERE directory_id = ? AND external_id = ?', dirId, ext);
const groupNames = (ext) => db.all('SELECT g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ', userOf(ext).id).map((r) => r.name).sort();

test('configuration is validated', () => {
  const bad = (rules, extra = {}) => provisioning.parseConfig({ rules, ...extra }).errors.join(' | ');
  assert.match(bad('external_id = attr("x")'), /must set username/);
  assert.match(bad('username = attr("x")'), /must set external_id/);
  assert.match(bad('external_id = attr("x")\nusername = attr("y")\npassword = attr("p")'), /"password" is not something a feed can set/);
  assert.match(bad('external_id = nope('), /Line 1/);
  assert.match(bad('', { enabled: true }), /Write a mapping/);
  assert.match(bad('external_id = a\nusername = b', { pull: { url: 'ftp://x' } }), /http\(s\)/);
  assert.match(bad('external_id = a\nusername = b', { pull: { intervalMinutes: 30 } }), /needs a feed URL/);
  assert.match(bad('external_id = a\nusername = b', { maxRemovalPercent: 150 }), /0 to 100/);
  assert.equal(bad(RULES), '');
});

test('a plain active mapping rejects words it does not know', () => {
  const prepared = provisioning.prepareRules('external_id = attr("id")\nusername = attr("u")\nactive = attr("s")');
  const bad = provisioning.mapRecord(prepared, { id: '1', u: 'a', s: 'Maybe' });
  assert.match(bad.errors[0], /active "maybe"/);
  assert.equal(provisioning.mapRecord(prepared, { id: '1', u: 'a', s: 'Terminated' }).srcActive, false);
  assert.equal(provisioning.mapRecord(prepared, { id: '1', u: 'a', s: 'YES' }).srcActive, true);
  const dated = provisioning.prepareRules('external_id = attr("id")\nusername = attr("u")\nend_date = attr("e")');
  const end = provisioning.mapRecord(dated, { id: '1', u: 'a', e: '2026-03-01' }).endAt;
  assert.equal(end, Date.parse('2026-03-02T00:00:00Z') / 1000, 'a last day lasts through that day');
  assert.equal(provisioning.mapRecord(dated, { id: '1', u: 'a', e: '2026-03-01T17:00:00-05:00' }).endAt, Date.parse('2026-03-01T22:00:00Z') / 1000);
});

test('console: create a REST-only directory and a feed, enable it', async () => {
  admin = await session();
  const made = await admin('/api/admin/directories', { method: 'POST', body: { name: 'Workday', type: 'ldap', enabled: true, config: {} } });
  assert.equal(made.status, 201);
  dirId = made.json.id;
  await admin(`/api/admin/directories/${dirId}`, { method: 'PUT', body: { name: 'Workday', type: 'ldap', enabled: true, config: {} } });
  token = (await admin(`/api/admin/directories/${dirId}/token`, { method: 'POST' })).json.token;

  const off = await push(token, csv('1,Ann,Lee,ann@x.net,Underwater Basket-Weaving,Active,,,,'));
  assert.equal(off.status, 403, 'a feed that is not enabled accepts nothing');

  const rejected = await admin(`/api/admin/directories/${dirId}/feed`, { method: 'PUT', body: { enabled: true, rules: 'username = attr("x")' } });
  assert.equal(rejected.status, 400);
  const saved = await admin(`/api/admin/directories/${dirId}/feed`, { method: 'PUT', body: { enabled: true, rules: RULES, leaverAction: 'deactivate', maxRemovalPercent: 40, pull: { authValue: 'sekret' } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.config.pull.authValue, undefined, 'the pull credential never comes back');
  assert.equal(saved.json.config.pull.authValueSet, true);
  assert.ok(saved.json.reference.targets.find((t) => t.name === 'groups').description);
  assert.match(saved.json.pushUrl, /\/directory\/v1\/feed$/);
});

test('a first delivery creates people, groups and custom attributes', async () => {
  const dry = await push(token, csv('100,Ann,Lee,ANN@x.net,Underwater Basket-Weaving,Active,,,Employee,B-1', '101,Bo,Ng,bo@x.net,Pottery,Active,,,Contractor,B-2'), { query: '?dry_run=true' });
  assert.equal(dry.json.status, 'preview');
  assert.equal(dry.json.summary.created, 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM users WHERE directory_id = ?', dirId).n, 0, 'a preview writes nothing');

  const r = await push(token, csv('100,Ann,Lee,ANN@x.net,Underwater Basket-Weaving,Active,,,Employee,B-1', '101,Bo,Ng,bo@x.net,Pottery,Active,,,Contractor,B-2', '102,Cy,Orr,cy@x.net,Underwater Basket-Weaving,Active,,,Employee,B-3', '103,Di,Fox,di@x.net,Biology,Active,,,Employee,B-4', '104,Ed,Poe,ed@x.net,Biology,Active,,,Employee,B-5'));
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'applied');
  assert.equal(r.json.summary.created, 5);
  const ann = userOf('100');
  assert.equal(ann.username, 'ann.lee');
  assert.equal(ann.email, 'ann@x.net');
  assert.equal(ann.active, 1);
  assert.deepEqual(groupNames('100'), ['Employees', 'dept-underwater basket-weaving']);
  assert.deepEqual(groupNames('101'), ['Contractor', 'Employees', 'dept-pottery']);
  assert.equal(db.get("SELECT value FROM user_attributes WHERE user_id = ? AND name = 'badge'", ann.id).value, 'B-1');
  assert.equal(db.get("SELECT source FROM groups WHERE name = 'dept-underwater basket-weaving'").source, 'directory');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'provisioning.user_create'"));
});

test('a repeat delivery changes nothing; a change updates only that person', async () => {
  const same = await push(token, csv('100,Ann,Lee,ANN@x.net,Underwater Basket-Weaving,Active,,,Employee,B-1', '101,Bo,Ng,bo@x.net,Pottery,Active,,,Contractor,B-2', '102,Cy,Orr,cy@x.net,Underwater Basket-Weaving,Active,,,Employee,B-3', '103,Di,Fox,di@x.net,Biology,Active,,,Employee,B-4', '104,Ed,Poe,ed@x.net,Biology,Active,,,Employee,B-5'));
  assert.equal(same.json.summary.unchanged, 5);
  assert.equal(same.json.rows.length, 0);

  const moved = await push(token, csv('100,Ann,Lee,ann@x.net,Pottery,Active,,,Employee,B-1', '101,Bo,Ng,bo@x.net,Pottery,Active,,,Contractor,B-2', '102,Cy,Orr,cy@x.net,Underwater Basket-Weaving,Active,,,Employee,B-3', '103,Di,Fox,di@x.net,Biology,Active,,,Employee,B-4', '104,Ed,Poe,ed@x.net,Biology,Active,,,Employee,B-5'));
  assert.equal(moved.json.summary.updated, 1);
  assert.deepEqual(moved.json.rows[0].changes, ['department', 'groups']);
  assert.equal(userOf('100').department, 'Pottery');
  assert.deepEqual(groupNames('100'), ['Employees', 'dept-pottery']);
  assert.equal(userOf('100').username, 'ann.lee', 'usernames are never changed after creation');
});

test('leavers: absent from a full feed, terminated, or past their end date', async () => {
  // Ed is missing (1 of 5 = 20%, under the 40% limit); Di is terminated; Cy has an end date in the past.
  const r = await push(token, csv('100,Ann,Lee,ann@x.net,Pottery,Active,,,Employee,B-1', '101,Bo,Ng,bo@x.net,Pottery,Active,,,Contractor,B-2', `102,Cy,Orr,cy@x.net,Underwater Basket-Weaving,Active,,${day(-3)},Employee,B-3`, '103,Di,Fox,di@x.net,Biology,Terminated,,,Employee,B-4'));
  assert.equal(r.status, 200);
  assert.equal(userOf('104').active, 0, 'missing from the feed');
  assert.equal(userOf('103').active, 0, 'terminated');
  assert.equal(userOf('102').active, 0, 'end date passed');
  assert.equal(userOf('100').active, 1);
  assert.equal(db.get('SELECT reason FROM provisioning_state WHERE user_id = ?', userOf('104').id).reason, 'missing');
  assert.equal(db.get('SELECT reason FROM provisioning_state WHERE user_id = ?', userOf('102').id).reason, 'ended');
});

test('a manual change by an administrator is not undone by an unchanged feed', async () => {
  db.run('UPDATE users SET active = 1 WHERE id = ?', userOf('104').id);
  const r = await push(token, csv('100,Ann,Lee,ann@x.net,Pottery,Active,,,Employee,B-1', '101,Bo,Ng,bo@x.net,Pottery,Active,,,Contractor,B-2', `102,Cy,Orr,cy@x.net,Underwater Basket-Weaving,Active,,${day(-3)},Employee,B-3`, '103,Di,Fox,di@x.net,Biology,Terminated,,,Employee,B-4'));
  assert.equal(r.json.summary.errors, 0);
  assert.equal(userOf('104').active, 1);
  db.run('UPDATE users SET active = 0 WHERE id = ?', userOf('104').id);
});

test('a returning person is reactivated', async () => {
  const r = await push(token, csv('100,Ann,Lee,ann@x.net,Pottery,Active,,,Employee,B-1', '101,Bo,Ng,bo@x.net,Pottery,Active,,,Contractor,B-2', '102,Cy,Orr,cy@x.net,Underwater Basket-Weaving,Active,,,Employee,B-3', '103,Di,Fox,di@x.net,Biology,Terminated,,,Employee,B-4', '104,Ed,Poe,ed@x.net,Biology,Active,,,Employee,B-5'));
  assert.equal(r.json.summary.reactivated, 2);
  assert.equal(userOf('104').active, 1);
  assert.equal(userOf('102').active, 1);
  assert.equal(db.get('SELECT missing_since FROM provisioning_state WHERE user_id = ?', userOf('104').id).missing_since, null);
});

test('safety limits hold back an empty or suspicious feed until an administrator forces it', async () => {
  const empty = await push(token, HEADER);
  assert.equal(empty.status, 409);
  assert.match(empty.json.error, /no records/);
  assert.equal(userOf('100').active, 1);

  // Only 2 of the 5 people remain: 3 of 5 is 60%, over the 40% limit.
  const feed = csv('100,Ann,Lee,ann@x.net,Pottery,Active,,,Employee,B-1', '101,Bo,Ng,bo@x.net,Pottery,Active,,,Contractor,B-2');
  const held = await push(token, feed);
  assert.equal(held.status, 409);
  assert.match(held.json.error, /3 of 4 people|3 of 5 people/);
  assert.equal(userOf('102').active, 1, 'nothing was changed');
  assert.equal(db.get("SELECT status FROM provisioning_runs WHERE directory_id = ? ORDER BY id DESC LIMIT 1", dirId).status, 'blocked');

  // The token cannot override the limit; the console can.
  const forced = await admin(`/api/admin/directories/${dirId}/feed/run`, { method: 'POST', body: { source: 'upload', filename: 'x.csv', content: feed, force: true } });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.status, 'applied');
  assert.equal(userOf('102').active, 0);
});

test('a delta feed never treats absence as departure', async () => {
  const r = await push(token, csv('100,Ann,Lee,ann@x.net,Pottery,Active,,,Employee,B-1'), { query: '?mode=delta' });
  assert.equal(r.json.mode, 'delta');
  assert.equal(r.json.summary.absent, 0);
  assert.equal(userOf('101').active, 1);
});

test('start dates create accounts inactive and the lifecycle job switches them on', async () => {
  const future = day(10);
  const r = await push(token, csv(`200,Fay,Kim,fay@x.net,Underwater Basket-Weaving,Active,${future},,Employee,B-9`), { query: '?mode=delta' });
  assert.equal(r.json.summary.created, 1);
  const fay = userOf('200');
  assert.equal(fay.active, 0);
  assert.equal(db.get('SELECT reason FROM provisioning_state WHERE user_id = ?', fay.id).reason, 'prehire');
  assert.equal(provisioning.lifecycleTick(Math.floor(Date.now() / 1000)).activated, 0);
  const later = provisioning.lifecycleTick(Math.floor(Date.now() / 1000) + 11 * 86400);
  assert.equal(later.activated, 1);
  assert.equal(userOf('200').active, 1);
});

test('leavers are deleted after the grace period, and administrators never are', async () => {
  await admin(`/api/admin/directories/${dirId}/feed`, { method: 'PUT', body: { ...(await admin(`/api/admin/directories/${dirId}/feed`)).json.config, deleteAfterDays: 30 } });
  const ed = userOf('104');
  assert.ok(ed && ed.active === 0);
  assert.equal(provisioning.lifecycleTick(Math.floor(Date.now() / 1000) + 10 * 86400).deleted, 0, 'still inside the grace period');
  // Give Di administrative access: a feed must not delete her.
  const adminRole = db.get("SELECT id FROM roles WHERE key = 'administrator'") || db.get('SELECT id FROM roles LIMIT 1');
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', userOf('103').id, adminRole.id);
  const out = provisioning.lifecycleTick(Math.floor(Date.now() / 1000) + 40 * 86400);
  assert.ok(out.deleted >= 1);
  assert.equal(userOf('104'), undefined);
  assert.ok(userOf('103'), 'a person with a role is kept');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'provisioning.user_delete'"));
});

test('local accounts are never taken over; bad rows are reported without stopping the rest', async () => {
  db.run("INSERT INTO users (guid, username, password_hash) VALUES ('g-local', 'gus.hill', 'x')");
  const r = await push(token, csv('300,Gus,Hill,gus@x.net,Underwater Basket-Weaving,Active,,,Employee,B', '301,Hal,Ito,not-an-email,Underwater Basket-Weaving,Active,,,Employee,B', '302,Ivy,Joy,ivy@x.net,Underwater Basket-Weaving,Maybe,,,Employee,B', '303,Jo,Kay,jo@x.net,Underwater Basket-Weaving,Active,tomorrow,,Employee,B', '304,Kit,Lam,kit@x.net,Underwater Basket-Weaving,Active,,,Employee,B', '304,Kit,Lam,kit2@x.net,Underwater Basket-Weaving,Active,,,Employee,B', '305,Lu,Mo,lu@x.net,Underwater Basket-Weaving,Active,,,Employee,B', '306,Ngo,Pi,ngo@x.net,Underwater Basket-Weaving,Active,,,Employee,B'), { query: '?mode=delta' });
  assert.equal(r.status, 200);
  const byRow = Object.fromEntries(r.json.rows.map((x) => [x.row, x]));
  assert.match(byRow[1].errors[0], /belongs to another account/);
  assert.match(byRow[2].errors[0], /not a valid address/);
  assert.match(byRow[3].warnings[0], /Created inactive/, 'an unlisted status maps to inactive with the extract() idiom');
  assert.match(byRow[4].errors[0], /ISO 8601/);
  assert.equal(byRow[5].action, 'create');
  assert.match(byRow[6].errors[0], /repeats row 5/);
  assert.equal(db.get("SELECT directory_id FROM users WHERE username = 'gus.hill'").directory_id, null);
  assert.ok(userOf('304'));
});

test('a username collision can be resolved with a number', async () => {
  await admin(`/api/admin/directories/${dirId}/feed`, { method: 'PUT', body: { ...(await admin(`/api/admin/directories/${dirId}/feed`)).json.config, usernameCollision: 'suffix' } });
  const r = await push(token, csv('310,Gus,Hill,gus2@x.net,Underwater Basket-Weaving,Active,,,Employee,B'), { query: '?mode=delta' });
  assert.equal(r.json.summary.created, 1);
  assert.equal(userOf('310').username, 'gus.hill2');
});

test('JSON feeds read a records path and nested fields', async () => {
  const json = { data: { workers: [{ id: 'J1', name: { first: 'Zed', last: 'Moe' }, mail: 'zed@x.net', orgs: ['Ops', 'Lab'] }] } };
  const rules = 'external_id = id\nfirst_name = name.first\nlast_name = name.last\nusername = lower(concat(first_name, ".", last_name))\nemail = mail\ngroups = orgs';
  const cfg = { ...(await admin(`/api/admin/directories/${dirId}/feed`)).json.config, rules, format: 'json', recordsPath: 'data.workers', mode: 'delta' };
  assert.equal((await admin(`/api/admin/directories/${dirId}/feed`, { method: 'PUT', body: cfg })).status, 200);
  const r = await push(token, json, { type: 'application/json' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(userOf('J1').username, 'zed.moe');
  assert.deepEqual(groupNames('J1'), ['Lab', 'Ops']);
  const wrong = await push(token, { other: [] }, { type: 'application/json' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /data\.workers/);
});

test('the feed URL is fetched with its credential and recorded in the run history', async () => {
  sourceBody = csv('400,Pat,Quinn,pat@x.net,Underwater Basket-Weaving,Active,,,Employee,B');
  const cfg = { ...(await admin(`/api/admin/directories/${dirId}/feed`)).json.config, rules: RULES, format: 'csv', recordsPath: '', mode: 'delta',
    pull: { url: `http://localhost:${source.address().port}/export`, authHeader: 'X-Feed-Key', intervalMinutes: 0 } };
  assert.equal((await admin(`/api/admin/directories/${dirId}/feed`, { method: 'PUT', body: cfg })).status, 200);
  const r = await admin(`/api/admin/directories/${dirId}/feed/run`, { method: 'POST', body: { source: 'pull' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.summary.created, 1);
  assert.equal(sourceAuth, 'sekret', 'the stored credential was sent');
  const view = (await admin(`/api/admin/directories/${dirId}/feed`)).json;
  assert.equal(view.runs[0].via, 'pull');
  const detail = await admin(`/api/admin/directories/${dirId}/feed/runs/${r.json.run_id}`);
  assert.equal(detail.json.rows[0].action, 'create');
  assert.equal(JSON.stringify(db.all('SELECT detail FROM audit_log WHERE action LIKE ?', 'directory.feed%')).includes('sekret'), false);
});

test('deleting the directory leaves the people in place', async () => {
  const before = db.get('SELECT COUNT(*) AS n FROM users WHERE external_id != ?', '').n;
  assert.equal((await admin(`/api/admin/directories/${dirId}`, { method: 'DELETE' })).status, 204);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM provisioning_state').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM users WHERE username = ?', 'pat.quinn').n, 1);
  assert.ok(before >= 1);
});
