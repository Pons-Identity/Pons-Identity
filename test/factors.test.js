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
const factorSettings = require('../src/factors/settings');
const totp = require('../src/totp');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
const sent = [];
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { sent.push({ url: req.url, body }); res.end('{}'); });
});
test.before(() => new Promise((r) => provider.listen(0, r)));
test.after(() => { server.close(); provider.close(); });
const pbase = () => `http://localhost:${provider.address().port}`;

/* ------------------------- a software FIDO2 authenticator ------------------------ */

const cbor = (v) => {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  const entries = v instanceof Map ? [...v] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
};
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');

function authenticator() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(32);
  const rpIdHash = sha('localhost');
  let counter = 0;
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  return {
    id: b64(credId),
    register(challenge, origin = 'http://localhost:0') {
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, 32]), credId, cose]);
      const clientData = JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false });
      return { id: b64(credId), rawId: b64(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64(clientData), attestationObject: b64(cbor({ fmt: 'none', attStmt: {}, authData })), transports: ['usb'] } };
    },
    assert(challenge, { origin = 'http://localhost:0', setCounter } = {}) {
      counter = setCounter ?? counter + 1;
      const c = Buffer.alloc(4); c.writeUInt32BE(counter);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), c]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientData)]), privateKey);
      return { id: b64(credId), rawId: b64(credId), type: 'public-key', clientExtensionResults: {},
        response: { authenticatorData: b64(authData), clientDataJSON: b64(clientData), signature: b64(signature), userHandle: null } };
    },
  };
}

/* --------------------------------- helpers ---------------------------------- */

async function client() {
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
  return call;
}
const login = async (username, password) => { const call = await client(); const r = await call('/api/login', { method: 'POST', body: { username, password } }); return { call, r }; };
const signedIn = async (call) => (await call('/api/session')).json.me;
const mkUser = (name) => Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)', newGuid(), name, hashPassword(`${name}-password`), `${name}@x.net`).lastInsertRowid);
const settle = () => db.run('UPDATE otp_challenges SET created_at = created_at - 100');
const lastSent = () => sent[sent.length - 1];

function configureMessaging() {
  const m = msgSettings.messaging();
  const { data } = msgSettings.parse({
    email: { provider: 'sendgrid', from: 'idp@x.net', sendgrid: { apiKey: 'SG.k', apiUrl: pbase() } },
    sms: { provider: 'http', from: '+15550000000', http: { url: `${pbase()}/sms`, body: '{"to":"{{to}}","text":"{{message}}"}' } },
    voice: { provider: 'twilio', twilio: { accountSid: 'AC1', authToken: 't', from: '+15550000000' } },
  }, m);
  msgSettings.save(data);
  messaging.deps.twilioBase = pbase();
}
const setFactors = (over) => factorSettings.save({ ...factorSettings.get(), ...over });
test.beforeEach(() => { sent.length = 0; messaging.resetRateLimits(); });

/* ----------------------------------- tests ----------------------------------- */

test('nothing changes for existing users until factors are turned on', async () => {
  const id = mkUser('plain');
  const { r } = await login('plain', 'plain-password');
  assert.equal(r.json.mfa, null);
  // an authenticator app still works exactly as before
  const secret = totp.generateSecret();
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', secret, id);
  const t = await login('plain', 'plain-password');
  assert.equal(t.r.json.mfa, 'totp');
  const state = (await t.call('/api/login/mfa')).json;
  assert.deepEqual(state.factors.map((f) => f.type), ['totp']);
  const ok = await t.call('/api/login/mfa', { method: 'POST', body: { code: totp.codeForStep(secret, totp.currentStep()) } });
  assert.equal(ok.status, 200);
});

