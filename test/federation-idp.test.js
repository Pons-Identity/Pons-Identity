process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const db = require('../src/db');
const appSettings = require('../src/app-settings');
const attrs = require('../src/attributes');
const idp = require('../src/federation/idp');
const md = require('../src/federation/metadata-source');
const { releaseFor } = require('../src/federation/release-policy');
const { generateKeyAndCert, certBody, hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const GOOD = {
  enabled: true, scope: 'Example.NET',
  organization: { name: 'Example Weaving Guild', displayName: 'Example U', url: 'https://www.example.net' },
  contacts: { technical: { name: 'IdP Ops', email: 'ops@example.net' }, security: { name: 'SOC', email: 'soc@example.net' } },
  categories: { rs: true, pseudonymous: true, anonymous: true },
  affiliationGroups: [{ group: 'Weavers', affiliation: 'faculty' }, { group: 'Apprentices', affiliation: 'student' }],
  releaseRequired: true, sirtfi: true,
};
const save = (over = {}) => {
  const { data, errors } = appSettings.parseFederationIdp({ ...GOOD, ...over });
  assert.deepEqual(errors, []);
  appSettings.saveFederationIdp(data);
};

const uid = Number(db.run(
  `INSERT INTO users (guid, username, password_hash, email, first_name, last_name, display_name, upn, mfa_enabled) VALUES (?,?,?,?,?,?,?,?,0)`,
  newGuid(), 'Jdoe', hashPassword('pw'), 'jdoe@example.net', 'Jane', 'Doe', 'Jane Doe', 'jdoe@corp.local').lastInsertRowid);
const gid = Number(db.run("INSERT INTO groups (name) VALUES ('Weavers')").lastInsertRowid);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', gid, uid);
const user = () => db.get('SELECT * FROM users WHERE id = ?', uid);
const ctxFor = (spEntityId) => ({ groups: attrs.userGroups(uid), custom: {}, sp: spEntityId ? { sp_entity_id: spEntityId } : undefined });

test('settings validation guards what makes the identity usable', () => {
  const bad = appSettings.parseFederationIdp({ enabled: true });
  assert.ok(bad.errors.some((e) => /scope/i.test(e)));
  assert.ok(bad.errors.some((e) => /organization/i.test(e)));
  assert.ok(bad.errors.some((e) => /technical contact/i.test(e)));
  assert.ok(appSettings.parseFederationIdp({ scope: 'not a domain' }).errors.some((e) => /scope/i.test(e)));
  assert.ok(appSettings.parseFederationIdp({ signatureAlgorithm: 'sha1' }).errors.some((e) => /SHA-2/.test(e)));
  assert.ok(appSettings.parseFederationIdp({ sirtfi: true }).errors.some((e) => /security contact/i.test(e)));
  assert.ok(appSettings.parseFederationIdp({ affiliationGroups: [{ group: 'x', affiliation: 'wizard' }] }).errors.length);
  const ok = appSettings.parseFederationIdp(GOOD);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.data.scope, 'example.net', 'scope is lowercased');
  assert.equal(appSettings.parseFederationIdp({}).data.enabled, false);
});

test('eduPerson attributes are scoped and derived from settings and groups', () => {
  save();
  const u = user();
  assert.deepEqual(attrs.resolve(u, 'eduperson_principal_name', ctxFor()), ['Jdoe@example.net']);
  assert.deepEqual(attrs.resolve(u, 'schac_home_organization', ctxFor()), ['example.net']);
  assert.deepEqual(attrs.resolve(u, 'eduperson_affiliation', ctxFor()).sort(), ['faculty', 'member']);
  assert.deepEqual(attrs.resolve(u, 'eduperson_scoped_affiliation', ctxFor()).sort(), ['faculty@example.net', 'member@example.net']);
  assert.match(attrs.resolve(u, 'subject_id', ctxFor())[0], /^[0-9a-f-]{36}@example\.net$/);
  save({ eppnSource: 'upn' });
  assert.deepEqual(attrs.resolve(u, 'eduperson_principal_name', ctxFor()), ['jdoe@example.net'], 'source domain is replaced by the scope');
  // A user in no mapped group gets the default affiliation.
  db.run('DELETE FROM group_members WHERE user_id = ?', uid);
  try {
    assert.deepEqual(attrs.resolve(u, 'eduperson_affiliation', ctxFor()), ['member']);
  } finally {
    db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', gid, uid);
  }
  save();
});

