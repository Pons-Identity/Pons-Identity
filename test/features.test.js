process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const db = require('../src/db');
const sps = require('../src/sps');
const { newGuid } = require('../src/guid');
const { hashPassword, generateKeyAndCert } = require('../src/crypto');
const { buildResponse } = require('../src/saml/response');
const { parseSpMetadata } = require('../src/saml/sp-metadata');
const { ENCRYPTION_ALGORITHMS } = require('../src/config');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const userId = Number(db.run(
  `INSERT INTO users (guid, username, password_hash, email, upn, sam_account_name, department) VALUES (?,?,?,?,?,?,?)`,
  newGuid(), 'bob', hashPassword('pw'), 'Bob@X.com', 'bob@corp.example', 'CORP\\bob', 'Eng Ops').lastInsertRowid);
const user = db.get('SELECT * FROM users WHERE id = ?', userId);

const enc = generateKeyAndCert('SP encryption');
const login = { amr: ['pwd'], authnInstant: new Date(), sessionIndex: '_s' };

function makeSp(over = {}) {
  const { data, errors } = sps.parseForm({
    name: 'Enc', acs_url: ['http://sp.test/acs'], nameid_format: 'emailAddress', nameid_source: 'upn',
    sign_response: 'on', sign_assertion: 'on', map_idp: ['email', 'sam_account_name'], map_saml: ['mail', 'sam'], ...over,
  });
  assert.deepEqual(errors, []);
  return sps.getSp(sps.createSp(data));
}

// Decrypt like an SP would: unwrap the key with the private key, then decrypt the EncryptedData.
function decrypt(xml, keyPem) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const q = (el, name) => [...el.getElementsByTagNameNS('*', name)];
  const data = q(doc, 'EncryptedData')[0];
  const alg = Object.values(ENCRYPTION_ALGORITHMS).find((a) => a.uri === q(data, 'EncryptionMethod')[0].getAttribute('Algorithm'));
  const keyEl = q(data, 'EncryptedKey')[0];
  const ktUri = q(keyEl, 'EncryptionMethod')[0].getAttribute('Algorithm');
  const oaepHash = ktUri.endsWith('rsa-oaep-mgf1p') ? 'sha1' : 'sha256';
  const key = crypto.privateDecrypt({ key: keyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
    Buffer.from(q(keyEl, 'CipherValue')[0].textContent, 'base64'));
  const raw = Buffer.from(q(data, 'CipherValue').pop().textContent, 'base64');
  const iv = raw.subarray(0, alg.ivBytes);
  if (alg.gcm) {
    const d = crypto.createDecipheriv(alg.cipher, key, iv);
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(alg.ivBytes, raw.length - 16)), d.final()]).toString();
  }
  const d = crypto.createDecipheriv(alg.cipher, key, iv);
  d.setAutoPadding(false);
  const pt = Buffer.concat([d.update(raw.subarray(alg.ivBytes)), d.final()]);
  return pt.subarray(0, pt.length - pt[pt.length - 1]).toString();
}

for (const encryption_algorithm of Object.keys(ENCRYPTION_ALGORITHMS)) {
  for (const key_transport_algorithm of ['rsa-oaep-mgf1p', 'rsa-oaep-sha256']) {
    test(`assertion encryption ${encryption_algorithm} + ${key_transport_algorithm} round-trips`, () => {
      const sp = makeSp({ encrypt_assertion: true, encryption_cert_pem: enc.certPem, encryption_algorithm, key_transport_algorithm });
      const { xml } = buildResponse({ sp, user, pending: { acsUrl: 'http://sp.test/acs' }, login });
      assert.ok(xml.includes('<saml:EncryptedAssertion'));
      assert.ok(!xml.includes('bob@corp.example'), 'plaintext must not leak into the response');
      const assertion = decrypt(xml, enc.keyPem);
      assert.match(assertion, /^<saml:Assertion/);
      assert.ok(assertion.includes('>bob@corp.example<') && assertion.includes('Signature'));
    });
  }
}

test('encryption needs a valid certificate; bare base64 DER is accepted', () => {
  const need = sps.parseForm({ name: 'x', acs_url: 'http://a/b', nameid_format: 'emailAddress', sign_response: 'on', encrypt_assertion: true });
  assert.ok(need.errors.some((e) => /encryption certificate/i.test(e)));
  const bad = sps.parseForm({ name: 'x', acs_url: 'http://a/b', nameid_format: 'emailAddress', sign_response: 'on', encryption_cert_pem: 'junk' });
  assert.ok(bad.errors.some((e) => /not a valid X\.509/.test(e)));
  const bare = enc.certPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const ok = sps.parseForm({ name: 'x', acs_url: 'http://a/b', nameid_format: 'emailAddress', sign_response: 'on', encryption_cert_pem: bare });
  assert.deepEqual(ok.errors, []);
  assert.match(ok.data.encryption_cert_pem, /^-----BEGIN CERTIFICATE-----\n/);
});

test('SP metadata import returns the encryption certificate', () => {
  const body = enc.certPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const r = parseSpMetadata(`<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="e"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>SIGNING</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp/acs" index="0"/>
    </md:SPSSODescriptor></md:EntityDescriptor>`);
  assert.equal(r.encryption_cert_pem, body);
});

test('transformation rules shape the assertion; AD attributes are available', () => {
  const sp = makeSp({ transform_rules: 'mail = lower(mail)\nsam = extract(sam, "\\\\\\\\(.+)$")' });
  const { xml, attributes } = buildResponse({ sp, user, pending: { acsUrl: 'http://sp.test/acs' }, login });
  assert.deepEqual(attributes.find((a) => a.name === 'mail').values, ['bob@x.com']);
  assert.deepEqual(attributes.find((a) => a.name === 'sam').values, ['bob']);
  assert.ok(xml.includes('>bob@corp.example<'), 'NameID from the upn attribute');
});