test('a security key can be registered from the profile and used to sign in', async () => {
  configureMessaging();
  setFactors({ webauthn: { enabled: true, userVerification: 'preferred' } });
  mkUser('kate');
  const key = authenticator();
  const { call } = await login('kate', 'kate-password');
  assert.equal((await signedIn(call)).username, 'kate');

  const opts = await call('/api/account/factors/webauthn/options', { method: 'POST', body: {} });
  assert.equal(opts.status, 200);
  const added = await call('/api/account/factors/webauthn/verify', { method: 'POST', body: { response: key.register(opts.json.challenge), label: 'Desk key' } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.factors[0].phishing_resistant, true);

  // a key made for another site's origin is refused
  const o2 = await call('/api/account/factors/webauthn/options', { method: 'POST', body: {} });
  const evil = await call('/api/account/factors/webauthn/verify', { method: 'POST', body: { response: authenticator().register(o2.json.challenge, 'https://evil.example') } });
  assert.equal(evil.status, 400);

  // sign in with it
  const s = await login('kate', 'kate-password');
  assert.equal(s.r.json.mfa, 'totp');
  const st = (await s.call('/api/login/mfa')).json;
  assert.equal(st.factors[0].type, 'webauthn');
  assert.equal(await signedIn(s.call), null);
  const ao = await s.call('/api/login/mfa/webauthn/options', { method: 'POST', body: {} });
  assert.equal(ao.json.allowCredentials[0].id, key.id);
  const wrongOrigin = await s.call('/api/login/mfa/webauthn/verify', { method: 'POST', body: { response: key.assert(ao.json.challenge, { origin: 'https://evil.example' }) } });
  assert.equal(wrongOrigin.status, 401);
  // the challenge was used up by the failed attempt
  assert.equal((await s.call('/api/login/mfa/webauthn/verify', { method: 'POST', body: { response: key.assert(ao.json.challenge) } })).status, 401);
  const ao2 = await s.call('/api/login/mfa/webauthn/options', { method: 'POST', body: {} });
  const good = await s.call('/api/login/mfa/webauthn/verify', { method: 'POST', body: { response: key.assert(ao2.json.challenge) } });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.equal((await signedIn(s.call)).username, 'kate');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'login.success' AND detail LIKE '%hwk%'"));

  // a replayed or cloned authenticator (counter not increasing) is refused
  const c = await login('kate', 'kate-password');
  const co = await c.call('/api/login/mfa/webauthn/options', { method: 'POST', body: {} });
  const cloned = await c.call('/api/login/mfa/webauthn/verify', { method: 'POST', body: { response: key.assert(co.json.challenge, { setCounter: 1 }) } });
  assert.equal(cloned.status, 401);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'mfa.failure' AND detail LIKE '%counter_regression%'"));
});

test('email codes: added after verification, then typed at sign-in; wrong codes are limited', async () => {
  configureMessaging();
  setFactors({ email: { enabled: true, mode: 'code' } });
  mkUser('emma');
  const { call } = await login('emma', 'emma-password');
  const add = await call('/api/account/factors/otp', { method: 'POST', body: { type: 'email', destination: 'emma@home.org' } });
  assert.equal(add.status, 200);
  assert.equal(add.json.hint, 'e***@home.org');
  const code = /code is (\d{6})/.exec(JSON.parse(lastSent().body).content[0].value)[1];
  assert.equal((await call('/api/account/factors/otp/verify', { method: 'POST', body: { code: '000000' } })).status, 401);
  const done = await call('/api/account/factors/otp/verify', { method: 'POST', body: { code } });
  assert.equal(done.status, 200);
  assert.equal(done.json.factors[0].type, 'email');

  settle();
  const s = await login('emma', 'emma-password');
  const fid = (await s.call('/api/login/mfa')).json.factors[0].id;
  const ch = await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: fid } });
  assert.equal(ch.json.mode, 'code');
  assert.equal(ch.json.number, undefined);
  const c2 = /code is (\d{6})/.exec(JSON.parse(lastSent().body).content[0].value)[1];
  assert.equal(db.all('SELECT code_hash FROM otp_challenges').some((r) => r.code_hash.includes(c2)), false);
  assert.equal((await s.call('/api/login/mfa/challenge/verify', { method: 'POST', body: { code: c2 === '111111' ? '222222' : '111111' } })).status, 401);
  assert.equal((await s.call('/api/login/mfa/challenge/verify', { method: 'POST', body: { code: c2 } })).status, 200);
  assert.equal((await signedIn(s.call)).username, 'emma');
  // a code cannot be used twice
  assert.equal(db.get("SELECT status FROM otp_challenges ORDER BY created_at DESC LIMIT 1").status, 'consumed');
});

