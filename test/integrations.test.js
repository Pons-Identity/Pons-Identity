process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const engine = require('../src/integrations/engine');
const variables = require('../src/integrations/variables');
const roles = require('../src/roles');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const call = async (path, { method = 'GET', body, headers: extra = {} } = {}) => {
    const headers = { cookie, ...extra };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: r.status, json };
  };
  const login = async (u, p) => {
    csrf = (await call('/api/session')).json.csrf;
    await call('/api/login', { method: 'POST', body: { username: u, password: p } });
    csrf = (await call('/api/session')).json.csrf;
  };
  return { call, login };
}

const admin = client();
const API = '/api/admin/integrations';
const make = async (over = {}) => (await admin.call(API, { method: 'POST', body: { name: `i${Math.random()}`, script: 'return 1;', scopes: [], ...over } })).json;

// The console starts a run and answers at once; wait for it to end, as its page does.
const settled = async (id, runId) => {
  for (;;) {
    const r = (await admin.call(`${API}/${id}/runs/${runId}`)).json.run;
    if (r.status !== 'running') return r;
    await new Promise((x) => setTimeout(x, 10));
  }
};
const runNow = async (id, body) => settled(id, (await admin.call(`${API}/${id}/run`, { method: 'POST', body })).json.run.id);
const runIt = (id, input) => runNow(id, { input });
// Runs a script straight through the engine, bypassing the console.
const direct = (script, scopes = [], input = null, timeoutSeconds = 3) => engine.run({ id: 0, name: 'direct', script, scopes, timeoutSeconds }, { input });

test('sign in as the administrator', async () => {
  await admin.login('admin', 'adminpass123');
});

test('scripts run, receive input and the pre-made variables, and return a result', async () => {
  const r = await direct('return { sum: input.a + input.b, app: idp.appName, base: idp.baseUrl, t: trigger.type, fields: idp.userFields.includes("email") };', [], { a: 2, b: 3 });
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  const out = JSON.parse(r.result);
  assert.equal(out.sum, 5);
  assert.equal(out.t, 'manual');
  assert.equal(out.app, 'Pons Identity');
  assert.equal(out.fields, true);
});

test('log output is captured; syntax and runtime errors report a line', async () => {
  const ok = await direct('log("hello", { a: 1 });\nconsole.warn("careful");');
  assert.deepEqual(ok.logs.map((l) => [l.level, l.text]), [['normal', 'hello {"a":1}'], ['warning', 'careful']]);

  const bad = await direct('const x = ;');
  assert.equal(bad.status, 'error');
  assert.equal(bad.error.line, 1);

  const thrown = await direct('const a = 1;\nconst b = 2;\nthrow new Error("boom");');
  assert.equal(thrown.status, 'error');
  assert.equal(thrown.error.message, 'boom');
  assert.equal(thrown.error.line, 3);
});

test('a script cannot reach the server process, eval, or the network without a scope', async () => {
  const probe = await direct(`return {
    process: typeof process, require: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout,
    fn: (() => { try { return typeof (new Function("return 1")); } catch (e) { return "blocked"; } })(),
    ev: (() => { try { eval("1"); return "ran"; } catch (e) { return "blocked"; } })(),
    escape: (() => { try { return typeof this.constructor.constructor("return process")(); } catch (e) { return "blocked"; } })(),
    host: (() => { try { return typeof (async () => {}).constructor("return process")(); } catch (e) { return "blocked"; } })(),
  };`);
  assert.equal(probe.status, 'ok', JSON.stringify(probe.error));
  assert.deepEqual(JSON.parse(probe.result), { process: 'undefined', require: 'undefined', fetch: 'undefined', setTimeout: 'undefined', fn: 'blocked', ev: 'blocked', escape: 'blocked', host: 'blocked' });

  const noScope = await direct('return await http.get("https://example.com/");');
  assert.equal(noScope.status, 'error');
  assert.match(noScope.error.message, /needs the "http" scope/);
  const noUsers = await direct('return await idp.users.find({ username: "x" });');
  assert.match(noUsers.error.message, /users:read/);
});

test('an endless loop and a runaway async script are stopped', async () => {
  const sync = await direct('while (true) {}', [], null, 1);
  assert.equal(sync.status, 'timeout');
  const hung = await direct('await new Promise(() => {});', [], null, 1);
  assert.equal(hung.status, 'timeout');
  const chatty = await direct('for (;;) { await sleep(0); }');
  assert.match(chatty.error.message, /at most 2000 calls/);
});

