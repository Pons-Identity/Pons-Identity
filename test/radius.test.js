process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const dgram = require('dgram');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const totp = require('../src/totp');
const radius = require('../src/radius');
const packet = require('../src/radius/packet');
const rs = require('../src/radius/settings');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin(); // before the tests add people: it only makes the administrator when there is nobody

const SECRET = 'a-long-shared-secret';
const source = { address: '10.1.2.3', port: 40000 };
let n = 0;

const user = (name, password, extra = {}) => {
  const id = Number(db.run("INSERT INTO users (guid, username, password_hash, active) VALUES (?, ?, ?, 1)", `rad-${name}`, name, hashPassword(password)).lastInsertRowid);
  for (const [k, v] of Object.entries(extra)) db.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v, id);
  return id;
};
const config = (client = {}) => ({
  enabled: true, port: 1812, bindAddress: '127.0.0.1',
  clients: [{ id: 'c1', name: 'Switch', address: '10.1.2.0/24', secret: SECRET, enabled: true, requireMessageAuthenticator: true, mfaMode: 'challenge', groups: [], attributes: [], ...client }],
});

// A device's side: send one Access-Request through handle() and decode the answer.
async function ask(cfg, attributes, { signed = true, from = source, id = ++n % 250, secret = SECRET } = {}) {
  const { packet: req, authenticator } = packet.buildRequest({ id, attributes, secret, signed });
  const raw = await radius.handle(req, from, cfg);
  if (!raw) return null;
  assert.ok(packet.verifyResponse(raw, authenticator, secret), 'the Response Authenticator is valid');
  return packet.parse(raw);
}
const login = (name, password, extra = []) => {
  const auth = crypto.randomBytes(16);
  return { auth, attrs: [['User-Name', name], ['User-Password', packet.encryptPassword(password, SECRET, auth)], ...extra] };
};
// buildRequest picks its own authenticator unless given one, so encrypt against the one we choose.
async function pap(cfg, name, password, extra = [], opts = {}) {
  const authenticator = crypto.randomBytes(16);
  const attributes = [['User-Name', name], ['User-Password', packet.encryptPassword(password, opts.secret || SECRET, authenticator)], ...extra];
  const { packet: req } = packet.buildRequest({ id: ++n % 250, attributes, secret: opts.secret || SECRET, authenticator, signed: opts.signed !== false });
  const raw = await radius.handle(req, opts.from || source, cfg);
  if (!raw) return null;
  assert.ok(packet.verifyResponse(raw, authenticator, opts.secret || SECRET));
  return { ...packet.parse(raw), authenticator };
}
const reply = (r, name) => packet.text(packet.first(r, name));

test('a device that is not listed gets no answer', async () => {
  assert.equal(await pap(config(), 'nobody', 'x', [], { from: { address: '192.168.9.9', port: 1 } }), null);
  assert.equal(await pap(config({ enabled: false }), 'nobody', 'x'), null);
});

test('a person with the right password is accepted, and a wrong one is rejected', async () => {
  user('sam', 'correct horse battery');
  const ok = await pap(config(), 'sam', 'correct horse battery');
  assert.equal(ok.code, packet.CODES.ACCESS_ACCEPT);
  const bad = await pap(config(), 'sam', 'wrong password!');
  assert.equal(bad.code, packet.CODES.ACCESS_REJECT);
  assert.equal(reply(bad, 'Reply-Message'), 'Authentication failed.');
  assert.equal((await pap(config(), 'ghost', 'whatever')).code, packet.CODES.ACCESS_REJECT);
  // Long passwords span several 16-byte blocks.
  user('rowan', 'a considerably longer passphrase, with punctuation!');
  assert.equal((await pap(config(), 'rowan', 'a considerably longer passphrase, with punctuation!')).code, packet.CODES.ACCESS_ACCEPT);
});