test('number matching: the sign-in page shows a number and nothing is typed into it', async () => {
  configureMessaging();
  setFactors({ sms: { enabled: true, mode: 'number_match' } });
  const id = mkUser('sam');
  db.run("INSERT INTO user_factors (user_id, type, destination, verified) VALUES (?, 'sms', '+15551230000', 1)", id);

  const s = await login('sam', 'sam-password');
  const st = (await s.call('/api/login/mfa')).json;
  assert.equal(st.factors[0].phishing_resistant, true);
  const ch = await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: st.factors[0].id } });
  assert.equal(ch.json.mode, 'number_match');
  assert.match(ch.json.number, /^\d{3}$/);
  const text = JSON.parse(lastSent().body).text;
  assert.equal(text.includes(ch.json.number), false); // the message does not reveal the number
  const token = /approve\/([\w-]+)/.exec(text)[1];

  // the sign-in page cannot complete it by itself, and cannot submit a code
  assert.deepEqual((await s.call('/api/login/mfa/challenge/status')).json, { result: 'waiting' });
  assert.equal((await s.call('/api/login/mfa/challenge/verify', { method: 'POST', body: { code: ch.json.number } })).status, 400);

  // on the phone: the link, a wrong number, then the right one
  const phone = await client();
  assert.equal((await phone(`/api/factors/approve/${token}`)).status, 200);
  assert.equal((await phone(`/api/factors/approve/${token}`, { method: 'POST', body: { number: ch.json.number === '123' ? '124' : '123' } })).status, 400);
  assert.equal((await phone(`/api/factors/approve/${token}`, { method: 'POST', body: { number: ch.json.number } })).status, 200);
  const done = await s.call('/api/login/mfa/challenge/status');
  assert.equal(done.status, 200);
  assert.equal((await signedIn(s.call)).username, 'sam');
  // the link is spent
  assert.equal((await phone(`/api/factors/approve/${token}`)).status, 404);
});

test('number matching locks after three wrong numbers', async () => {
  const id = mkUser('lou');
  db.run("INSERT INTO user_factors (user_id, type, destination, verified) VALUES (?, 'sms', '+15551230001', 1)", id);
  const s = await login('lou', 'lou-password');
  const ch = await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: (await s.call('/api/login/mfa')).json.factors[0].id } });
  const token = /approve\/([\w-]+)/.exec(JSON.parse(lastSent().body).text)[1];
  const phone = await client();
  const wrong = ch.json.number === '999' ? '998' : '999';
  for (let i = 0; i < 2; i++) assert.equal((await phone(`/api/factors/approve/${token}`, { method: 'POST', body: { number: wrong } })).status, 400);
  assert.equal((await phone(`/api/factors/approve/${token}`, { method: 'POST', body: { number: wrong } })).status, 429);
  assert.equal((await phone(`/api/factors/approve/${token}`, { method: 'POST', body: { number: ch.json.number } })).status, 404);
  assert.equal((await s.call('/api/login/mfa/challenge/status')).json.result, 'failed');
});

test('voice number matching collects the number on the keypad through Twilio', async () => {
  setFactors({ voice: { enabled: true, mode: 'number_match' } });
  const id = mkUser('vera');
  db.run("INSERT INTO user_factors (user_id, type, destination, verified) VALUES (?, 'voice', '+15551230002', 1)", id);
  const s = await login('vera', 'vera-password');
  const ch = await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: (await s.call('/api/login/mfa')).json.factors[0].id } });
  const form = new URLSearchParams(lastSent().body);
  assert.match(lastSent().url, /Calls\.json/);
  const callUrl = new URL(form.get('Url'));
  assert.equal(form.get('Twiml'), null);
  const twiml = await (await fetch(`${base}${callUrl.pathname}`, { method: 'POST' })).text();
  assert.match(twiml, /<Gather[^>]*numDigits="3"/);
  assert.equal(twiml.includes(ch.json.number), false);
  const wrong = await (await fetch(`${base}${callUrl.pathname}/digits`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'Digits=000' })).text();
  assert.match(wrong, /not right/);
  const right = await (await fetch(`${base}${callUrl.pathname}/digits`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `Digits=${ch.json.number}` })).text();
  assert.match(right, /Approved/);
  assert.equal((await s.call('/api/login/mfa/challenge/status')).status, 200);
  assert.equal((await signedIn(s.call)).username, 'vera');
  const dead = await (await fetch(`${base}/factors/voice/nonsense`)).text();
  assert.match(dead, /expired/);
});

