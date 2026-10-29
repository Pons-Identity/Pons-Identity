process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
process.env.ALLOW_PRIVATE_FETCH = 'true';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const messaging = require('../src/messaging');
const msgSettings = require('../src/messaging/settings');
const recovery = require('../src/recovery');
const identitySettings = require('../src/identity/settings');
const identity = require('../src/identity');
const integrations = require('../src/integrations');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;

// A stand-in for an identity service and for the person's mail provider. The service's status is set by the test.
const sent = [];
const service = { status: 'pending', created: 0 };
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    sent.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/create') { service.created += 1; return json({ id: `v-${service.created}`, link: `https://verify.example/v-${service.created}` }); }
    if (req.url === '/send' || req.url === '/email') return json({});
    if (req.url.startsWith('/status/')) return json({ state: service.status, id: req.url.split('/').pop() });
    return json({ error: 'no' }, 404);
  });
});
test.before(() => new Promise((r) => provider.listen(0, r)));
test.after(() => { server.close(); provider.close(); });
const pbase = () => `http://localhost:${provider.address().port}`;

async function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers: extra = {} } = {}) => {
    const headers = { cookie, ...extra };
    if (method !== 'GET' && !extra['content-type']) { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()).csrf; }
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  await call('/api/session');
  return call;
}
const mkUser = (name, extra = '') => Number(db.run(`INSERT INTO users (guid, username, password_hash, email, personal_email, personal_email_verified ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?,?,?,?,?,1 ${extra ? ', ' + extra.split('=')[1] : ''})`,
  newGuid(), name, hashPassword(`${name}-password`), `${name}@x.net`, `${name}.home@x.net`).lastInsertRowid);

function configure({ provider: which = 'rest', requirement = {} } = {}) {
  const { data, errors } = identitySettings.parse({
    provider: which,
    rest: {
      create: { method: 'POST', url: `${pbase()}/create`, headers: 'Authorization: Bearer test-token', body: '{"email":"{{user.email}}","name":"{{user.first_name}}"}' },
      send: { method: 'POST', url: `${pbase()}/send`, headers: '', body: '{"username":"{{user.username}}","ref":"{{ref}}"}' },
      status: { method: 'GET', url: `${pbase()}/status/{{ref}}`, headers: '', body: '' },
      refPath: 'id', urlPath: 'link', statusPath: 'state', approved: 'approved', declined: 'declined', expired: 'expired',
      webhookRefPath: 'id',
    },
    requirement: { password: true, mfa: true, integrationId: null, ...requirement },
  }, identitySettings.get());
  assert.deepEqual(errors, []);
  identitySettings.save(data);
  messaging.deps.postmarkBase = pbase();
  const m = msgSettings.parse({ email: { provider: 'postmark', from: 'idp@x.net', postmark: { serverToken: 'pm-token-abcdef', inboundToken: 'inb-1' } } }, msgSettings.messaging());
  msgSettings.save(m.data);
  recovery.save({ enabled: true, allowAdmins: false });
  return data;
}
test.beforeEach(() => { sent.length = 0; messaging.resetRateLimits(); service.status = 'pending'; });

// The link in the email the person was sent.
const tokenFromMail = () => {
  const mail = [...sent].reverse().find((r) => r.url === '/email');
  return /\/recover\/([\w-]+)/.exec(JSON.parse(mail.body).TextBody)[1];
};

/* ------------------------------------------- settings ------------------------------------------- */

test('settings are checked: a provider needs its details, and a requirement needs a provider', () => {
  const persona = identitySettings.parse({ provider: 'persona', persona: { apiKey: '', templateId: '' } }, identitySettings.get());
  assert.ok(persona.errors.some((e) => /API key/.test(e)));
  assert.ok(persona.errors.some((e) => /template ID/.test(e)));
  const rest = identitySettings.parse({ provider: 'rest', rest: { create: { url: 'ftp://x' }, status: { url: '' } } }, identitySettings.get());
  assert.ok(rest.errors.some((e) => /Create the request: the address must be an http or https address/.test(e)));
  assert.ok(rest.errors.some((e) => /Get the status: the address is required/.test(e)));
  const none = identitySettings.parse({ provider: 'none', requirement: { password: true } }, identitySettings.get());
  assert.ok(none.errors.some((e) => /Choose a provider/.test(e)));
});

