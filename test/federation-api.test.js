process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { generateKeyAndCert } = require('../src/crypto');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = '';
  return async function api(path, { method = 'GET', body, csrf } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json };
  };
}
const csrfOf = async (api) => (await api('/api/session')).json.csrf;
async function signIn(username, password) {
  const api = client();
  await api('/api/login', { method: 'POST', csrf: await csrfOf(api), body: { username, password } });
  return { api, csrf: await csrfOf(api) };
}

test('federation sources: permission gating, validation, and secrets stay server-side', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const role = await admin.api('/api/admin/roles', { method: 'POST', csrf: admin.csrf,
    body: { name: 'Fed viewer', permissions: ['federation.view'] } });
  assert.equal(role.status, 201);
  const made = await admin.api('/api/admin/users', { method: 'POST', csrf: admin.csrf,
    body: { username: 'viewer', password: 'viewerpassword', active: true, role_ids: [role.json.role.id] } });
  assert.equal(made.status, 201);

  const bad = await admin.api('/api/admin/federation/sources', { method: 'POST', csrf: admin.csrf,
    body: { name: 'InCommon', url: 'http://md.example/x.xml' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.length >= 2, 'http URL and missing certificate both reported');

  const { certPem } = generateKeyAndCert('pinned');
  const created = await admin.api('/api/admin/federation/sources', { method: 'POST', csrf: admin.csrf,
    body: { name: 'InCommon', url: 'https://md.example/InCommon.xml', signing_cert_pem: certPem } });
  assert.equal(created.status, 201);
  assert.equal(created.json.has_cert, true);
  assert.equal(created.json.signing_cert_pem, undefined, 'pinned certificate is not echoed back');

  const viewer = await signIn('viewer', 'viewerpassword');
  const listed = await viewer.api('/api/admin/federation/sources');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.sources.length, 1);
  assert.equal((await viewer.api('/api/admin/federation/entities')).status, 200);
  const write = await viewer.api('/api/admin/federation/sources', { method: 'POST', csrf: viewer.csrf, body: { name: 'x', url: 'https://a.example/b', signing_cert_pem: certPem } });
  assert.equal(write.status, 403);
  assert.equal((await viewer.api(`/api/admin/federation/sources/${created.json.id}/refresh`, { method: 'POST', csrf: viewer.csrf, body: {} })).status, 403);

  // A refresh pointing at an internal host fails safely and is recorded on the source.
  db.run("UPDATE federation_sources SET url = 'https://127.0.0.1:1/x.xml' WHERE id = ?", created.json.id);
  const refresh = await admin.api(`/api/admin/federation/sources/${created.json.id}/refresh`, { method: 'POST', csrf: admin.csrf, body: {} });
  assert.equal(refresh.status, 502);
  assert.match(refresh.json.source.last_error, /non-public/);

  assert.equal((await admin.api(`/api/admin/federation/sources/${created.json.id}`, { method: 'DELETE', csrf: admin.csrf })).status, 204);
});

test('federation identity settings: validation, key generation, preview gating', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const get = await admin.api('/api/admin/federation/idp');
  assert.equal(get.status, 200);
  assert.equal(get.json.config.enabled, false);
  assert.ok(get.json.categories.some((c) => c.id === 'rs'));
  assert.ok(!get.json.algorithms.signature.some((a) => a.value === 'sha1'), 'SHA-1 is not offered');

  const bad = await admin.api('/api/admin/federation/idp', { method: 'PUT', csrf: admin.csrf, body: { enabled: true } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.some((e) => /scope/i.test(e)));

  const body = {
    enabled: true, scope: 'example.net',
    organization: { name: 'Example Weaving Guild', displayName: 'Example U', url: 'https://www.example.net' },
    contacts: { technical: { name: 'Ops', email: 'ops@example.net' } },
    categories: { rs: true },
  };
  const put = await admin.api('/api/admin/federation/idp', { method: 'PUT', csrf: admin.csrf, body });
  assert.equal(put.status, 200);
  assert.equal(put.json.config.scope, 'example.net');
  assert.ok(put.json.keys.signing.sha256, 'keys are generated on save');
  assert.match(put.json.urls.signedMetadata, /\/fed\/idp\/metadata\?signed=true$/);
  assert.equal(JSON.stringify(put.json).includes('PRIVATE KEY'), false, 'private keys never leave the server');

  const meta = await fetch(`${base}/fed/idp/metadata`);
  assert.equal(meta.status, 200);
  assert.match(await meta.text(), /shibmd:Scope[^>]*>example\.net</);

  // Preview: needs a known SP and a user; a view-only admin cannot use it.
  const noSp = await admin.api('/api/admin/federation/idp/preview?entityId=https://nope.example/sp&userId=1');
  assert.equal(noSp.status, 400);
  const viewer = await signIn('viewer', 'viewerpassword');
  assert.equal((await viewer.api('/api/admin/federation/idp')).status, 200);
  assert.equal((await viewer.api('/api/admin/federation/idp', { method: 'PUT', csrf: viewer.csrf, body })).status, 403);
  assert.equal((await viewer.api('/api/admin/federation/idp/preview?entityId=x&userId=1')).status, 403);
});

