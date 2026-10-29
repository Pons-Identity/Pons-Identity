process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
process.env.ALLOW_PRIVATE_FETCH = 'true'; // the restCall test calls a stub API on localhost
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const db = require('../src/db');
const { createApp, seedAdmin } = require('../src/server');
const engine = require('../src/integrations/engine');
const functions = require('../src/integrations/functions');
const inputNames = require('../src/integrations/input-names');
const starters = require('../src/integrations/starter-functions');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
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
const saveFn = (name, script, description = '', inputs = []) => admin.call(`${API}/functions/${name}`, { method: 'PUT', body: { description, script, inputs } });
const makeIntegration = async (script, scopes = []) => (await admin.call(API, { method: 'POST', body: { name: `i${Math.random()}`, script, scopes } })).json;
// The console starts a run and answers at once; wait for it to end, as its page does.
const settled = async (id, runId) => {
  for (;;) {
    const r = (await admin.call(`${API}/${id}/runs/${runId}`)).json.run;
    if (r.status !== 'running') return r;
    await new Promise((x) => setTimeout(x, 10));
  }
};
const runNow = async (id, body) => settled(id, (await admin.call(`${API}/${id}/run`, { method: 'POST', body })).json.run.id);
const direct = (script, { scopes = [], trigger = 'manual', perms = null } = {}) => engine.run(
  { id: 0, name: 'direct', script, scopes, timeoutSeconds: 3 },
  { input: null, trigger, perms, functions: functions.sources() },
);

test('sign in as the administrator', async () => {
  await admin.login('admin', 'adminpass123');
});

test('the starter functions are in place from the first start', async () => {
  const { functions: list } = (await admin.call(`${API}/functions`)).json;
  const names = list.map((f) => f.name);
  for (const n of ['normalizeEmail', 'splitName', 'toE164', 'parseBoolean', 'chunk', 'requestJson', 'restCall', 'findOrCreateUser', 'addToGroups']) {
    assert.ok(names.includes(n), `missing starter ${n}`);
  }
  assert.equal(list.find((f) => f.name === 'normalizeEmail').created_by, 'starter');
});

test('every starter function takes only inputs the Inputs table offers', () => {
  const offered = new Set(inputNames.catalog.map((c) => c.name));
  for (const f of starters) {
    for (const i of f.inputs) assert.ok(offered.has(i.name), `starter ${f.name} takes ${i.name}, which is not in the input list`);
  }
});

test('starter functions behave as their descriptions say', async () => {
  const r = await direct(`return {
    email: await fn.normalizeEmail({ email: '  Sam@Example.NET ' }),
    bad: await fn.normalizeEmail({ email: 'not an address' }),
    name: await fn.splitName({ display_name: 'Sam Augusta King Rivera' }),
    slug: await fn.slugify({ text: 'Crème brûlée & Tea!' }),
    phone: [await fn.toE164({ phone: '(555) 123-4567' }), await fn.toE164({ phone: '+44 20 7946 0958' }), await fn.toE164({ phone: '12' })],
    bools: [await fn.parseBoolean({ value: 'Yes' }), await fn.parseBoolean({ value: '' }), await fn.parseBoolean({ value: 'maybe' })],
    batches: await fn.chunk({ items: [1, 2, 3, 4, 5], size: 2 }),
    unique: await fn.uniqueBy({ items: [{ e: 'a' }, { e: 'b' }, { e: 'a' }], key: 'e' }),
    full: await fn.fullName({ first_name: ' Sam ', last_name: '' }),
  };`);
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  const out = JSON.parse(r.result);
  assert.equal(out.email, 'sam@example.net');
  assert.equal(out.bad, '');
  assert.deepEqual(out.name, { first_name: 'Sam', last_name: 'Augusta King Rivera' });
  assert.equal(out.slug, 'creme-brulee-tea');
  assert.deepEqual(out.phone, ['+15551234567', '+442079460958', '']);
  assert.deepEqual(out.bools, [true, false, null]);
  assert.deepEqual(out.batches, [[1, 2], [3, 4], [5]]);
  assert.equal(out.unique.length, 2);
  assert.equal(out.full, 'Sam');
});