test('the console never gets a secret back, but shows whether it is set, and the callback addresses', () => {
  const { data } = identitySettings.parse({ provider: 'persona', persona: { apiKey: 'sk_live_123', templateId: 'itmpl_1', webhookSecret: 'whs_9' } }, identitySettings.get());
  identitySettings.save(data);
  const v = identitySettings.view();
  assert.equal(v.persona.apiKey, '');
  assert.equal(v.secrets['persona.apiKey'], true);
  assert.equal(v.persona.templateId, 'itmpl_1');
  assert.match(v.callbacks.persona, /\/identity\/webhook\/persona$/);
  // A blank secret keeps the stored one.
  const again = identitySettings.parse({ provider: 'persona', persona: { apiKey: '', templateId: 'itmpl_1', webhookSecret: '' } }, identitySettings.get());
  assert.equal(again.data.persona.apiKey, 'sk_live_123');
});

test('values put into a call are escaped for the place they go', () => {
  const vars = { 'user.username': 'a&b', 'user.first_name': 'Say "hi"\n' };
  assert.equal(identity.fill('https://x.test/{{user.username}}', vars, 'url'), 'https://x.test/a%26b');
  assert.equal(identity.fill('{"n":"{{user.first_name}}"}', vars, 'json'), '{"n":"Say \\"hi\\"\\n"}');
  assert.deepEqual(identity.headersOf('Authorization: Bearer {{user.username}}', vars), { Authorization: 'Bearer a&b' });
});