test('requests are signed: a wrong secret or a missing Message-Authenticator is dropped', async () => {
  user('jordan', 'jordan-password-1');
  assert.equal(await pap(config(), 'jordan', 'jordan-password-1', [], { secret: 'not-the-secret' }), null);
  assert.equal(await pap(config(), 'jordan', 'jordan-password-1', [], { signed: false }), null);
  const lenient = await pap(config({ requireMessageAuthenticator: false }), 'jordan', 'jordan-password-1', [], { signed: false });
  assert.equal(lenient.code, packet.CODES.ACCESS_ACCEPT);
});

test('inactive and blocked people are rejected; CHAP and EAP are refused', async () => {
  const id = user('casey', 'casey-password-1');
  db.run('UPDATE users SET active = 0 WHERE id = ?', id);
  assert.equal((await pap(config(), 'casey', 'casey-password-1')).code, packet.CODES.ACCESS_REJECT);
  const chap = await radiusAsk(config(), [['User-Name', 'sam'], ['CHAP-Password', Buffer.alloc(17)]]);
  assert.equal(chap.code, packet.CODES.ACCESS_REJECT);
});
async function radiusAsk(cfg, attributes) {
  const { packet: req, authenticator } = packet.buildRequest({ id: ++n % 250, attributes, secret: SECRET });
  const raw = await radius.handle(req, source, cfg);
  assert.ok(packet.verifyResponse(raw, authenticator, SECRET));
  return packet.parse(raw);
}

test('a client can be limited to a group, and sends the attributes set for it', async () => {
  const staff = Number(db.run("INSERT INTO groups (name) VALUES ('radius-staff')").lastInsertRowid);
  const lab = Number(db.run("INSERT INTO groups (name) VALUES ('radius-lab')").lastInsertRowid);
  const a = user('staffer', 'staffer-password-1'); user('outsider', 'outsider-password-1');
  db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', staff, a);
  const cfg = config({ groups: [staff], attributes: [
    { attribute: 'VLAN', value: '120', group_id: staff }, { attribute: 'VLAN', value: '999', group_id: lab },
    { attribute: 'Filter-Id', value: 'staff-acl', group_id: null }, { attribute: 'Session-Timeout', value: '3600', group_id: null },
  ] });
  const ok = await pap(cfg, 'staffer', 'staffer-password-1');
  assert.equal(ok.code, packet.CODES.ACCESS_ACCEPT);
  assert.equal(reply(ok, 'Tunnel-Private-Group-Id'), '120');
  assert.equal(reply(ok, 'Filter-Id'), 'staff-acl');
  assert.equal(packet.first(ok, 'Session-Timeout').readUInt32BE(0), 3600);
  assert.equal(packet.first(ok, 'Tunnel-Type').readUInt32BE(0) & 0xffffff, 13);
  assert.equal(ok.attributes.filter((x) => x.name === 'Tunnel-Private-Group-Id').length, 1);
  assert.equal((await pap(cfg, 'outsider', 'outsider-password-1')).code, packet.CODES.ACCESS_REJECT);
});

test('someone with an authenticator app is challenged for a code', async () => {
  const secret = totp.generateSecret();
  user('mfa-sam', 'mfa-password-123', { totp_enabled: 1, totp_secret: secret });
  const cfg = config();
  const first = await pap(cfg, 'mfa-sam', 'mfa-password-123');
  assert.equal(first.code, packet.CODES.ACCESS_CHALLENGE);
  const state = packet.first(first, 'State');
  assert.ok(state && /code/i.test(reply(first, 'Reply-Message')));
  const wrong = await pap(cfg, 'mfa-sam', '000000', [['State', state]]);
  assert.equal(wrong.code, packet.CODES.ACCESS_REJECT);
  // A state is good for one try.
  const again = (await pap(cfg, 'mfa-sam', 'mfa-password-123'));
  const code = totp.codeForStep(secret, totp.currentStep());
  const done = await pap(cfg, 'mfa-sam', code, [['State', packet.first(again, 'State')]]);
  assert.equal(done.code, packet.CODES.ACCESS_ACCEPT);
  // The same code cannot be used twice.
  const third = await pap(cfg, 'mfa-sam', 'mfa-password-123');
  assert.equal((await pap(cfg, 'mfa-sam', code, [['State', packet.first(third, 'State')]])).code, packet.CODES.ACCESS_REJECT);
});