test('inbound sign-in settings and the approval queue are permission-gated', async () => {
  const admin = await signIn('admin', 'adminpass123');
  // The organization and technical contact (set in the previous test) are required before enabling.
  const put = await admin.api('/api/admin/federation/sp', { method: 'PUT', csrf: admin.csrf, body: { enabled: true, provisioning: 'approve', idpAllowlist: 'https://a.example/idp\nhttps://a.example/idp\nhttps://b.example/idp' } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.config.idpAllowlist, ['https://a.example/idp', 'https://b.example/idp'], 'allow list is split and de-duplicated');
  assert.ok(put.json.keys.signing.sha256);
  assert.equal(JSON.stringify(put.json).includes('PRIVATE KEY'), false);
  assert.equal((await admin.api('/api/admin/federation/sp', { method: 'PUT', csrf: admin.csrf, body: { provisioning: 'whenever' } })).status, 400);

  const session = await admin.api('/api/session');
  assert.equal(session.json.config.federationLogin, true, 'the sign-in page is told to offer the institution route');

  // Someone waiting in the queue.
  const row = Number(db.run(
    `INSERT INTO federated_identities (idp_entity_id, subject_type, subject, status, display_name, attributes) VALUES (?,?,?,?,?,?)`,
    'https://a.example/idp', 'eppn', 'pat@a.example', 'pending', 'Pat', '{}').lastInsertRowid);

  const fedOnly = await admin.api('/api/admin/roles', { method: 'POST', csrf: admin.csrf, body: { name: 'Fed admin', permissions: ['federation.manage'] } });
  await admin.api('/api/admin/users', { method: 'POST', csrf: admin.csrf, body: { username: 'fedadmin', password: 'fedadminpassword', active: true, role_ids: [fedOnly.json.role.id] } });
  const fa = await signIn('fedadmin', 'fedadminpassword');
  assert.equal((await fa.api('/api/admin/federation/identities')).json.identities.length, 1);
  assert.equal((await fa.api(`/api/admin/federation/identities/${row}/approve`, { method: 'POST', csrf: fa.csrf, body: {} })).status, 403, 'creating accounts needs users.manage');
  assert.equal((await fa.api(`/api/admin/federation/identities/${row}/status`, { method: 'POST', csrf: fa.csrf, body: { status: 'blocked' } })).status, 200);
  assert.equal((await fa.api(`/api/admin/federation/identities/${row}/status`, { method: 'POST', csrf: fa.csrf, body: { status: 'active' } })).status, 400, 'cannot activate an identity with no account');

  const viewer = await signIn('viewer', 'viewerpassword');
  assert.equal((await viewer.api('/api/admin/federation/sp')).status, 200);
  assert.equal((await viewer.api(`/api/admin/federation/identities/${row}/status`, { method: 'POST', csrf: viewer.csrf, body: { status: 'active' } })).status, 403);
  assert.equal((await viewer.api(`/api/admin/federation/identities/${row}`, { method: 'DELETE', csrf: viewer.csrf })).status, 403);

  const approved = await admin.api(`/api/admin/federation/identities/${row}/approve`, { method: 'POST', csrf: admin.csrf, body: {} });
  assert.equal(approved.status, 200);
  const pat = approved.json.identities.find((i) => i.id === row);
  assert.equal(pat.status, 'active');
  assert.equal(pat.username, 'pat@a.example');
  assert.equal((await admin.api(`/api/admin/federation/identities/${row}`, { method: 'DELETE', csrf: admin.csrf })).status, 200);
  assert.ok(db.get("SELECT 1 FROM users WHERE username = 'pat@a.example'"), 'forgetting a sign-in keeps the account');
});

test('key rollover endpoints step through stage, activate and retire, and are permission-gated', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const post = (kind, action, who = admin) => who.api(`/api/admin/federation/${kind}/keys/${action}`, { method: 'POST', csrf: who.csrf, body: {} });

  for (const kind of ['idp', 'sp']) {
    const before = (await admin.api(`/api/admin/federation/${kind}`)).json.keys;
    assert.equal(before.next, null);
    assert.equal((await post(kind, 'activate')).status, 400, 'nothing staged yet');

    const staged = await post(kind, 'stage');
    assert.equal(staged.status, 200);
    assert.ok(staged.json.keys.next.signing.sha256);
    assert.equal(staged.json.keys.signing.sha256, before.signing.sha256, 'active key unchanged');
    assert.equal((await post(kind, 'stage')).status, 400, 'only one staged key');

    const activated = await post(kind, 'activate');
    assert.equal(activated.json.keys.signing.sha256, staged.json.keys.next.signing.sha256);
    assert.equal(activated.json.keys.previous.signing.sha256, before.signing.sha256);
    assert.equal(activated.json.keys.next, null);
    assert.equal(JSON.stringify(activated.json).includes('PRIVATE KEY'), false);

    assert.equal((await post(kind, 'retire')).json.keys.previous, null);
    assert.equal((await post(kind, 'retire')).status, 400);
    assert.equal((await post(kind, 'explode')).status, 404);
  }

  const viewer = await signIn('viewer', 'viewerpassword');
  assert.equal((await post('idp', 'stage', viewer)).status, 403);
});

