process.env.DB_PATH = ':memory:';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const { SignedXml } = require('xml-crypto');
const db = require('../src/db');
const { generateKeyAndCert, certBody } = require('../src/crypto');
const md = require('../src/federation/metadata-source');

const key = generateKeyAndCert('federation signer');
const other = generateKeyAndCert('someone else');
const entityCert = certBody(generateKeyAndCert('entity').certPem);
const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 7 * 86400000).toISOString();

const idp = (id, name, extra = '') => `
  <md:EntityDescriptor entityID="${id}" ${extra}>
    <md:Extensions>
      <mdrpi:RegistrationInfo xmlns:mdrpi="urn:oasis:names:tc:SAML:metadata:rpi" registrationAuthority="https://incommon.org"/>
    </md:Extensions>
    <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:Extensions>
        <shibmd:Scope xmlns:shibmd="urn:mace:shibboleth:metadata:1.0" regexp="false">example.net</shibmd:Scope>
        <mdui:UIInfo xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui">
          <mdui:DisplayName xml:lang="fr">Guilde</mdui:DisplayName>
          <mdui:DisplayName xml:lang="en">${name}</mdui:DisplayName>
        </mdui:UIInfo>
      </md:Extensions>
      <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${entityCert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${id}/sso"/>
    </md:IDPSSODescriptor>
  </md:EntityDescriptor>`;

const sp = (id) => `
  <md:EntityDescriptor entityID="${id}">
    <md:Extensions>
      <mdattr:EntityAttributes xmlns:mdattr="urn:oasis:names:tc:SAML:metadata:attribute">
        <saml:Attribute xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" Name="http://macedir.org/entity-category">
          <saml:AttributeValue>http://refeds.org/category/research-and-scholarship</saml:AttributeValue>
        </saml:Attribute>
      </mdattr:EntityAttributes>
    </md:Extensions>
    <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:AssertionConsumerService index="0" isDefault="true" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${id}/acs"/>
      <md:AttributeConsumingService index="1">
        <md:RequestedAttribute Name="urn:oid:1.3.6.1.4.1.5923.1.1.1.6" FriendlyName="eduPersonPrincipalName" isRequired="true"/>
      </md:AttributeConsumingService>
    </md:SPSSODescriptor>
  </md:EntityDescriptor>`;

const NSDECL = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';