test('restCall sends the method, path, query and token to the API, and returns the status and data', async () => {
  const seen = [];
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.startsWith('/v1/people/missing')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"error":"no such person"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 7, active: false }));
    });
  }).listen(0);
  test.after(() => api.close());
  const apiBase = `http://localhost:${api.address().port}/v1/`;
  const r = await direct(`const ok = await fn.restCall({ request: { baseUrl: ${JSON.stringify(apiBase)}, path: '/people/7', method: 'patch', query: { fields: 'name', skip: undefined }, token: 'secret-token', body: { active: false } } });
let missing;
try { await fn.restCall({ request: { baseUrl: ${JSON.stringify(apiBase)}, path: 'people/missing' } }); } catch (e) { missing = e.message; }
let insecure;
try { await fn.restCall({ request: { baseUrl: 'ftp://files.example.net', path: '/people' } }); } catch (e) { insecure = e.message; }
return { ok, missing, insecure };`, { scopes: ['http'] });
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  const out = JSON.parse(r.result);
  assert.deepEqual(out.ok, { status: 200, data: { id: 7, active: false } });
  assert.equal(seen[0].method, 'PATCH');
  assert.equal(seen[0].url, '/v1/people/7?fields=name');
  assert.equal(seen[0].auth, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(seen[0].body), { active: false });
  assert.equal(seen[1].method, 'GET');
  assert.equal(seen[1].url, '/v1/people/missing');
  assert.match(out.missing, /GET http:\/\/localhost:\d+\/v1\/people\/missing answered 404: .*no such person/);
  assert.ok(!out.missing.includes('secret-token'));
  assert.match(out.insecure, /needs a baseUrl that starts with https/);
});

test('a function can call another function and return a value to the caller', async () => {
  const address = [{ name: 'address', variable: 'address' }];
  assert.equal((await saveFn('domainOf', 'const normalized = await fn.normalizeEmail({ email: address });\nreturn normalized ? normalized.split("@")[1] : null;', '', address)).status, 200);
  assert.equal((await saveFn('isStaffEmail', 'return (await fn.domainOf({ address })) === "example.net";', '', address)).status, 200);
  const r = await direct('return [await fn.isStaffEmail({ address: "sam@EXAMPLE.net" }), await fn.isStaffEmail({ address: "x@other.org" })];');
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  assert.deepEqual(JSON.parse(r.result), [true, false]);
});

test('a function gets only the scopes of the integration that calls it', async () => {
  const r = await direct('return await fn.findOrCreateUser({ email: "sam@example.net", first_name: "Sam", last_name: "L" });', { scopes: ['groups:read'] });
  assert.equal(r.status, 'error');
  assert.match(r.error.message, /users:read/);
});

test('a function that throws reports its message to the caller', async () => {
  const days = [{ name: 'days', variable: 'days' }];
  assert.equal((await saveFn('needsDate', 'if (typeof days !== "number") throw new Error("Pass a number of days.");\nreturn days;', '', days)).status, 200);
  const r = await direct('return await fn.needsDate({ days: "ninety" });');
  assert.equal(r.status, 'error');
  assert.equal(r.error.message, 'Pass a number of days.');
});

test('a function with a syntax error is refused, with its line, and nothing is saved', async () => {
  const res = await saveFn('broken', 'const x = ;\nreturn x;');
  assert.equal(res.status, 400);
  assert.match(res.json.errors.join(' '), /Script error on line 1/);
  assert.equal(db.get('SELECT 1 FROM integration_functions WHERE name = ?', 'broken'), undefined);
});

test('names must be identifiers, and may not reuse JavaScript object names', async () => {
  assert.equal((await saveFn('2fast', 'return 1;')).status, 400);
  assert.equal((await saveFn('my-fn', 'return 1;')).status, 400);
  const res = await saveFn('constructor', 'return 1;');
  assert.equal(res.status, 400);
  assert.match(res.json.errors.join(' '), /reserved/);
});

test('an empty function is refused', async () => {
  const res = await saveFn('empty', '   ');
  assert.equal(res.status, 400);
  assert.match(res.json.errors.join(' '), /Write the function/);
});

