process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const db = require('../src/db');
const sps = require('../src/sps');
const { newGuid, GUID_RE, immutableId } = require('../src/guid');
const { hashPassword, fingerprints } = require('../src/crypto');
const { buildMetadata } = require('../src/saml/metadata');
const { parseSpMetadata } = require('../src/saml/sp-metadata');
const { buildResponse } = require('../src/saml/response');
const totp = require('../src/totp');
const { createApp, seedAdmin } = require('../src/server');

function verify(xml, cert, tagName) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const el = [...doc.getElementsByTagNameNS('*', tagName)][0];
  const sigs = [...el.childNodes].filter((n) => n.localName === 'Signature');
  assert.equal(sigs.length, 1, `${tagName} should carry its own signature`);
  const sig = new SignedXml({ publicCert: cert });
  sig.loadSignature(sigs[0]);
  return sig.checkSignature(xml);
}

function makeSp(over = {}) {
  const { data } = sps.parseForm({
    name: 'Test', acs_url: ['http://sp.test/acs', 'http://sp.test/acs2'], nameid_format: 'emailAddress', nameid_source: 'email',
    signature_algorithm: 'sha256', sign_response: 'on', sign_assertion: 'on',
    map_idp: ['email', 'groups'], map_saml: ['mail', 'memberOf'],
    static_name: 'acct', static_value: '12345', ...over,
  });
  return sps.getSp(sps.createSp(data));
}

seedAdmin();
const userId = Number(db.run(
  `INSERT INTO users (guid, username, password_hash, email, first_name, mfa_enabled) VALUES (?,?,?,?,?,0)`,
  newGuid(), 'bob', hashPassword('pw'), 'bob@x.com', 'Bob').lastInsertRowid);
const user = db.get('SELECT * FROM users WHERE id = ?', userId);
const gid = Number(db.run("INSERT INTO groups (name) VALUES ('Admins')").lastInsertRowid);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', gid, userId);

test('GUID looks like AD objectGUID', () => {
  assert.match(user.guid, GUID_RE);
  assert.equal(Buffer.from(immutableId('00112233-4455-6677-8899-aabbccddeeff'), 'base64').toString('hex'), '33221100554477668899aabbccddeeff');
});

test('at least one signing option is required', () => {
  const { errors } = sps.parseForm({ name: 'x', acs_url: 'http://a/b', nameid_format: 'emailAddress' });
  assert.ok(errors.some((e) => /at least one/i.test(e)));
});