test('a transformed attribute can supply the NameID, and temporary attributes are left out', () => {
  const sp = makeSp({ transform_rules: 'tmp = lower(mail)\nmail = concat(tmp, ".id")', transform_nameid_attr: 'tmp', transform_temp_attrs: ['tmp'] });
  assert.deepEqual(sp.transform_temp_attrs, ['tmp']);
  const { xml, attributes } = buildResponse({ sp, user, pending: { acsUrl: 'http://sp.test/acs' }, login });
  assert.ok(xml.includes('>bob@x.com<'), 'NameID from the transformed attribute');
  assert.equal(attributes.find((a) => a.name === 'tmp'), undefined);
  assert.deepEqual(attributes.find((a) => a.name === 'mail').values, ['bob@x.com.id']);
});

test('disabled transformations are kept but not applied, and not validated', () => {
  const sp = makeSp({ transform_enabled: false, transform_rules: 'mail = upper(mail)' });
  assert.equal(sp.transform_enabled, 0);
  assert.equal(sp.transform_rules, 'mail = upper(mail)');
  const { attributes } = buildResponse({ sp, user, pending: { acsUrl: 'http://sp.test/acs' }, login });
  assert.deepEqual(attributes.find((a) => a.name === 'mail').values, ['Bob@X.com']);
  const bad = sps.parseForm({ name: 'x', acs_url: 'http://a/b', nameid_format: 'emailAddress', sign_response: 'on', transform_enabled: false, transform_rules: 'x = nope()' });
  assert.deepEqual(bad.errors, []);
});

test('invalid transformation rules are rejected at save', () => {
  const { errors } = sps.parseForm({ name: 'x', acs_url: 'http://a/b', nameid_format: 'emailAddress', sign_response: 'on', transform_rules: 'x = nope()' });
  assert.deepEqual(errors, ['Line 1: unknown function "nope"']);
});

test('SP page API: new fields persist, preview applies unsaved rules', async () => {
  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    let cookie = '';
    const call = async (path, method = 'GET', body, csrf) => {
      const r = await fetch(base + path, { method, redirect: 'manual', headers: {
        ...(cookie && { cookie }), ...(body && { 'content-type': 'application/json' }), ...(csrf && { 'x-csrf-token': csrf }) },
      body: body && JSON.stringify(body) });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const t = await r.text();
      return { status: r.status, json: t ? JSON.parse(t) : null };
    };
    await call('/api/login', 'POST', { username: 'admin', password: 'adminpass123' }, (await call('/api/session')).json.csrf);
    const csrf = (await call('/api/session')).json.csrf;

    const opts = (await call('/api/admin/options')).json;
    assert.ok(opts.encryptionAlgorithms['aes256-gcm'] && opts.keyTransportAlgorithms['rsa-oaep-sha256']);
    assert.ok(opts.attributes.some((a) => a.key === 'upn') && opts.attributes.some((a) => a.key === 'sam_account_name'));

    const created = await call('/api/admin/sps', 'POST', {
      name: 'Portal', description: 'Docs only', metadata_mode: 'url', metadata_url: 'https://sp.test/md',
      acs_url: ['https://sp.test/acs'], nameid_format: 'emailAddress', nameid_source: 'email', sign_response: true,
      encrypt_assertion: true, encryption_cert_pem: enc.certPem, encryption_algorithm: 'aes128-gcm', key_transport_algorithm: 'rsa-oaep-sha256',
      transform_rules: 'mail = upper(mail)', map_idp: ['email'], map_saml: ['mail'],
    }, csrf);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const sp = created.json.sp;
    assert.deepEqual([sp.description, sp.metadata_mode, sp.metadata_url, sp.encrypt_assertion, sp.encryption_algorithm, sp.transform_rules],
      ['Docs only', 'url', 'https://sp.test/md', 1, 'aes128-gcm', 'mail = upper(mail)']);
    assert.match(sp.encryption_cert.sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(sp.private_key_pem, undefined);

    const preview = await call('/api/admin/sps/preview', 'POST', {
      user_id: userId, nameid_format: 'emailAddress', nameid_source: 'upn', map_idp: ['email'], map_saml: ['mail'],
      transform_rules: 'mail = lower(mail)\nbroken(',
    }, csrf);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.json.attributes.find((a) => a.name === 'mail').values, ['bob@x.com']);
    assert.equal(preview.json.nameId, 'bob@corp.example');
    assert.equal(preview.json.errors.length, 1);
  } finally {
    server.close();
  }
});

test('user access: disabled for all, enabled for certain groups, enabled for all', () => {
  const base = sps.parseForm({ name: 'Acc', acs_url: 'https://acc.test/acs', nameid_format: 'emailAddress', nameid_source: 'email' }).data;
  const gid = Number(db.run("INSERT INTO groups (name) VALUES ('access-test')").lastInsertRowid);
  const id = sps.createSp({ ...base, access_mode: 'groups', access_groups: [gid] });
  assert.equal(sps.userHasAccess(sps.getSp(id), userId), false);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', gid, userId);
  assert.equal(sps.userHasAccess(sps.getSp(id), userId), true);
  sps.updateSp(id, { ...base, access_mode: 'none', access_groups: [] });
  assert.equal(sps.userHasAccess(sps.getSp(id), userId), false);
  sps.updateSp(id, { ...base, access_mode: 'all', access_groups: [] });
  assert.equal(sps.userHasAccess(sps.getSp(id), userId), true);
  assert.ok(sps.parseForm({ ...base, acs_url: base.acs_urls, access_mode: 'bogus' }).errors.length);
});
