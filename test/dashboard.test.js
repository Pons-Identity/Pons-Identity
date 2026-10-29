process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function adminClient() {
  let cookie = '';
  let csrf = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  csrf = (await call('/api/session')).json.csrf;
  await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  csrf = (await call('/api/session')).json.csrf;
  return call;
}

const HOUR = 3600;
const BUCKET = 15 * 60;
const now = () => Math.floor(Date.now() / 1000);
const event = (ts, type, outcome, reason = '') => db.run(
  'INSERT INTO auth_events (ts, type, outcome, reason, username, ip) VALUES (?, ?, ?, ?, ?, ?)', ts, type, outcome, reason, 'dash-test', '198.51.100.44');

test('dashboard counts directory objects and reports sign-ins for the last 24 hours, 15 minutes at a time', async () => {
  const call = await adminClient();
  const t = now();
  // Two hours back: three completed sign-ins, one refused password, one denied sign-in, one failed second step.
  const at = t - 2 * HOUR - 100;
  for (let i = 0; i < 3; i += 1) event(at, 'signin', 'success');
  event(at, 'password', 'failure', 'bad_credentials');
  event(at, 'signin', 'failure', 'blocked_by_risk');
  event(at, 'mfa', 'failure', 'failed');
  // Older than 24 hours: must not be counted.
  event(t - 25 * HOUR, 'signin', 'success');

  const r = await call('/api/admin/dashboard');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.users, 'number');
  assert.equal(typeof r.json.activeUsers, 'number');
  assert.equal(typeof r.json.groups, 'number');
  assert.equal(typeof r.json.sps, 'number');
  assert.equal(typeof r.json.roles, 'number');
  assert.ok(r.json.activeUsers <= r.json.users);

  const s = r.json.signIns;
  assert.equal(s.buckets.length, 96);
  assert.ok(s.buckets.every((b, i) => i === 0 || b.ts === s.buckets[i - 1].ts + BUCKET), 'buckets are consecutive');
  assert.ok(s.buckets[95].ts <= t && t < s.buckets[95].ts + BUCKET, 'the last bucket is the current 15 minutes');
  const bucket = s.buckets.find((b) => b.ts <= at && at < b.ts + BUCKET);
  assert.equal(bucket.succeeded, 3);
  assert.equal(bucket.failed, 3);
  assert.ok(s.succeeded >= 3 && s.failed >= 3);
  assert.ok(s.usersSignedIn >= 0);
});

test('the dashboard requires a signed-in administrator', async () => {
  const r = await fetch(`${base}/api/admin/dashboard`);
  assert.equal(r.status, 401);
});
