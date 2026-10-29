process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const factorSettings = require('../src/factors/settings');
const totp = require('../src/totp');
const apps = require('../src/apps');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// A browser: one cookie jar, so the device cookie set at the password step comes back on later sign-ins.
async function browser() {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers: extra = {} } = {}) => {
    const headers = { cookie, ...extra };
    if (method !== 'GET') { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()).csrf; }
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    // Cookies merge by name, as in a browser: a response that sets only the session cookie keeps the device cookie.
    const jar = new Map(cookie.split('; ').filter(Boolean).map((c) => c.split('=')));
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a redirect has no JSON body */ }
    return { status: r.status, json, location: r.headers.get('location') };
  };
  await call('/api/session');
  return call;
}

const mkUser = (name, { totp = null } = {}) => {
  const id = Number(db.run('INSERT INTO users (guid, username, password_hash, email, totp_secret, totp_enabled) VALUES (?,?,?,?,?,?)',
    newGuid(), name, hashPassword(`${name}-password`), `${name}@x.net`, totp || '', totp ? 1 : 0).lastInsertRowid);
  return id;
};
const signedIn = async (call) => (await call('/api/session')).json.me;
const passwordStep = (call, username) => call('/api/login', { method: 'POST', body: { username, password: `${username}-password` } });
const enterCode = (call, secret) => {
  db.run('UPDATE users SET totp_last_step = 0 WHERE totp_secret = ?', secret);
  return call('/api/login/mfa', { method: 'POST', body: { code: totp.codeForStep(secret, totp.currentStep()) } });
};

// A group whose members must use a second factor and remember it for `hours` (null = the rule is not set).
let groupSeq = 0;
function rememberPolicy(hours, extra = {}) {
  const g = Number(db.run('INSERT INTO groups (name) VALUES (?)', `Remembers ${++groupSeq}`).lastInsertRowid);
  const pid = Number(db.run('INSERT INTO policies (name, require_mfa, remember_mfa_hours, allowed_factors) VALUES (?,?,?,?)',
    `Remember ${groupSeq}`, 1, hours, extra.allowed || '').lastInsertRowid);
  db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', pid, g);
  return g;
}
const join = (g, id) => db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', g, id);

test.before(() => {
  factorSettings.save({ ...factorSettings.get(), webauthn: { enabled: true, userVerification: 'preferred' } });
});

test('a second factor is remembered for the policy period, then asked for again', async () => {
  const g = rememberPolicy(12);
  const id = mkUser('rita', { totp: totp.generateSecret() });
  join(g, id);
  const secret = db.get('SELECT totp_secret FROM users WHERE id = ?', id).totp_secret;
  const call = await browser();

  assert.equal((await passwordStep(call, 'rita')).json.mfa, 'totp');
  assert.equal((await enterCode(call, secret)).status, 200);
  assert.ok((await signedIn(call)).username === 'rita');

  // Same browser, next sign-in: no second factor.
  const again = (await passwordStep(call, 'rita')).json;
  assert.equal(again.mfa, null);
  assert.equal(again.remembered, true);
  assert.equal((await signedIn(call)).username, 'rita');

  // The period runs from when the factor was completed, so an old completion no longer counts.
  db.run('UPDATE mfa_remembered SET completed_at = ? WHERE user_id = ?', Date.now() - 13 * 3600 * 1000, id);
  assert.equal((await passwordStep(call, 'rita')).json.mfa, 'totp');
});

test('a person can ask to be asked for the second factor again at the next sign-in', async () => {
  const g = rememberPolicy(12);
  const id = mkUser('ross', { totp: totp.generateSecret() });
  join(g, id);
  const secret = db.get('SELECT totp_secret FROM users WHERE id = ?', id).totp_secret;
  const call = await browser();
  await passwordStep(call, 'ross');
  await enterCode(call, secret);
  assert.equal((await passwordStep(call, 'ross')).json.mfa, null);

  const cleared = await call('/api/account/mfa/forget', { method: 'POST', body: {} });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.browsers, 1);
  assert.equal((await passwordStep(call, 'ross')).json.mfa, 'totp');
});

test('no remember period, or a period of zero, means the factor is asked for every time', async () => {
  const none = rememberPolicy(null);
  const zero = rememberPolicy(0);
  const a = mkUser('nora', { totp: totp.generateSecret() });
  const b = mkUser('omar', { totp: totp.generateSecret() });
  join(none, a); join(zero, b);
  for (const [name, uid] of [['nora', a], ['omar', b]]) {
    const secret = db.get('SELECT totp_secret FROM users WHERE id = ?', uid).totp_secret;
    const call = await browser();
    await passwordStep(call, name);
    await enterCode(call, secret);
    assert.equal((await passwordStep(call, name)).json.mfa, 'totp', name);
  }
});