test('health and entity detail', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const health = await admin.api('/api/admin/federation/health');
  assert.equal(health.status, 200);
  assert.ok(Array.isArray(health.json.alerts));

  const { certPem } = generateKeyAndCert('pinned');
  const src = Number(db.run('INSERT INTO federation_sources (name, url, signing_cert_pem, last_error) VALUES (?,?,?,?)', 'Broken', 'https://md.example/x.xml', certPem, 'boom').lastInsertRowid);
  const alerts = (await admin.api('/api/admin/federation/health')).json.alerts;
  assert.ok(alerts.some((a) => a.code === 'source-refresh-failed' && a.title === 'Broken'));

  db.run('UPDATE federation_sources SET valid_until = ?, last_error = ? WHERE id = ?', new Date(Date.now() + 86400000).toISOString(), '', src);
  db.run(`INSERT INTO federation_entities (source_id, entity_id, is_idp, display_name, parsed, xml) VALUES (?,?,?,?,?,?)`, src, 'https://idp.detail.net/idp', 1, 'Detail U',
    JSON.stringify({ entityAttributes: {}, registrationAuthority: 'https://incommon.org', idp: { ui: {}, scopes: [{ value: 'detail.net', regexp: false }], keys: [{ use: 'signing', certificate: certPem.replace(/-----[A-Z ]+-----|\s/g, '') }], singleSignOnServices: [] }, sp: null }), '<x/>');
  const detail = await admin.api('/api/admin/federation/entity?entityId=' + encodeURIComponent('https://idp.detail.net/idp'));
  assert.equal(detail.status, 200);
  assert.equal(detail.json.parsed.idp.keys[0].use, 'signing');
  assert.match(detail.json.parsed.idp.keys[0].sha256, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/, 'a fingerprint to compare');
  assert.equal(detail.json.parsed.idp.keys[0].certificate, undefined, 'raw certificate body is not sent');
  assert.equal((await admin.api('/api/admin/federation/entity?entityId=nope')).status, 404);
});

test('MDQ sources: created through the API, tested with a lookup, and their cache dropped when the address changes', async () => {
  const admin = await signIn('admin', 'adminpass123');
  const { certPem } = generateKeyAndCert('mdq pinned');
  const created = await admin.api('/api/admin/federation/sources', { method: 'POST', csrf: admin.csrf,
    body: { name: 'MDQ', kind: 'mdq', url: 'https://mdq.example/entities/', signing_cert_pem: certPem } });
  assert.equal(created.status, 201);
  assert.equal(created.json.kind, 'mdq');
  assert.equal(created.json.url, 'https://mdq.example', 'trailing /entities/ is dropped');
  assert.equal(created.json.roles, 'all');
  const id = created.json.id;

  const listed = await admin.api('/api/admin/federation/sources');
  assert.match(listed.json.defaults.incommonMdqUrl, /^https:\/\/mdq\./);
  assert.match(listed.json.defaults.incommonIdpOnlyUrl, /^https:\/\//);

  // There is nothing to refresh on a source that is queried on demand.
  const refresh = await admin.api(`/api/admin/federation/sources/${id}/refresh`, { method: 'POST', csrf: admin.csrf, body: {} });
  assert.equal(refresh.status, 502);
  assert.match(refresh.json.errors[0], /on demand/);

  // A test lookup against an internal address fails safely, and is recorded.
  db.run("UPDATE federation_sources SET url = 'https://127.0.0.1:1' WHERE id = ?", id);
  const bad = await admin.api(`/api/admin/federation/sources/${id}/lookup`, { method: 'POST', csrf: admin.csrf, body: { entityId: 'https://idp.example.net/idp' } });
  assert.equal(bad.status, 502);
  assert.match(bad.json.source.last_error, /non-public/);
  const noId = await admin.api(`/api/admin/federation/sources/${id}/lookup`, { method: 'POST', csrf: admin.csrf, body: { entityId: 'nope' } });
  assert.equal(noId.status, 502);
  assert.match(noId.json.errors[0], /entity ID/i);

  // Changing the address or certificate discards what was cached under the old one.
  db.run("INSERT INTO federation_entities (source_id, entity_id, is_sp, display_name, parsed, xml) VALUES (?,?,1,'Cached','{}','<x/>')", id, 'https://cached.example/sp');
  const moved = await admin.api(`/api/admin/federation/sources/${id}`, { method: 'PUT', csrf: admin.csrf, body: { name: 'MDQ', kind: 'mdq', url: 'https://mdq2.example' } });
  assert.equal(moved.status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM federation_entities WHERE source_id = ?', id).n, 0);

  const viewer = await signIn('viewer', 'viewerpassword');
  assert.equal((await viewer.api(`/api/admin/federation/sources/${id}/lookup`, { method: 'POST', csrf: viewer.csrf, body: { entityId: 'https://x.example/idp' } })).status, 403);
  assert.equal((await admin.api(`/api/admin/federation/sources/${id}`, { method: 'DELETE', csrf: admin.csrf })).status, 204);
});