test('variables: secrets are write-only and blanked from output', async () => {
  assert.equal((await admin.call(`${API}/variables/API_KEY`, { method: 'PUT', body: { value: 'k-123456-secret', secret: true, description: 'for tests' } })).status, 200);
  assert.equal((await admin.call(`${API}/variables/REGION`, { method: 'PUT', body: { value: 'eu' } })).status, 200);
  assert.equal((await admin.call(`${API}/variables/bad name`, { method: 'PUT', body: { value: 'x' } })).status, 400);

  const listed = (await admin.call(`${API}/variables`)).json.variables;
  assert.equal(listed.find((v) => v.name === 'API_KEY').value, '');
  assert.equal(listed.find((v) => v.name === 'API_KEY').set, true);
  assert.equal(listed.find((v) => v.name === 'REGION').value, 'eu');
  assert.equal(JSON.stringify(listed).includes('k-123456-secret'), false);

  // A blank value keeps the secret, and a secret cannot be turned into a plain variable.
  await admin.call(`${API}/variables/API_KEY`, { method: 'PUT', body: { value: '', secret: false } });
  assert.equal(variables.values().API_KEY, 'k-123456-secret');
  assert.equal(variables.list().find((v) => v.name === 'API_KEY').secret, true);

  const i = await make({ script: 'log("key is " + vars.API_KEY);\nreturn { k: vars.API_KEY, region: vars.get("REGION"), none: vars.get("NOPE", "dflt") };' });
  const run = await runIt(i.id);
  assert.equal(run.status, 'ok');
  assert.deepEqual(run.result, { k: '[secret]', region: 'eu', none: 'dflt' });
  assert.equal(run.logs[0].text, 'key is [secret]');
  assert.equal(JSON.stringify(db.all('SELECT * FROM integration_runs')).includes('k-123456-secret'), false);
  assert.equal(JSON.stringify(db.all('SELECT detail FROM audit_log')).includes('k-123456-secret'), false);

  assert.equal((await admin.call(`${API}/variables/REGION`, { method: 'DELETE' })).status, 200);
  assert.equal(variables.values().REGION, undefined);
});

test('users: create, find, update and delete through a script, within scopes', async () => {
  db.run("INSERT INTO groups (name) VALUES ('Staff')");
  const i = await make({
    scopes: ['users:read', 'users:write', 'groups:read', 'groups:write'],
    script: `
      const username = await idp.users.suggestUsername("Sam", "Rivera");
      const made = await idp.users.create({ username, first_name: "Sam", last_name: "Rivera", email: input.email, generate_password: true, groups: ["Staff"] });
      const again = await idp.users.suggestUsername("Sam", "Rivera");
      await idp.users.update(username, { title: "Director", attributes: { pet: "owl" } });
      await idp.groups.removeMember("Staff", username);
      await idp.groups.addMember("Staff", username);
      const found = await idp.users.find({ email: input.email });
      return { username, again, hasPassword: !!made.generated_password, title: found.title, groups: found.groups, pet: found.attributes.pet, members: (await idp.groups.members("Staff")).map((u) => u.username) };
    `,
  });
  const run = await runIt(i.id, { email: 'sam@x.net' });
  assert.equal(run.status, 'ok', JSON.stringify(run.error));
  assert.deepEqual(run.result, { username: 'srivera', again: 'srivera2', hasPassword: true, title: 'Director', groups: ['Staff'], pet: 'owl', members: ['srivera'] });

  const row = db.get("SELECT * FROM users WHERE username = 'srivera'");
  assert.equal(row.password_changed_via, 'api');
  const created = db.get("SELECT * FROM audit_log WHERE action = 'user.create' AND target_name = 'srivera'");
  assert.equal(created.actor_type, 'integration');
  assert.match(created.actor_name, /^integration:/);

  // The generated password is not kept in run history.
  assert.equal(JSON.stringify(db.all('SELECT result FROM integration_runs')).includes('generated_password'), false);

  const del = await make({ scopes: ['users:write'], script: 'await idp.users.delete("srivera"); return true;' });
  assert.equal((await runIt(del.id)).status, 'ok');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users WHERE username = 'srivera'").n, 0);
});

test('scripts cannot touch administrators, directory users, roles or externally managed groups', async () => {
  const mk = (n, extra = '') => Number(db.run(`INSERT INTO users (guid, username, password_hash${extra ? ', directory_id' : ''}) VALUES (?,?,?${extra ? ',?' : ''})`, ...[newGuid(), n, hashPassword('x'), ...(extra ? [extra] : [])]).lastInsertRowid);
  const helper = mk('helper');
  roles.setRolePermissions(Number(db.run("INSERT INTO roles (key, name) VALUES ('custom-helpdesk', 'Help desk')").lastInsertRowid), ['users.view']);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, (SELECT id FROM roles WHERE key = ?))', helper, 'custom-helpdesk');
  db.run("INSERT INTO groups (name, source) VALUES ('Synced', 'grouper')");

  const i = await make({ scopes: ['users:write', 'groups:write'], script: `
    const errors = [];
    for (const f of [() => idp.users.update("admin", { active: false }), () => idp.users.delete("helper"),
                     () => idp.users.create({ username: "x1", password: "longenough-pass1", roles: ["admin"] }),
                     () => idp.groups.addMember("Synced", "x1")]) {
      try { await f(); errors.push("allowed"); } catch (e) { errors.push(e.message); }
    }
    return errors;
  ` });
  const run = await runIt(i.id);
  assert.equal(run.status, 'ok', JSON.stringify(run.error));
  assert.match(run.result[0], /administrative access/);
  assert.match(run.result[1], /administrative access/);
  assert.match(run.result[2], /Unknown field: roles/);
  assert.match(run.result[3], /managed outside the console/);
  assert.equal(db.get("SELECT active FROM users WHERE username = 'admin'").active, 1);
});

