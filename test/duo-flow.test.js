process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const settings = require('../src/settings');
const { newGuid } = require('../src/guid');
const { hashPassword } = require('../src/crypto');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)', newGuid(), 'dana', hashPassword('pw'), 'dana@x.com');

// Stub the Duo Auth API; everything else goes to the real network stack.
const realFetch = globalThis.fetch;
// `expiresIn` is how long a Verified Push transaction lives from its preauth, in seconds. `pushes` records the body of each push.
const duo = { preauth: 'auth', push: 'allow', passcode: 'allow', fail: false, expiresIn: 60, verified: true, pushes: [], preauths: 0 };
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://api.duo.test/')) return realFetch(url, opts);
  const path = new URL(url).pathname;
  const reply = (response) => new Response(JSON.stringify({ stat: 'OK', response }), { headers: { 'content-type': 'application/json' } });
  if (duo.fail) return new Response('{"stat":"FAIL","code":42901,"message":"busy"}', { status: 429 });
  if (path === '/auth/v2/preauth') {
    const body = JSON.parse(opts.body);
    duo.preauths += 1;
    const verified = body.client_supports_verified_push === '1' && duo.verified
      ? { txid: `vtx${duo.preauths}`, verification_code: '482913', expiration: Math.floor(Date.now() / 1000) + duo.expiresIn }
      : {};
    return reply({ result: duo.preauth, devices: [{ device: 'DP1', type: 'phone', capabilities: ['auto', 'push'] }], ...verified });
  }
  if (path === '/auth/v2/auth') {
    const body = JSON.parse(opts.body);
    if (body.factor === 'push') { duo.pushes.push(body); return reply({ txid: 'tx1' }); }
    return reply({ result: duo.passcode, status: duo.passcode });
  }
  if (path === '/auth/v2/auth_status') return reply({ result: duo.push, status: duo.push });
  return new Response('{}', { status: 404 });
};

settings.duoApiHost = 'api.duo.test';
settings.duoIntegrationKey = 'DIKEY';
settings.duoSecretKey = 'secret';

function harness() {
  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return r;
  };
  // Logins and Duo steps regenerate the session, so the CSRF token is re-read before each write.
  const csrf = async () => (await (await call('/api/session')).json()).csrf;
  const api = async (path, body) => call(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': await csrf() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { server, call, api, csrf };
}

test('Duo push: password, then Duo, then polled allow reaches the app', async () => {
  Object.assign(duo, { preauth: 'auth', push: 'allow', passcode: 'allow', fail: false });
  const h = harness();
  try {
    let r = await h.api('/login', { username: 'dana', password: 'pw', next: '/' });
    assert.deepEqual(await r.json(), { mfa: 'duo' });
    const pending = await (await h.api('/login/duo')).json();
    assert.equal(pending.canPush, true);
    r = await h.api('/login/duo/push', {});
    assert.equal(r.status, 200);
    const status = await (await h.call('/api/login/duo/status')).json();
    assert.deepEqual(status, { result: 'allow', next: '/' });
    r = await h.call('/api/apps');
    assert.equal(r.status, 200, 'signed in after Duo allow');
  } finally { h.server.close(); }
});

test('Duo passcode: wrong code is retried, correct code signs in', async () => {
  Object.assign(duo, { preauth: 'auth', push: 'allow', passcode: 'deny', fail: false });
  const h = harness();
  try {
    await h.api('/login', { username: 'dana', password: 'pw', next: '/' });
    let r = await h.api('/login/duo/passcode', { code: '000000' });
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /Incorrect or expired code/);
    duo.passcode = 'allow';
    r = await h.api('/login/duo/passcode', { code: '123 456' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { next: '/' });
    assert.equal((await h.call('/api/apps')).status, 200);
  } finally { h.server.close(); }
});

test('Duo deny at preauth blocks sign-in; Duo outage fails closed', async () => {
  const h = harness();
  try {
    Object.assign(duo, { preauth: 'deny', fail: false });
    let r = await h.api('/login', { username: 'dana', password: 'pw', next: '/' });
    assert.equal(r.status, 403);
    Object.assign(duo, { preauth: 'auth', fail: true });
    r = await h.api('/login', { username: 'dana', password: 'pw', next: '/' });
    assert.equal(r.status, 503);
  } finally {
    duo.fail = false;
    h.server.close();
  }
});

test('Duo allow (policy bypass) skips the Duo step', async () => {
  Object.assign(duo, { preauth: 'allow', fail: false });
  const h = harness();
  try {
    const r = await h.api('/login', { username: 'dana', password: 'pw', next: '/' });
    assert.deepEqual(await r.json(), { mfa: null, next: '/' });
  } finally { h.server.close(); }
});

test('Verified Push: the number is shown, and the push carries the preauth txid', async () => {
  Object.assign(duo, { preauth: 'auth', push: 'allow', passcode: 'allow', fail: false, expiresIn: 60, verified: true, pushes: [], preauths: 0 });
  const h = harness();
  try {
    await h.api('/login', { username: 'dana', password: 'pw', next: '/' });
    const pending = await (await h.call('/api/login/duo')).json();
    assert.equal(pending.verificationCode, '482913');
    const r = await h.api('/login/duo/push', {});
    assert.equal(r.status, 200);
    assert.equal(duo.pushes.length, 1);
    assert.equal(duo.pushes[0].txid, 'vtx1');
    assert.equal(duo.pushes[0].async, '1');
    assert.deepEqual(await (await h.call('/api/login/duo/status')).json(), { result: 'allow', next: '/' });
    // The number is forgotten once the transaction is finished.
    const after = await (await h.call('/api/login/duo')).json();
    assert.equal(after.verificationCode, null);
  } finally { h.server.close(); }
});

test('Verified Push: a transaction that expired while the page sat open is replaced before the push', async () => {
  Object.assign(duo, { preauth: 'auth', push: 'allow', passcode: 'allow', fail: false, expiresIn: -60, verified: true, pushes: [], preauths: 0 });
  const h = harness();
  try {
    await h.api('/login', { username: 'dana', password: 'pw', next: '/' });
    assert.equal((await (await h.call('/api/login/duo')).json()).verificationCode, null, 'expired number is not shown');
    duo.expiresIn = 60;
    const r = await h.api('/login/duo/push', {});
    assert.equal(r.status, 200);
    assert.equal(duo.preauths, 2, 'preauth asked again for a fresh transaction');
    assert.equal(duo.pushes[0].txid, 'vtx2');
    assert.deepEqual(await (await h.call('/api/login/duo/status')).json(), { result: 'allow', next: '/' });
  } finally { h.server.close(); }
});

test('Duo without Verified Push sends no txid and shows no number', async () => {
  Object.assign(duo, { preauth: 'auth', push: 'allow', passcode: 'allow', fail: false, expiresIn: 60, verified: false, pushes: [], preauths: 0 });
  const h = harness();
  try {
    await h.api('/login', { username: 'dana', password: 'pw', next: '/' });
    assert.equal((await (await h.call('/api/login/duo')).json()).verificationCode, null);
    assert.equal((await h.api('/login/duo/push', {})).status, 200);
    assert.equal(duo.pushes[0].txid, undefined);
  } finally {
    duo.verified = true;
    h.server.close();
  }
});
