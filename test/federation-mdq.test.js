process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
process.env.ALLOW_PRIVATE_FETCH = 'true'; // the end-to-end test queries a stub MDQ service on localhost
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('zlib');
const { SignedXml } = require('xml-crypto');
const db = require('../src/db');
const appSettings = require('../src/app-settings');
const md = require('../src/federation/metadata-source');
const mdq = require('../src/federation/mdq');
const fedSp = require('../src/federation/sp');
const { generateKeyAndCert, certBody } = require('../src/crypto');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const mdqKey = generateKeyAndCert('mdq signer');
const aggKey = generateKeyAndCert('aggregate signer');
const evilKey = generateKeyAndCert('attacker');
const entityKey = certBody(generateKeyAndCert('entity').certPem);
const HOUR = 3600000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const NS = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';

const spBody = (id) => `<md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${id}/acs" index="0" isDefault="true"/></md:SPSSODescriptor>`;
const idpBody = (id) => `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:Extensions><shibmd:Scope xmlns:shibmd="urn:mace:shibboleth:metadata:1.0" regexp="false">partner.net</shibmd:Scope></md:Extensions><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${entityKey}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${id}/sso"/></md:IDPSSODescriptor>`;

function sign(xml, rootName, key) {
  const sig = new SignedXml({ privateKey: key.keyPem, publicCert: key.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: `/*[local-name(.)='${rootName}']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: `/*[local-name(.)='${rootName}']`, action: 'prepend' }, prefix: 'ds' });
  return sig.getSignedXml();
}
/** What an MDQ service returns: one signed EntityDescriptor. */
function mdqEntity(id, { kind = 'sp', signer = mdqKey, validUntil = iso(7 * 24 * HOUR), cacheDuration, entityId = id } = {}) {
  const attrs = `ID="_e${Math.random().toString(36).slice(2)}" entityID="${entityId}" validUntil="${validUntil}"${cacheDuration ? ` cacheDuration="${cacheDuration}"` : ''}`;
  return sign(`<md:EntityDescriptor ${NS} ${attrs}>${kind === 'sp' ? spBody(id) : idpBody(id)}</md:EntityDescriptor>`, 'EntityDescriptor', signer);
}
const aggregate = (body, validUntil = iso(7 * 24 * HOUR)) => sign(`<md:EntitiesDescriptor ${NS} ID="_agg" validUntil="${validUntil}">${body}</md:EntitiesDescriptor>`, 'EntitiesDescriptor', aggKey);
const entityXml = (id, kind) => (kind === 'sp'
  ? `<md:EntityDescriptor entityID="${id}">${spBody(id)}</md:EntityDescriptor>`
  : `<md:EntityDescriptor entityID="${id}">${idpBody(id)}</md:EntityDescriptor>`);

const addMdq = (name = 'MDQ', url = 'https://mdq.example') => Number(db.run(
  "INSERT INTO federation_sources (name, kind, url, signing_cert_pem) VALUES (?, 'mdq', ?, ?)", name, url, mdqKey.certPem).lastInsertRowid);
const reset = () => { mdq.reset(); db.run('DELETE FROM federation_entities'); db.run('DELETE FROM federation_sources'); };

/** A fetch that answers from `entities` ({ id: xml | Error }) and records every request. */
function stub(entities) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const id = decodeURIComponent(url.split('/entities/')[1]);
    const r = entities[id];
    if (r === undefined) throw new Error('HTTP 404');
    if (r instanceof Error) throw r;
    return { status: 200, text: r, headers: new Map() };
  };
  fn.calls = calls;
  return fn;
}

/* ------------------------------------ forms ------------------------------------ */

test('source forms: kind, role filter and MDQ address normalisation', () => {
  const form = (o) => md.parseSourceForm({ name: 'x', url: 'https://mdq.example', signing_cert_pem: mdqKey.certPem, ...o });
  assert.equal(form({ kind: 'mdq', url: 'https://mdq.example/' }).data.url, 'https://mdq.example');
  assert.equal(form({ kind: 'mdq', url: 'https://mdq.example/entities/' }).data.url, 'https://mdq.example', 'a pasted /entities path is not part of the base');
  assert.equal(form({ kind: 'mdq', roles: 'idp' }).data.roles, 'all', 'a query service has no role filter');
  assert.equal(form({}).data.kind, 'aggregate');
  assert.equal(form({ roles: 'idp' }).data.roles, 'idp');
  assert.ok(form({ kind: 'carrier-pigeon' }).errors.some((e) => /MDQ/.test(e)));
  assert.ok(form({ roles: 'everything' }).errors.some((e) => /which entities/i.test(e)));
  assert.ok(form({ kind: 'mdq', url: 'http://mdq.example' }).errors.some((e) => /MDQ service URL must be https/.test(e)));
  assert.ok(form({ kind: 'mdq', signing_cert_pem: '' }).errors.some((e) => /certificate/i.test(e)));
});

test('durations are read as ISO 8601', () => {
  assert.equal(mdq.durationMs('PT6H'), 6 * HOUR);
  assert.equal(mdq.durationMs('P1DT12H30M'), 36.5 * HOUR);
  assert.equal(mdq.durationMs('PT90S'), 90000);
  for (const bad of ['', 'P', 'PT', '6 hours', 'PT-1H', null, undefined]) assert.equal(mdq.durationMs(bad), null, String(bad));
});

test('an aggregate can keep only identity providers, to stay small', async () => {
  reset();
  const id = Number(db.run("INSERT INTO federation_sources (name, url, signing_cert_pem, roles) VALUES ('IdPs', 'https://md.example/idp.xml', ?, 'idp')", aggKey.certPem).lastInsertRowid);
  const body = entityXml('https://idp.a.net/idp', 'idp') + entityXml('https://sp.b.org/sp', 'sp') + entityXml('https://idp.c.net/idp', 'idp');
  await md.refreshSource(id, { fetchText: async () => ({ status: 200, text: aggregate(body), headers: new Map() }) });
  assert.equal(md.get(id).entity_count, 2);
  assert.equal(md.searchEntities({ role: 'sp' }).total, 0);
  assert.equal(md.searchEntities({ role: 'idp' }).total, 2);
});

/* ------------------------------------- lookups ------------------------------------- */

const SP = 'https://sp.example.org/shibboleth';

test('an unknown entity is fetched once, verified, cached and then served from the cache', async () => {
  reset();
  const src = addMdq();
  const fetchText = stub({ [SP]: mdqEntity(SP, { cacheDuration: 'PT2H' }) });
  assert.equal(md.findEntity(SP), null);

  const e = await mdq.ensureEntity(SP, { fetchText });
  assert.equal(e.entity_id, SP);
  assert.equal(fetchText.calls.length, 1);
  assert.equal(fetchText.calls[0].url, `https://mdq.example/entities/${encodeURIComponent(SP)}`);
  assert.equal(fetchText.calls[0].url, 'https://mdq.example/entities/https%3A%2F%2Fsp.example.org%2Fshibboleth');
  assert.equal(fetchText.calls[0].headers.Accept, 'application/samlmetadata+xml');
  assert.equal(md.findEntity(SP).parsed.sp.assertionConsumerServices[0].location, `${SP}/acs`);
  assert.equal(md.get(src).entity_count, 1);
  assert.ok(md.get(src).last_success_at);

  await mdq.ensureEntity(SP, { fetchText });
  assert.equal(fetchText.calls.length, 1, 'served from the cache');
  const row = db.get('SELECT fetched_at, expires_at FROM federation_entities WHERE entity_id = ?', SP);
  assert.ok(Math.abs(Date.parse(row.expires_at) - Date.parse(row.fetched_at) - 2 * HOUR) < 1000, 'cacheDuration sets the lifetime');

  // After the lifetime it is asked for again, and the copy is replaced rather than duplicated.
  await mdq.ensureEntity(SP, { fetchText, now: new Date(Date.now() + 3 * HOUR) });
  assert.equal(fetchText.calls.length, 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM federation_entities WHERE entity_id = ?', SP).n, 1);
});

test('the cache lifetime is bounded by the entity\'s own validUntil and by sane limits', async () => {
  reset();
  addMdq();
  const soon = iso(30 * 60000);
  await mdq.ensureEntity(SP, { fetchText: stub({ [SP]: mdqEntity(SP, { validUntil: soon, cacheDuration: 'PT20H' }) }) });
  let row = db.get('SELECT expires_at FROM federation_entities WHERE entity_id = ?', SP);
  assert.equal(row.expires_at, new Date(soon).toISOString(), 'never cached beyond validUntil');

  reset();
  addMdq();
  await mdq.ensureEntity(SP, { fetchText: stub({ [SP]: mdqEntity(SP, { cacheDuration: 'P30D' }) }) });
  row = db.get('SELECT fetched_at, expires_at FROM federation_entities WHERE entity_id = ?', SP);
  assert.ok(Date.parse(row.expires_at) - Date.parse(row.fetched_at) <= 24 * HOUR + 1000, 'capped at a day');
});

test('forged, mismatched and expired answers are never cached', async () => {
  for (const [name, xml, pattern] of [
    ['signed by another key', mdqEntity(SP, { signer: evilKey }), /invalid|signature/i],
    ['a different entity than asked for', mdqEntity('https://other.example/sp'), /different entity/i],
    ['entityID swapped after signing', mdqEntity(SP).replace(`entityID="${SP}"`, 'entityID="https://other.example/sp"'), /invalid|different/i],
    ['expired', mdqEntity(SP, { validUntil: iso(-HOUR) }), /expired/i],
    ['unsigned', `<md:EntityDescriptor ${NS} entityID="${SP}" validUntil="${iso(HOUR)}">${spBody(SP)}</md:EntityDescriptor>`, /not signed/i],
  ]) {
    reset();
    const src = addMdq();
    const e = await mdq.ensureEntity(SP, { fetchText: stub({ [SP]: xml }) });
    assert.equal(e, null, name);
    assert.equal(md.findEntity(SP), null, `${name}: nothing cached`);
    assert.match(md.get(src).last_error, pattern, name);
    assert.ok(md.get(src).last_error.includes(SP), 'the error says which entity');
  }
  // A signature that covers a multi-entity document is not accepted as an answer for one entity.
  reset();
  addMdq();
  const two = sign(`<md:EntitiesDescriptor ${NS} ID="_two" validUntil="${iso(HOUR)}">${entityXml(SP, 'sp')}${entityXml('https://smuggled.example/sp', 'sp')}</md:EntitiesDescriptor>`, 'EntitiesDescriptor', mdqKey);
  assert.equal(await mdq.ensureEntity(SP, { fetchText: stub({ [SP]: two }) }), null);
  assert.equal(md.findEntity('https://smuggled.example/sp'), null);
});

test('unknown entities and failures are remembered briefly instead of being asked for again', async () => {
  reset();
  const src = addMdq();
  const fetchText = stub({});
  const t0 = new Date();
  assert.equal(await mdq.ensureEntity('https://nobody.example/sp', { fetchText, now: t0 }), null);
  assert.equal(await mdq.ensureEntity('https://nobody.example/sp', { fetchText, now: t0 }), null);
  assert.equal(fetchText.calls.length, 1, 'a 404 is not repeated');
  assert.equal(md.get(src).last_error, '', 'an unknown entity is not a service fault');
  await mdq.ensureEntity('https://nobody.example/sp', { fetchText, now: new Date(t0.getTime() + 6 * 60000) });
  assert.equal(fetchText.calls.length, 2, 'asked again after the pause');

  const down = stub({ [SP]: new Error('connect ECONNREFUSED') });
  await mdq.ensureEntity(SP, { fetchText: down, now: t0 });
  await mdq.ensureEntity(SP, { fetchText: down, now: t0 });
  assert.equal(down.calls.length, 1, 'not hammered while failing');
  assert.match(md.get(src).last_error, /ECONNREFUSED/);
  await mdq.ensureEntity(SP, { fetchText: down, now: new Date(t0.getTime() + 31000) });
  assert.equal(down.calls.length, 2, 'retried soon');
});

test('if the service is down when the cache expires, the old copy keeps working until its validUntil', async () => {
  reset();
  addMdq();
  await mdq.ensureEntity(SP, { fetchText: stub({ [SP]: mdqEntity(SP, { cacheDuration: 'PT1H', validUntil: iso(10 * HOUR) }) }) });
  const later = new Date(Date.now() + 3 * HOUR);
  const e = await mdq.ensureEntity(SP, { fetchText: stub({ [SP]: new Error('HTTP 503') }), now: later });
  assert.equal(e.entity_id, SP, 'stale-if-error');
  assert.ok(md.findEntity(SP));
  // Past validUntil nothing is served, outage or not.
  db.run('UPDATE federation_entities SET valid_until = ?', iso(-1000));
  assert.equal(md.findEntity(SP), null);
});

test('concurrent requests share one lookup, and bulk-loaded entities never trigger one', async () => {
  reset();
  addMdq();
  const fetchText = stub({ [SP]: mdqEntity(SP) });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => mdq.ensureEntity(SP, { fetchText })));
  assert.equal(fetchText.calls.length, 1);
  assert.ok(results.every((r) => r && r.entity_id === SP));

  const agg = Number(db.run("INSERT INTO federation_sources (name, url, signing_cert_pem) VALUES ('Agg', 'https://md.example/a.xml', ?)", aggKey.certPem).lastInsertRowid);
  await md.refreshSource(agg, { fetchText: async () => ({ status: 200, text: aggregate(entityXml('https://known.example/sp', 'sp')), headers: new Map() }) });
  const quiet = stub({});
  assert.ok(await mdq.ensureEntity('https://known.example/sp', { fetchText: quiet }));
  assert.equal(quiet.calls.length, 0);
  assert.equal(md.searchEntities({ q: 'example' }).total, 2, 'an entity held twice is listed once');
});