test('persistent and pairwise identifiers are stable per SP and differ between SPs', () => {
  save();
  const u = user();
  const a1 = attrs.resolve(u, 'persistent_id', ctxFor('https://a.example/sp'))[0];
  const a2 = attrs.resolve(u, 'persistent_id', ctxFor('https://a.example/sp'))[0];
  const b = attrs.resolve(u, 'persistent_id', ctxFor('https://b.example/sp'))[0];
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.deepEqual(attrs.resolve(u, 'pairwise_id', ctxFor('https://a.example/sp')), [`${a1}@example.net`]);
  assert.deepEqual(attrs.resolve(u, 'eduperson_targeted_id', ctxFor('https://a.example/sp')), [a1]);
  assert.deepEqual(attrs.resolve(u, 'persistent_id', ctxFor()), [], 'nothing without an SP');
});

const parsedSp = (categories, requested = []) => ({
  entityAttributes: categories.length ? { 'http://macedir.org/entity-category': categories } : {},
  sp: { requestedAttributes: requested },
});
const RS = 'http://refeds.org/category/research-and-scholarship';

test('release policy: category bundles, required requests, and nothing by default', () => {
  save();
  const cfg = appSettings.federationIdp();
  const names = (r) => r.maps.map((m) => m.idp_attribute).sort();
  assert.deepEqual(releaseFor(parsedSp([]), cfg).maps, [], 'no category and no request releases nothing');
  assert.deepEqual(names(releaseFor(parsedSp([RS]), cfg)),
    ['display_name', 'eduperson_principal_name', 'eduperson_scoped_affiliation', 'eduperson_targeted_id', 'email', 'first_name', 'last_name']);
  const offRs = { ...cfg, categories: { ...cfg.categories, rs: false } };
  assert.deepEqual(releaseFor(parsedSp([RS]), offRs).maps, [], 'a disabled category releases nothing');

  const req = [
    { name: 'urn:oid:0.9.2342.19200300.100.1.3', required: true },
    { name: 'eduPersonPrincipalName', required: false },
    { name: 'urn:oid:unknown', required: true },
  ];
  const r = releaseFor(parsedSp([], req), cfg);
  assert.deepEqual(r.maps, [{ idp_attribute: 'email', saml_name: 'urn:oid:0.9.2342.19200300.100.1.3' }], 'only required, known attributes');
  assert.deepEqual(releaseFor(parsedSp([], req), { ...cfg, releaseRequired: false }).maps, []);

  const coco = 'https://refeds.org/category/code-of-conduct/v2';
  const noRequired = { ...cfg, releaseRequired: false };
  assert.deepEqual(releaseFor(parsedSp([coco], req), noRequired).maps, [], 'CoCo off by default');
  const withCoco = releaseFor(parsedSp([coco], req), { ...noRequired, categories: { ...cfg.categories, coco: true } });
  assert.deepEqual(withCoco.maps.map((m) => m.saml_name).sort(), ['eduPersonPrincipalName', 'urn:oid:0.9.2342.19200300.100.1.3'], 'CoCo releases the requested names as asked');
});

test('IdP metadata carries scope, categories, SIRTFI and contacts, and signs when asked', () => {
  save();
  const xml = idp.buildMetadata();
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  assert.equal(doc.documentElement.getAttribute('entityID'), idp.identity().entityId);
  assert.ok(xml.includes('>example.net</shibmd:Scope>'));
  assert.ok(xml.includes('http://refeds.org/category/research-and-scholarship'));
  assert.ok(xml.includes('https://refeds.org/sirtfi'));
  assert.ok(xml.includes('remd:contactType="http://refeds.org/metadata/contact/security"'));
  assert.ok(xml.includes('mailto:ops@example.net'));
  assert.equal(doc.getElementsByTagNameNS('*', 'KeyDescriptor').length, 2);
  assert.ok(!xml.includes('validUntil'));

  const signed = idp.buildMetadata({ signed: true });
  assert.ok(signed.includes('validUntil=') && signed.includes('cacheDuration='));
  const root = new DOMParser().parseFromString(signed, 'text/xml').documentElement;
  md.verifyAggregateSignature(signed, root, idp.ensureKeys().signing.certPem);
  assert.throws(() => md.verifyAggregateSignature(signed.replace('ops@example.net', 'evil@example.net'), new DOMParser().parseFromString(signed.replace('ops@example.net', 'evil@example.net'), 'text/xml').documentElement, idp.ensureKeys().signing.certPem), /invalid/i);
});

/* ------------------------------- End to end ------------------------------- */