test('metadata matches cert fingerprint and has endpoints', () => {
  const sp = makeSp();
  const md = buildMetadata(sp);
  assert.ok(md.includes(sp.urls.sso) && md.includes(sp.urls.slo));
  assert.match(fingerprints(sp.cert_pem).sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

for (const [resp, assertion] of [[1, 1], [1, 0], [0, 1]]) {
  test(`response signing resp=${resp} assertion=${assertion}`, () => {
    const sp = makeSp({ sign_response: resp ? 'on' : undefined, sign_assertion: assertion ? 'on' : undefined,
      role_group: String(gid), role_name: 'role', role_value: 'admin' });
    const { xml } = buildResponse({ sp, user, pending: { acsUrl: 'http://sp.test/acs', inResponseTo: '_r1' },
      login: { amr: ['pwd', 'otp', 'mfa'], authnInstant: new Date(), sessionIndex: '_s' } });
    if (resp) assert.ok(verify(xml, sp.cert_pem, 'Response'));
    if (assertion) assert.ok(verify(xml, sp.cert_pem, 'Assertion'));
    assert.ok(xml.includes('Name="mail"') && xml.includes('bob@x.com'));
    assert.ok(xml.includes('Name="acct"') && xml.includes('>12345<'));
    assert.ok(xml.includes('Name="role"') && xml.includes('>admin<'));
    assert.ok(xml.includes('Name="memberOf"') && xml.includes('>Admins<'));
    assert.ok(xml.includes('Name="amr"') && xml.includes('authnmethodsreferences'));
    assert.ok(xml.includes('TimeSyncToken'));
  });
}

test('transient NameID differs per assertion', () => {
  const sp = makeSp({ nameid_format: 'transient' });
  const a = () => buildResponse({ sp, user, pending: { acsUrl: 'http://sp.test/acs' }, login: { amr: ['pwd'], authnInstant: new Date(), sessionIndex: '_s' } }).nameId;
  assert.notEqual(a(), a());
});

test('SP metadata import', () => {
  const r = parseSpMetadata(`<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example/e"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example/slo"/>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example/acs" index="0"/>
    <md:AttributeConsumingService index="0"><md:RequestedAttribute Name="urn:oid:0.9.2342.19200300.100.1.3"/><md:RequestedAttribute Name="email"/></md:AttributeConsumingService>
    </md:SPSSODescriptor></md:EntityDescriptor>`);
  assert.deepEqual([r.sp_entity_id, r.acs_urls[0], r.slo_url, r.nameid_format], ['https://sp.example/e', 'https://sp.example/acs', 'https://sp.example/slo', 'persistent']);
  assert.equal(r.maps[1].idp_attribute, 'email');
});

test('end to end: login, SP-initiated and IdP-initiated SSO over HTTP', async () => {
  const sp = makeSp({ default_relay_state: 'DEFAULT-RS', sp_entity_id: 'urn:sp:test' });
  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return r;
  };
  const apiPost = (path, body, csrf) => call(`/api${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  const csrfOf = async () => (await (await call('/api/session')).json()).csrf;
  try {
    // IdP-initiated → bounces to the login screen
    let r = await call(`/saml/${sp.id}/init`);
    assert.equal(r.status, 302);
    assert.ok(r.headers.get('location').startsWith('/login'), 'IdP-initiated sign-in goes through login');
    r = await apiPost('/login', { username: 'bob', password: 'pw', next: `/saml/${sp.id}/resume` }, await csrfOf());
    assert.equal(r.status, 200);
    const { next } = await r.json();
    r = await call(next);
    let html = await r.text();
    assert.ok(html.includes('name="RelayState" value="DEFAULT-RS"'), 'default relay state on IdP-initiated');
    const decode = (h) => Buffer.from(h.match(/name="SAMLResponse" value="([^"]+)"/)[1], 'base64').toString();
    assert.ok(verify(decode(html), sp.cert_pem, 'Assertion'));

    // SP-initiated, redirect binding
    const req = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_req1" Version="2.0" AssertionConsumerServiceURL="http://sp.test/acs2"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">urn:sp:test</saml:Issuer></samlp:AuthnRequest>`;
    const q = new URLSearchParams({ SAMLRequest: zlib.deflateRawSync(req).toString('base64'), RelayState: 'my-rs' });
    html = await (await call(`/saml/${sp.id}/sso?${q}`)).text();
    const xml = decode(html);
    assert.ok(html.includes('action="http://sp.test/acs2"') && html.includes('value="my-rs"'));
    assert.ok(xml.includes('InResponseTo="_req1"'));
    assert.ok(verify(xml, sp.cert_pem, 'Response'));

    // Unregistered ACS rejected
    const bad = req.replace('acs2', 'evil');
    r = await call(`/saml/${sp.id}/sso?${new URLSearchParams({ SAMLRequest: zlib.deflateRawSync(bad).toString('base64') })}`);
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test('TOTP matches RFC 6238 vector and rejects replay', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.codeForStep(secret, Math.floor(59 / 30), 8), '94287082');
  const now = 59 * 1000;
  const step = totp.verify(secret, '287082', 0, now);
  assert.equal(step, 1);
  assert.equal(totp.verify(secret, '287082', step, now), null);
  assert.equal(totp.verify(secret, '000000', 0, now), null);
  assert.equal(totp.verify(secret, 'abc', 0, now), null);
});

test('AMR reflects only the methods used', () => {
  const sp = makeSp();
  const run = (amr) => buildResponse({ sp, user, pending: { acsUrl: 'http://sp.test/acs' },
    login: { amr, authnInstant: new Date(), sessionIndex: '_s' } }).xml;
  const pwdOnly = run(['pwd']);
  assert.ok(pwdOnly.includes('PasswordProtectedTransport') && !pwdOnly.includes('multipleauthn') && !pwdOnly.includes('>otp<'));
  const mfa = run(['pwd', 'otp', 'mfa']);
  assert.ok(mfa.includes('>otp<') && mfa.includes('multipleauthn'));
});

test('end to end: TOTP login yields otp/mfa AMR; password-only does not', async () => {
  const sp = makeSp();
  const secret = totp.generateSecret();
  db.run(`INSERT INTO users (guid, username, password_hash, email, totp_secret, totp_enabled) VALUES (?,?,?,?,?,1)`,
    newGuid(), 'carol', hashPassword('pw'), 'carol@x.com', secret);
  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return r;
  };
  // Logins regenerate the session, so each step re-reads the CSRF token, as the SPA does.
  const apiPost = async (path, body) => call(`/api${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfOf() }, body: JSON.stringify(body) });
  const csrfOf = async () => (await (await call('/api/session')).json()).csrf;
  try {
    let r = await apiPost('/login', { username: 'carol', password: 'pw', next: `/saml/${sp.id}/init` });
    assert.deepEqual(await r.json(), { mfa: 'totp', enroll: false });
    r = await apiPost('/login/mfa', { code: '000000' });
    assert.equal(r.status, 401);
    const code = totp.codeForStep(secret, totp.currentStep());
    r = await apiPost('/login/mfa', { code });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { next: `/saml/${sp.id}/init` });
    const html = await (await call(`/saml/${sp.id}/init`)).text();
    const xml = Buffer.from(html.match(/name="SAMLResponse" value="([^"]+)"/)[1], 'base64').toString();
    assert.ok(xml.includes('>otp<') && xml.includes('>mfa<') && xml.includes('TimeSyncToken'));
    // replaying the same code on a fresh login is rejected
    cookie = '';
    await apiPost('/login', { username: 'carol', password: 'pw', next: '/' });
    r = await apiPost('/login/mfa', { code });
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});