test('a phishing-resistant policy refuses weaker factors and offers only strong enrollment', async () => {
  setFactors({ webauthn: { enabled: true, userVerification: 'preferred' }, sms: { enabled: true, mode: 'code' } });
  const gid = Number(db.run("INSERT INTO groups (name) VALUES ('Strict')").lastInsertRowid);
  const pid = Number(db.run("INSERT INTO policies (name, require_phishing_resistant) VALUES ('PR only', 1)").lastInsertRowid);
  db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', pid, gid);
  const weak = mkUser('wes'); const fresh = mkUser('fay'); const strong = mkUser('stan'); const codey = mkUser('cody');
  for (const u of [weak, fresh, strong, codey]) db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', gid, u);
  db.run("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1 WHERE id = ?", weak);
  db.run("INSERT INTO user_factors (user_id, type, destination, verified) VALUES (?, 'sms', '+15551230003', 1)", codey);
  const key = authenticator();
  db.run("INSERT INTO user_factors (user_id, type, label, credential_id, credential, verified) VALUES (?, 'webauthn', 'k', ?, ?, 1)", strong, key.id, JSON.stringify({ publicKey: '', counter: 0, transports: [] }));

  // enrolled factors exist but none is allowed: refused, with no way in
  for (const name of ['wes', 'cody']) {
    const r = await login(name, `${name}-password`);
    assert.equal(r.r.status, 403, name);
    assert.equal(await signedIn(r.call), null);
  }
  // someone with a strong key is offered it (and only it)
  const s = await login('stan', 'stan-password');
  assert.equal(s.r.status, 200);
  assert.deepEqual((await s.call('/api/login/mfa')).json.factors.map((f) => f.type), ['webauthn']);
  // someone with nothing may set up a key, but not an authenticator app
  const f = await login('fay', 'fay-password');
  const state = (await f.call('/api/login/mfa')).json;
  assert.deepEqual(state.enroll_options, ['webauthn']);
  assert.equal(state.enroll, null);
  assert.equal((await f.call('/api/login/mfa', { method: 'POST', body: { code: '123456' } })).status, 400);

  // they register a key during sign-in and are signed in
  const newKey = authenticator();
  const o = await f.call('/api/login/mfa/webauthn/enroll/options', { method: 'POST', body: {} });
  const v = await f.call('/api/login/mfa/webauthn/enroll/verify', { method: 'POST', body: { response: newKey.register(o.json.challenge), label: 'New key' } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal((await signedIn(f.call)).username, 'fay');

  // an administrator can clear a locked-out person's factors so they can start again
  const adm = (await login('admin', 'adminpass123')).call;
  const wid = weak;
  const reset = await adm(`/api/admin/users/${wid}/factors/all`, { method: 'DELETE' });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.json.factors, []);
  assert.equal((await login('wes', 'wes-password')).r.status, 200);
  db.run('DELETE FROM policies');
});

test('turned-off factors are not offered, and settings cannot enable a channel with no delivery', async () => {
  setFactors({ email: { enabled: false, mode: 'code' }, webauthn: { enabled: false, userVerification: 'preferred' } });
  mkUser('ned');
  const { call } = await login('ned', 'ned-password');
  assert.equal((await call('/api/account/factors/otp', { method: 'POST', body: { type: 'email', destination: 'n@x.net' } })).status, 400);
  assert.equal((await call('/api/account/factors/webauthn/options', { method: 'POST', body: {} })).status, 404);
  const blank = factorSettings.parse({ voice: { enabled: true, mode: 'number_match' } }, msgSettings.parse({}, msgSettings.messaging()).data);
  assert.ok(blank.errors.length);
  configureMessaging();
  const generic = msgSettings.parse({ voice: { provider: 'http', http: { url: 'https://x.test/v', body: '{{to}} {{message}}' } } }, msgSettings.messaging());
  assert.ok(factorSettings.parse({ voice: { enabled: true, mode: 'number_match' } }, generic.data).errors.some((e) => /Twilio/.test(e)));
});

test('removing a method needs the password, and the last one cannot go while MFA is required', async () => {
  setFactors({ sms: { enabled: true, mode: 'code' } });
  const id = mkUser('rita');
  const f = Number(db.run("INSERT INTO user_factors (user_id, type, destination, verified) VALUES (?, 'sms', '+15551230004', 1)", id).lastInsertRowid);
  db.run('UPDATE users SET mfa_enabled = 1 WHERE id = ?', id);
  const s = await login('rita', 'rita-password');
  const ch = await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: `f${f}` } });
  const code = /code is (\d{6})/.exec(JSON.parse(lastSent().body).text)[1];
  await s.call('/api/login/mfa/challenge/verify', { method: 'POST', body: { code } });
  assert.equal(ch.status, 200);
  assert.equal((await s.call(`/api/account/factors/${f}`, { method: 'DELETE', body: { current_password: 'nope' } })).status, 400);
  assert.equal((await s.call(`/api/account/factors/${f}`, { method: 'DELETE', body: { current_password: 'rita-password' } })).status, 409);
  db.run('UPDATE users SET mfa_enabled = 0 WHERE id = ?', id);
  assert.equal((await s.call(`/api/account/factors/${f}`, { method: 'DELETE', body: { current_password: 'rita-password' } })).status, 200);
});