test('http needs its scope and refuses non-public addresses', async () => {
  const r = await direct('try { await http.get("http://127.0.0.1:1/"); return "reached"; } catch (e) { return e.message; }', ['http']);
  assert.equal(r.status, 'ok');
  assert.match(JSON.parse(r.result), /non-public address/);
});

test('helpers: csv, hashes and generated passwords', async () => {
  const r = await direct(`
    const rows = await csv.parse("first,last\\nSam,Rivera\\nRowan,Lee");
    return { rows, sha: await util.sha256("abc"), b64: await util.base64Decode(await util.base64Encode("héllo")), pw: (await util.randomPassword(20)).length };
  `);
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  const out = JSON.parse(r.result);
  assert.deepEqual(out.rows, [{ first: 'Sam', last: 'Rivera' }, { first: 'Rowan', last: 'Lee' }]);
  assert.equal(out.sha, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(out.b64, 'héllo');
  assert.equal(out.pw, 20);
});

test('saving validates, and the console needs the integrations permissions', async () => {
  assert.equal((await admin.call(API, { method: 'POST', body: { name: '', script: '' } })).status, 400);
  const syntax = await admin.call(API, { method: 'POST', body: { name: 'broken', script: 'let = ;' } });
  assert.equal(syntax.status, 400);
  assert.match(syntax.json.errors.join(' '), /Script error on line 1/);
  assert.equal((await admin.call(API, { method: 'POST', body: { name: 'x', script: '', scopes: ['everything'] } })).status, 400);
  assert.equal((await admin.call(API, { method: 'POST', body: { name: 'x', script: '', timeout_seconds: 999 } })).status, 400);
  const a = await make({ name: 'Dup' });
  assert.equal((await admin.call(API, { method: 'POST', body: { name: 'dup', script: '' } })).status, 400);
  assert.equal(a.name, 'Dup');
  assert.equal((await admin.call(`${API}/check`, { method: 'POST', body: { script: 'return (' } })).json.ok, false);

  // A viewer sees integrations but cannot change or run them.
  const viewerId = Number(db.run("INSERT INTO users (guid, username, password_hash) VALUES (?, 'viewer', ?)", newGuid(), hashPassword('viewerpass1')).lastInsertRowid);
  const roleId = Number(db.run("INSERT INTO roles (key, name) VALUES ('iv', 'Integration viewer')").lastInsertRowid);
  roles.setRolePermissions(roleId, ['integrations.view']);
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', viewerId, roleId);
  const viewer = client();
  await viewer.login('viewer', 'viewerpass1');
  const listing = await viewer.call(API);
  assert.equal(listing.status, 200);
  assert.ok(listing.json.reference.functions.length);
  assert.equal((await viewer.call(`${API}/${a.id}`)).status, 200);
  assert.equal((await viewer.call(`${API}/${a.id}/run`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await viewer.call(API, { method: 'POST', body: { name: 'n', script: '' } })).status, 403);
  assert.equal((await viewer.call(`${API}/variables/X`, { method: 'PUT', body: { value: '1' } })).status, 403);
});

test('webhook: bearer token, JSON input, result in the response; only a hash is stored', async () => {
  const i = await make({ script: 'return { got: input.n * 2 };' });
  const hook = (token, body) => fetch(`${base}/hooks/integrations/${i.id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

  assert.equal((await hook(null, { n: 1 })).status, 401);
  const { token } = (await admin.call(`${API}/${i.id}/webhook`, { method: 'POST' })).json;
  assert.match(token, /^iwh_/);
  assert.equal(JSON.stringify(db.all('SELECT * FROM integrations')).includes(token), false);
  assert.equal((await hook('iwh_wrong', { n: 1 })).status, 401);
  assert.equal((await fetch(`${base}/hooks/integrations/99999`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 401);

  const ok = await hook(token, { n: 21 });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual([body.status, body.result], ['ok', { got: 42 }]);
  assert.equal(db.get('SELECT trigger, actor FROM integration_runs WHERE integration_id = ? ORDER BY id DESC', i.id).trigger, 'webhook');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'token.auth_failure' AND detail LIKE '%integration-webhook%'"));

  // A script error is a 422 with the message; a disabled integration refuses.
  const failing = await make({ script: 'throw new Error("nope");' });
  const t2 = (await admin.call(`${API}/${failing.id}/webhook`, { method: 'POST' })).json.token;
  const bad = await fetch(`${base}/hooks/integrations/${failing.id}`, { method: 'POST', headers: { authorization: `Bearer ${t2}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.message, 'nope');

  await admin.call(`${API}/${i.id}`, { method: 'PUT', body: { ...i, enabled: false } });
  assert.equal((await hook(token, { n: 1 })).status, 409);
  // A disabled integration can still be tried from the console.
  assert.equal((await runIt(i.id, { n: 1 })).trigger, 'test');

  // Revoking the token stops the webhook.
  await admin.call(`${API}/${i.id}/webhook`, { method: 'DELETE' });
  assert.equal((await hook(token, { n: 1 })).status, 401);
});

test('run history is kept to the newest runs, and changes are audited without the script', async () => {
  const i = await make({ script: 'return input;' });
  for (let n = 0; n < 53; n++) db.run("INSERT INTO integration_runs (integration_id, trigger, status, started_at) VALUES (?, 'manual', 'ok', '')", i.id);
  await runIt(i.id, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM integration_runs WHERE integration_id = ?', i.id).n, 50);

  await admin.call(`${API}/${i.id}`, { method: 'PUT', body: { ...i, script: 'return "SECRET-LOOKING-CODE";' } });
  const upd = db.get("SELECT * FROM audit_log WHERE action = 'integration.update' ORDER BY id DESC");
  assert.equal(JSON.parse(upd.detail).script_changed, true);
  assert.equal(upd.detail.includes('SECRET-LOOKING-CODE'), false);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'integration.run'"));

  assert.equal((await admin.call(`${API}/${i.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM integration_runs WHERE integration_id = ?', i.id).n, 0);
});

/* ------------------------- Schedules, events and documentation ------------------------- */

const schedule = require('../src/integrations/schedule');
const triggers = require('../src/integrations/triggers');
const userApi = require('../src/user-api');
const auditLog = require('../src/audit');

test('schedules: validation, next run times in UTC, and labels', () => {
  assert.deepEqual(schedule.parse({ type: 'interval', minutes: 15 }).schedule, { type: 'interval', minutes: 15 });
  assert.equal(schedule.parse(null).schedule, null);
  for (const bad of [{ type: 'interval', minutes: 1 }, { type: 'interval', minutes: 99999 }, { type: 'daily', at: '25:00' }, { type: 'weekly', day: 7, at: '01:00' }, { type: 'hourly' }]) {
    assert.ok(schedule.parse(bad).errors.length, JSON.stringify(bad));
  }
  const from = new Date('2026-10-14T10:00:00Z'); // a Wednesday
  assert.equal(schedule.nextRun({ type: 'interval', minutes: 30 }, from), '2026-10-14T10:30:00.000Z');
  assert.equal(schedule.nextRun({ type: 'daily', at: '09:00' }, from), '2026-10-15T09:00:00.000Z');
  assert.equal(schedule.nextRun({ type: 'daily', at: '11:00' }, from), '2026-10-14T11:00:00.000Z');
  assert.equal(schedule.nextRun({ type: 'weekly', day: 3, at: '09:00' }, from), '2026-10-21T09:00:00.000Z');
  assert.equal(schedule.nextRun({ type: 'weekly', day: 1, at: '09:00' }, from), '2026-10-19T09:00:00.000Z');
  assert.equal(schedule.describe({ type: 'weekly', day: 1, at: '02:30' }), 'Weekly on Monday at 02:30 UTC');
  assert.equal(schedule.describe({ type: 'interval', minutes: 120 }), 'Every 2 hours');
});

test('custom schedules: weeks on chosen days, and minutes, hours and days', () => {
  const weekly = { type: 'custom', unit: 'week', days: [1, 3], every: 2, at: '09:00', starts_on: '2026-10-12', ends_on: '2026-11-01' }; // starts on a Monday
  assert.deepEqual(schedule.parse(weekly).schedule, weekly);
  assert.equal(schedule.parse({ ...weekly, days: [] }).errors.length, 1);
  assert.equal(schedule.parse({ ...weekly, every: 0 }).errors.length, 1);
  assert.equal(schedule.parse({ ...weekly, every: 53 }).errors.length, 1);
  assert.equal(schedule.parse({ ...weekly, ends_on: '2026-10-01' }).errors.length, 1);
  assert.equal(schedule.parse({ ...weekly, unit: 'year' }).errors.length, 1);
  assert.equal(schedule.nextRun(weekly, new Date('2026-10-01T00:00:00Z')), '2026-10-12T09:00:00.000Z'); // waits for the start date
  assert.equal(schedule.nextRun(weekly, new Date('2026-10-12T10:00:00Z')), '2026-10-14T09:00:00.000Z');
  assert.equal(schedule.nextRun(weekly, new Date('2026-10-14T10:00:00Z')), '2026-10-26T09:00:00.000Z'); // skips the off week
  assert.equal(schedule.nextRun(weekly, new Date('2026-10-28T10:00:00Z')), ''); // past the end date
  assert.match(schedule.describe(weekly), /Every 2 weeks on Mon, Wed at 09:00 UTC, from 2026-10-12 until 2026-11-01/);

  const everyMinute = { type: 'custom', unit: 'minute', every: 1, days: [], at: '09:00', starts_on: '2026-10-14', ends_on: '' };
  assert.deepEqual(schedule.parse(everyMinute).schedule, everyMinute);
  assert.equal(schedule.parse({ ...everyMinute, every: 60 }).errors.length, 1);
  assert.equal(schedule.nextRun(everyMinute, new Date('2026-10-14T08:00:00Z')), '2026-10-14T09:00:00.000Z'); // waits for the first run
  assert.equal(schedule.nextRun(everyMinute, new Date('2026-10-14T09:00:30Z')), '2026-10-14T09:01:00.000Z');
  assert.equal(schedule.describe(everyMinute), 'Every minute, from 2026-10-14 starting 09:00 UTC');

  const everyTwoHours = { type: 'custom', unit: 'hour', every: 2, days: [], at: '08:15', starts_on: '2026-10-14', ends_on: '2026-10-14' };
  assert.equal(schedule.nextRun(everyTwoHours, new Date('2026-10-14T09:00:00Z')), '2026-10-14T10:15:00.000Z');
  assert.equal(schedule.nextRun(everyTwoHours, new Date('2026-10-14T16:00:00Z')), '2026-10-14T16:15:00.000Z'); // the end date's last moment is 23:59:59
  assert.equal(schedule.nextRun(everyTwoHours, new Date('2026-10-14T23:30:00Z')), '');
  assert.equal(schedule.describe(everyTwoHours), 'Every 2 hours, from 2026-10-14 until 2026-10-14 starting 08:15 UTC');

  const everyDay = { type: 'custom', unit: 'day', every: 3, days: [], at: '06:00', starts_on: '2026-10-14', ends_on: '' };
  assert.equal(schedule.nextRun(everyDay, new Date('2026-10-14T07:00:00Z')), '2026-10-17T06:00:00.000Z');
  assert.equal(schedule.describe(everyDay), 'Every 3 days at 06:00 UTC, from 2026-10-14');
});

test('a scheduled integration runs when due, once, and a turned-off one only moves on', async () => {
  const on = await make({ script: 'return { due: input.scheduled_for, type: trigger.type };', schedules: [{ type: 'interval', minutes: 10 }] });
  const off = await make({ script: 'return 1;', enabled: false, schedules: [{ type: 'interval', minutes: 10 }] });
  assert.equal(on.schedules[0].label, 'Every 10 minutes');
  assert.ok(Date.parse(on.schedules[0].next_run_at) > Date.now());
  assert.equal(triggers.runDue(), 0, 'nothing is due yet');

  const past = new Date(Date.now() - 60000).toISOString();
  db.run('UPDATE integration_schedules SET next_run_at = ? WHERE integration_id IN (?, ?)', past, on.id, off.id);
  assert.equal(triggers.runDue(), 1);
  assert.equal(triggers.runDue(), 0, 'the next time was moved on before running, so it cannot start twice');
  await triggers.idle();

  const runs = db.all('SELECT * FROM integration_runs WHERE integration_id = ?', on.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'schedule');
  assert.deepEqual(JSON.parse(runs[0].result), { due: past, type: 'schedule' });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM integration_runs WHERE integration_id = ?', off.id).n, 0);
  assert.ok(Date.parse(db.get('SELECT next_run_at FROM integration_schedules WHERE integration_id = ?', off.id).next_run_at) > Date.now());

  // Saving without touching a schedule keeps its place; changing it restarts the count.
  const keep = (await admin.call(`${API}/${on.id}`, { method: 'PUT', body: { ...(await admin.call(`${API}/${on.id}`)).json, description: 'x' } })).json;
  assert.equal(keep.schedules[0].next_run_at, db.get('SELECT next_run_at FROM integration_schedules WHERE integration_id = ?', on.id).next_run_at);
  const changed = (await admin.call(`${API}/${on.id}`, { method: 'PUT', body: { ...keep, schedules: [{ type: 'daily', at: '03:00' }] } })).json;
  assert.equal(changed.schedules[0].label, 'Daily at 03:00 UTC');
  assert.equal((await admin.call(`${API}/${on.id}`, { method: 'PUT', body: { ...keep, schedules: [{ type: 'interval', minutes: 1 }] } })).status, 400);
  assert.deepEqual((await admin.call(`${API}/${on.id}`, { method: 'PUT', body: { ...keep, schedules: [] } })).json.schedules, []);
});

test('an integration can have several schedules, each with its own next run', async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  const two = await make({ schedules: [{ type: 'daily', at: '07:00' }, { type: 'custom', unit: 'hour', every: 6, days: [], at: '00:00', starts_on: '2026-10-14', ends_on: '' }] });
  assert.deepEqual(two.schedules.map((s) => s.label), ['Daily at 07:00 UTC', 'Every 6 hours, from 2026-10-14 starting 00:00 UTC']);
  const [first, second] = two.schedules;

  assert.equal((await admin.call(API, { method: 'POST', body: { name: `i${Math.random()}`, script: 'return 1;', schedules: Array(11).fill({ type: 'daily', at: '01:00' }) } })).status, 400);

  db.run('UPDATE integration_schedules SET next_run_at = ? WHERE id = ?', past, first.id);
  assert.equal(triggers.runDue(), 1, 'only the due schedule starts a run');
  await triggers.idle();
  assert.equal(db.get('SELECT COUNT(*) AS n FROM integration_runs WHERE integration_id = ?', two.id).n, 1);

  // The unchanged schedule keeps its id and time; the removed one goes and a new one is added.
  const edited = (await admin.call(`${API}/${two.id}`, { method: 'PUT', body: { ...two, schedules: [second, { type: 'weekdays', at: '08:00' }] } })).json;
  assert.equal(edited.schedules.length, 2);
  assert.equal(edited.schedules[0].id, second.id);
  assert.equal(edited.schedules[0].next_run_at, second.next_run_at);
  assert.equal(edited.schedules[1].label, 'Every weekday at 08:00 UTC');

  assert.equal((await admin.call(`${API}/${two.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM integration_schedules WHERE integration_id = ?', two.id).n, 0, 'deleting an integration deletes its schedules');
});

test('events start integrations with an Event as input; a script\'s own changes do not start anything', async () => {
  triggers.listen();
  db.run("INSERT INTO groups (name) VALUES ('Events')");
  const listener = await make({ script: 'return { event: input.event, trigger: trigger.event, username: input.user && input.user.username, via: input.detail.via, group: input.group, member: input.member };',
    events: ['user.created', 'group.member_added'] });
  const quiet = await make({ script: 'return 1;', events: ['user.deleted'] });
  assert.equal((await admin.call(API, { method: 'POST', body: { name: 'bad', script: '', events: ['user.exploded'] } })).status, 400);
  const runsOf = (id) => db.all('SELECT * FROM integration_runs WHERE integration_id = ? ORDER BY id', id);

  // Through the user API (its tokens are type "integration" but are not scripts).
  const token = userApi.createToken({ name: 'hr', scopes: ['users:write'], createdBy: 't' }).token;
  const created = await fetch(`${base}/api/v1/users`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'evt1', password: 'longenough-pass1', groups: ['Events'] }) });
  assert.equal(created.status, 201);
  await triggers.idle();
  const first = runsOf(listener.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].trigger, 'event');
  assert.deepEqual(JSON.parse(first[0].result), { event: 'user.created', trigger: 'user.created', username: 'evt1', via: 'user-api' });

  auditLog.admin('group.member.add', { actor: { type: 'user', id: 1, name: 'admin' }, target: { type: 'group', id: 1, name: 'Events' }, detail: { change: 'evt1' } });
  await triggers.idle();
  assert.deepEqual(JSON.parse(runsOf(listener.id)[1].result), { event: 'group.member_added', trigger: 'group.member_added', group: 'Events', member: 'evt1' });
  assert.equal(runsOf(quiet.id).length, 0);

  // A script creating a user is not an event, so the listener is not started again (no loops).
  const maker = await make({ scopes: ['users:write'], script: 'await idp.users.create({ username: "evt2", password: "longenough-pass1" }); return true;' });
  assert.equal((await runIt(maker.id)).status, 'ok');
  await triggers.idle();
  assert.equal(runsOf(listener.id).length, 2);

  // Turned off, it stops listening; deleting a user reaches a listener of user.deleted without a user object.
  await admin.call(`${API}/${listener.id}`, { method: 'PUT', body: { ...listener, enabled: false } });
  auditLog.admin('user.create', { actor: { type: 'user', id: 1, name: 'admin' }, target: { type: 'user', id: 1, name: 'admin' }, detail: {} });
  await triggers.idle();
  assert.equal(runsOf(listener.id).length, 2);
  await fetch(`${base}/api/v1/users/${db.get("SELECT guid FROM users WHERE username = 'evt1'").guid}`, { method: 'DELETE', headers: { authorization: `Bearer ${userApi.createToken({ name: 'del', scopes: ['users:write'], createdBy: 't' }).token}` } });
  await triggers.idle();
  assert.equal(runsOf(quiet.id).length, 1);
});

test('the Run table, a schedule and an event each give inputs their values, typed; a custom input can be named', async () => {
  triggers.listen();
  const declared = [{ name: 'days', variable: 'days' }, { name: 'email', variable: 'email' }];
  const typedRun = await make({ script: 'return input;', inputs: declared });
  const values = (body) => admin.call(`${API}/${typedRun.id}/run`, { method: 'POST', body });
  const ran = await settled(typedRun.id, (await values({ values: [{ name: 'days', type: 'number', value: '90' }, { name: 'note', type: 'yes_no', value: 'Yes' }, { name: 'blank', type: 'text', value: '' }, { name: 'extra', type: 'json', value: '{"a":[1]}' }] })).json.run.id);
  assert.deepEqual(ran.input, { days: 90, note: true, blank: null, extra: { a: [1] } });
  assert.equal((await values({ values: [{ name: 'days', type: 'number', value: 'many' }] })).status, 400);
  assert.equal((await values({ values: [{ name: 'days', type: 'time', value: '1' }] })).status, 400);
  assert.equal((await values({ values: [{ name: 'days', type: 'number', value: '1' }, { name: 'days', type: 'text', value: '2' }] })).status, 400);

  const scheduled = await make({ script: 'return input;', schedules: [{ type: 'interval', minutes: 10, inputs: [{ name: 'days', type: 'number', value: '30' }] }] });
  assert.deepEqual(scheduled.schedules[0].inputs, [{ name: 'days', type: 'number', value: '30' }]);
  const past = new Date(Date.now() - 60000).toISOString();
  db.run('UPDATE integration_schedules SET next_run_at = ? WHERE integration_id = ?', past, scheduled.id);
  triggers.runDue();
  await triggers.idle();
  assert.deepEqual(JSON.parse(db.get('SELECT result FROM integration_runs WHERE integration_id = ?', scheduled.id).result), { days: 30, scheduled_for: past });

  // An event takes one input from the user it is about, and gives another a value of its own.
  assert.equal((await admin.call(API, { method: 'POST', body: { name: `i${Math.random()}`, script: 'return 1;', event_inputs: [{ name: 'who', from: 'user.email' }] } })).status, 400, 'no event chosen');
  assert.equal((await admin.call(API, { method: 'POST', body: { name: `i${Math.random()}`, script: 'return 1;', events: ['user.deleted'], event_inputs: [{ name: 'who', from: 'user.email' }] } })).status, 400, 'a field the chosen events do not have');
  const mapped = await make({ script: 'return { who: input.who, source: input.source, event: input.event };', events: ['user.created'],
    event_inputs: [{ name: 'who', from: 'user.email' }, { name: 'source', type: 'text', value: 'hr' }] });
  const token = userApi.createToken({ name: 'map', scopes: ['users:write'], createdBy: 't' }).token;
  assert.equal((await fetch(`${base}/api/v1/users`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'evt3', email: 'sam@example.net', password: 'longenough-pass1' }) })).status, 201);
  await triggers.idle();
  const got = db.all('SELECT result FROM integration_runs WHERE integration_id = ?', mapped.id).map((r) => JSON.parse(r.result));
  assert.deepEqual(got, [{ who: 'sam@example.net', source: 'hr', event: 'user.created' }]);
});

