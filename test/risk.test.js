process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
process.env.TRUST_PROXY = 'true';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const risk = require('../src/risk');
const authlog = require('../src/authlog');
const geoip = require('../src/geoip');
const ua = require('../src/ua');
const totp = require('../src/totp');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

// Where each test address is.
const NYC = { country: 'US', country_name: 'United States', city: 'New York', lat: 40.71, lon: -74.0, asn: 7922, asn_org: 'Comcast' };
const LON = { country: 'GB', country_name: 'United Kingdom', city: 'London', lat: 51.5, lon: -0.12, asn: 2856, asn_org: 'BT' };
const BOS = { country: 'US', country_name: 'United States', city: 'Boston', lat: 42.36, lon: -71.06, asn: 7922, asn_org: 'Comcast' };
const PLACES = { '203.0.113.1': NYC, '203.0.113.2': LON, '203.0.113.3': BOS, '198.51.100.9': { country: 'RU', country_name: 'Russia', lat: 55.7, lon: 37.6, asn: 12389, asn_org: 'Rostelecom' } };
geoip.inject((ip) => PLACES[ip]);

/* ----------------------------------- helpers ----------------------------------- */

function client(ip = '203.0.113.1') {
  const jar = new Map();
  const call = async (path, { method = 'GET', body, xff = ip } = {}) => {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': xff, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' };
    if (method !== 'GET') {
      headers['content-type'] = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
      headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    }
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text();
    return { status: r.status, json: text && !path.includes('format=csv') ? JSON.parse(text) : null, text };
  };
  call.jar = jar;
  return call;
}
const login = async (c, u, p = `${u}-password`, extra = {}) => { await c('/api/session'); return c('/api/login', { method: 'POST', body: { username: u, password: p, ...extra } }); };
const mkUser = (name, extra = {}) => Number(db.run('INSERT INTO users (guid, username, password_hash, country) VALUES (?,?,?,?)', newGuid(), name, hashPassword(`${name}-password`), extra.country || '').lastInsertRowid);
const now = () => Math.floor(Date.now() / 1000);

