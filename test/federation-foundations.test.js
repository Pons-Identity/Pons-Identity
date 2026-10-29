process.env.DB_PATH = ':memory:';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const zlib = require('zlib');
const { SignedXml } = require('xml-crypto');
const { generateKeyAndCert } = require('../src/crypto');
const { verifyRequestSignature } = require('../src/saml/request');
const { isPrivateAddress, safeFetchText } = require('../src/safe-fetch');
const { PERMISSIONS, normalize } = require('../src/permissions');
const sps = require('../src/sps');
const { createApp } = require('../src/server');

const { keyPem, certPem } = generateKeyAndCert('test sp');
const other = generateKeyAndCert('other sp');
const REQ = '<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1" Version="2.0">'
  + '<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">urn:sp</saml:Issuer></samlp:AuthnRequest>';

function signPost(xml) {
  const sig = new SignedXml({ privateKey: keyPem, publicCert: certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "/*[local-name(.)='AuthnRequest']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "/*[local-name(.)='AuthnRequest']/*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}

function redirectQuery(key) {
  const alg = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  const base = `SAMLRequest=${encodeURIComponent(zlib.deflateRawSync(REQ).toString('base64'))}&RelayState=rs%201&SigAlg=${encodeURIComponent(alg)}`;
  const sig = crypto.sign('sha256', Buffer.from(base), key).toString('base64');
  return `${base}&Signature=${encodeURIComponent(sig)}`;
}

test('POST-binding request signature', () => {
  const signed = signPost(REQ);
  verifyRequestSignature({ binding: 'post', xml: signed, certPem });
  assert.throws(() => verifyRequestSignature({ binding: 'post', xml: signed, certPem: other.certPem }), /invalid/i);
  assert.throws(() => verifyRequestSignature({ binding: 'post', xml: REQ, certPem }), /not signed/i);
  assert.throws(() => verifyRequestSignature({ binding: 'post', xml: signed.replace('urn:sp', 'urn:evil'), certPem }), /invalid|cover/i);
});

test('Redirect-binding request signature', () => {
  const q = redirectQuery(keyPem);
  verifyRequestSignature({ binding: 'redirect', rawQuery: q, certPem });
  assert.throws(() => verifyRequestSignature({ binding: 'redirect', rawQuery: q, certPem: other.certPem }), /invalid/i);
  assert.throws(() => verifyRequestSignature({ binding: 'redirect', rawQuery: q.replace('rs%201', 'rs%202'), certPem }), /invalid/i);
  assert.throws(() => verifyRequestSignature({ binding: 'redirect', rawQuery: q.split('&Signature')[0], certPem }), /not signed/i);
});

test('private and loopback addresses are recognised', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.ok(isPrivateAddress(a), a);
  }
  for (const a of ['8.8.8.8', '129.79.1.1', '2607:f8b0:4004::1']) assert.ok(!isPrivateAddress(a), a);
});

test('safeFetchText refuses internal targets and non-http schemes', async () => {
  await assert.rejects(safeFetchText('http://127.0.0.1:1/x'), /non-public/);
  await assert.rejects(safeFetchText('http://169.254.169.254/latest/meta-data'), /non-public/);
  await assert.rejects(safeFetchText('file:///etc/passwd'), /http/);
});

test('federation permissions exist and manage implies view', () => {
  assert.ok(PERMISSIONS.some((p) => p.key === 'federation.manage'));
  assert.ok(normalize(['federation.manage']).has('federation.view'));
});

test('SSO enforces request signatures only for SPs with a registered signing certificate', async () => {
  const mk = (extra) => sps.createSp(sps.parseForm({
    name: 'T', acs_url: 'http://sp.test/acs', nameid_format: 'emailAddress', nameid_source: 'email',
    sign_response: 'on', sign_assertion: 'on', ...extra,
  }).data);
  const strict = mk({ signing_cert_pem: certPem });
  const lax = mk({});
  const server = createApp().listen(0);
  try {
    const base = `http://localhost:${server.address().port}`;
    const get = (id, q) => fetch(`${base}/saml/${id}/sso?${q}`, { redirect: 'manual' });
    const unsigned = `SAMLRequest=${encodeURIComponent(zlib.deflateRawSync(REQ).toString('base64'))}`;

    assert.equal((await get(strict, unsigned)).status, 400, 'unsigned request rejected');
    assert.equal((await get(strict, redirectQuery(other.keyPem))).status, 400, 'wrong key rejected');
    assert.equal((await get(strict, redirectQuery(keyPem))).status, 302, 'correctly signed request accepted (sent to login)');
    assert.equal((await get(lax, unsigned)).status, 302, 'SP without a certificate is unchanged');

    const post = await fetch(`${base}/saml/${strict}/sso`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SAMLRequest: Buffer.from(signPost(REQ)).toString('base64') }),
    });
    assert.equal(post.status, 302, 'signed POST request accepted');
    const unsignedPost = await fetch(`${base}/saml/${strict}/sso`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SAMLRequest: Buffer.from(REQ).toString('base64') }),
    });
    assert.equal(unsignedPost.status, 400, 'unsigned POST request rejected');
  } finally {
    server.close();
  }
});