test('the reference documents objects field by field, events, triggers and functions', async () => {
  db.run("INSERT INTO attribute_defs (name, label, type, options, required, default_value) VALUES ('grade', 'Grade', 'enum', '[\"A\",\"B\"]', 0, '')");
  const ref = (await admin.call(API)).json.reference;
  const type = (n) => ref.types.find((t) => t.name === n);
  assert.deepEqual(['User', 'NewUser', 'UserPatch', 'Group', 'GroupMember', 'HttpRequest', 'HttpResponse', 'Message', 'Trigger', 'Event', 'WebhookResponse'].filter((n) => !type(n)), []);
  for (const t of ref.types) { assert.ok(t.fields.length && t.description, t.name); assert.ok(t.example, t.name); for (const f of t.fields) assert.ok(f.name && f.type, `${t.name}.${f.name}`); }
  const user = type('User');
  assert.ok(['id', 'username', 'employee_id', 'emails', 'groups', 'attributes', 'active'].every((n) => user.fields.some((f) => f.name === n)));
  assert.match(user.fields.find((f) => f.name === 'attributes').description, /grade \(enum: A \| B\)/, 'defined attributes are listed');
  assert.ok(type('NewUser').fields.find((f) => f.name === 'username').required);
  for (const g of ref.functions) for (const it of g.items) assert.ok(it.signature && it.description && (it.returns !== undefined), it.signature);
  assert.ok(ref.functions.flatMap((g) => g.items).filter((it) => it.example).length >= 5);
  assert.deepEqual(ref.events.map((e) => e.name).sort(), ['group.member_added', 'group.member_removed', 'login.failed', 'login.succeeded', 'user.created', 'user.deleted', 'user.locked_down', 'user.password_reset', 'user.updated']);
  assert.ok(ref.events.every((e) => e.example.event === e.name));
  assert.deepEqual(ref.triggers.map((t) => t.name), ['Console', 'Webhook', 'Schedule', 'Event']);
  assert.ok(ref.limits.length);
});