test('the strictest remember period among several policies applies', async () => {
  const id = mkUser('pia', { totp: totp.generateSecret() });
  join(rememberPolicy(24), id);
  join(rememberPolicy(2), id);
  const policies = require('../src/policies');
  assert.equal(policies.effectivePolicy(id).rememberMfaHours, 2);
});

/* ------------------------------ application policies ----------------------------- */

const APP_CB = 'https://portal.example.net/cb';
function oidcApp(name) {
  const { id } = apps.createApp({ name, description: '', protocol: 'oidc', access_mode: 'all', access_groups: [], maps: [], redirect_uris: [APP_CB], post_logout_uris: [], confidential: false, require_pkce: 1, grant_types: ['authorization_code'], scopes: ['openid'], subject_source: 'guid', access_token_ttl: 3600 });
  return db.get('SELECT client_id FROM apps WHERE id = ?', id).client_id === undefined ? null : id;
}
function appPolicy(name, appId, { allowed = '', phishing = 0, mfa = 0 } = {}) {
  const p = Number(db.run('INSERT INTO app_policies (name, require_mfa, require_phishing_resistant, allowed_factors) VALUES (?,?,?,?)', name, mfa, phishing, allowed).lastInsertRowid);
  db.run('INSERT INTO app_policy_apps (policy_id, app_id) VALUES (?, ?)', p, appId);
  return p;
}
const authorizeUrl = (clientId) => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return `/oidc/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: APP_CB, response_type: 'code', scope: 'openid', state: 'abc', nonce: 'n', code_challenge: challenge, code_challenge_method: 'S256' })}`;
};
const clientIdOf = (appId) => db.get('SELECT client_id FROM apps WHERE id = ?', appId).client_id;

test('an application that needs a factor the person used is given a sign-in', async () => {
  const appId = oidcApp('Payroll');
  const secret = totp.generateSecret();
  mkUser('uma', { totp: secret });
  appPolicy('Payroll: authenticator app', appId, { allowed: 'totp' });
  const call = await browser();
  await passwordStep(call, 'uma');
  await enterCode(call, secret);
  const r = await call(authorizeUrl(clientIdOf(appId)));
  assert.ok(r.location && r.location.startsWith(APP_CB) && /code=/.test(r.location), r.location);
});

test('an application that needs a factor the person does not have is refused', async () => {
  const appId = oidcApp('Vault');
  const secret = totp.generateSecret();
  mkUser('vic', { totp: secret });
  appPolicy('Vault: phishing-resistant', appId, { phishing: 1 });
  const call = await browser();
  await passwordStep(call, 'vic');
  await enterCode(call, secret);
  const r = await call(authorizeUrl(clientIdOf(appId)));
  assert.ok(r.location && r.location.startsWith(APP_CB) && /error=access_denied/.test(r.location), r.location);
});

test('a sign-in that does not meet an application policy steps up to a factor that does', async () => {
  const appId = oidcApp('Ledger');
  const secret = totp.generateSecret();
  const id = mkUser('wes', { totp: secret });
  db.run("INSERT INTO user_factors (user_id, type, label, credential_id, credential, verified) VALUES (?, 'webauthn', 'Key', 'cid', '{}', 1)", id);
  appPolicy('Ledger: security key', appId, { allowed: 'webauthn' });
  const call = await browser();
  await passwordStep(call, 'wes');
  await enterCode(call, secret);
  const r = await call(authorizeUrl(clientIdOf(appId)));
  assert.equal(r.status, 302);
  assert.equal(r.location, '/login/mfa');
  const pending = (await call('/api/login/mfa')).json;
  assert.deepEqual(pending.factors.map((f) => f.type), ['webauthn']);
});

test('applications with no policy are unaffected, and the policy is stored with its applications', async () => {
  const appId = oidcApp('Open');
  const secret = totp.generateSecret();
  mkUser('xena', { totp: secret });
  const call = await browser();
  await passwordStep(call, 'xena');
  await enterCode(call, secret);
  const r = await call(authorizeUrl(clientIdOf(appId)));
  assert.ok(/code=/.test(r.location), r.location);

  const admin = await browser();
  const login = await admin('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  assert.ok(login.json, 'admin signs in');
  const made = await admin('/api/admin/app-policies', { method: 'POST', body: { name: 'Ledger rules', require_mfa: true, apps: [appId], allowed_factors: ['totp'] } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.deepEqual(made.json.apps, [appId]);
  assert.deepEqual(made.json.allowed_factors, ['totp']);
  const none = await admin('/api/admin/app-policies', { method: 'POST', body: { name: 'Nothing', require_mfa: true, apps: [] } });
  assert.equal(none.status, 400);
});