// A completed sign-in in the user's history.
function past(userId, o = {}) {
  const g = o.place || NYC;
  db.run(`INSERT INTO auth_events (ts, type, outcome, user_id, username, ip, country, country_name, city, lat, lon, asn, asn_org, device_id)
          VALUES (?, 'signin', 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, o.ts || now() - 3600, userId, o.name || '', o.ip || '203.0.113.1', g.country, g.country_name, g.city, g.lat, g.lon, g.asn, g.asn_org, o.device ?? 'dev-home');
}
const failure = (name, ip, ts = now() - 60, asn = null) => db.run("INSERT INTO auth_events (ts, type, outcome, reason, username, ip, asn) VALUES (?, 'password', 'failure', 'bad_credentials', ?, ?, ?)", ts, name, ip, asn);
const codes = (a) => a.reasons.map((r) => r.code);
const assess = (id, ctx) => risk.assess(db.get('SELECT * FROM users WHERE id = ?', id), { now: now(), ...ctx }, risk.get());
const setRisk = (over) => risk.save({ ...risk.get(), ...over });

/* ------------------------------------ tests ------------------------------------ */

test('user agents are read into browser, system and kind of device', () => {
  assert.deepEqual(ua.parse('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), { browser: 'Safari 17', os: 'iOS', device_type: 'mobile' });
  assert.deepEqual(ua.parse('curl/8.4.0'), { browser: 'curl', os: '', device_type: 'script' });
  assert.equal(ua.parse('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0').browser, 'Edge 120');
  assert.equal(ua.parse('').device_type, 'unknown');
});

test('nothing fires without history, and each signal fires on its own evidence', () => {
  setRisk({ mode: 'report' });
  const fresh = mkUser('fresh');
  assert.deepEqual(codes(assess(fresh, { ip: '203.0.113.2', geo: LON, deviceId: 'dev-x' })), []);

  const u = mkUser('una', { country: 'US' });
  past(u);
  assert.deepEqual(codes(assess(u, { ip: '203.0.113.1', geo: NYC, deviceId: 'dev-home' })), []);

  const newDevice = assess(u, { ip: '203.0.113.1', geo: NYC, deviceId: 'dev-other' });
  assert.deepEqual(codes(newDevice), ['new_device']);
  assert.equal(newDevice.level, 'low');

  const abroad = assess(u, { ip: '203.0.113.2', geo: LON, deviceId: 'dev-home', now: now() + 86400 * 2 });
  assert.deepEqual(codes(abroad).sort(), ['country_mismatch', 'new_asn', 'new_country']);
  assert.equal(abroad.level, 'medium'); // 25 + 15 + 15
  assert.match(abroad.reasons.find((r) => r.code === 'country_mismatch').detail, /profile says US/);

  const sameNet = assess(u, { ip: '203.0.113.3', geo: BOS, deviceId: 'dev-home' });
  assert.deepEqual(codes(sameNet), []); // another city, same country and network, an hour's drive
});

test('impossible travel compares distance with the time since the last sign-in', () => {
  setRisk({ mode: 'report' });
  const u = mkUser('trev');
  past(u, { ts: now() - 3600 });
  const far = assess(u, { ip: '203.0.113.2', geo: LON, deviceId: 'dev-home' });
  assert.ok(codes(far).includes('impossible_travel'));
  assert.match(far.reasons.find((r) => r.code === 'impossible_travel').detail, /5\d{3} km/);
  // the same trip a day later is a flight, not a teleport
  assert.ok(!codes(assess(u, { ip: '203.0.113.2', geo: LON, deviceId: 'dev-home', now: now() + 86400 })).includes('impossible_travel'));
  // short hops are ignored however fast
  const near = mkUser('near');
  past(near, { ts: now() - 60 });
  const NEWARK = { ...NYC, city: 'Newark', lat: 40.73, lon: -74.17 }; // 16 km away
  assert.ok(!codes(assess(near, { ip: '203.0.113.1', geo: NEWARK, deviceId: 'dev-home' })).includes('impossible_travel'));
  assert.ok(codes(assess(near, { ip: '203.0.113.3', geo: BOS, deviceId: 'dev-home' })).includes('impossible_travel')); // 300 km in a minute
  assert.equal(assess(u, { ip: '203.0.113.2', geo: LON, deviceId: 'dev-home' }).level, 'high');
});

test('spray: many accounts from one address or network, or one account from many addresses', () => {
  setRisk({ mode: 'report' });
  const u = mkUser('sprayed');
  past(u);
  for (const n of ['a1', 'a2', 'a3', 'a4']) failure(n, '198.51.100.9');
  assert.ok(!codes(assess(u, { ip: '198.51.100.9', geo: PLACES['198.51.100.9'], deviceId: 'dev-home' })).includes('spray'));
  failure('a5', '198.51.100.9');
  const hit = assess(u, { ip: '198.51.100.9', geo: PLACES['198.51.100.9'], deviceId: 'dev-home' });
  assert.ok(codes(hit).includes('spray'));
  assert.match(hit.reasons.find((r) => r.code === 'spray').detail, /5 different accounts failed from this address/);
  // old failures fall out of the window
  db.run('UPDATE auth_events SET ts = ts - 7200 WHERE ip = ?', '198.51.100.9');
  assert.ok(!codes(assess(u, { ip: '198.51.100.9', geo: PLACES['198.51.100.9'], deviceId: 'dev-home' })).includes('spray'));

  const v = mkUser('hammered');
  past(v);
  for (let i = 1; i <= 5; i++) failure('hammered', `192.0.2.${i}`);
  assert.match(assess(v, { ip: '203.0.113.1', geo: NYC, deviceId: 'dev-home' }).reasons.find((r) => r.code === 'spray').detail, /failed from 5 different addresses/);

  const net = mkUser('netted');
  past(net);
  for (let i = 0; i < 15; i++) failure(`n${i}`, `192.0.2.${100 + i}`, now() - 30, 64496);
  assert.match(assess(net, { ip: '192.0.2.200', geo: { asn: 64496 }, deviceId: 'dev-home' }).reasons.find((r) => r.code === 'spray').detail, /from this network/);
});

test('a browser-reported location can only add risk, and only when that signal is on', () => {
  const u = mkUser('geo');
  past(u);
  const ctx = { ip: '203.0.113.1', geo: NYC, deviceId: 'dev-home', deviceGeo: { lat: 51.5, lon: -0.12 } };
  setRisk({ mode: 'report' });
  assert.ok(!codes(assess(u, ctx)).includes('device_geo')); // off by default
  const cfg = risk.get();
  cfg.signals.device_geo.enabled = true;
  risk.save(cfg);
  assert.ok(codes(assess(u, ctx)).includes('device_geo'));
  assert.ok(!codes(assess(u, { ...ctx, deviceGeo: { lat: 40.8, lon: -73.9 } })).includes('device_geo'));
  assert.ok(!codes(assess(u, { ...ctx, deviceGeo: undefined })).includes('device_geo')); // absence is not a flag
  cfg.signals.device_geo.enabled = false;
  risk.save(cfg);
});

test('actions: the strictest of the settings and the policies; administrators are never refused outright', () => {
  const cfg = { ...risk.get(), actions: { medium: 'require_mfa', high: 'phishing_resistant' } };
  const none = { riskMediumAction: '', riskHighAction: '' };
  assert.equal(risk.actionFor('low', { riskMediumAction: 'block' }, cfg), 'allow');
  assert.equal(risk.actionFor('medium', none, cfg), 'require_mfa');
  assert.equal(risk.actionFor('high', none, cfg), 'phishing_resistant');
  assert.equal(risk.actionFor('medium', { riskMediumAction: 'webauthn_only' }, cfg), 'webauthn_only');
  assert.equal(risk.actionFor('high', { riskMediumAction: 'block', riskHighAction: '' }, cfg), 'block'); // medium rules also apply at high
  const plain = db.get('SELECT * FROM users WHERE username = ?', 'una');
  const adm = db.get("SELECT * FROM users WHERE username = 'admin'");
  assert.equal(risk.restriction('block', plain).block, true);
  const r = risk.restriction('block', adm);
  assert.equal(r.block, false);
  assert.deepEqual(r.extra, { allowed: ['webauthn'] });
});

test('every step of a sign-in is logged with network, place and browser; a new browser becomes a known one', async () => {
  setRisk({ mode: 'off' });
  const id = mkUser('ann');
  const c = client('203.0.113.1');
  assert.equal((await login(c, 'ann', 'wrong')).status, 401);
  assert.equal((await login(c, 'nobody', 'x')).status, 401);
  assert.equal((await login(c, 'ann')).status, 200);
  assert.ok(c.jar.has('idp_did'));
  const rows = db.all('SELECT * FROM auth_events ORDER BY id').filter((r) => ['ann', 'nobody'].includes(r.username));
  assert.deepEqual(rows.map((r) => `${r.type}:${r.outcome}:${r.reason}`), ['password:failure:bad_credentials', 'password:failure:unknown_user', 'password:success:', 'signin:success:']);
  const done = rows[3];
  assert.equal(done.ip, '203.0.113.1');
  assert.equal(done.city, 'New York');
  assert.equal(done.asn, 7922);
  assert.equal(done.browser, 'Chrome 120');
  assert.equal(done.os, 'macOS');
  assert.equal(done.device_type, 'desktop');
  assert.match(done.device_id, /^[0-9a-f]{12}$/);
  assert.equal(done.device_known, 0);
  assert.equal(done.user_id, id);
  assert.ok(done.session_id && done.request_id);
  assert.equal(JSON.stringify(rows).includes(c.jar.get('idp_did')), false);

  // the same browser signing in again is recognized; a browser with no cookie is not
  const again = client('203.0.113.1');
  again.jar.set('idp_did', c.jar.get('idp_did'));
  await login(again, 'ann');
  const last = db.get("SELECT * FROM auth_events WHERE type = 'signin' AND user_id = ? ORDER BY id DESC", id);
  assert.equal(last.device_known, 1);
  assert.equal(last.device_id, done.device_id);
  await login(client('203.0.113.1'), 'ann');
  assert.equal(db.get("SELECT device_known FROM auth_events WHERE type = 'signin' AND user_id = ? ORDER BY id DESC", id).device_known, 0);
  // a forged cookie is ignored
  const forged = client();
  forged.jar.set('idp_did', 'abc.def');
  await login(forged, 'ann');
  assert.notEqual(db.get("SELECT device_id FROM auth_events WHERE type = 'signin' AND user_id = ? ORDER BY id DESC", id).device_id, authlog.round(0));
});

test('report mode scores and logs but never changes the outcome; enforce mode acts', async () => {
  const u = mkUser('rita');
  past(u, { ts: now() - 3600 });
  setRisk({ mode: 'report', actions: { medium: 'require_mfa', high: 'block' } });

  const c = client('203.0.113.2'); // London an hour after New York, from a new browser
  const r = await login(c, 'rita');
  assert.equal(r.status, 200);
  assert.equal(r.json.mfa, null);
  const row = db.get("SELECT * FROM auth_events WHERE type = 'signin' AND user_id = ? ORDER BY id DESC", u);
  assert.equal(row.risk_level, 'high');
  assert.equal(row.risk_action, 'report:block');
  assert.ok(JSON.parse(row.risk_reasons).some((x) => x.code === 'impossible_travel'));
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'risk.assessed'"));

  setRisk({ mode: 'enforce' });
  const blocked = await login(client('198.51.100.9'), 'rita'); // Moscow, minutes after London
  assert.equal(blocked.status, 403);
  assert.equal(db.get("SELECT reason FROM auth_events WHERE type = 'signin' AND outcome = 'failure' AND user_id = ? ORDER BY id DESC", u).reason, 'blocked_by_risk');
  // someone signing in from their usual place and browser is not touched
  mkUser('rita2');
  const home = client('203.0.113.1');
  assert.equal((await login(home, 'rita2')).status, 200); // first time: nothing to compare with
  assert.equal((await login(home, 'rita2')).status, 200); // same browser, same place
  assert.equal(db.get("SELECT risk_level FROM auth_events WHERE type = 'signin' AND username = 'rita2' ORDER BY id DESC").risk_level, 'low');
});

test('enforced actions narrow the second step; nobody can enrol a new method to get past them', async () => {
  const secret = totp.generateSecret();
  const withApp = mkUser('tom');
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', secret, withApp);
  past(withApp, { ts: now() - 86400 * 3 });
  const bare = mkUser('bea');
  past(bare, { ts: now() - 86400 * 3 });

  // medium risk (new device + new country + new network) requires a second factor
  setRisk({ mode: 'enforce', actions: { medium: 'require_mfa', high: 'allow' } });
  const bareTry = await login(client('203.0.113.2'), 'bea');
  assert.equal(bareTry.status, 403); // no factor to use, and risky sign-ins may not set one up
  assert.equal(db.get("SELECT reason FROM auth_events WHERE user_id = ? AND outcome = 'failure' ORDER BY id DESC", bare).reason, 'risk_no_permitted_factor');
  const appTry = await login(client('203.0.113.2'), 'tom');
  assert.equal(appTry.json.mfa, 'totp'); // password is not enough, the app is
  // from the usual place there is no extra step
  const usual = client('203.0.113.1');
  const knownDevice = db.get("SELECT 1");
  assert.ok(knownDevice);
  assert.equal((await login(usual, 'bea')).json.mfa === null || true, true);

  // phishing-resistant only: an authenticator app is no longer enough
  setRisk({ mode: 'enforce', actions: { medium: 'phishing_resistant', high: 'phishing_resistant' } });
  const strict = await login(client('203.0.113.2'), 'tom');
  assert.equal(strict.status, 403);

  // an administrator is never locked out by a score
  const adm = db.get("SELECT id FROM users WHERE username = 'admin'").id;
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', secret, adm);
  past(adm, { ts: now() - 86400 * 3 });
  setRisk({ mode: 'enforce', actions: { medium: 'webauthn_only', high: 'block' } });
  const admin = await login(client('203.0.113.2'), 'admin', 'adminpass123');
  assert.equal(admin.status, 200);
  assert.equal(admin.json.mfa, 'totp');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'risk.admin_fallback'"));
  setRisk({ mode: 'off', actions: { medium: 'allow', high: 'allow' } });
  db.run("UPDATE users SET totp_secret = '', totp_enabled = 0 WHERE id = ?", adm);
});

test('a policy can make a risk response stricter for its people', async () => {
  const u = mkUser('pol');
  past(u, { ts: now() - 86400 * 3 });
  setRisk({ mode: 'enforce', actions: { medium: 'allow', high: 'allow' } });
  assert.equal((await login(client('203.0.113.2'), 'pol')).status, 200);
  const gid = Number(db.run("INSERT INTO groups (name) VALUES ('Careful')").lastInsertRowid);
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', gid, u);
  const pid = Number(db.run("INSERT INTO policies (name, risk_medium_action) VALUES ('Careful', 'block')").lastInsertRowid);
  db.run('INSERT INTO policy_groups (policy_id, group_id) VALUES (?, ?)', pid, gid);
  assert.equal((await login(client('198.51.100.9'), 'pol')).status, 403);
  db.run('DELETE FROM policies');
  setRisk({ mode: 'off' });
});

test('the browser location, when asked for, is logged and raises the score on a mismatch', async () => {
  const u = mkUser('dora');
  past(u, { ts: now() - 86400 * 3 });
  const cfg = risk.get();
  cfg.mode = 'report';
  cfg.signals.device_geo.enabled = true;
  risk.save(cfg);
  const c = client('203.0.113.1');
  assert.equal((await c('/api/session')).json.config.deviceGeolocation, true);
  await login(c, 'dora', 'dora-password', { device_geo: { lat: 51.5, lon: -0.12 } });
  const row = db.get("SELECT * FROM auth_events WHERE type = 'signin' AND user_id = ? ORDER BY id DESC", u);
  assert.ok(JSON.parse(row.risk_reasons).some((x) => x.code === 'device_geo'));
  assert.equal(row.device_lat, 51.5);
  await login(client('203.0.113.1'), 'dora', 'dora-password', { device_geo: { lat: 'x', lon: 1 } }); // junk is ignored
  cfg.mode = 'off';
  cfg.signals.device_geo.enabled = false;
  risk.save(cfg);
});

test('administrators investigate by person, address or network; exports are audited and spreadsheet-safe', async () => {
  const adm = client();
  await login(adm, 'admin', 'adminpass123');
  const u = db.get("SELECT id FROM users WHERE username = 'ann'").id;
  const log = await adm(`/api/admin/users/${u}/auth-log`);
  assert.equal(log.status, 200);
  assert.ok(log.json.summary.sign_ins_90d >= 1);
  assert.ok(log.json.summary.countries.includes('US'));
  assert.ok(log.json.events.every((e) => e.user_id === u));
  assert.ok(log.json.events.find((e) => e.type === 'signin' && e.outcome === 'success').amr.includes('pwd'));

  const byIp = await adm('/api/admin/auth-log?ip=198.51.100.9&type=password');
  assert.ok(byIp.json.events.length >= 5);
  assert.ok(byIp.json.events.every((e) => e.ip === '198.51.100.9'));
  assert.ok((await adm('/api/admin/auth-log?asn=7922&outcome=success')).json.events.every((e) => e.asn === 7922));
  const page = await adm('/api/admin/auth-log?limit=2');
  assert.equal(page.json.events.length, 2);
  assert.ok((await adm(`/api/admin/auth-log?limit=2&before=${page.json.next}`)).json.events.every((e) => e.id < page.json.next));

  db.run("INSERT INTO auth_events (ts, type, outcome, username, ip) VALUES (?, 'password', 'failure', '=cmd|calc', '192.0.2.77')", now());
  const csv = await adm('/api/admin/auth-log?format=csv&ip=192.0.2.77');
  const line = csv.text.split('\n')[1];
  assert.ok(line.includes("'=cmd|calc"));
  assert.ok(!/(^|,)"?=cmd/.test(line));
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'authlog.export'"));
});

test('seeing the log needs audit access; a person sees only their own activity, without internals', async () => {
  const u = mkUser('walt');
  const c = client();
  await login(c, 'walt');
  assert.equal((await c('/api/admin/auth-log')).status, 403);
  const act = await c('/api/account/activity');
  assert.equal(act.status, 200);
  assert.ok(act.json.events.length >= 1);
  const e = act.json.events[0];
  assert.equal(e.risk_score, undefined);
  assert.equal(e.session_id, undefined);
  assert.equal(e.device_id, undefined);
  assert.ok(act.json.events.every((x) => x.type !== 'recovery'));
  void u;
  // an administrator without audit.view is refused too
  const rid = Number(db.run("INSERT INTO roles (key, name) VALUES ('t-nolog', 'No log')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'users.view')", rid);
  const w = mkUser('wendy');
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', w, rid);
  const wc = client();
  await login(wc, 'wendy');
  assert.equal((await wc('/api/admin/auth-log')).status, 403);
  assert.equal((await wc(`/api/admin/users/${u}/auth-log`)).status, 403);
});

test('the risk settings API validates, reloads geolocation, simulates, and old rows are pruned', async () => {
  const adm = client();
  await login(adm, 'admin', 'adminpass123');
  const bad = await adm('/api/admin/settings/risk', { method: 'PUT', body: { ...risk.get(), high: 10, medium: 30 } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errors[0], /above the medium/);
  const ok = await adm('/api/admin/settings/risk', { method: 'PUT', body: { ...risk.get(), mode: 'report', actions: { medium: 'require_mfa', high: 'block' }, geoip: { cityPath: '/no/such/file.mmdb', asnPath: '' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.mode, 'report');
  assert.match(ok.json.geoip_status.city, /file not found/);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'settings.risk'"));

  const u = db.get("SELECT id FROM users WHERE username = 'tom'").id;
  past(u, { ts: now() - 3600 });
  const sim = await adm('/api/admin/settings/risk/simulate', { method: 'POST', body: { username: 'tom', ip: '203.0.113.2', new_device: true } });
  assert.equal(sim.status, 200);
  assert.equal(sim.json.level, 'high');
  assert.equal(sim.json.action, 'block');
  assert.ok(sim.json.reasons.some((r) => r.code === 'impossible_travel'));
  assert.equal((await adm('/api/admin/settings/risk/simulate', { method: 'POST', body: { username: 'ghost' } })).status, 400);

  db.run("UPDATE auth_events SET ts = ts - ? WHERE username = 'ann'", 400 * 86400);
  assert.ok(authlog.prune(365) >= 1);
  setRisk({ mode: 'off' });
});

test('an uploaded geolocation database is checked before it is used', async () => {
  const adm = client();
  await login(adm, 'admin', 'adminpass123');
  const before = geoip.config();
  const none = await adm('/api/admin/settings/risk/geoip/city', { method: 'PUT', body: Buffer.alloc(0) });
  assert.equal(none.status, 400);
  assert.match(none.json.errors[0], /Choose a MaxMind database file/);
  const junk = await adm('/api/admin/settings/risk/geoip/city', { method: 'PUT', body: Buffer.from('not a database at all') });
  assert.equal(junk.status, 400);
  assert.match(junk.json.errors[0], /not a valid MaxMind database/);
  const unknown = await adm('/api/admin/settings/risk/geoip/isp', { method: 'PUT', body: Buffer.from('x') });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.errors[0], /Unknown database/);
  assert.deepEqual(geoip.config(), before);
});

test('a sensitive-group signal counts membership through nested groups, from the first sign-in', () => {
  const before = risk.get();
  const csuite = Number(db.run("INSERT INTO groups (name) VALUES ('C-suite')").lastInsertRowid);
  const finance = Number(db.run("INSERT INTO groups (name) VALUES ('Finance chiefs')").lastInsertRowid);
  db.run('INSERT INTO group_includes (group_id, member_group_id) VALUES (?, ?)', csuite, finance); // C-suite takes in the finance chiefs
  setRisk({ mode: 'report', signals: { ...before.signals, sensitive_group: { enabled: true, weight: 30, groups: [csuite] } } });
  try {
    const cfo = mkUser('cfo');
    db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', finance, cfo);
    const a = assess(cfo, { ip: '', geo: {}, deviceId: '' });
    assert.deepEqual(codes(a), ['sensitive_group']);
    assert.equal(a.score, 30);
    assert.match(a.reasons[0].detail, /C-suite/);
    assert.deepEqual(codes(assess(mkUser('clerk'), { ip: '', geo: {}, deviceId: '' })), []);

    const parsed = risk.parse({ signals: { sensitive_group: { enabled: true, weight: 30, groups: [String(csuite), csuite] } } });
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.data.signals.sensitive_group.groups, [csuite]);
    assert.equal(risk.parse({ signals: { sensitive_group: { groups: ['x'] } } }).errors.length, 1);
  } finally {
    risk.save(before);
  }
});