test('output() and log levels are captured with default and per-line colors', async () => {
  const r = await direct(`output("one", { a: 1 });
output.color("green", "two");
log.debug("d");
log.warning("w");
log.error.color("#b3261e", "e");
console.warn("cw");`);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.output.map((o) => [o.text, o.color]), [['one {"a":1}', 'default'], ['two', 'green']]);
  assert.deepEqual(r.logs.map((l) => [l.level, l.text, l.color]), [['debug', 'd', 'grey'], ['warning', 'w', 'orange'], ['error', 'e', '#b3261e'], ['warning', 'cw', 'orange']]);
  const bad = await direct('output.color("plaid", "x");');
  assert.equal(bad.status, 'error');
  assert.match(bad.error.message, /Unknown color/);
});

test('a running integration\'s lines are pushed to a follower as they are printed, then the end', async () => {
  const integrations = require('../src/integrations');
  const created = await admin.call('/api/admin/integrations', { method: 'POST', body: { name: 'Streamer', script: 'output("first"); log("seen"); await sleep(1500); output("second"); return 1;', scopes: [] } });
  const id = created.json.id;
  const started = (await admin.call(`${API}/${id}/run`, { method: 'POST', body: {} })).json.run;
  assert.equal(started.status, 'running');
  const seen = [];
  const stop = integrations.follow(started.id, {
    snapshot: (lines) => seen.push(['snapshot', lines.output.map((o) => o.text)]),
    line: (stream, line) => seen.push(['line', stream, line.text]),
    end: () => seen.push(['end']),
  });
  assert.ok(stop, 'a running run can be followed');
  while (!seen.some((e) => e[0] === 'end')) await new Promise((x) => setTimeout(x, 10));
  const outputLines = seen.flatMap((e) => (e[0] === 'snapshot' ? e[1] : e[0] === 'line' && e[1] === 'output' ? [e[2]] : []));
  assert.deepEqual(outputLines, ['first', 'second']);
  assert.equal(integrations.follow(started.id, {}), null, 'a finished run is no longer followed');
  const done = await settled(id, started.id);
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.output.map((o) => o.text), ['first', 'second']);
});

