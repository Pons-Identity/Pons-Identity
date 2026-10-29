process.env.DB_PATH = ':memory:';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const { SignedXml } = require('xml-crypto');
const db = require('../src/db');
const appSettings = require('../src/app-settings');
const keyring = require('../src/federation/keyring');
const idp = require('../src/federation/idp');
const fedSp = require('../src/federation/sp');
const md = require('../src/federation/metadata-source');
const health = require('../src/federation/health');
const { decryptAssertion } = require('../src/federation/xml-decrypt');
const { encryptAssertion } = require('../src/saml/encrypt');
const { parseXml } = require('../src/saml/xml');
const { generateKeyAndCert, certBody } = require('../src/crypto');

const DAY = 86400000;

/* --------------------------------- keyring --------------------------------- */

test('rollover: stage, activate, retire — each step only when it makes sense', () => {
  const k0 = keyring.create('t');
  assert.equal(k0.next, null);
  assert.throws(() => keyring.activate(k0), /no staged key/);
  assert.throws(() => keyring.retire(k0), /no previous key/);
  assert.throws(() => keyring.cancel(k0), /no staged key/);

  const k1 = keyring.stage(k0, 't');
  assert.throws(() => keyring.stage(k1, 't'), /already staged/);
  assert.deepEqual(keyring.published(k1, 'signing').map((c) => c.role), ['active', 'next']);
  assert.equal(keyring.cancel(k1).next, null);

  const k2 = keyring.activate(k1);
  assert.equal(k2.signing.certPem, k1.next.signing.certPem, 'the staged key is now the active one');
  assert.equal(k2.previous.signing.certPem, k0.signing.certPem, 'the old key stays published');
  assert.equal(k2.next, null);
  assert.deepEqual(keyring.published(k2, 'encryption').map((c) => c.role), ['active', 'previous']);
  assert.throws(() => keyring.activate(keyring.stage(k2, 't')), /Retire the previous key first/);

  assert.equal(keyring.retire(k2).previous, null);
  // Anything encrypted to the old, current or staged certificate can still be opened.
  assert.deepEqual(keyring.decryptionKeys(keyring.stage(k2, 't')).length, 3);
  assert.equal(keyring.decryptionKeys(k0).length, 1);
});

const keyCount = (xml, use) => (xml.match(new RegExp(`<md:KeyDescriptor use="${use}"`, 'g')) || []).length;
const signer = (xml) => {
  const doc = parseXml(xml);
  const cert = doc.getElementsByTagNameNS('*', 'X509Certificate')[0].textContent.trim();
  return cert;
};

test('IdP metadata publishes staged and previous keys, and signs only with the active one', () => {
  const { data } = appSettings.parseFederationIdp({
    enabled: true, scope: 'example.net',
    organization: { name: 'Example', displayName: 'Example', url: 'https://example.net' }, contacts: { technical: { email: 'ops@example.net' } },
  });
  appSettings.saveFederationIdp(data);
  const set = (fn) => appSettings.saveFederationKeys(fn(idp.ensureKeys(), idp.KEY_LABEL));
  const original = certBody(idp.ensureKeys().signing.certPem);
  let xml = idp.buildMetadata();
  assert.deepEqual([keyCount(xml, 'signing'), keyCount(xml, 'encryption')], [1, 1]);

  set(keyring.stage);
  const staged = certBody(idp.ensureKeys().next.signing.certPem);
  xml = idp.buildMetadata();
  assert.deepEqual([keyCount(xml, 'signing'), keyCount(xml, 'encryption')], [2, 2]);
  assert.ok(xml.includes(staged) && xml.includes(original));
  assert.equal(signer(idp.buildMetadata({ signed: true })), original, 'still signing with the old key while the new one is only staged');

  set(keyring.activate);
  xml = idp.buildMetadata();
  assert.deepEqual([keyCount(xml, 'signing'), keyCount(xml, 'encryption')], [2, 2], 'old key still published');
  assert.equal(signer(idp.buildMetadata({ signed: true })), staged, 'now signing with the new key');
  assert.equal(certBody(idp.ensureKeys().signing.certPem), staged);

  set(keyring.retire);
  xml = idp.buildMetadata();
  assert.deepEqual([keyCount(xml, 'signing'), keyCount(xml, 'encryption')], [1, 1]);
  assert.ok(!xml.includes(original));
});