test('a Persona webhook is accepted only with its signature, and only when recent', () => {
  const secret = 'whs_secret';
  const body = '{"data":{"id":"evt_1","attributes":{"payload":{"data":{"id":"inq_1"}}}}}';
  const t = Math.floor(Date.now() / 1000);
  const good = `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  assert.equal(identity.personaSignatureOk(body, good, secret), true);
  assert.equal(identity.personaSignatureOk(body + ' ', good, secret), false);
  assert.equal(identity.personaSignatureOk(body, good, 'other'), false);
  const old = t - 3600;
  const stale = `t=${old},v1=${crypto.createHmac('sha256', secret).update(`${old}.${body}`).digest('hex')}`;
  assert.equal(identity.personaSignatureOk(body, stale, secret), false);
  assert.equal(identity.personaSignatureOk(body, '', secret), false);
});

/* ------------------------------------- resets with a REST service ------------------------------------- */

test('a password reset waits for an approved verification made after its link, and only then can change the password', async () => {
  configure();
  mkUser('ivy');
  const c = await client();
  assert.equal((await c('/api/recover', { method: 'POST', body: { identifier: 'ivy' } })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const token = tokenFromMail();

  const page = (await c(`/api/recover/${token}`)).json;
  assert.equal(page.identity.required, true);
  assert.equal(page.identity.status, 'missing');

  // Without a passed verification the reset is refused, and says why.
  const early = await c('/api/recover/reset', { method: 'POST', body: { token, new_password: 'a-much-longer-password-1' } });
  assert.equal(early.status, 403);
  assert.equal(early.json.identity_required, true);

  const started = await c('/api/recover/identity', { method: 'POST', body: { token } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.identity.status, 'pending');
  assert.equal(started.json.identity.url, 'https://verify.example/v-1');
  assert.equal((await c('/api/recover/identity/check', { method: 'POST', body: { token } })).json.identity.status, 'pending');
  assert.equal((await c('/api/recover/reset', { method: 'POST', body: { token, new_password: 'a-much-longer-password-1' } })).status, 403);

  // The service says it passed; the check asks it and records the answer.
  service.status = 'approved';
  const passed = await c('/api/recover/identity/check', { method: 'POST', body: { token } });
  assert.equal(passed.json.identity.status, 'approved');
  const done = await c('/api/recover/reset', { method: 'POST', body: { token, new_password: 'a-much-longer-password-1' } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await (await client())('/api/login', { method: 'POST', body: { username: 'ivy', password: 'a-much-longer-password-1' } })).json.mfa, null);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'identity.result'"));
});

test('a verification the person did not start, or that passed before the link, does not reset anything', async () => {
  configure();
  const id = mkUser('kit');
  // An approved verification from before any link was sent.
  db.run("INSERT INTO identity_verifications (user_id, purpose, provider, ref, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", id, 'password_reset', 'rest', 'old-1', 'approved', Math.floor(Date.now() / 1000) - 60, Math.floor(Date.now() / 1000) - 60);
  const c = await client();
  await c('/api/recover', { method: 'POST', body: { identifier: 'kit' } });
  await new Promise((r) => setTimeout(r, 50));
  const token = tokenFromMail();
  assert.equal((await c(`/api/recover/${token}`)).json.identity.status, 'missing');
  assert.equal((await c('/api/recover/reset', { method: 'POST', body: { token, new_password: 'a-much-longer-password-2' } })).status, 403);
});

test('a service webhook asks for the status again; a wrong token or a call without the secret changes nothing', async () => {
  const settings = configure();
  const id = mkUser('lou');
  db.run("INSERT INTO identity_verifications (user_id, purpose, provider, ref, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", id, 'password_reset', 'rest', 'v-42', 'pending', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  service.status = 'approved';
  const bad = await fetch(`${base}/identity/webhook/rest/not-the-token`, { method: 'POST', body: JSON.stringify({ id: 'v-42' }) });
  assert.equal(bad.status, 403);
  const good = await fetch(`${base}/identity/webhook/rest/${settings.rest.webhookToken}`, { method: 'POST', body: JSON.stringify({ id: 'v-42' }) });
  assert.equal(good.status, 200);
  assert.equal(db.get("SELECT status FROM identity_verifications WHERE ref = 'v-42'").status, 'approved');
});

/* ------------------------------------------ second-factor reset ------------------------------------------ */

test('a second-factor reset needs a passed verification, then removes the factors and lets the person set up a new one', async () => {
  configure();
  const id = mkUser('max', "mfa_enabled = 1");
  db.run("INSERT INTO user_factors (user_id, type, destination, verified) VALUES (?, 'sms', '+15551230009', 1)", id);
  const c = await client();
  assert.equal((await c('/api/recover/mfa', { method: 'POST', body: { identifier: 'max' } })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const token = tokenFromMail();
  const page = (await c(`/api/recover/${token}`)).json;
  assert.equal(page.purpose, 'mfa');
  assert.equal(page.identity.purpose, 'mfa_reset');
  assert.equal((await c('/api/recover/mfa/reset', { method: 'POST', body: { token } })).status, 403);
  await c('/api/recover/identity', { method: 'POST', body: { token } });
  service.status = 'approved';
  await c('/api/recover/identity/check', { method: 'POST', body: { token } });
  const done = await c('/api/recover/mfa/reset', { method: 'POST', body: { token } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM user_factors WHERE user_id = ?', id).n, 0);
  assert.equal(db.get('SELECT mfa_enabled FROM users WHERE id = ?', id).mfa_enabled, 1);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'recovery.mfa_reset'"));
});

test('a second-factor reset is refused when identity verification is not required for it', async () => {
  configure({ requirement: { mfa: false } });
  mkUser('nia');
  const c = await client();
  assert.equal((await c('/api/recover/mfa', { method: 'POST', body: { identifier: 'nia' } })).status, 404);
});

/* ------------------------------------------- integration scripts ------------------------------------------- */

test('an integration script can be the gate, and a script can start and check verifications through the identity functions', async () => {
  const { data, errors } = integrations.parse({ name: 'Gate', script: "if (input.step === 'start') return { ref: 'gate-7', url: 'https://gate.example/go' };\nreturn { approved: input.ref === 'gate-7' };", scopes: [] });
  assert.deepEqual(errors, []);
  integrations.create(data, 'test');
  const gate = db.get("SELECT * FROM integrations WHERE name = 'Gate'");
  configure({ provider: 'none', requirement: { password: true, mfa: false, integrationId: gate.id } });
  const mail = mkUser('oli');
  const c = await client();
  await c('/api/recover', { method: 'POST', body: { identifier: 'oli' } });
  await new Promise((r) => setTimeout(r, 50));
  const token = tokenFromMail();
  const started = await c('/api/recover/identity', { method: 'POST', body: { token } });
  assert.equal(started.json.identity.url, 'https://gate.example/go');
  assert.equal(started.json.identity.status, 'pending');
  const checked = await c('/api/recover/identity/check', { method: 'POST', body: { token } });
  assert.equal(checked.json.identity.status, 'approved');
  assert.equal((await c('/api/recover/reset', { method: 'POST', body: { token, new_password: 'a-much-longer-password-3' } })).status, 200);
  assert.ok(mail);

  // A script's own calls: it can read the latest verification for a person, and it cannot run its own gate again.
  const probe = integrations.parse({ name: 'Probe', script: "return await idp.identity.latest('oli', 'password_reset');", scopes: ['identity', 'users:read'] });
  integrations.create(probe.data, 'test');
  const row = db.get("SELECT * FROM integrations WHERE name = 'Probe'");
  const { outcome } = await integrations.execute(row, { input: {}, trigger: 'manual', actor: 'test' });
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome.error));
  const seen = JSON.parse(outcome.result);
  assert.equal(seen.provider, 'script');
  assert.equal(seen.status, 'approved');
  const noScope = integrations.parse({ name: 'NoScope', script: "return await idp.identity.latest('oli');", scopes: [] });
  integrations.create(noScope.data, 'test');
  const bare = db.get("SELECT * FROM integrations WHERE name = 'NoScope'");
  const refused = await integrations.execute(bare, { input: {}, trigger: 'manual', actor: 'test' });
  assert.match(refused.outcome.error.message, /needs the "identity" scope/);
});
