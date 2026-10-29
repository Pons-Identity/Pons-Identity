process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const db = require('../src/db');
const jwt = require('../src/jwt');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const bobId = Number(db.run('INSERT INTO users (guid, username, password_hash, first_name, last_name, email, active) VALUES (?,?,?,?,?,?,1)',
  newGuid(), 'bob', hashPassword('bobpassword'), 'Bob', 'Builder', 'bob@x.com').lastInsertRowid);
const staffId = Number(db.run("INSERT INTO groups (name) VALUES ('staff')").lastInsertRowid);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?,?)', staffId, bobId);

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// Cookie-keeping client that never follows redirects, so tests can read Location.
function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body, form, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    const r = await fetch(path.startsWith('http') ? path : base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text, location: r.headers.get('location'), headers: r.headers };
  };
  call.login = async (username, password) => {
    const csrf = (await call('/api/session')).json.csrf;
    const r = await call('/api/login', { method: 'POST', body: { username, password }, headers: { 'x-csrf-token': csrf } });
    assert.equal(r.status, 200);
    return (await call('/api/session')).json.csrf; // the session is regenerated on login
  };
  return call;
}

async function adminClient() {
  const api = client();
  const csrf = await api.login('admin', 'adminpass123');
  const withCsrf = (path, opts = {}) => api(path, { ...opts, headers: { ...(opts.headers || {}), 'x-csrf-token': csrf } });
  return withCsrf;
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
const basic = (id, secret) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` });

async function createOidc(admin, over = {}) {
  const r = await admin('/api/admin/apps', { method: 'POST', body: {
    protocol: 'oidc', name: 'Wiki', redirect_uris: ['https://wiki.test/cb'], confidential: true, grant_types: ['authorization_code', 'refresh_token'],
    scopes: ['openid', 'profile', 'email', 'groups', 'offline_access'], maps: [{ idp_attribute: 'department', claim_name: 'dept' }], ...over } });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

test('admin API validates, creates and hides the secret after creation', async () => {
  const admin = await adminClient();
  const bad = await admin('/api/admin/apps', { method: 'POST', body: { protocol: 'oidc', name: '', redirect_uris: ['javascript:alert(1)'], grant_types: ['implicit'] } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.length >= 3);

  const made = await createOidc(admin);
  assert.ok(made.secret && made.app.client_id.startsWith('oidc-'));
  assert.equal(made.app.client_secret_hash, undefined);
  const again = await admin(`/api/admin/apps/${made.app.id}`);
  assert.equal(again.json.secret, undefined);
  assert.equal(again.json.app.confidential, true);

  const rotated = await admin(`/api/admin/apps/${made.app.id}/rotate-secret`, { method: 'POST' });
  assert.ok(rotated.json.secret && rotated.json.secret !== made.secret);

  const list = await admin('/api/admin/apps');
  assert.ok(list.json.some((a) => a.id === made.app.id && a.protocol === 'oidc'));
  assert.equal((await admin(`/api/admin/apps/${made.app.id}`, { method: 'DELETE' })).status, 204);
});

test('public clients cannot use client credentials and always get PKCE', async () => {
  const admin = await adminClient();
  const r = await admin('/api/admin/apps', { method: 'POST', body: { protocol: 'oauth2', name: 'M2M', redirect_uris: ['https://m/cb'], confidential: false, grant_types: ['client_credentials'] } });
  assert.equal(r.status, 400);
  const ok = await admin('/api/admin/apps', { method: 'POST', body: { protocol: 'oidc', name: 'SPA', redirect_uris: ['https://spa.test/cb'], confidential: false, require_pkce: false, grant_types: ['authorization_code'] } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.secret, undefined);
  assert.equal(ok.json.app.require_pkce, 1);
});

test('OIDC authorization code flow with PKCE, ID token, userinfo and refresh', async () => {
  const admin = await adminClient();
  db.run("UPDATE users SET department = 'Eng' WHERE id = ?", bobId);
  const { app, secret } = await createOidc(admin);
  const disc = (await client()('/oidc/.well-known/openid-configuration')).json;
  assert.equal(disc.issuer, 'http://localhost:0/oidc');
  assert.ok((await client()('/oidc/jwks')).json.keys[0].kid);

  const user = client();
  const { verifier, challenge } = pkce();
  const authUrl = `/oidc/authorize?${new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: 'https://wiki.test/cb',
    scope: 'openid profile email groups offline_access', state: 's1', nonce: 'n1', code_challenge: challenge, code_challenge_method: 'S256' })}`;

  // Not signed in: sent to the sign-in page, which returns here afterwards.
  const first = await user(authUrl);
  assert.equal(first.status, 302);
  assert.match(first.location, /^\/login\?next=%2Foidc%2Fauthorize%3F/);

  await user.login('bob', 'bobpassword');
  const granted = await user(authUrl);
  assert.equal(granted.status, 302);
  const cb = new URL(granted.location);
  assert.equal(cb.origin + cb.pathname, 'https://wiki.test/cb');
  assert.equal(cb.searchParams.get('state'), 's1');
  const code = cb.searchParams.get('code');

  // Wrong verifier burns the code; a fresh one is needed for the real exchange.
  const wrong = await client()('/oidc/token', { method: 'POST', headers: basic(app.client_id, secret), form: { grant_type: 'authorization_code', code, redirect_uri: 'https://wiki.test/cb', code_verifier: pkce().verifier } });
  assert.equal(wrong.json.error, 'invalid_grant');
  const code2 = new URL((await user(authUrl)).location).searchParams.get('code');

  const noAuth = await client()('/oidc/token', { method: 'POST', form: { grant_type: 'authorization_code', code: code2, redirect_uri: 'https://wiki.test/cb', code_verifier: verifier } });
  assert.equal(noAuth.status, 401);

  const tok = await client()('/oidc/token', { method: 'POST', headers: basic(app.client_id, secret), form: { grant_type: 'authorization_code', code: code2, redirect_uri: 'https://wiki.test/cb', code_verifier: verifier } });
  assert.equal(tok.status, 200, tok.text);
  assert.equal(tok.json.token_type, 'Bearer');
  const id = jwt.verify(tok.json.id_token);
  assert.ok(id, 'id_token is signed by our key');
  assert.equal(id.aud, app.client_id);
  assert.equal(id.nonce, 'n1');
  assert.equal(id.email, 'bob@x.com');
  assert.deepEqual(id.groups, ['staff']);
  assert.equal(id.dept, 'Eng');
  assert.equal(id.at_hash, crypto.createHash('sha256').update(tok.json.access_token).digest().subarray(0, 16).toString('base64url'));

  // Replaying the code fails.
  const replay = await client()('/oidc/token', { method: 'POST', headers: basic(app.client_id, secret), form: { grant_type: 'authorization_code', code: code2, redirect_uri: 'https://wiki.test/cb', code_verifier: verifier } });
  assert.equal(replay.json.error, 'invalid_grant');

  const info = await client()('/oidc/userinfo', { headers: { authorization: `Bearer ${tok.json.access_token}` } });
  assert.equal(info.json.sub, id.sub);
  assert.equal(info.json.preferred_username, 'bob');
  assert.equal((await client()('/oidc/userinfo', { headers: { authorization: 'Bearer nope' } })).status, 401);

  const intro = await client()('/oidc/introspect', { method: 'POST', headers: basic(app.client_id, secret), form: { token: tok.json.access_token } });
  assert.equal(intro.json.active, true);

  const ref = await client()('/oidc/token', { method: 'POST', headers: basic(app.client_id, secret), form: { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token } });
  assert.equal(ref.status, 200, ref.text);
  assert.notEqual(ref.json.refresh_token, tok.json.refresh_token);
  const spent = await client()('/oidc/token', { method: 'POST', headers: basic(app.client_id, secret), form: { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token } });
  assert.equal(spent.json.error, 'invalid_grant');

  await client()('/oidc/revoke', { method: 'POST', headers: basic(app.client_id, secret), form: { token: ref.json.access_token } });
  assert.equal((await client()('/oidc/userinfo', { headers: { authorization: `Bearer ${ref.json.access_token}` } })).status, 401);
});

test('authorize refuses unregistered redirects, missing PKCE, and honours prompt=none and group access', async () => {
  const admin = await adminClient();
  const { app } = await createOidc(admin, { require_pkce: true });
  const user = client();
  const q = (extra) => `/oidc/authorize?${new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: 'https://wiki.test/cb', scope: 'openid', ...extra })}`;

  const evil = await user(q({ redirect_uri: 'https://evil.test/cb' }));
  assert.equal(evil.status, 400);
  assert.equal(evil.location, null);

  const nopkce = await user(q({}));
  assert.equal(new URL(nopkce.location).searchParams.get('error'), 'invalid_request');

  const { challenge } = pkce();
  const pk = { code_challenge: challenge, code_challenge_method: 'S256' };
  const none = await user(q({ ...pk, prompt: 'none' }));
  assert.equal(new URL(none.location).searchParams.get('error'), 'login_required');

  await user.login('bob', 'bobpassword');
  const badScope = await user(q({ ...pk, scope: 'openid admin' }));
  assert.equal(new URL(badScope.location).searchParams.get('error'), 'invalid_scope');

  // Restrict the app to a group Bob is not in.
  const other = Number(db.run("INSERT INTO groups (name) VALUES ('other')").lastInsertRowid);
  const a = await admin(`/api/admin/apps/${app.id}`);
  await admin(`/api/admin/apps/${app.id}`, { method: 'PUT', body: { ...a.json.app, access_mode: 'groups', access_groups: [other] } });
  const denied = await user(q(pk));
  assert.equal(new URL(denied.location).searchParams.get('error'), 'access_denied');
  const relogin = await user(q({ ...pk, prompt: 'login' }));
  assert.ok(relogin.location.startsWith('/login?next='));
  assert.ok(!decodeURIComponent(relogin.location).includes('prompt=login'));
});

test('OAuth 2.0 client credentials and RP-initiated logout', async () => {
  const admin = await adminClient();
  const made = await admin('/api/admin/apps', { method: 'POST', body: { protocol: 'oauth2', name: 'Svc', redirect_uris: ['https://svc.test/cb'],
    confidential: true, grant_types: ['client_credentials'], scopes: ['read', 'write'] } });
  assert.equal(made.status, 201, made.text);
  const { app, secret } = made.json;
  const tok = await client()('/oauth2/token', { method: 'POST', headers: basic(app.client_id, secret), form: { grant_type: 'client_credentials', scope: 'read' } });
  assert.equal(tok.status, 200, tok.text);
  assert.equal(tok.json.scope, 'read');
  assert.equal(tok.json.id_token, undefined);
  assert.equal(tok.json.refresh_token, undefined);
  const over = await client()('/oauth2/token', { method: 'POST', headers: basic(app.client_id, secret), form: { grant_type: 'client_credentials', scope: 'admin' } });
  assert.equal(over.json.error, 'invalid_scope');
  assert.equal((await client()('/oauth2/token', { method: 'POST', headers: basic(app.client_id, 'wrong'), form: { grant_type: 'client_credentials' } })).status, 401);
  // An OAuth2 client is not reachable through the OIDC endpoints.
  assert.equal((await client()('/oidc/token', { method: 'POST', headers: basic(app.client_id, secret), form: { grant_type: 'client_credentials' } })).status, 401);
  assert.equal((await client()('/oauth2/.well-known/oauth-authorization-server')).json.token_endpoint.endsWith('/oauth2/token'), true);

  const oidc = await createOidc(admin, { post_logout_uris: ['https://wiki.test/bye'] });
  const user = client();
  await user.login('bob', 'bobpassword');
  const out = await user(`/oidc/logout?${new URLSearchParams({ client_id: oidc.app.client_id, post_logout_redirect_uri: 'https://wiki.test/bye', state: 'x' })}`);
  assert.equal(out.status, 302);
  assert.equal(out.location, 'https://wiki.test/bye?state=x');
  const bogus = await client()(`/oidc/logout?${new URLSearchParams({ client_id: oidc.app.client_id, post_logout_redirect_uri: 'https://evil.test/' })}`);
  assert.equal(bogus.status, 200);
});

test('CAS: ticket issue, validation (1.0, 2.0, 3.0), single use, service binding and logout', async () => {
  const admin = await adminClient();
  const made = await admin('/api/admin/apps', { method: 'POST', body: { protocol: 'cas', name: 'Legacy', redirect_uris: ['https://legacy.test/app/*', 'https://exact.test/cas'],
    maps: [{ idp_attribute: 'email', claim_name: 'mail' }, { idp_attribute: 'groups', claim_name: 'memberOf' }] } });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.secret, undefined);

  const user = client();
  const service = 'https://legacy.test/app/home';
  const first = await user(`/cas/login?service=${encodeURIComponent(service)}`);
  assert.match(first.location, /^\/login\?next=%2Fcas%2Flogin/);
  assert.equal((await user(`/cas/login?service=${encodeURIComponent('https://other.test/x')}`)).status, 403);
  const gateway = await user(`/cas/login?gateway=true&service=${encodeURIComponent(service)}`);
  assert.equal(gateway.location, service);

  await user.login('bob', 'bobpassword');
  const ticketOf = async (svc = service) => new URL((await user(`/cas/login?service=${encodeURIComponent(svc)}`)).location).searchParams.get('ticket');

  const t3 = await ticketOf();
  assert.match(t3, /^ST-/);
  const wrongSvc = await client()(`/cas/p3/serviceValidate?service=${encodeURIComponent('https://legacy.test/app/other')}&ticket=${t3}`);
  assert.match(wrongSvc.text, /INVALID_SERVICE/);
  // That attempt spent the ticket.
  assert.match((await client()(`/cas/p3/serviceValidate?service=${encodeURIComponent(service)}&ticket=${t3}`)).text, /INVALID_TICKET/);

  const t3b = await ticketOf();
  const ok = await client()(`/cas/p3/serviceValidate?service=${encodeURIComponent(service)}&ticket=${t3b}`);
  assert.match(ok.text, /<cas:user>bob<\/cas:user>/);
  assert.match(ok.text, /<cas:mail>bob@x\.com<\/cas:mail>/);
  assert.match(ok.text, /<cas:memberOf>staff<\/cas:memberOf>/);

  const t2 = await ticketOf();
  const v2 = await client()(`/cas/serviceValidate?service=${encodeURIComponent(service)}&ticket=${t2}`);
  assert.match(v2.text, /<cas:user>bob<\/cas:user>/);
  assert.ok(!v2.text.includes('<cas:attributes>'));

  const t1 = await ticketOf();
  assert.equal((await client()(`/cas/validate?service=${encodeURIComponent(service)}&ticket=${t1}`)).text, 'yes\nbob\n');
  assert.equal((await client()(`/cas/validate?service=${encodeURIComponent(service)}&ticket=ST-bogus`)).text, 'no\n\n');

  const out = await user(`/cas/logout?service=${encodeURIComponent(service)}`);
  assert.equal(out.location, service);
  assert.ok((await user(`/cas/login?service=${encodeURIComponent(service)}`)).location.startsWith('/login'));
});

test('applications need the service-provider permission', async () => {
  const api = client();
  await api.login('bob', 'bobpassword');
  assert.equal((await api('/api/admin/apps')).status, 403);
});

test('a new application\'s client ID and endpoints are known before it is saved, and the saved application uses that ID', async () => {
  const c = await adminClient();
  const blank = (await c('/api/admin/apps/blank?protocol=oidc')).json;
  assert.match(blank.client_id, /^oidc-[A-Za-z0-9_-]{16}$/);
  assert.match(blank.urls.discovery, /\/oidc\/\.well-known\/openid-configuration$/);
  assert.ok((await c('/api/admin/apps/blank?protocol=cas')).json.urls.login.endsWith('/cas/login'));
  assert.equal((await c('/api/admin/apps/blank?protocol=cas')).json.client_id, undefined);
  const body = { protocol: 'oidc', name: 'Reserved', client_id: blank.client_id, confidential: true, redirect_uris: ['https://rp.example.net/cb'], grant_types: ['authorization_code'], scopes: ['openid'] };
  const made = await c('/api/admin/apps', { method: 'POST', body });
  assert.equal(made.status, 201);
  assert.equal(made.json.app.client_id, blank.client_id);
  assert.equal((await c('/api/admin/apps', { method: 'POST', body: { ...body, name: 'Again' } })).status, 400);
  assert.equal((await c('/api/admin/apps', { method: 'POST', body: { ...body, name: 'Odd', client_id: 'oidc-short' } })).status, 400);
});