test('implausible entity IDs are ignored, and lookups are rate limited', async () => {
  reset();
  addMdq();
  const fetchText = stub({});
  for (const bad of ['', 'no-scheme', 'https://has space/sp', `https://${'a'.repeat(1100)}.example/sp`, null, undefined, 42, {}]) {
    assert.equal(await mdq.ensureEntity(bad, { fetchText }), null);
  }
  assert.equal(fetchText.calls.length, 0);

  for (let i = 0; i < 80; i++) await mdq.ensureEntity(`https://flood${i}.example/sp`, { fetchText });
  assert.equal(fetchText.calls.length, 60, 'at most 60 queries a minute, however many IDs are sent');
});

test('with no MDQ source, nothing is ever fetched', async () => {
  reset();
  const fetchText = stub({});
  assert.equal(await mdq.ensureEntity(SP, { fetchText }), null);
  assert.equal(fetchText.calls.length, 0);
  const src = addMdq();
  db.run('UPDATE federation_sources SET enabled = 0 WHERE id = ?', src);
  assert.equal(await mdq.ensureEntity(SP, { fetchText }), null);
  assert.equal(fetchText.calls.length, 0, 'a disabled source is not queried');
});

test('old cached lookups are pruned; a source of this kind is not refreshed on a schedule', async () => {
  reset();
  const src = addMdq();
  await mdq.ensureEntity(SP, { fetchText: stub({ [SP]: mdqEntity(SP) }) });
  mdq.pruneCache();
  assert.equal(md.get(src).entity_count, 1);
  mdq.pruneCache(new Date(Date.now() + 31 * 24 * HOUR));
  assert.equal(md.get(src).entity_count, 0);
  assert.equal(md.dueSources().length, 0);
  await assert.rejects(md.refreshSource(src), /on demand/);
});