test('saving again replaces the function, and it is what the next run calls', async () => {
  const who = [{ name: 'name', variable: 'name' }];
  assert.equal((await saveFn('greet', 'return "hello " + name;', 'Greets', who)).status, 200);
  assert.equal((await saveFn('greet', 'return "hi " + name;', 'Greets', who)).json.functions.find((f) => f.name === 'greet').script, 'return "hi " + name;');
  const r = await direct('return await fn.greet({ name: "Sam" });');
  assert.equal(JSON.parse(r.result), 'hi Sam');
});

test('deleting a function makes a script that calls it fail', async () => {
  assert.equal((await saveFn('temporary', 'return 1;')).status, 200);
  const del = await admin.call(`${API}/functions/temporary`, { method: 'DELETE' });
  assert.ok(!del.json.functions.some((f) => f.name === 'temporary'));
  const r = await direct('return await fn.temporary();');
  assert.equal(r.status, 'error');
  assert.match(r.error.message, /not a function/);
});

test('deleting a starter function removes it, and the starters are only added when the table is first created', async () => {
  const { json } = await admin.call(`${API}/functions/dateInDays`, { method: 'DELETE' });
  assert.ok(!json.functions.some((f) => f.name === 'dateInDays'));
  assert.equal(db.get('SELECT 1 FROM integration_functions WHERE name = ?', 'dateInDays'), undefined);
});

test('reports get no functions', async () => {
  const r = await direct('return typeof fn.normalizeEmail;', { trigger: 'report', perms: new Set() });
  assert.equal(JSON.parse(r.result), 'undefined');
});

test('a console run of an integration can call functions', async () => {
  assert.equal((await saveFn('plusOne', 'return n + 1;', '', [{ name: 'n', variable: 'n' }])).status, 200);
  const integration = await makeIntegration('return await fn.plusOne({ n: input.n });');
  const run = await runNow(integration.id, { input: { n: 41 } });
  assert.equal(run.status, 'ok', JSON.stringify(run.error));
  assert.equal(run.result, 42);
});

test('the reference lists the administrator\'s functions under Your functions', async () => {
  const { json } = await admin.call(API);
  const group = json.reference.functions.find((g) => g.group === 'Your functions');
  assert.ok(group.items.some((i) => i.signature === 'await fn.plusOne({ n: value })'));
});

test('the inputs table is checked: a variable is used once, is a usable name, and may not hide what the code has', async () => {
  const twice = await saveFn('twice', 'return a;', '', [{ name: 'x', variable: 'a' }, { name: 'y', variable: 'a' }]);
  assert.equal(twice.status, 400);
  assert.match(twice.json.errors.join(' '), /used twice/);
  const reserved = await saveFn('usesArgs', 'return 1;', '', [{ name: 'x', variable: 'args' }]);
  assert.equal(reserved.status, 400);
  const notAName = await saveFn('notAName', 'return 1;', '', [{ name: 'x', variable: 'first-name' }]);
  assert.equal(notAName.status, 400);
  const clash = await saveFn('clashes', 'const email = 1;\nreturn email;', '', [{ name: 'email', variable: 'email' }]);
  assert.equal(clash.status, 400);
  assert.match(clash.json.errors.join(' '), /Script error/);
});

test('a function reads each input from its variable, and an input that is not passed is undefined', async () => {
  const inputs = [{ name: 'first name', variable: 'first' }, { name: 'nick', variable: 'nick' }];
  assert.equal((await saveFn('hello', 'return [first, nick ?? "none"];', '', inputs)).status, 200);
  const r = await direct('return await fn.hello({ "first name": "Sam" });');
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  assert.deepEqual(JSON.parse(r.result), ['Sam', 'none']);
});

test('an integration\'s inputs are variables bound from its input', async () => {
  const r = await engine.run(
    { id: 0, name: 'direct', script: 'return { who: greeting, rest: input };', scopes: [], timeoutSeconds: 3, inputs: [{ name: 'hello', variable: 'greeting' }] },
    { input: { hello: 'hi' } },
  );
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  assert.deepEqual(JSON.parse(r.result), { who: 'hi', rest: { hello: 'hi' } });
});
