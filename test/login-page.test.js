process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const appSettings = require('../src/app-settings');
const messaging = require('../src/messaging');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
const host = `localhost:0`; // baseUrl host used by the guard
test.after(() => server.close());

const sent = [];
messaging.deps.createTransport = () => ({ sendMail: async (m) => { sent.push(m); } });
appSettings.write('messaging', { email: { provider: 'smtp', from: 'idp@example.com', smtp: { host: 'smtp.test', port: 25 } } });
const adminRole = db.get("SELECT id FROM roles WHERE key = 'admin'").id;

function setBranding(extra) {
  const { data } = appSettings.parseBranding({ ...appSettings.BRANDING_DEFAULTS, ...extra });
  appSettings.saveBranding(data);
}

async function session() {
  const r = await fetch(`${base}/api/session`);
  return { cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), json: await r.json() };
}

test('template and CSS are not in public settings; only a same-origin page with a session can fetch them', async () => {
  setBranding({ loginTemplate: '{{username_input}}{{password_input}}{{submit_button}}', loginCss: 'a{color:red}' });
  const s = await session();
  assert.equal(s.json.branding.loginCustom, true);
  assert.equal(s.json.branding.loginCss, undefined);
  assert.equal(s.json.branding.loginTemplate, undefined);

  const ok = await fetch(`${base}/api/login-page`, { headers: { cookie: s.cookie, 'x-csrf-token': s.json.csrf, 'sec-fetch-site': 'same-origin', origin: `http://${host}` } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.match(body.css, /a\{color:red\}/);
  assert.match(body.css, /beacon\.gif\?t=/);
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  for (const headers of [{}, { 'sec-fetch-site': 'cross-site' }, { cookie: s.cookie, 'sec-fetch-site': 'same-origin' }]) {
    assert.equal((await fetch(`${base}/api/login-page`, { headers })).status, 403, JSON.stringify(headers));
  }
});

test('validation rejects unknown variables, missing fields, scripts and remote CSS', () => {
  const bad = (x) => appSettings.parseBranding({ ...appSettings.BRANDING_DEFAULTS, ...x }).errors.length > 0;
  assert.ok(bad({ loginTemplate: '{{username_input}}{{password_input}}' }));
  assert.ok(bad({ loginTemplate: '{{username_input}}{{password_input}}{{submit_button}}{{nope}}' }));
  assert.ok(bad({ loginTemplate: '<script>x</script>{{username_input}}{{password_input}}{{submit_button}}' }));
  assert.ok(bad({ loginCss: '@import "x.css";' }));
  assert.ok(bad({ loginCss: 'a{background:url(https://evil/x.png)}' }));
  assert.ok(!bad({ loginCss: 'a{background:url(data:image/png;base64,AAAA)}' }));
});

test('a beacon hit from another site is reported by email to the chosen roles; our own site is not', async () => {
  appSettings.saveLoginPageProtection({ enabled: true, notifyRoleIds: [adminRole], cooldownMinutes: 60 });
  db.run("UPDATE users SET email = 'admin@example.com' WHERE username = 'admin'");
  const guard = require('../src/login-page-guard');
  const url = `${base}/api/login-page/beacon.gif?t=${guard.watermark()}`;

  assert.equal((await fetch(url, { headers: { referer: `http://${host}/login` } })).status, 200);
  assert.equal((await fetch(url)).status, 200);
  assert.equal(sent.length, 0);

  const r = await fetch(url, { headers: { referer: 'https://login-acme-phish.example/signin' } });
  assert.equal(r.headers.get('content-type'), 'image/gif');
  await new Promise((x) => setTimeout(x, 100));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'admin@example.com');
  assert.match(sent[0].text, /login-acme-phish\.example/);
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'login_page.clone_detected'"));

  // Repeats inside the cooldown do not send again.
  await fetch(url, { headers: { referer: 'https://login-acme-phish.example/signin' } });
  await new Promise((x) => setTimeout(x, 100));
  assert.equal(sent.length, 1);

  // A wrong token is ignored.
  await fetch(`${base}/api/login-page/beacon.gif?t=nope`, { headers: { referer: 'https://other.example/' } });
  assert.equal(db.all("SELECT 1 FROM audit_log WHERE action = 'login_page.clone_detected'").length, 1);
});