test('the logging engine saves lines at or above the chosen level, and the console can read them', async () => {
  const logging = require('../src/integrations/logging');
  const created = await admin.call('/api/admin/integrations', { method: 'POST', body: { name: 'Logger', script: 'log.debug("quiet"); log.warning("loud"); output("printed"); return 1;', scopes: [] } });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal((await admin.call('/api/admin/integrations/logging', { method: 'PUT', body: { saveLevel: 'warning', saveOutput: true, retentionDays: 30, colors: { warning: 'purple' } } })).status, 200);
  const run = await runNow(id, {});
  assert.deepEqual(run.output.map((o) => o.text), ['printed']);
  assert.equal(run.logs.length, 2);
  const saved = (await admin.call(`/api/admin/integrations/logs?integration=${id}`)).json.lines;
  assert.deepEqual(saved.map((l) => [l.stream, l.level, l.text]).sort(), [['log', 'warning', 'loud'], ['output', 'normal', 'printed']]);
  assert.equal(saved.find((l) => l.text === 'loud').color, 'purple');
  assert.equal((await admin.call('/api/admin/integrations/logs?level=error')).json.lines.filter((l) => l.stream === 'log').length, 0);
  assert.equal((await admin.call('/api/admin/integrations/logging', { method: 'PUT', body: { saveLevel: 'warning', retentionDays: 30, colors: { warning: 'plaid' } } })).status, 400);
  logging.save({ ...logging.DEFAULTS });
  // Saved lines are kept in files: today's file for the integration.
  assert.equal((await admin.call(`/api/admin/integrations/logs?integration=${id}`, { method: 'DELETE' })).json.removed, 1);
  assert.equal((await admin.call(`/api/admin/integrations/logs?integration=${id}`)).json.lines.length, 0);
});