test('assertions encrypted to the previous or staged SP certificate can still be read', () => {
  let keys = fedSp.ensureKeys();
  const sp = (certPem) => ({ encryption_cert_pem: certPem, encryption_algorithm: 'aes128-gcm', key_transport_algorithm: 'rsa-oaep-mgf1p' });
  const plain = '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a" Version="2.0"/>';
  const open = (certPem) => decryptAssertion(parseXml(encryptAssertion(plain, sp(certPem))).documentElement, keyring.decryptionKeys(keys));

  const oldCert = keys.encryption.certPem;
  keys = keyring.stage(keys, 't');
  assert.equal(open(keys.next.encryption.certPem), plain, 'IdP already picked up the staged certificate');
  keys = keyring.activate(keys);
  assert.equal(open(oldCert), plain, 'IdP still holding the old certificate');
  assert.equal(open(keys.encryption.certPem), plain);
  keys = keyring.retire(keys);
  assert.throws(() => open(oldCert), /could not be decrypted/, 'a retired key no longer decrypts');
});

/* ----------------------------- expiry and health ----------------------------- */

const fedKey = generateKeyAndCert('federation signer');
const NSDECL = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
function signedAggregate(body, validUntil) {
  const xml = `<md:EntitiesDescriptor ${NSDECL} ID="_agg" validUntil="${validUntil}">${body}</md:EntitiesDescriptor>`;
  const sig = new SignedXml({ privateKey: fedKey.keyPem, publicCert: fedKey.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "/*[local-name(.)='EntitiesDescriptor']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "/*[local-name(.)='EntitiesDescriptor']", action: 'prepend' }, prefix: 'ds' });
  return sig.getSignedXml();
}
const SP = `<md:EntityDescriptor entityID="https://sp.example.org/sp"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.org/acs" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`;
const addSource = (name, certPem = fedKey.certPem) => Number(db.run('INSERT INTO federation_sources (name, url, signing_cert_pem) VALUES (?,?,?)', name, 'https://md.example/x.xml', certPem).lastInsertRowid);
const fetchOf = (xml) => async () => ({ status: 200, text: xml, headers: new Map() });

test('metadata past its validUntil stops being trusted, and returns when it is refreshed', async () => {
  const id = addSource('Expiring');
  await md.refreshSource(id, { fetchText: fetchOf(signedAggregate(SP, new Date(Date.now() + DAY).toISOString())) });
  assert.ok(md.findEntity('https://sp.example.org/sp'));
  assert.equal(md.searchEntities({ q: 'sp.example' }).total, 1);
  assert.ok(idp.forEntity('https://sp.example.org/sp', { preview: true }));

  db.run("UPDATE federation_sources SET valid_until = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), id);
  assert.equal(md.findEntity('https://sp.example.org/sp'), null);
  assert.equal(md.searchEntities({ q: 'sp.example' }).total, 0);
  assert.equal(idp.forEntity('https://sp.example.org/sp', { preview: true }), null, 'no sign-in on expired metadata');

  await md.refreshSource(id, { fetchText: fetchOf(signedAggregate(SP, new Date(Date.now() + 3 * DAY).toISOString())) });
  assert.ok(md.findEntity('https://sp.example.org/sp'));
  assert.ok(md.get(id).valid_until.endsWith('Z'), 'stored as UTC ISO');
  db.run('DELETE FROM federation_sources WHERE id = ?', id);
});

const codes = (now) => health.alerts(now).map((a) => `${a.severity}:${a.code}`);

test('alerts for sources: failing, expired, stale, never fetched, and an expiring pinned certificate', async () => {
  db.run('DELETE FROM federation_sources');
  assert.deepEqual(codes(), []);

  const fresh = addSource('Fresh');
  await md.refreshSource(fresh, { fetchText: fetchOf(signedAggregate(SP, new Date(Date.now() + 7 * DAY).toISOString())) });
  assert.deepEqual(codes(), [], 'a healthy source raises nothing');

  const never = addSource('Never');
  assert.deepEqual(codes(), ['warning:source-never-fetched']);
  db.run('DELETE FROM federation_sources WHERE id = ?', never);

  // A failed refresh is a warning while the old copy is good for a while, an error when it is about to lapse.
  await assert.rejects(md.refreshSource(fresh, { fetchText: async () => { throw new Error('connect ETIMEDOUT'); } }));
  let a = health.alerts().find((x) => x.code === 'source-refresh-failed');
  assert.equal(a.severity, 'warning');
  assert.match(a.detail, /ETIMEDOUT/);
  db.run('UPDATE federation_sources SET valid_until = ? WHERE id = ?', new Date(Date.now() + 3 * 3600000).toISOString(), fresh);
  assert.equal(health.alerts().find((x) => x.code === 'source-refresh-failed').severity, 'error');
  db.run('UPDATE federation_sources SET valid_until = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), fresh);
  assert.deepEqual(codes(), ['error:source-expired']);

  // Silent staleness: no error recorded but nothing has refreshed for far longer than the interval.
  db.run("UPDATE federation_sources SET last_error = '', valid_until = ?, last_success_at = ? WHERE id = ?",
    new Date(Date.now() + 7 * DAY).toISOString(), new Date(Date.now() - 5 * DAY).toISOString(), fresh);
  assert.deepEqual(codes(), ['warning:source-stale']);
  db.run('DELETE FROM federation_sources');

  // The pinned signing certificate running out is the federation's trust anchor failing.
  const soon = generateKeyAndCert('federation signer (expiring)', { days: 20 });
  const near = addSource('Near', soon.certPem);
  assert.deepEqual(codes().filter((c) => /cert/.test(c)), ['warning:source-cert-expiring']);
  assert.deepEqual(codes(Date.now() + 10 * DAY).filter((c) => /cert/.test(c)), ['error:source-cert-expiring']);
  assert.deepEqual(codes(Date.now() + 30 * DAY).filter((c) => /cert/.test(c)), ['error:source-cert-expired']);
  db.run('DELETE FROM federation_sources WHERE id = ?', near);
});

test('alerts for keys: expiring certificates and an unfinished rollover', () => {
  db.run('DELETE FROM federation_sources');
  const { data } = appSettings.parseFederationIdp({
    enabled: true, scope: 'example.net',
    organization: { name: 'Example', displayName: 'Example', url: 'https://example.net' }, contacts: { technical: { email: 'ops@example.net' } },
  });
  appSettings.saveFederationIdp(data);
  const fresh = keyring.create('t');
  appSettings.saveFederationKeys(fresh);
  assert.deepEqual(codes(), []);

  // Generated keys last 3650 days; look ahead to when 60 or 10 of them remain.
  assert.deepEqual(codes(Date.now() + 3590 * DAY), ['warning:key-expiring', 'warning:key-expiring'], 'within 90 days warns, for signing and encryption');
  assert.deepEqual(codes(Date.now() + 3640 * DAY), ['error:key-expiring', 'error:key-expiring'], 'within 30 days is an error');

  appSettings.saveFederationKeys(keyring.stage(fresh, 't'));
  assert.deepEqual(codes(), ['info:key-staged']);
  appSettings.saveFederationKeys(keyring.activate(keyring.stage(fresh, 't')));
  assert.deepEqual(codes(), ['info:key-previous']);

  // Alerts only concern what is switched on.
  appSettings.saveFederationIdp({ ...data, enabled: false });
  assert.deepEqual(codes(), []);
});
