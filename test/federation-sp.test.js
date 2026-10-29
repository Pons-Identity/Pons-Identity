process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { SignedXml } = require('xml-crypto');
const db = require('../src/db');
const appSettings = require('../src/app-settings');
const md = require('../src/federation/metadata-source');
const fedSp = require('../src/federation/sp');
const identities = require('../src/federation/identities');
const { validateResponse } = require('../src/federation/response-validator');
const { verifyRequestSignature } = require('../src/saml/request');
const { encryptAssertion } = require('../src/saml/encrypt');
const { generateKeyAndCert, certBody, hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const IDP_ID = 'https://idp.partner.net/idp';
const SSO = 'https://idp.partner.net/idp/profile/SAML2/Redirect/SSO';
const idpKey = generateKeyAndCert('partner idp');
const evilKey = generateKeyAndCert('attacker');
const fedKey = generateKeyAndCert('federation signer');
const NSDECL = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

/* ---------- configure: institution details, metadata containing one partner IdP, inbound enabled ---------- */
const idpCfg = appSettings.parseFederationIdp({
  organization: { name: 'Example Weaving Guild', displayName: 'Example U', url: 'https://www.example.net' },
  contacts: { technical: { name: 'Ops', email: 'ops@example.net' } },
});
appSettings.saveFederationIdp(idpCfg.data);

function signedAggregate(body) {
  const xml = `<md:EntitiesDescriptor ${NSDECL} ID="_agg" validUntil="${FUTURE}">${body}</md:EntitiesDescriptor>`;
  const sig = new SignedXml({ privateKey: fedKey.keyPem, publicCert: fedKey.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "/*[local-name(.)='EntitiesDescriptor']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "/*[local-name(.)='EntitiesDescriptor']", action: 'prepend' }, prefix: 'ds' });
  return sig.getSignedXml();
}
const partnerIdp = (id, name, scope = 'partner.net') => `
  <md:EntityDescriptor entityID="${id}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:Extensions><shibmd:Scope xmlns:shibmd="urn:mace:shibboleth:metadata:1.0" regexp="false">${scope}</shibmd:Scope>
      <mdui:UIInfo xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui"><mdui:DisplayName xml:lang="en">${name}</mdui:DisplayName></mdui:UIInfo></md:Extensions>
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(idpKey.certPem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${id === IDP_ID ? SSO : `${id}/sso`}"/>
  </md:IDPSSODescriptor></md:EntityDescriptor>`;

const sourceId = Number(db.run('INSERT INTO federation_sources (name, url, signing_cert_pem) VALUES (?,?,?)', 'T', 'https://md.example/a.xml', fedKey.certPem).lastInsertRowid);
const importMetadata = () => md.refreshSource(sourceId, {
  fetchText: async () => ({ status: 200, text: signedAggregate(partnerIdp(IDP_ID, 'Partner Weaving Guild') + partnerIdp('https://idp.other.net/idp', 'Other Guild', 'other.net')), headers: new Map() }),
});
const enable = (over = {}) => {
  const { data, errors } = appSettings.parseFederationSp({ enabled: true, ...over }, appSettings.federationIdp());
  assert.deepEqual(errors, []);
  appSettings.saveFederationSp(data);
};

/* --------------------------- build upstream responses -------------------------- */
const ids = fedSp.identity();
const SP_ID = ids.entityId;
const ACS = ids.urls.acs;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
let counter = 0;

function sign(xml, rootName, key) {
  const sig = new SignedXml({ privateKey: key.keyPem, publicCert: key.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: `/*[local-name(.)='${rootName}']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: `/*[local-name(.)='${rootName}']/*[local-name(.)='Issuer']`, action: 'after' }, prefix: 'ds' });
  return sig.getSignedXml();
}
const A_NS = 'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"';
const attrXml = (attrs) => Object.entries(attrs).map(([n, vs]) => `<saml:Attribute Name="${n}">${[].concat(vs).map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('');

/**
 * options: requestId, issuer, audience, recipient, notBefore, notOnOrAfter, attrs, nameId, status,
 *          signAssertion (default true), signResponse (default false), encrypt, signer, destination, assertionId
 */
function makeResponse(requestId, o = {}) {
  const issuer = o.issuer ?? IDP_ID;
  const aid = o.assertionId ?? `_assertion${++counter}`;
  let assertion = `<saml:Assertion ${A_NS} ID="${aid}" IssueInstant="${iso(0)}" Version="2.0"><saml:Issuer>${issuer}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient'}">${o.nameId ?? 'abc123'}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo ?? requestId}" Recipient="${o.recipient ?? ACS}" NotOnOrAfter="${o.confirmUntil ?? iso(300000)}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${o.notBefore ?? iso(-60000)}" NotOnOrAfter="${o.notOnOrAfter ?? iso(300000)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SP_ID}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(-1000)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>${o.authnContext ?? 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attrXml(o.attrs ?? { 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6': 'jdoe@partner.net', 'urn:oid:0.9.2342.19200300.100.1.3': 'jdoe@partner.net', 'urn:oid:2.16.840.1.113730.3.1.241': 'Jane Doe' })}</saml:AttributeStatement></saml:Assertion>`;
  const signer = o.signer ?? idpKey;
  if (o.signAssertion !== false) assertion = sign(assertion, 'Assertion', signer);
  if (o.encrypt) assertion = encryptAssertion(assertion, { encryption_cert_pem: fedSp.ensureKeys().encryption.certPem, encryption_algorithm: o.encrypt, key_transport_algorithm: o.keyTransport ?? 'rsa-oaep-mgf1p' });
  let response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ${A_NS} ID="_resp${counter}" InResponseTo="${requestId}" Version="2.0" IssueInstant="${iso(0)}" Destination="${o.destination ?? ACS}">`
    + `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${o.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status>${o.extra ?? ''}${assertion}</samlp:Response>`;
  if (o.signResponse) response = sign(response, 'Response', signer);
  return response;
}

async function expectedFor(requestId, over = {}) {
  await importMetadata();
  enable();
  const idp = fedSp.allowedIdp(IDP_ID);
  return { requestId, idpEntityId: IDP_ID, spEntityId: SP_ID, acsUrl: ACS, signingCerts: idp.signingCerts, decryptionKeyPem: fedSp.ensureKeys().encryption.keyPem, ...over };
}

/* ------------------------------------ tests ------------------------------------ */

test('valid responses are accepted in every signing and encryption arrangement', async () => {
  const exp = await expectedFor('_req1');
  const cases = {
    'signed assertion': {},
    'signed response only': { signAssertion: false, signResponse: true },
    'signed assertion and response': { signResponse: true },
    'encrypted, assertion signed (GCM)': { encrypt: 'aes128-gcm' },
    'encrypted, assertion signed (CBC)': { encrypt: 'aes256-cbc' },
    'encrypted, response signed': { encrypt: 'aes256-gcm', signAssertion: false, signResponse: true },
    'encrypted, OAEP-SHA256': { encrypt: 'aes128-gcm', keyTransport: 'rsa-oaep-sha256' },
  };
  for (const [name, o] of Object.entries(cases)) {
    const r = validateResponse(makeResponse('_req1', o), exp);
    assert.equal(r.attributes['urn:oid:1.3.6.1.4.1.5923.1.1.1.6'][0], 'jdoe@partner.net', name);
    assert.equal(r.nameId.value, 'abc123', name);
    assert.equal(r.sessionIndex, '_s1', name);
  }
});

test('forged, tampered and mis-addressed responses are rejected', async () => {
  const exp = await expectedFor('_req2');
  const bad = (name, xml, pattern, e = exp) => assert.throws(() => validateResponse(xml, e), pattern, name);
  const R = (o) => makeResponse('_req2', o);

  bad('signed by an unknown key', R({ signer: evilKey }), /invalid|signature/i);
  bad('unsigned', R({ signAssertion: false }), /neither|signed/i);
  bad('attribute changed after signing', R().replace('jdoe@partner.net', 'admin@partner.net'), /invalid/i);
  bad('wrong audience', R({ audience: 'https://other.example/sp' }), /different service provider/i);
  bad('wrong recipient', R({ recipient: 'https://evil.example/acs' }), /different endpoint/i);
  bad('wrong Destination', R({ destination: 'https://evil.example/acs' }), /different endpoint/i);
  bad('reply to another request', R(), /not a reply/i, { ...exp, requestId: '_someone_elses' });
  bad('assertion InResponseTo differs', R({ inResponseTo: '_other' }), /not a reply/i);
  bad('wrong assertion issuer', R({ issuer: 'https://idp.other.net/idp' }), /different identity provider/i);
  bad('expired', R({ notOnOrAfter: iso(-600000), confirmUntil: iso(-600000) }), /expired/i);
  bad('not yet valid', R({ notBefore: iso(600000) }), /not yet valid/i);
  bad('encrypted for another key', makeResponse('_req2', { encrypt: 'aes128-gcm' }), /decrypted/i, { ...exp, decryptionKeyPem: generateKeyAndCert('other').keyPem });
  assert.throws(() => validateResponse(R({ status: 'urn:oasis:names:tc:SAML:2.0:status:Responder', extra: '' }).replace('<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"/>', '<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Requester"><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:NoPassive"/></samlp:StatusCode>'), exp), (e) => e.userFacing && /NoPassive/.test(e.message));
});

test('signature-wrapping: a signed assertion cannot vouch for a forged one', async () => {
  const exp = await expectedFor('_req3');
  const legit = makeResponse('_req3');
  const forged = makeResponse('_req3', { signAssertion: false, attrs: { 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6': 'admin@partner.net' } });
  const legitAssertion = legit.slice(legit.indexOf('<saml:Assertion'), legit.lastIndexOf('</saml:Assertion>') + '</saml:Assertion>'.length);
  const forgedAssertion = forged.slice(forged.indexOf('<saml:Assertion'), forged.lastIndexOf('</saml:Assertion>') + '</saml:Assertion>'.length);

  // Forged assertion first, legitimate signed one second.
  const two = forged.replace(forgedAssertion, forgedAssertion + legitAssertion);
  assert.throws(() => validateResponse(two, exp), /exactly one assertion/i);
  // Signed assertion tucked inside an unsigned assertion's Advice.
  const nested = forged.replace('</saml:Issuer>', `</saml:Issuer>`).replace('<saml:Subject>', `<saml:Advice>${legitAssertion}</saml:Advice><saml:Subject>`);
  assert.throws(() => validateResponse(nested, exp), /neither|signed/i);
  // Real signature moved onto a different element's ID.
  const swapped = legit.replace(/ID="_assertion\d+"/, 'ID="_forged"');
  assert.throws(() => validateResponse(swapped, exp), /invalid|cover/i);
});

test('assertions cannot be replayed', () => {
  const t = Date.now() + 60000;
  assert.equal(identities.consumeAssertion('_once', t), true);
  assert.equal(identities.consumeAssertion('_once', t), false);
  assert.equal(identities.consumeAssertion('_old', Date.now() - 1), true);
  assert.equal(identities.consumeAssertion('_other', t, Date.now() + 10000), true, 'expired records are pruned');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM used_assertions WHERE assertion_id = '_old'").n, 0);
});

const scopes = [{ value: 'partner.net', regexp: false }];
const A = (attributes, nameId = { value: 'x', format: '' }) => ({ attributes, nameId });

test('identifiers count only when the IdP is authoritative for them', () => {
  const EPPN = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6';
  assert.deepEqual(identities.pickSubject(A({ [EPPN]: ['Jdoe@Partner.net'] }), scopes), { type: 'eppn', value: 'jdoe@partner.net' });
  assert.throws(() => identities.pickSubject(A({ [EPPN]: ['jdoe@elsewhere.net'] }), scopes), /allowed to assert/, 'ePPN outside the IdP scope');
  assert.throws(() => identities.pickSubject(A({ [EPPN]: ['jdoe@partner.net'] }), []), /allowed to assert/, 'IdP publishes no scope');
  assert.throws(() => identities.pickSubject(A({ [EPPN]: ['jdoe@evilpartner.net'] }), scopes), /allowed to assert/, 'suffix match is not a match');
  assert.deepEqual(identities.pickSubject(A({ 'eduPersonPrincipalName': ['jdoe@partner.net'] }), scopes).type, 'eppn', 'legacy attribute names');
  const persistent = { value: 'opaque-1', format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' };
  assert.deepEqual(identities.pickSubject(A({ [EPPN]: ['jdoe@partner.net'] }, persistent), scopes), { type: 'persistent', value: 'opaque-1' }, 'persistent beats eppn');
  assert.deepEqual(identities.pickSubject(A({ 'urn:oasis:names:tc:SAML:attribute:pairwise-id': ['ABC@partner.net'], [EPPN]: ['jdoe@partner.net'] }, persistent), scopes),
    { type: 'pairwise-id', value: 'abc@partner.net' }, 'pairwise-id beats everything');
  assert.deepEqual(identities.pickSubject(A({ 'urn:oasis:names:tc:SAML:attribute:pairwise-id': ['abc@elsewhere.net'] }, persistent), scopes).type, 'persistent', 'out-of-scope pairwise-id is skipped');
  assert.deepEqual(identities.pickSubject(A({}, persistent), [{ value: 'partner\\.(edu|org)', regexp: true }]).type, 'persistent');
  assert.ok(identities.inScope('a@partner.org', [{ value: 'partner\\.(edu|org)', regexp: true }]));
  assert.ok(!identities.inScope('a@partner.com', [{ value: 'partner\\.(edu|org)', regexp: true }]));
});

const EPPN = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6';
const assertionFor = (eppn, extra = {}) => A({ [EPPN]: [eppn], 'urn:oid:0.9.2342.19200300.100.1.3': ['boss@example.net'], 'urn:oid:2.16.840.1.113730.3.1.241': ['Mallory'], ...extra });

test('first-time sign-ins wait for approval, and are never matched to local accounts by email', async () => {
  await importMetadata();
  const idp = fedSp.allowedIdp(IDP_ID);
  // A local administrator whose email the IdP will claim.
  const bossId = Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)', newGuid(), 'boss', hashPassword('x'), 'boss@example.net').lastInsertRowid);

  const first = identities.resolve({ idp, assertion: assertionFor('mallory@partner.net'), provisioning: 'approve' });
  assert.deepEqual(first, { pending: true });
  const row = identities.list('pending')[0];
  assert.equal(row.subject, 'mallory@partner.net');
  assert.equal(row.user_id, null);
  assert.deepEqual(identities.resolve({ idp, assertion: assertionFor('mallory@partner.net'), provisioning: 'approve' }), { pending: true }, 'still waiting');

  identities.approve(row.id);
  const approved = identities.resolve({ idp, assertion: assertionFor('mallory@partner.net'), provisioning: 'approve' });
  assert.equal(approved.user.username, 'mallory@partner.net');
  assert.notEqual(approved.user.id, bossId, 'a new account, not the one with the claimed email');
  assert.equal(approved.user.email, 'boss@example.net');
  assert.equal(db.get('SELECT password_hash FROM users WHERE id = ?', approved.user.id).password_hash.length > 20, true);

  // Blocking stops sign-in; an unlinked disabled account does too.
  identities.setStatus(row.id, 'blocked');
  assert.throws(() => identities.resolve({ idp, assertion: assertionFor('mallory@partner.net'), provisioning: 'approve' }), /blocked/);
  identities.setStatus(row.id, 'active');
  db.run('UPDATE users SET active = 0 WHERE id = ?', approved.user.id);
  assert.throws(() => identities.resolve({ idp, assertion: assertionFor('mallory@partner.net'), provisioning: 'approve' }), /disabled/);
  db.run('UPDATE users SET active = 1 WHERE id = ?', approved.user.id);
});

test('auto provisioning, linking to an existing user, and username collisions', async () => {
  await importMetadata();
  const idp = fedSp.allowedIdp(IDP_ID);
  const auto = identities.resolve({ idp, assertion: assertionFor('kim@partner.net'), provisioning: 'auto' });
  assert.equal(auto.user.username, 'kim@partner.net');
  // A local account already has that name: the federated one is given another rather than taking it over.
  db.run('INSERT INTO users (guid, username, password_hash) VALUES (?,?,?)', newGuid(), 'lee@partner.net', hashPassword('x'));
  const lee = identities.resolve({ idp, assertion: assertionFor('lee@partner.net', { 'urn:oid:2.5.4.4': ['Lee'] }), provisioning: 'auto' });
  assert.equal(lee.user.username, 'lee@partner.net-2');

  // Linking to an existing account is an explicit decision.
  const pendingFirst = identities.resolve({ idp, assertion: assertionFor('sam@partner.net'), provisioning: 'approve' });
  assert.equal(pendingFirst.pending, true);
  const target = Number(db.run('INSERT INTO users (guid, username, password_hash, first_name) VALUES (?,?,?,?)', newGuid(), 'sam.local', hashPassword('x'), 'Sam').lastInsertRowid);
  const row = identities.list('pending').find((r) => r.subject === 'sam@partner.net');
  identities.approve(row.id, { userId: target });
  const linked = identities.resolve({ idp, assertion: assertionFor('sam@partner.net', { 'urn:oid:2.16.840.1.113730.3.1.241': ['Renamed By IdP'] }), provisioning: 'approve' });
  assert.equal(linked.user.id, target);
  assert.equal(linked.user.display_name, '', 'linked accounts are not rewritten from the IdP');
});

/* --------------------------- the whole round trip over HTTP --------------------------- */

test('end to end: choose an institution, return from it, wait for approval, then sign in', async () => {
  await importMetadata();
  enable({ provisioning: 'approve' });
  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return r;
  };
  const post = (xml, relay) => call('/fed/sp/acs', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse: Buffer.from(xml).toString('base64'), RelayState: relay }) });
  const begin = async (next = '/') => {
    const r = await call(`/fed/sp/login?idp=${encodeURIComponent(IDP_ID)}&next=${encodeURIComponent(next)}`);
    assert.equal(r.status, 302);
    const url = new URL(r.headers.get('location'));
    const q = url.searchParams;
    const xml = zlib.inflateRawSync(Buffer.from(q.get('SAMLRequest'), 'base64')).toString();
    return { url, q, xml, id: q.get('RelayState') };
  };

  try {
    // Discovery lists the institutions from the imported metadata.
    const list = await (await call('/api/federation/idps?q=partner')).json();
    assert.deepEqual(list.idps, [{ entity_id: IDP_ID, name: 'Partner Weaving Guild' }]);

    // The request: addressed to the IdP's SSO endpoint, from our entity ID, to our ACS, and signed with our key.
    const r1 = await begin('/saml/xyz/resume');
    assert.equal(`${r1.url.origin}${r1.url.pathname}`, SSO);
    assert.ok(r1.xml.includes(`<saml:Issuer>${SP_ID}</saml:Issuer>`));
    assert.ok(r1.xml.includes(`AssertionConsumerServiceURL="${ACS}"`));
    assert.ok(r1.xml.includes(`ID="${r1.id}"`));
    verifyRequestSignature({ binding: 'redirect', rawQuery: r1.url.search.slice(1), certPem: fedSp.ensureKeys().signing.certPem });

    // First visit: the IdP vouches for them, but an administrator has to approve.
    let r = await post(makeResponse(r1.id), r1.id);
    assert.equal(r.status, 202);
    assert.match(await r.text(), /approve/i);
    assert.equal(identities.list('pending').filter((i) => i.subject === 'jdoe@partner.net').length, 1);
    const pending = identities.list('pending').find((i) => i.subject === 'jdoe@partner.net');

    // The same response cannot be used again (the sign-in it belonged to is spent).
    assert.equal((await post(makeResponse(r1.id), r1.id)).status, 400);

    identities.approve(pending.id);
    const r2 = await begin('/saml/xyz/resume');
    r = await post(makeResponse(r2.id, { encrypt: 'aes128-gcm' }), r2.id);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/saml/xyz/resume', 'returns to where they were going');
    const me = (await (await call('/api/session')).json()).me;
    assert.equal(me.username, 'jdoe@partner.net');
    assert.deepEqual(me.permissions, []);

    // Failure modes: a response made for some other request, a forged one, an unknown RelayState, an unlisted IdP.
    cookie = '';
    const r3 = await begin();
    assert.equal((await post(makeResponse('_not_the_request'), r3.id)).status, 400);
    const r4 = await begin();
    assert.equal((await post(makeResponse(r4.id, { signer: evilKey }), r4.id)).status, 400);
    assert.equal((await call('/api/session').then((x) => x.json())).me, null, 'nobody was signed in by a bad response');
    assert.equal((await post(makeResponse('_x'), '_never_issued')).status, 400);
    assert.equal((await call('/fed/sp/login?idp=https://unknown.example/idp')).status, 403);

    enable({ idpAllowlist: ['https://idp.other.net/idp'] });
    assert.equal((await call(`/fed/sp/login?idp=${encodeURIComponent(IDP_ID)}`)).status, 403, 'not on the allow list');
    enable();

    // Metadata: signing and encryption keys, the ACS, requested attributes.
    const meta = await (await call('/fed/sp/metadata')).text();
    assert.ok(meta.includes(`entityID="${SP_ID}"`) && meta.includes(`Location="${ACS}"`));
    assert.ok(meta.includes('AuthnRequestsSigned="true"') && meta.includes('WantAssertionsSigned="true"'));
    assert.equal((meta.match(/<md:KeyDescriptor/g) || []).length, 2);
    assert.ok(meta.includes('urn:oid:1.3.6.1.4.1.5923.1.1.1.6'));

    appSettings.saveFederationSp({ ...appSettings.federationSp(), enabled: false });
    assert.equal((await call('/fed/sp/metadata')).status, 404, 'nothing is served until enabled');
  } finally {
    server.close();
  }
});

test('sign-in policies apply to federated sign-ins', async () => {
  await importMetadata();
  enable({ provisioning: 'auto' });
  const REFEDS_MFA = 'https://refeds.org/profile/mfa';
  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  const signIn = async (o = {}) => {
    let cookie = '';
    const call = async (path, opts = {}) => {
      const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
      const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
      if (sc.length) cookie = sc.join('; ');
      return r;
    };
    const r = await call(`/fed/sp/login?idp=${encodeURIComponent(IDP_ID)}`);
    const id = new URL(r.headers.get('location')).searchParams.get('RelayState');
    const xml = makeResponse(id, { attrs: { [EPPN]: 'pat@partner.net' }, ...(o.mfa && { authnContext: REFEDS_MFA }) });
    const acs = await call('/fed/sp/acs', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ SAMLResponse: Buffer.from(xml).toString('base64'), RelayState: id }) });
    return { acs, me: (await (await call('/api/session')).json()).me };
  };
  try {
    const ok = await signIn();
    assert.equal(ok.acs.status, 302);
    const uid = ok.me.id;
    const gid = Number(db.run("INSERT INTO groups (name) VALUES ('Policy test')").lastInsertRowid);
    db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', gid, uid);

    const policy = Number(db.run("INSERT INTO policies (name, block_sign_in) VALUES ('Block', 1)").lastInsertRowid);
    db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', policy, gid);
    const blocked = await signIn();
    assert.equal(blocked.acs.status, 400);
    assert.equal(blocked.me, null);

    db.run('UPDATE policies SET block_sign_in = 0, require_mfa = 1 WHERE id = ?', policy);
    const noMfa = await signIn();
    assert.equal(noMfa.acs.status, 400, 'MFA required but not reported');
    assert.equal(noMfa.me, null);
    const withMfa = await signIn({ mfa: true });
    assert.equal(withMfa.acs.status, 302);
    assert.equal(withMfa.me.username, 'pat@partner.net');
  } finally {
    server.close();
  }
});