test('a client can take the code after the password instead', async () => {
  const secret = totp.generateSecret();
  user('append-sam', 'append-password-1', { totp_enabled: 1, totp_secret: secret });
  const cfg = config({ mfaMode: 'append' });
  assert.equal((await pap(cfg, 'append-sam', 'append-password-1')).code, packet.CODES.ACCESS_REJECT);
  const code = totp.codeForStep(secret, totp.currentStep());
  assert.equal((await pap(cfg, 'append-sam', `append-password-1${code}`)).code, packet.CODES.ACCESS_ACCEPT);
  assert.equal((await pap(cfg, 'append-sam', `append-password-1${code}`)).code, packet.CODES.ACCESS_REJECT);
});

test('someone who must use a second factor but has none a RADIUS prompt can ask for is rejected', async () => {
  user('nofactor', 'nofactor-password-1', { mfa_enabled: 1 });
  assert.equal((await pap(config(), 'nofactor', 'nofactor-password-1')).code, packet.CODES.ACCESS_REJECT);
});

test('repeated failures lock the name for a while, and a retransmission gets the same answer', async () => {
  user('locky', 'locky-password-1');
  const cfg = config();
  for (let i = 0; i < radius.MAX_FAILURES; i++) assert.equal((await pap(cfg, 'locky', 'nope-nope-nope')).code, packet.CODES.ACCESS_REJECT);
  assert.equal((await pap(cfg, 'locky', 'locky-password-1')).code, packet.CODES.ACCESS_REJECT);
  const events = db.all("SELECT detail FROM audit_log WHERE action = 'login.failure' AND detail LIKE '%lockout%'");
  assert.ok(events.length >= 1);

  user('retry', 'retry-password-1');
  const authenticator = crypto.randomBytes(16);
  const { packet: req } = packet.buildRequest({ id: 7, attributes: [['User-Name', 'retry'], ['User-Password', packet.encryptPassword('retry-password-1', SECRET, authenticator)]], secret: SECRET, authenticator });
  const [one, two] = await Promise.all([radius.handle(req, source, cfg), radius.handle(req, source, cfg)]);
  assert.ok(one.equals(two));
});

test('sign-ins by RADIUS are recorded with the device that asked', async () => {
  const ok = db.get("SELECT * FROM audit_log WHERE action = 'login.success' AND actor_name = 'sam' ORDER BY id DESC LIMIT 1");
  assert.ok(ok);
  assert.equal(JSON.parse(ok.detail).via, 'radius');
  assert.equal(JSON.parse(ok.detail).client, 'Switch');
  assert.equal(ok.ip, '10.1.2.3');
  const log = db.get("SELECT * FROM auth_events WHERE username = 'sam' AND outcome = 'success' ORDER BY id DESC LIMIT 1");
  assert.ok(log);
  assert.equal(log.ip, '10.1.2.3');
});

test('settings: clients are validated, secrets are kept when left blank and never shown', () => {
  const body = { enabled: true, port: 1812, bindAddress: '0.0.0.0', clients: [{ name: 'AP', address: '10.0.0.0/24', secret: 'short' }] };
  assert.match(rs.parse(body, { clients: [] }).errors.join(' '), /at least 12/);
  const good = rs.parse({ ...body, clients: [{ ...body.clients[0], secret: 'long-enough-secret' }] }, { clients: [] });
  assert.deepEqual(good.errors, []);
  const saved = good.data;
  const keep = rs.parse({ ...body, clients: [{ id: saved.clients[0].id, name: 'AP', address: '10.0.0.0/24', secret: '' }] }, saved);
  assert.deepEqual(keep.errors, []);
  assert.equal(keep.data.clients[0].secret, 'long-enough-secret');
  const shown = JSON.stringify(rs.view({ ...saved }));
  assert.ok(!shown.includes('long-enough-secret'));
  assert.match(rs.parse({ ...body, clients: [{ name: 'X', address: 'not-an-address', secret: 'long-enough-secret' }] }, { clients: [] }).errors.join(' '), /IP address/);
  assert.match(rs.parse({ ...body, enabled: true, clients: [] }, { clients: [] }).errors.join(' '), /at least one client/);
  assert.match(rs.parse({ ...body, clients: [{ name: 'V', address: '10.0.0.1', secret: 'long-enough-secret', attributes: [{ attribute: 'VLAN', value: '9999' }] }] }, { clients: [] }).errors.join(' '), /VLAN/);
});

