process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { SignedXml } = require('xml-crypto');
const db = require('../src/db');
const sps = require('../src/sps');
const { newGuid } = require('../src/guid');
const { hashPassword, generateKeyAndCert, verifyPasswordAsync, dummyPasswordHash } = require('../src/crypto');
const { createApp, seedAdmin, sessionLimits } = require('../src/server');
const { isPrivateAddress } = require('../src/safe-fetch');
const { safeNext } = require('../src/safe-redirect');
const throttle = require('../src/throttle');
const emailAuth = require('../src/messaging/email-auth');
const { twilioSignatureOk } = require('../src/messaging/twilio-signature');
const apps = require('../src/apps');
const security = require('../src/security-settings');
const userService = require('../src/user-service');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function session(username, password, ip) {
  let cookie = '';
  const call = async (path, { method = 'GET', body, raw } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') headers['content-type'] = raw ? 'application/x-www-form-urlencoded' : 'application/json';
    if (method !== 'GET' && !raw) headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  await call('/api/session');
  const login = await call('/api/login', { method: 'POST', body: { username, password } });
  return { call, login, cookie: () => cookie };
}

const addUser = (username, password) => Number(db.run('INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,1)', newGuid(), username, hashPassword(password)).lastInsertRowid);

test('SSRF filter: IPv6 forms that carry an IPv4 address are not public', () => {
  for (const a of ['127.0.0.1', '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '::1', 'fd00::1', 'fe80::1', '169.254.169.254', '100.64.0.1', '0.0.0.0', 'not-an-ip']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
});

test('only a path on this site is accepted as the place to go after sign-in', () => {
  for (const ok of ['/', '/admin/users?x=1', '/saml/abc/resume', '/oidc/authorize?client_id=a&state=b']) assert.equal(safeNext(ok), ok);
  for (const bad of ['//evil.test', '/\\evil.test', '/\\/evil.test', '/\t/evil.test', '/\n/evil.test', 'https://evil.test', 'javascript:alert(1)', 'evil', '', null, undefined, 5, `/${'a'.repeat(3000)}`]) {
    assert.equal(safeNext(bad), '/', String(bad).slice(0, 30));
  }
});

test('password sign-in is limited per account and per address, in the database, and the limit ends with the window', async () => {
  addUser('dana', 'danapass123abc');
  for (let i = 0; i < 10; i++) {
    const s = await session('dana', 'wrong-password');
    assert.equal(s.login.status, 401, `attempt ${i + 1}`);
  }
  const blocked = await session('dana', 'danapass123abc');
  assert.equal(blocked.login.status, 429, 'even the right password is refused while the account is limited');
  assert.ok(Number(blocked.login.headers.get('retry-after')) > 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM auth_failures WHERE scope = 'password' AND key = 'acct:dana'").n, 10);
  const other = addUser('erin', 'erinpass123abc');
  assert.ok(other);
  assert.equal((await session('erin', 'erinpass123abc')).login.status, 200, 'other accounts are not affected');
  // The window ends: the oldest failures age out and the right password works again.
  db.run('UPDATE auth_failures SET ts = ts - ?', throttle.WINDOW_MS + 1000);
  assert.equal((await session('dana', 'danapass123abc')).login.status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM auth_failures WHERE key = 'acct:dana'").n, 0, 'a success clears the account count');
});

test('a name that does not exist is counted and limited like one that does, with a hash check either way', async () => {
  assert.equal(await verifyPasswordAsync('anything', dummyPasswordHash()), false);
  for (let i = 0; i < 10; i++) assert.equal((await session('nobody-here', 'x')).login.status, 401);
  assert.equal((await session('nobody-here', 'x')).login.status, 429);
});

test('one-time-code failures are counted per account across sessions', () => {
  const who = { account: 4242 };
  for (let i = 0; i < 9; i++) throttle.fail('totp', who);
  assert.equal(throttle.check('totp', who).blocked, false);
  throttle.fail('totp', who);
  assert.equal(throttle.check('totp', who).blocked, true);
  throttle.reset('totp', who);
  assert.equal(throttle.check('totp', who).blocked, false);
});

test('a wrong code at the second step counts toward the account limit even after signing in again', async () => {
  const uid = addUser('finn', 'finnpass123abc');
  const totp = require('../src/totp');
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', totp.generateSecret(), uid);
  // Five wrong codes use up one sign-in's tries; signing in again must not give five more without limit.
  for (let round = 0; round < 3; round++) {
    const s = await session('finn', 'finnpass123abc');
    assert.equal(s.login.json.mfa, 'totp');
    let last;
    for (let i = 0; i < 6; i++) last = await s.call('/api/login/mfa', { method: 'POST', body: { code: '000000' } });
    assert.ok([401, 404, 429].includes(last.status), `status ${last.status}`);
  }
  assert.equal(throttle.check('totp', { account: uid }).blocked, true);
  const again = await session('finn', 'finnpass123abc');
  const r = await again.call('/api/login/mfa', { method: 'POST', body: { code: '000000' } });
  assert.equal(r.status, 429);
});

test('changing a password signs out the other sessions and keeps this one', async () => {
  addUser('gale', 'galepass123abc');
  const a = await session('gale', 'galepass123abc');
  const b = await session('gale', 'galepass123abc');
  assert.equal((await b.call('/api/account/activity')).status, 200);
  const changed = await a.call('/api/account/password', { method: 'POST', body: { current_password: 'galepass123abc', new_password: 'galepass456xyz!Q' } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal((await a.call('/api/account/activity')).status, 200, 'the browser that changed it stays signed in');
  assert.equal((await b.call('/api/account/activity')).status, 401, 'the other one is signed out');
});

test('CAS wildcard patterns must end in /* and cannot reach another host', () => {
  const app = { redirect_uris: ['https://legacy.test/app/*', 'https://bare.test*', 'https://x.test/a*b', 'https://exact.test/cas'] };
  assert.equal(apps.serviceAllowed(app, 'https://legacy.test/app/home'), true);
  assert.equal(apps.serviceAllowed(app, 'https://legacy.test/other'), false);
  assert.equal(apps.serviceAllowed(app, 'https://legacy.test.evil.test/app/x'), false);
  assert.equal(apps.serviceAllowed(app, 'https://legacy.test@evil.test/app/x'), false);
  assert.equal(apps.serviceAllowed(app, 'https://bare.test.evil.test/'), false, 'a pattern that is not of the allowed form matches nothing');
  assert.equal(apps.serviceAllowed(app, 'https://x.test/axb'), false);
  assert.equal(apps.serviceAllowed(app, 'https://exact.test/cas'), true);
  const { errors } = apps.parseForm({ protocol: 'cas', name: 'n', redirect_uris: ['https://ok.test/app/*', 'https://bad.test*', 'https://bad.test/a*b', 'https://bad.test/*/x'] });
  assert.equal(errors.length, 3);
});

test('security headers are sent, and HSTS only when the public address is https', async () => {
  const r = await fetch(`${base}/api/session`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('strict-transport-security'), null, 'BASE_URL is http in this test');
});

test('email authentication verdicts: the provider decides, and a missing verdict counts as failed', () => {
  const required = { spf: false, dkim: false, dmarc: true };
  assert.equal(emailAuth.check({ spf: false, dkim: false, dmarc: false }, {}).ok, true, 'nothing required');
  assert.equal(emailAuth.check(required, emailAuth.fromSes({ dmarcVerdict: { status: 'PASS' } })).ok, true);
  assert.deepEqual(emailAuth.check(required, emailAuth.fromSes({ dmarcVerdict: { status: 'FAIL' } })).failed, ['dmarc']);
  assert.equal(emailAuth.check(required, {}).ok, false);
  const headers = [{ Name: 'Authentication-Results', Value: 'mx.example; spf=pass smtp.mailfrom=a.test; dkim=pass header.d=a.test; dmarc=pass header.from=a.test' },
    { Name: 'Authentication-Results', Value: 'forged; dmarc=fail' }, { Name: 'Received-SPF', Value: 'fail' }];
  assert.deepEqual(emailAuth.fromHeaders(headers), { spf: true, dkim: true, dmarc: true }, 'only the first Authentication-Results header is read');
  assert.equal(emailAuth.fromHeaders([{ Name: 'Received-SPF', Value: 'Pass (sender ok)' }]).spf, true);
  const mg = emailAuth.fromMailgun({ 'X-Mailgun-Spf': 'Pass', 'X-Mailgun-Dkim-Check-Result': 'Fail' });
  assert.deepEqual([mg.spf, mg.dkim], [true, false]);
});

test('Twilio signatures are checked with the auth token over the URL and sorted fields', () => {
  const crypto = require('crypto');
  const url = 'https://idp.test/factors/voice/tok/digits';
  const fields = { Digits: '123', CallSid: 'CA1' };
  const sig = crypto.createHmac('sha1', 'tok').update(url + 'CallSidCA1Digits123').digest('base64');
  assert.equal(twilioSignatureOk(url, fields, sig, 'tok'), true);
  assert.equal(twilioSignatureOk(url, { ...fields, Digits: '999' }, sig, 'tok'), false);
  assert.equal(twilioSignatureOk(url, fields, '', 'tok'), false);
  assert.equal(twilioSignatureOk(url, fields, undefined, 'tok'), false);
});

test('dangerous settings need an acknowledgement, which is remembered until the risk goes away', async () => {
  const admin = await session('admin', 'adminpass123');
  assert.equal(admin.login.status, 200);
  // Email delivery has to be set up before the email factor can be turned on.
  const msgBase = (await admin.call('/api/admin/settings/messaging')).json;
  const email = { ...msgBase.email, provider: 'smtp', from: 'idp@example.net', smtp: { host: 'smtp.example.net', port: 587, secure: false, user: '', pass: '' } };
  const voice = { ...msgBase.voice, provider: 'twilio', twilio: { accountSid: 'AC1', authToken: 'secret-token', from: '+15555550100', verifySignature: false } };
  const m1 = await admin.call('/api/admin/settings/messaging', { method: 'PUT', body: { ...msgBase, email, voice } });
  assert.equal(m1.status, 200, m1.text);

  const f = (await admin.call('/api/admin/settings/factors')).json;
  const risky = { ...f, email: { enabled: true, modes: ['number_match', 'yes_no'] }, voice: { enabled: true, modes: ['number_match'] } };
  const refused = await admin.call('/api/admin/settings/factors', { method: 'PUT', body: risky });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.requires_acknowledgement, true);
  assert.deepEqual(refused.json.warnings.map((w) => w.id).sort(), ['email_inbound_auth', 'voice_signature', 'yes_no']);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.risk_acknowledged'").n, 0);
  assert.equal((await admin.call('/api/admin/settings/factors')).json.email.enabled, false, 'nothing was saved');

  const partial = await admin.call('/api/admin/settings/factors', { method: 'PUT', body: { ...risky, acknowledge: ['yes_no'] } });
  assert.equal(partial.status, 409);
  assert.deepEqual(partial.json.warnings.map((w) => w.id).sort(), ['email_inbound_auth', 'voice_signature']);

  const accepted = await admin.call('/api/admin/settings/factors', { method: 'PUT', body: { ...risky, acknowledge: ['yes_no', 'email_inbound_auth', 'voice_signature'] } });
  assert.equal(accepted.status, 200, accepted.text);
  assert.ok(accepted.json.warnings.every((w) => w.acknowledged));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.risk_acknowledged'").n, 1);

  // Once accepted, an unrelated save does not ask again.
  assert.equal((await admin.call('/api/admin/settings/factors', { method: 'PUT', body: { ...risky, codeLength: 5 } })).status, 200);

  // Fixing the risks (require DMARC, verify the signature) clears them; the answers are forgotten.
  const mFixed = await admin.call('/api/admin/settings/messaging', { method: 'PUT', body: { ...msgBase, email: { ...email, inboundAuth: { spf: false, dkim: false, dmarc: true } },
    voice: { ...voice, twilio: { ...voice.twilio, verifySignature: true } }, acknowledge: [] } });
  assert.equal(mFixed.status, 200, mFixed.text);
  assert.deepEqual(security.active().filter((id) => id !== 'idle_timeout'), ['yes_no']);
  assert.deepEqual(Object.keys(security.get().acknowledged), ['yes_no']);

  // Turning the voice check back off asks again.
  const back = await admin.call('/api/admin/settings/messaging', { method: 'PUT', body: { ...msgBase, email: { ...email, inboundAuth: { spf: false, dkim: false, dmarc: true } }, voice } });
  assert.equal(back.status, 409);
  assert.deepEqual(back.json.warnings.map((w) => w.id), ['voice_signature']);
});

test('session settings: length and idle timeout are validated, and no idle timeout needs an acknowledgement', async () => {
  const admin = await session('admin', 'adminpass123');
  const view = (await admin.call('/api/admin/settings/session')).json;
  assert.equal(view.sessionHours, 8);
  assert.equal(view.idleMinutes, 0);
  assert.deepEqual(view.warnings.map((w) => w.id), ['idle_timeout']);
  for (const bad of [{ sessionHours: 0, idleMinutes: 0 }, { sessionHours: 8, idleMinutes: 2 }, { sessionHours: 1, idleMinutes: 90 }, { sessionHours: 8.5, idleMinutes: 0 }, { sessionHours: 'x', idleMinutes: 0 }]) {
    assert.equal((await admin.call('/api/admin/settings/session', { method: 'PUT', body: bad })).status, 400, JSON.stringify(bad));
  }
  const refused = await admin.call('/api/admin/settings/session', { method: 'PUT', body: { sessionHours: 4, idleMinutes: 0 } });
  assert.equal(refused.status, 409);
  assert.equal(security.get().sessionHours, 8, 'a refused save changes nothing');
  assert.equal((await admin.call('/api/admin/settings/session', { method: 'PUT', body: { sessionHours: 4, idleMinutes: 0, acknowledge: ['idle_timeout'] } })).status, 200);
  const set = await admin.call('/api/admin/settings/session', { method: 'PUT', body: { sessionHours: 4, idleMinutes: 30 } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json.warnings, []);
  assert.equal(security.get().idleMinutes, 30);
  assert.deepEqual(security.get().acknowledged.idle_timeout, undefined, 'the acceptance is forgotten once the risk is gone');
});

test('sessions end at the idle timeout and at the session length, whatever else the person does', async () => {
  security.save({ ...security.get(), sessionHours: 2, idleMinutes: 30 });
  const s = await session('admin', 'adminpass123');
  assert.equal((await s.call('/api/session')).json.me.username, 'admin');
  // The session id is the signed cookie's value without its "s:" prefix and signature.
  const edit = (who, fn) => {
    const id = decodeURIComponent(who.cookie().split('connect.sid=')[1].split(';')[0]).slice(2).split('.')[0];
    const r = db.get('SELECT data FROM sessions WHERE sid = ?', id);
    const d = JSON.parse(r.data);
    fn(d);
    db.run('UPDATE sessions SET data = ? WHERE sid = ?', JSON.stringify(d), id);
  };

  edit(s, (d) => { d.lastSeen = Date.now() - 31 * 60 * 1000; });
  assert.equal((await s.call('/api/session')).json.me, null, 'idle for longer than the timeout');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'session.expired'"));

  const t = await session('admin', 'adminpass123');
  edit(t, (d) => { d.lastSeen = Date.now() - 5 * 60 * 1000; });
  assert.equal((await t.call('/api/session')).json.me.username, 'admin', 'recently active');
  edit(t, (d) => { d.authnInstant = new Date(Date.now() - 3 * 3600 * 1000).toISOString(); d.lastSeen = Date.now(); });
  assert.equal((await t.call('/api/session')).json.me, null, 'past the session length even though active');
  assert.equal(typeof sessionLimits, 'function');
  security.save({ ...security.get(), sessionHours: 8, idleMinutes: 0 });
});

test('a SAML LogoutRequest from an SP with a registered certificate must be signed, current and from that SP', async () => {
  const { keyPem, certPem } = generateKeyAndCert('sp.test');
  const { data } = sps.parseForm({ name: 'Signed SP', sp_entity_id: 'urn:sp:signed', acs_url: ['http://sp.test/acs'], slo_url: 'http://sp.test/slo', signing_cert_pem: certPem, nameid_format: 'emailAddress', nameid_source: 'email', signature_algorithm: 'sha256' });
  const sp = sps.getSp(sps.createSp(data));
  const make = (issuer, instant) => `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr1" Version="2.0" IssueInstant="${instant}"><saml:Issuer>${issuer}</saml:Issuer><saml:NameID>x</saml:NameID></samlp:LogoutRequest>`;
  const sign = (xml) => {
    const sig = new SignedXml({ privateKey: keyPem, publicCert: certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({ xpath: "//*[local-name(.)='LogoutRequest']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
    return sig.getSignedXml();
  };
  const post = async (xml) => {
    const s = await session('admin', 'adminpass123');
    return s.call(`/saml/${sp.id}/slo`, { method: 'POST', raw: true, body: new URLSearchParams({ SAMLRequest: Buffer.from(xml).toString('base64') }).toString() });
  };
  const now = new Date().toISOString();
  const unsigned = await post(make('urn:sp:signed', now));
  assert.match(unsigned.text, /Invalid logout message/);
  assert.equal(unsigned.status, 400);
  const good = await post(sign(make('urn:sp:signed', now)));
  assert.equal(good.status, 200, good.text);
  assert.match(good.text, /Signed out/);
  const old = await post(sign(make('urn:sp:signed', new Date(Date.now() - 3600 * 1000).toISOString())));
  assert.match(old.text, /not current/);
  // Redirect binding (GET) is refused even with a good signature in the query.
  const viaGet = await (await session('admin', 'adminpass123')).call(`/saml/${sp.id}/slo?${new URLSearchParams({ SAMLRequest: zlib.deflateRawSync(sign(make('urn:sp:signed', now))).toString('base64') })}`);
  assert.match(viaGet.text, /HTTP-POST binding/);
  assert.equal(viaGet.status, 400);
  // An SP with no certificate registered cannot log anyone out this way.
  const bare = sps.getSp(sps.createSp(sps.parseForm({ name: 'No cert', sp_entity_id: 'urn:sp:bare', acs_url: ['http://bare.test/acs'], slo_url: 'http://bare.test/slo', nameid_format: 'emailAddress', nameid_source: 'email', signature_algorithm: 'sha256' }).data));
  const s2 = await session('admin', 'adminpass123');
  const noCert = await s2.call(`/saml/${bare.id}/slo`, { method: 'POST', raw: true, body: new URLSearchParams({ SAMLRequest: Buffer.from(make('urn:sp:bare', now)).toString('base64') }).toString() });
  assert.match(noCert.text, /no signing certificate/);
  assert.ok(!/HTTP-Redirect/.test((await s2.call(`/saml/${sp.id}/metadata`)).text.match(/SingleLogoutService[^>]*>/g).join('')), 'metadata offers only HTTP-POST for logout');
  const tampered = await post(sign(make('urn:sp:signed', now)).replace('<saml:NameID>x', '<saml:NameID>y'));
  assert.equal(tampered.status, 400);
});

test('revokeSessions keeps the session it is told to', () => {
  const uid = addUser('hale', 'halepass123abc');
  for (const sid of ['keep', 'drop']) db.run('INSERT INTO sessions (sid, data, expires) VALUES (?,?,?)', sid, JSON.stringify({ userId: uid }), Date.now() + 1e6);
  userService.revokeSessions(uid, { except: 'keep' });
  assert.deepEqual(db.all('SELECT sid FROM sessions WHERE sid IN (?,?)', 'keep', 'drop').map((r) => r.sid), ['keep']);
});

test('the voice webhook refuses requests without a valid Twilio signature once checking is on', async () => {
  const crypto = require('crypto');
  const messagingSettings = require('../src/messaging/settings');
  const before = messagingSettings.messaging();
  const set = (verifySignature) => messagingSettings.save({ ...before, voice: { ...before.voice, provider: 'twilio', twilio: { accountSid: 'AC1', authToken: 'voice-token', from: '+15555550100', verifySignature } } });
  try {
    set(false);
    assert.equal((await fetch(`${base}/factors/voice/sometoken`, { method: 'POST' })).status, 200, 'unchecked: the token in the path is all there is');
    set(true);
    assert.equal((await fetch(`${base}/factors/voice/sometoken`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/factors/voice/sometoken`, { method: 'POST', headers: { 'x-twilio-signature': 'AAAA' } })).status, 403);
    const { baseUrl } = require('../src/config');
    const sig = crypto.createHmac('sha1', 'voice-token').update(`${baseUrl}/factors/voice/sometoken`).digest('base64');
    assert.equal((await fetch(`${base}/factors/voice/sometoken`, { method: 'POST', headers: { 'x-twilio-signature': sig } })).status, 200);
  } finally {
    messagingSettings.save(before);
  }
});

test('an email reply is dropped unless the provider reports the required checks as passed', async () => {
  const messagingSettings = require('../src/messaging/settings');
  const challenges = require('../src/factors/challenges');
  const before = messagingSettings.messaging();
  const realReply = challenges.reply;
  const seen = [];
  challenges.reply = (r) => { seen.push(r); return 'none'; };
  const set = (inboundAuth) => messagingSettings.save({ ...before, email: { ...before.email, provider: 'postmark', postmark: { ...before.email.postmark, inboundToken: 'tok123', serverToken: 'x' }, inboundAuth } });
  const post = (headers) => fetch(`${base}/messaging/inbound/postmark/tok123`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ From: 'a@b.test', TextBody: 'Y', Headers: headers }) });
  try {
    set({ spf: false, dkim: false, dmarc: false });
    assert.equal((await post([])).status, 200);
    assert.equal(seen.length, 1, 'nothing required: accepted on the sender address');
    set({ spf: false, dkim: false, dmarc: true });
    assert.equal((await post([])).status, 200);
    assert.equal((await post([{ Name: 'Authentication-Results', Value: 'mx; dmarc=fail' }])).status, 200);
    assert.equal(seen.length, 1, 'required but missing or failed: dropped');
    assert.equal((await post([{ Name: 'Authentication-Results', Value: 'mx; dmarc=pass header.from=b.test' }])).status, 200);
    assert.equal(seen.length, 2);
  } finally {
    challenges.reply = realReply;
    messagingSettings.save(before);
  }
});