test('the factor settings API validates, and policies carry factor rules', async () => {
  const adm = (await login('admin', 'adminpass123')).call;
  msgSettings.save(msgSettings.parse({}, msgSettings.messaging()).data); // nothing configured
  const bad = await adm('/api/admin/settings/factors', { method: 'PUT', body: { ...factorSettings.get(), sms: { enabled: true, mode: 'code' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errors[0], /Messaging/);
  configureMessaging();
  const good = await adm('/api/admin/settings/factors', { method: 'PUT', body: { webauthn: { enabled: true, userVerification: 'required' }, sms: { enabled: true, mode: 'number_match' }, email: { enabled: false }, voice: { enabled: false } } });
  assert.equal(good.status, 200);
  assert.equal(good.json.webauthn.userVerification, 'required');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'settings.factors'"));

  const gid = Number(db.run("INSERT INTO groups (name) VALUES ('Factor rules')").lastInsertRowid);
  const p = await adm('/api/admin/policies', { method: 'POST', body: { name: 'Keys only', subject_type: 'group', subject_id: gid, allowed_factors: ['webauthn', 'sms'], require_phishing_resistant: true, min_password_length: '' } });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.deepEqual(p.json.allowed_factors, ['webauthn', 'sms']);
  assert.equal(p.json.require_phishing_resistant, true);
  assert.equal((await adm('/api/admin/policies', { method: 'POST', body: { name: 'Bad', subject_type: 'group', subject_id: gid, allowed_factors: ['fax'] } })).status, 400);
  db.run('DELETE FROM policies');
});

test('an administrator chooses which methods count as phishing resistant', async () => {
  const factorSettings = require('../src/factors/settings');
  const cfg = factorSettings.get();
  assert.equal(factorSettings.phishingResistant('webauthn', cfg), true);
  assert.equal(factorSettings.phishingResistant('totp', cfg), false);
  assert.equal(factorSettings.phishingResistant('sms:number_match', cfg), true);
  assert.equal(factorSettings.phishingResistant('sms:code', cfg), false);
  const { data, errors } = factorSettings.parse({ ...cfg, phishingResistantMethods: ['totp', 'sms:code'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(data.phishingResistantMethods, ['totp', 'sms:code']);
  assert.equal(factorSettings.phishingResistant('webauthn', data), false);
  assert.equal(factorSettings.phishingResistant('totp', data), true);
  assert.equal(factorSettings.phishingResistant('sms', { ...data, sms: { ...data.sms, modes: ['code'] } }), true);
  assert.equal(factorSettings.phishingResistant('sms', { ...data, sms: { enabled: true, modes: ['code'] }, phishingResistantMethods: ['sms:code'] }), true);
  assert.equal(factorSettings.parse({ ...cfg, phishingResistantMethods: ['carrier-pigeon'] }).errors.length, 1);
});