test('over UDP: the server listens, answers a real datagram, and stops', async () => {
  user('udp-sam', 'udp-password-123');
  const port = 20000 + Math.floor(Math.random() * 20000);
  rs.save({ ...config(), port, bindAddress: '127.0.0.1', clients: [{ ...config().clients[0], address: '127.0.0.1' }] });
  const status = await radius.apply();
  try {
    assert.equal(status.listening, true, status.error);
    const authenticator = crypto.randomBytes(16);
    const { packet: req } = packet.buildRequest({ id: 9, attributes: [['User-Name', 'udp-sam'], ['User-Password', packet.encryptPassword('udp-password-123', SECRET, authenticator)]], secret: SECRET, authenticator });
    const client = dgram.createSocket('udp4');
    const answer = await new Promise((resolve, reject) => {
      client.once('message', resolve);
      client.send(req, port, '127.0.0.1', (e) => e && reject(e));
      setTimeout(() => reject(new Error('no answer')), 3000);
    });
    client.close();
    assert.equal(packet.parse(answer).code, packet.CODES.ACCESS_ACCEPT);
    assert.ok(packet.verifyResponse(answer, authenticator, SECRET));
  } finally {
    rs.save({ ...rs.get(), enabled: false });
    await radius.apply();
  }
  assert.equal(radius.getStatus().listening, false);
});

test('the console saves RADIUS settings without ever returning a secret, and keeps the secret when it is left blank', async () => {
  const server = createApp().listen(0);
  try {
    const base = `http://localhost:${server.address().port}`;
    let cookie = ''; let csrf = '';
    const call = async (path, { method = 'GET', body } = {}) => {
      const headers = { cookie };
      if (csrf) headers['x-csrf-token'] = csrf;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const t = await r.text();
      return { status: r.status, text: t, json: t ? JSON.parse(t) : null };
    };
    csrf = (await call('/api/session')).json.csrf;
    await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
    csrf = (await call('/api/session')).json.csrf;
    const body = { enabled: false, port: 30000 + Math.floor(Math.random() * 1000), bindAddress: '127.0.0.1', clients: [{ name: 'Gateway', address: '10.9.0.0/16', secret: 'super-secret-value-1', attributes: [{ attribute: 'Filter-Id', value: 'vpn' }] }] };
    const saved = await call('/api/admin/settings/radius', { method: 'PUT', body });
    assert.equal(saved.status, 200, saved.text);
    assert.ok(!saved.text.includes('super-secret-value-1'));
    assert.equal(saved.json.clients[0].secret_set, true);
    const id = saved.json.clients[0].id;
    const again = await call('/api/admin/settings/radius', { method: 'PUT', body: { ...body, clients: [{ ...body.clients[0], id, secret: '' }] } });
    assert.equal(again.status, 200, again.text);
    assert.equal(rs.get().clients[0].secret, 'super-secret-value-1');
    assert.ok(!(await call('/api/admin/settings/radius')).text.includes('super-secret-value-1'));
    assert.equal((await call('/api/admin/settings/radius', { method: 'PUT', body: { ...body, port: 0 } })).status, 400);
    const audit = db.get("SELECT detail FROM audit_log WHERE action = 'settings.radius' ORDER BY id DESC LIMIT 1");
    assert.ok(!audit.detail.includes('super-secret-value-1'));
  } finally {
    server.close();
  }
});