const fedKey = generateKeyAndCert('federation signer');
const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 7 * 86400000).toISOString();
const spCert = certBody(generateKeyAndCert('rs sp').certPem);
const SP_ID = 'https://rs.example.org/shibboleth';
const NSDECL = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const spEntity = (id, { categories = [], acs = `${id}/acs`, encrypt = false, requested = '' } = {}) => `
  <md:EntityDescriptor entityID="${id}">
    ${categories.length ? `<md:Extensions><mdattr:EntityAttributes xmlns:mdattr="urn:oasis:names:tc:SAML:metadata:attribute"><saml:Attribute xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" Name="http://macedir.org/entity-category">${categories.map((c) => `<saml:AttributeValue>${c}</saml:AttributeValue>`).join('')}</saml:Attribute></mdattr:EntityAttributes></md:Extensions>` : ''}
    <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      ${encrypt ? `<md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${spCert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` : ''}
      <md:AssertionConsumerService index="0" isDefault="true" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}"/>
      ${requested ? `<md:AttributeConsumingService index="1">${requested}</md:AttributeConsumingService>` : ''}
    </md:SPSSODescriptor>
  </md:EntityDescriptor>`;

function signedAggregate(body) {
  const xml = `<md:EntitiesDescriptor ${NSDECL} ID="_agg" validUntil="${FUTURE}">${body}</md:EntitiesDescriptor>`;
  const sig = new SignedXml({ privateKey: fedKey.keyPem, publicCert: fedKey.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "/*[local-name(.)='EntitiesDescriptor']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "/*[local-name(.)='EntitiesDescriptor']", action: 'prepend' }, prefix: 'ds' });
  return sig.getSignedXml();
}

test('end to end: an InCommon SP signs in through /fed/idp and gets only what the policy releases', async () => {
  const sourceId = Number(db.run('INSERT INTO federation_sources (name, url, signing_cert_pem) VALUES (?,?,?)', 'T', 'https://md.example/a.xml', fedKey.certPem).lastInsertRowid);
  const body = spEntity(SP_ID, { categories: [RS] })
    + spEntity('https://enc.example.org/sp', { categories: [RS], encrypt: true })
    + spEntity('https://plain.example.org/sp', { requested: '<md:RequestedAttribute Name="urn:oid:0.9.2342.19200300.100.1.3" isRequired="true"/><md:RequestedAttribute Name="urn:oid:2.5.4.42"/>' });
  await md.refreshSource(sourceId, { fetchText: async () => ({ status: 200, text: signedAggregate(body), headers: new Map() }) });

  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return r;
  };
  const csrfOf = async () => (await (await call('/api/session')).json()).csrf;
  const authn = (issuer, acs) => `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_q1" Version="2.0" AssertionConsumerServiceURL="${acs}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer></samlp:AuthnRequest>`;
  const sso = (issuer, acs) => `/fed/idp/sso?${new URLSearchParams({ SAMLRequest: zlib.deflateRawSync(authn(issuer, acs)).toString('base64'), RelayState: 'rs' })}`;
  const decode = (html) => Buffer.from(html.match(/name="SAMLResponse" value="([^"]+)"/)[1], 'base64').toString();
  const attrsOf = (xml) => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return Object.fromEntries([...doc.getElementsByTagNameNS('*', 'Attribute')].map((a) => [a.getAttribute('Name'), [...a.getElementsByTagNameNS('*', 'AttributeValue')].map((v) => v.textContent.trim())]));
  };

  try {
    // Disabled: the endpoints do not exist.
    appSettings.saveFederationIdp({ ...appSettings.federationIdp(), enabled: false });
    assert.equal((await call(sso(SP_ID, `${SP_ID}/acs`))).status, 404);
    save();

    assert.equal((await call(sso('https://nobody.example/sp', 'https://nobody.example/acs'))).status, 403, 'unknown SP');
    assert.equal((await call(sso(SP_ID, 'https://evil.example/acs'))).status, 400, 'ACS not in metadata');

    let r = await call(sso(SP_ID, `${SP_ID}/acs`));
    assert.equal(r.status, 302);
    assert.equal(new URL(r.headers.get('location'), base).searchParams.get('next'), '/fed/idp/resume');
    r = await call('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfOf() }, body: JSON.stringify({ username: 'Jdoe', password: 'pw', next: '/fed/idp/resume' }) });
    assert.equal(r.status, 200);
    r = await call('/fed/idp/resume');
    const html = await r.text();
    assert.ok(html.includes(`action="${SP_ID}/acs"`) && html.includes('value="rs"'));
    const xml = decode(html);
    const issuer = idp.identity().entityId;
    assert.ok(xml.includes(`<saml:Issuer>${issuer}</saml:Issuer>`), 'federation entity ID is the issuer');
    assert.ok(xml.includes('InResponseTo="_q1"'));
    assert.ok(xml.includes(`<saml:Audience>${SP_ID}</saml:Audience>`));
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const assertion = doc.getElementsByTagNameNS('*', 'Assertion')[0];
    const sigNode = [...assertion.childNodes].find((n) => n.localName === 'Signature');
    const verifier = new SignedXml({ publicCert: idp.ensureKeys().signing.certPem });
    verifier.loadSignature(sigNode);
    assert.ok(verifier.checkSignature(xml), 'signed with the federation key');

    const got = attrsOf(xml);
    assert.deepEqual(Object.keys(got).sort(), [
      'urn:oid:0.9.2342.19200300.100.1.3', 'urn:oid:1.3.6.1.4.1.5923.1.1.1.10', 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6',
      'urn:oid:1.3.6.1.4.1.5923.1.1.1.9', 'urn:oid:2.16.840.1.113730.3.1.241', 'urn:oid:2.5.4.4', 'urn:oid:2.5.4.42'].sort(),
    'R&S bundle only: no amr claims, no groups');
    assert.deepEqual(got['urn:oid:1.3.6.1.4.1.5923.1.1.1.6'], ['Jdoe@example.net']);
    assert.deepEqual(got['urn:oid:0.9.2342.19200300.100.1.3'], ['jdoe@example.net']);
    assert.ok(xml.includes('FriendlyName="eduPersonPrincipalName"'));
    const nameId = doc.getElementsByTagNameNS('*', 'NameID')[0];
    assert.equal(nameId.getAttribute('Format'), 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
    assert.equal(nameId.getAttribute('SPNameQualifier'), SP_ID);
    assert.equal(nameId.getAttribute('NameQualifier'), issuer);
    const pid = nameId.textContent.trim();
    assert.deepEqual(got['urn:oid:1.3.6.1.4.1.5923.1.1.1.10'], [pid], 'ePTID carries the same opaque value as the persistent NameID');
    assert.ok(xml.includes('<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" NameQualifier'), 'ePTID is a NameID element');

    // A second sign-in gets the same identifier; an SP with no category gets only its required attribute.
    const again = decode(await (await call('/fed/idp/init?providerId=' + encodeURIComponent(SP_ID))).text());
    assert.equal(new DOMParser().parseFromString(again, 'text/xml').getElementsByTagNameNS('*', 'NameID')[0].textContent.trim(), pid);
    const plain = attrsOf(decode(await (await call('/fed/idp/init?providerId=' + encodeURIComponent('https://plain.example.org/sp'))).text()));
    assert.deepEqual(Object.keys(plain), ['urn:oid:0.9.2342.19200300.100.1.3'], 'optional request is not released');

    // A SP that publishes an encryption key receives an encrypted assertion.
    const enc = decode(await (await call('/fed/idp/init?providerId=' + encodeURIComponent('https://enc.example.org/sp'))).text());
    assert.ok(enc.includes('EncryptedAssertion') && !enc.includes('Jdoe@example.net'));

    // The federation does not touch the per-application IdP: a hand-registered SP still uses its own identity.
    const meta = await (await call('/fed/idp/metadata')).text();
    assert.ok(meta.includes(`entityID="${issuer}"`));
  } finally {
    server.close();
  }
});

test('a hand-registered SP with the same entity ID keeps its own mapping but uses the federation identity', () => {
  save();
  const sps = require('../src/sps');
  const id = sps.createSp(sps.parseForm({
    name: 'Registered', acs_url: `${SP_ID}/acs`, sp_entity_id: SP_ID, nameid_format: 'emailAddress', nameid_source: 'email',
    sign_response: 'on', sign_assertion: 'on', map_idp: ['username'], map_saml: ['custom-uid'],
  }).data);
  const sp = idp.forEntity(SP_ID);
  assert.equal(sp.id, id);
  assert.equal(sp.synthetic, false);
  assert.deepEqual(sp.maps, [{ idp_attribute: 'username', saml_name: 'custom-uid' }]);
  assert.equal(sp.urls.entityId, idp.identity().entityId);
  assert.equal(sp.cert_pem, idp.ensureKeys().signing.certPem);
  db.run('DELETE FROM service_providers WHERE id = ?', id);
});