/* ------------------------------ end to end over HTTP ------------------------------ */

test('end to end: sign-in requests from, and sign-ins to, institutions known only to an MDQ service', async () => {
  reset();
  const IDP = 'https://idp.partner.net/idp';
  const served = { [SP]: mdqEntity(SP), [IDP]: mdqEntity(IDP, { kind: 'idp' }) };
  const requests = [];
  const stubServer = http.createServer((req, res) => {
    requests.push(req.url);
    const id = decodeURIComponent(req.url.replace('/entities/', ''));
    if (!served[id]) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/samlmetadata+xml');
    res.end(served[id]);
  }).listen(0);
  const src = addMdq('Local MDQ', `http://127.0.0.1:${stubServer.address().port}`);

  const org = { name: 'Example', displayName: 'Example U', url: 'https://www.example.net' };
  appSettings.saveFederationIdp(appSettings.parseFederationIdp({ enabled: true, scope: 'example.net', organization: org, contacts: { technical: { email: 'ops@example.net' } } }).data);
  appSettings.saveFederationSp(appSettings.parseFederationSp({ enabled: true }, appSettings.federationIdp()).data);

  const server = createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  const authn = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_q1" Version="2.0" AssertionConsumerServiceURL="${SP}/acs"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${SP}</saml:Issuer></samlp:AuthnRequest>`;
  const sso = (xml) => `${base}/fed/idp/sso?${new URLSearchParams({ SAMLRequest: zlib.deflateRawSync(xml).toString('base64') })}`;
  try {
    // Outbound: an SP nobody imported sends a request. It is looked up, found, and the person is sent to sign in.
    let r = await fetch(sso(authn), { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.ok(r.headers.get('location').startsWith('/login'));
    assert.deepEqual(requests, [`/entities/${encodeURIComponent(SP)}`]);
    r = await fetch(sso(authn), { redirect: 'manual' });
    assert.equal(requests.length, 1, 'the second request comes from the cache');

    // An SP the service has never heard of is refused, and asked about once.
    const stranger = authn.replace(new RegExp(SP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'https://stranger.example/sp');
    assert.equal((await fetch(sso(stranger), { redirect: 'manual' })).status, 403);
    assert.equal((await fetch(sso(stranger), { redirect: 'manual' })).status, 403);
    assert.equal(requests.filter((u) => u.includes('stranger')).length, 1);

    // Inbound: the person picks an institution that is not in any imported file; it is looked up and they are sent there.
    r = await fetch(`${base}/fed/sp/login?idp=${encodeURIComponent(IDP)}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(new URL(r.headers.get('location')).origin + new URL(r.headers.get('location')).pathname, `${IDP}/sso`);
    assert.ok(requests.includes(`/entities/${encodeURIComponent(IDP)}`));
    assert.equal((await fetch(`${base}/fed/sp/login?idp=${encodeURIComponent('https://unknown.example/idp')}`, { redirect: 'manual' })).status, 403);

    // Rejecting a bad answer: the service now signs with the wrong key.
    served['https://idp.bad.net/idp'] = mdqEntity('https://idp.bad.net/idp', { kind: 'idp', signer: evilKey });
    assert.equal((await fetch(`${base}/fed/sp/login?idp=${encodeURIComponent('https://idp.bad.net/idp')}`, { redirect: 'manual' })).status, 403);
    assert.match(md.get(src).last_error, /idp\.bad\.net/);
  } finally {
    server.close();
    stubServer.close();
  }
});