test('a run can start again with its input; one whose input kept a secret or was too long to keep cannot', async () => {
  const it = await make({ script: 'return input;' });
  const first = await runIt(it.id, { n: 1 });
  const again = await admin.call(`${API}/${it.id}/runs/${first.id}/rerun`, { method: 'POST' });
  assert.equal(again.status, 202);
  assert.notEqual(again.json.run.id, first.id);
  const rerun = await settled(it.id, again.json.run.id);
  assert.deepEqual(rerun.input, { n: 1 });
  assert.deepEqual(rerun.result, { n: 1 });
  assert.equal(rerun.trigger, 'manual');

  const secret = await runIt(it.id, { password: 'hunter2-hunter2' });
  const refused = await admin.call(`${API}/${it.id}/runs/${secret.id}/rerun`, { method: 'POST' });
  assert.equal(refused.status, 409);
  assert.match(refused.json.errors[0], /secret value/);

  const long = await runIt(it.id, { text: 'x'.repeat(5000) });
  const tooLong = await admin.call(`${API}/${it.id}/runs/${long.id}/rerun`, { method: 'POST' });
  assert.equal(tooLong.status, 409);
  assert.match(tooLong.json.errors[0], /too long/);

  assert.equal((await admin.call(`${API}/${it.id}/runs/999999/rerun`, { method: 'POST' })).status, 404);
});

test('a run can save log lines at a level of its own, in place of the integration\'s setting', async () => {
  const logStore = require('../src/files/logs');
  const it = await make({ script: "log.debug('quiet one'); return 1;", logging: { inherit: false, saveLevel: 'off', saveOutput: false, retentionDays: 30 } });
  const saved = (run) => logStore.query({ integration: it.id, run: run.id, limit: 50 }).lines.map((l) => l.text);
  const plain = await runNow(it.id, {});
  assert.deepEqual(saved(plain), []);
  const debug = await runNow(it.id, { save_level: 'debug' });
  assert.deepEqual(saved(debug), ['quiet one']);
  const off = await runNow(it.id, { save_level: 'off' });
  assert.deepEqual(saved(off), []);
  assert.equal((await admin.call(`${API}/${it.id}/run`, { method: 'POST', body: { save_level: 'loud' } })).status, 400);
});