function aggregate(body, { validUntil = FUTURE, signer = key, sign = true } = {}) {
  const xml = `<md:EntitiesDescriptor ${NSDECL} ID="_agg" Name="test" validUntil="${validUntil}">${body}</md:EntitiesDescriptor>`;
  if (!sign) return xml;
  const sig = new SignedXml({ privateKey: signer.keyPem, publicCert: signer.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "/*[local-name(.)='EntitiesDescriptor']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "/*[local-name(.)='EntitiesDescriptor']", action: 'prepend' }, prefix: 'ds' });
  return sig.getSignedXml();
}

const BODY = idp('https://idp.example.net/idp', 'Example Weaving Guild') + sp('https://sp.example.org/shibboleth');

test('a correctly signed aggregate is parsed into entities', () => {
  const { entities, validUntil } = md.parseAggregate(aggregate(BODY), key.certPem, NOW);
  assert.equal(validUntil, FUTURE);
  assert.equal(entities.length, 2);
  const i = entities.find((e) => e.isIdp);
  assert.equal(i.displayName, 'Example Weaving Guild', 'English display name preferred');
  assert.equal(i.parsed.registrationAuthority, 'https://incommon.org');
  assert.deepEqual(i.parsed.idp.scopes, [{ value: 'example.net', regexp: false }]);
  assert.equal(i.parsed.idp.keys[0].use, 'signing');
  assert.equal(i.parsed.idp.singleSignOnServices[0].location, 'https://idp.example.net/idp/sso');
  assert.ok(i.xml.includes('entityID="https://idp.example.net/idp"'));
  const s = entities.find((e) => e.isSp);
  assert.deepEqual(s.parsed.entityAttributes['http://macedir.org/entity-category'], ['http://refeds.org/category/research-and-scholarship']);
  assert.deepEqual(s.parsed.sp.requestedAttributes, [{ name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6', friendlyName: 'eduPersonPrincipalName', required: true }]);
  assert.equal(s.parsed.sp.assertionConsumerServices[0].isDefault, true);
});

test('unsigned, wrongly signed, tampered and expired aggregates are rejected', () => {
  assert.throws(() => md.parseAggregate(aggregate(BODY, { sign: false }), key.certPem, NOW), /not signed/i);
  assert.throws(() => md.parseAggregate(aggregate(BODY, { signer: other }), key.certPem, NOW), /invalid/i);
  assert.throws(() => md.parseAggregate(aggregate(BODY).replace('Example Weaving Guild', 'Evil Weaving Guild'), key.certPem, NOW), /invalid|cover/i);
  assert.throws(() => md.parseAggregate(aggregate(BODY, { validUntil: new Date(NOW.getTime() - 86400000).toISOString() }), key.certPem, NOW), /expired/i);
});

test('a signature over only part of the document is refused', () => {
  const inner = aggregate(sp('https://sp.example.org/x'));
  const wrapped = `<md:EntitiesDescriptor ${NSDECL} validUntil="${FUTURE}" ID="_outer">${inner}${idp('https://smuggled.example/idp', 'Smuggled')}</md:EntitiesDescriptor>`;
  assert.throws(() => md.parseAggregate(wrapped, key.certPem, NOW), /not signed/i);
});

test('entities past their own validUntil are skipped', () => {
  const body = idp('https://old.example/idp', 'Old', 'validUntil="2020-01-01T00:00:00Z"') + idp('https://new.example/idp', 'New');
  const { entities } = md.parseAggregate(aggregate(body), key.certPem, NOW);
  assert.deepEqual(entities.map((e) => e.entityId), ['https://new.example/idp']);
});

test('source form needs https and a pinned certificate', () => {
  assert.ok(md.parseSourceForm({ name: 'x', url: 'http://md.example/a.xml', signing_cert_pem: key.certPem }).errors.some((e) => /https/.test(e)));
  assert.ok(md.parseSourceForm({ name: 'x', url: 'https://md.example/a.xml' }).errors.some((e) => /certificate/i.test(e)));
  assert.equal(md.parseSourceForm({ name: 'x', url: 'https://md.example/a.xml', signing_cert_pem: key.certPem }).errors.length, 0);
});

function addSource() {
  return Number(db.run('INSERT INTO federation_sources (name, url, signing_cert_pem) VALUES (?,?,?)',
    'Test', 'https://md.example/agg.xml', key.certPem).lastInsertRowid);
}
const respond = (text, etag = '"v1"', status = 200) => async () => ({ status, text, headers: new Map([['etag', etag]]) });

test('refresh stores entities, honours ETag, and a failed refresh keeps the last good data', async () => {
  const id = addSource();
  const r = await md.refreshSource(id, { fetchText: respond(aggregate(BODY)), now: NOW });
  assert.equal(r.count, 2);
  let src = md.get(id);
  assert.equal(src.entity_count, 2);
  assert.equal(src.last_etag, '"v1"');
  assert.equal(src.last_error, '');
  assert.equal(md.searchEntities({ q: 'example weav' }).total, 1);
  assert.equal(md.searchEntities({ role: 'sp' }).entities[0].entity_id, 'https://sp.example.org/shibboleth');
  assert.equal(md.findEntity('https://idp.example.net/idp').parsed.idp.scopes[0].value, 'example.net');

  let sent;
  assert.deepEqual(await md.refreshSource(id, { fetchText: async (u, o) => { sent = o.headers; return { status: 304, text: '', headers: new Map() }; }, now: NOW }), { notModified: true });
  assert.deepEqual(sent, { 'If-None-Match': '"v1"' });

  await assert.rejects(md.refreshSource(id, { fetchText: respond(aggregate(BODY, { signer: other })), now: NOW }), /invalid/i);
  src = md.get(id);
  assert.match(src.last_error, /invalid/i);
  assert.equal(src.entity_count, 2, 'counts unchanged');
  assert.equal(md.searchEntities({}).total, 2, 'entities unchanged');
  await assert.rejects(md.refreshSource(id, { fetchText: async () => { throw new Error('connect ECONNREFUSED'); }, now: NOW }), /ECONNREFUSED/);
  assert.equal(md.searchEntities({}).total, 2);
});

test('a refresh that loses most entities is refused as truncated', async () => {
  const id = addSource();
  const many = Array.from({ length: 30 }, (_, n) => idp(`https://idp${n}.example/idp`, `IdP ${n}`)).join('');
  await md.refreshSource(id, { fetchText: respond(aggregate(many), '"a"'), now: NOW });
  assert.equal(md.get(id).entity_count, 30);
  await assert.rejects(md.refreshSource(id, { fetchText: respond(aggregate(idp('https://only.example/idp', 'Only')), '"b"'), now: NOW }), /truncated/);
  assert.equal(md.get(id).entity_count, 30);
});

test('dueSources respects the refresh interval and enabled flag', () => {
  const id = addSource();
  db.run("UPDATE federation_sources SET enabled = 0 WHERE id != ?", id);
  assert.ok(md.dueSources().some((s) => s.id === id), 'never checked is due');
  db.run("UPDATE federation_sources SET last_checked_at = ? WHERE id = ?", new Date().toISOString(), id);
  assert.ok(!md.dueSources().some((s) => s.id === id), 'just checked is not due');
  db.run("UPDATE federation_sources SET last_checked_at = ? WHERE id = ?", new Date(Date.now() - 7 * 3600 * 1000).toISOString(), id);
  assert.ok(md.dueSources().some((s) => s.id === id), 'past interval is due');
});
