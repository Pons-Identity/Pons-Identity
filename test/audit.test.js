process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const db = require('../src/db');
const audit = require('../src/audit');
const forward = require('../src/audit-forward');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const mkUser = (n, active = 1) => Number(db.run('INSERT INTO users (guid, username, password_hash, active) VALUES (?,?,?,?)',
  newGuid(), n, hashPassword('pw-' + n), active).lastInsertRowid);
mkUser('plain');
mkUser('dormant', 0);

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => { server.close(); forward.stop(); });

function client() {
  let cookie = ''; let csrf = '';
  const call = async (path, { method = 'GET', body, headers: extra = {} } = {}) => {
    const headers = { cookie, ...extra };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* csv */ }
    return { status: r.status, json, text };
  };
  const login = async (username, password) => {
    csrf = (await call('/api/session')).json.csrf;
    const r = await call('/api/login', { method: 'POST', body: { username, password } });
    csrf = (await call('/api/session')).json.csrf;
    return r;
  };
  return { call, login };
}

const events = (filters, limit = 50) => audit.query(filters, limit);
const last = (action) => events({ action }, 1)[0];

/* ------------------------------- Core module ------------------------------- */

test('record stores the event with actor, target and a redacted detail', () => {
  const id = audit.record({
    category: 'admin', action: 'thing.change', actor: { type: 'user', id: 7, name: 'ann' },
    target: { type: 'thing', id: 3, name: 'widget' },
    detail: { changed: ['name'], password: 'hunter2', nested: { clientSecret: 'x', apiToken: 'y', ok: 1 }, list: [{ totp_secret: 'z' }] },
  });
  const row = audit.query({ action: 'thing.change' }, 1)[0];
  assert.equal(row.id, id);
  assert.equal(row.actor_name, 'ann');
  assert.equal(row.target_name, 'widget');
  assert.equal(row.outcome, 'success');
  assert.deepEqual(row.detail.changed, ['name']);
  assert.equal(row.detail.password, '[redacted]');
  assert.equal(row.detail.nested.clientSecret, '[redacted]');
  assert.equal(row.detail.nested.apiToken, '[redacted]');
  assert.equal(row.detail.nested.ok, 1);
  assert.equal(row.detail.list[0].totp_secret, '[redacted]');
  assert.ok(!JSON.stringify(row).includes('hunter2'));
});

test('record never throws, even when the insert fails', () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const circular = {}; circular.self = circular;
    assert.doesNotThrow(() => audit.record({ category: 'system', action: 'x', detail: circular }));
    assert.equal(audit.record({ category: null, action: null }), null);
  } finally {
    console.error = orig;
  }
});

test('query filters and pages newest-first', () => {
  for (let i = 0; i < 5; i++) audit.record({ category: 'user', action: 'page.test', outcome: i % 2 ? 'failure' : 'success', detail: { i } });
  const all = audit.query({ action: 'page.test' }, 100);
  assert.equal(all.length, 5);
  assert.ok(all[0].id > all[4].id);
  const first = audit.query({ action: 'page.test' }, 2);
  const second = audit.query({ action: 'page.test', before: first[1].id }, 2);
  assert.equal(second.length, 2);
  assert.ok(second[0].id < first[1].id);
  assert.equal(audit.query({ action: 'page.test', outcome: 'failure' }, 100).length, 2);
  assert.equal(audit.query({ q: '%' }, 5).filter((r) => !JSON.stringify(r).includes('%')).length, 0, 'LIKE wildcards are escaped');
});

test('prune removes only rows past retention, and 0 keeps everything', () => {
  const old = audit.record({ category: 'system', action: 'prune.old' });
  const fresh = audit.record({ category: 'system', action: 'prune.fresh' });
  db.run('UPDATE audit_log SET ts = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 40 * 86400, old);
  assert.equal(audit.prune(0), 0);
  assert.ok(audit.query({ action: 'prune.old' }).length);
  assert.ok(audit.prune(30) >= 1);
  assert.equal(audit.query({ action: 'prune.old' }).length, 0);
  assert.equal(audit.query({ action: 'prune.fresh' })[0].id, fresh);
});

/* ------------------------------- Through the app ------------------------------- */

test('failed and successful sign-ins are recorded without leaking why to the caller', async () => {
  const c = client();
  const bad = await c.login('plain', 'wrong-password');
  assert.equal(bad.status, 401);
  const unknown = await c.login('nobody-here', 'x');
  const dormant = await c.login('dormant', 'pw-dormant');
  assert.deepEqual([unknown.json, dormant.json], [bad.json, bad.json], 'responses are identical');

  const fails = events({ action: 'login.failure' }, 10);
  const reasons = Object.fromEntries(fails.map((f) => [f.actor_name, f.detail.reason]));
  assert.equal(reasons.plain, 'bad_credentials');
  assert.equal(reasons['nobody-here'], 'unknown_user');
  assert.equal(reasons.dormant, 'inactive');
  assert.ok(fails.every((f) => f.outcome === 'failure' && f.ip && f.request_id));
  assert.ok(!JSON.stringify(fails).includes('wrong-password'));

  const ok = await c.login('plain', 'pw-plain');
  assert.equal(ok.status, 200);
  const row = last('login.success');
  assert.equal(row.actor_name, 'plain');
  assert.equal(row.actor_type, 'user');
  assert.equal(row.category, 'user');
  assert.ok(row.session_id.length === 16);
});

test('administrator changes are recorded with actor and field names, never secrets', async () => {
  const c = client();
  assert.equal((await c.login('admin', 'adminpass123')).status, 200);
  const made = await c.call('/api/admin/users', { method: 'POST', body: { username: 'newbie', first_name: 'New', last_name: 'Bie', email: 'n@example.com', password: 'a-long-password-1', active: true } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.id;
  const upd = await c.call(`/api/admin/users/${id}`, { method: 'PUT', body: { username: 'newbie', first_name: 'Renamed', last_name: 'Bie', email: 'n@example.com', password: 'another-long-pass-2', active: true } });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  assert.equal((await c.call(`/api/admin/users/${id}/reset-totp`, { method: 'POST' })).status, 200);
  assert.equal((await c.call(`/api/admin/users/${id}`, { method: 'DELETE' })).status, 204);

  const trail = events({ targetType: 'user', targetId: String(id) }, 20).map((e) => e.action).reverse();
  assert.deepEqual(trail, ['user.create', 'user.update', 'user.password_reset', 'user.totp_reset', 'user.delete']);
  const update = last('user.update');
  assert.equal(update.actor_name, 'admin');
  assert.equal(update.target_name, 'newbie', 'target name survives deletion');
  assert.ok(update.detail.changed.includes('first_name') && !update.detail.changed.includes('email'), 'only fields that changed are listed');
  const everything = JSON.stringify(events({ targetType: 'user', targetId: String(id) }));
  assert.ok(!everything.includes('another-long-pass-2') && !everything.includes('a-long-password-1'));
  assert.ok(!everything.includes('$'), 'no password hash');
});

test('groups changed through the console also land in the central log', async () => {
  const c = client();
  await c.login('admin', 'adminpass123');
  await c.call('/api/admin/groups', { method: 'POST', body: { name: 'audited-group' , description: 'Test group'} });
  // The group's include and exclude groups are made with it; find the base's entry.
  const row = events({ action: 'group.create' }, 5).find((e) => e.target_name === 'audited-group');
  assert.ok(row);
  assert.equal(row.actor_name, 'admin');
});

test('the audit log needs its own permission, and a refusal is itself recorded', async () => {
  const c = client();
  await c.login('plain', 'pw-plain');
  const r = await c.call('/api/admin/audit');
  assert.equal(r.status, 403);

  const admin = client();
  await admin.login('admin', 'adminpass123');
  const roleBody = { name: 'Group viewer', description: '', permissions: ['groups.view'], user_ids: [] };
  const role = await admin.call('/api/admin/roles', { method: 'POST', body: roleBody });
  assert.equal(role.status, 201, JSON.stringify(role.json));
  const viewer = mkUser('viewer');
  db.run('INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = ?', viewer, 'Group viewer');
  const v = client();
  await v.login('viewer', 'pw-viewer');
  assert.equal((await v.call('/api/admin/audit')).status, 403);
  const denied = last('access.denied');
  assert.equal(denied.actor_name, 'viewer');
  assert.equal(denied.detail.permission, 'audit.view');
  assert.equal(denied.outcome, 'failure');
});

test('administrators can search and export; exports are audited and spreadsheet-safe', async () => {
  const c = client();
  await c.login('admin', 'adminpass123');
  audit.record({ category: 'user', action: 'csv.test', actor: { type: 'user', name: '=HYPERLINK("http://evil")' }, detail: { a: 'with, comma' } });
  const list = await c.call('/api/admin/audit?action=csv.test');
  assert.equal(list.status, 200);
  assert.equal(list.json.events.length, 1);
  assert.equal(list.json.retentionDays, 365);
  const csv = await c.call('/api/admin/audit.csv?action=csv.test');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.split('\r\n')[0].startsWith('id,ts,category,action'));
  assert.ok(csv.text.includes(`'=HYPERLINK`), 'formula prefix neutralised');
  assert.equal(last('audit.export').actor_name, 'admin');
});

test('a bad bearer token on the SCIM API is recorded without the token', async () => {
  const r = await fetch(`${base}/scim/v2/Users`, { headers: { authorization: 'Bearer super-secret-guess' } });
  assert.ok([401, 403].includes(r.status));
  const rows = events({ action: 'token.auth_failure' }, 5);
  if (r.status === 401) {
    assert.equal(rows[0].detail.api, 'scim');
    assert.equal(rows[0].detail.tokenPresented, true);
  }
  assert.ok(!JSON.stringify(rows).includes('super-secret-guess'));
});

/* ------------------------------- Forwarding ------------------------------- */

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
};

function httpSink(status = 200) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { got.push({ headers: req.headers, body }); res.statusCode = status; res.end('ok'); });
  });
  return new Promise((resolve) => srv.listen(0, () => resolve({
    srv, got, url: `http://127.0.0.1:${srv.address().port}/ingest`,
    setStatus: (s) => { status = s; },
    close: () => new Promise((r) => srv.close(r)),
  })));
}

test('HTTP sink: json, splunk-hec, ecs and cef formats', async () => {
  const sink = await httpSink();
  try {
    for (const format of ['json', 'splunk-hec', 'ecs', 'cef']) {
      sink.got.length = 0;
      forward.start({ auditHttp: { url: sink.url, authToken: 'tok-123', format } });
      const id = audit.record({ category: 'user', action: `fmt.${format}`, outcome: 'failure', actor: { type: 'user', id: 4, name: 'dana' }, ip: '203.0.113.9', detail: { n: 1, password: 'nope' } });
      const req = await waitFor(() => sink.got.find((g) => g.body.includes(`fmt.${format}`)));
      assert.ok(!req.body.includes('nope'), 'secrets never leave the process');
      if (format === 'json') {
        assert.equal(req.headers.authorization, 'Bearer tok-123');
        const ev = JSON.parse(req.body).find((e) => e.id === id);
        assert.equal(ev.actor.name, 'dana');
        assert.equal(ev.outcome, 'failure');
        assert.equal(ev.source.ip, '203.0.113.9');
      } else if (format === 'splunk-hec') {
        assert.equal(req.headers.authorization, 'Splunk tok-123');
        const ev = JSON.parse(req.body.split('\n').find((l) => l.includes(`fmt.${format}`)));
        assert.equal(ev.sourcetype, '_json');
        assert.equal(ev.event.id, id);
      } else if (format === 'ecs') {
        const ev = JSON.parse(req.body).find((e) => e.event.id === String(id));
        assert.equal(ev.event.action, 'fmt.ecs');
        assert.equal(ev.source.ip, '203.0.113.9');
        assert.equal(ev.user.name, 'dana');
        assert.ok(ev['@timestamp']);
      } else {
        const line = req.body.split('\n').find((l) => l.includes('fmt.cef'));
        assert.ok(line.startsWith('CEF:0|Pons Identity|Pons Identity|1.0|fmt.cef|fmt.cef|5|'));
        assert.ok(line.includes('suser=dana') && line.includes('src=203.0.113.9'));
      }
    }
  } finally {
    forward.stop();
    await sink.close();
  }
});

test('an unreachable sink backs off, reports its error, and catches up without losing or reordering events', async () => {
  const sink = await httpSink(503);
  const orig = console.error;
  console.error = () => {};
  try {
    forward.start({ auditHttp: { url: sink.url, format: 'json' } });
    const ids = [1, 2, 3].map((i) => audit.record({ category: 'system', action: `outage.${i}` }));
    await waitFor(() => forward.status()[0].lastError);
    assert.equal(forward.status()[0].consecutiveFailures >= 1, true);
    assert.ok(forward.status()[0].pending >= 3);
    assert.match(forward.status()[0].lastError.message, /503/);

    sink.setStatus(200);
    sink.got.length = 0;
    forward.start({ auditHttp: { url: sink.url, format: 'json' } }); // restart: resumes from the saved cursor
    await waitFor(() => forward.status()[0].pending === 0 && sink.got.length);
    const delivered = sink.got.flatMap((g) => JSON.parse(g.body)).map((e) => e.id);
    for (const id of ids) assert.ok(delivered.includes(id), `event ${id} replayed`);
    assert.deepEqual(delivered, [...delivered].sort((a, b) => a - b), 'in order');
    assert.equal(forward.status()[0].lastError, null);
    // The failure was noted locally but is not sent back out.
    assert.ok(audit.query({ action: 'audit.forward.failure' }, 1).length);
    assert.ok(!sink.got.some((g) => g.body.includes('audit.forward.failure')));
  } finally {
    console.error = orig;
    forward.stop();
    await sink.close();
  }
});

test('a down sink does not slow or fail requests', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    forward.start({ auditHttp: { url: 'http://127.0.0.1:1/never', format: 'json' } });
    const c = client();
    const t = Date.now();
    const r = await c.login('plain', 'wrong');
    assert.equal(r.status, 401);
    assert.ok(Date.now() - t < 2000);
  } finally {
    console.error = orig;
    forward.stop();
  }
});

test('syslog over TCP uses RFC 5424 with octet-counting framing', async () => {
  const chunks = [];
  const srv = net.createServer((s) => s.on('data', (d) => chunks.push(d)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    forward.start({ auditSyslog: { url: `tcp://127.0.0.1:${srv.address().port}`, facility: 'local4', appName: 'idp-test' } });
    const id = audit.record({ category: 'user', action: 'syslog.tcp', outcome: 'failure', actor: { type: 'user', name: 'eve "e" ]x' }, ip: '198.51.100.2' });
    await waitFor(() => Buffer.concat(chunks).toString().includes('syslog.tcp'));
    const text = Buffer.concat(chunks).toString();
    const m = /^(\d+) (<.*)$/s.exec(text);
    assert.ok(m, 'starts with a length prefix');
    const msg = m[2].slice(0, Number(m[1]));
    assert.equal(Buffer.byteLength(msg), Number(m[1]));
    // facility local4 (20) * 8 + warning (4) for a failure
    assert.match(msg, /^<164>1 \d{4}-\d\d-\d\dT[\d:.]+Z \S+ idp-test \d+ syslog\.tcp /);
    assert.ok(msg.includes(`[audit@32473 id="${id}" category="user" action="syslog.tcp" outcome="failure" actor="eve \\"e\\" \\]x" ip="198.51.100.2"]`));
    assert.equal(JSON.parse(msg.slice(msg.indexOf('{'))).id, id);
  } finally {
    forward.stop();
    srv.close();
  }
});

test('syslog over UDP sends one datagram per event', async () => {
  const sock = dgram.createSocket('udp4');
  const got = [];
  sock.on('message', (m) => got.push(m.toString()));
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  try {
    forward.start({ auditSyslog: { url: `udp://127.0.0.1:${sock.address().port}` } });
    audit.record({ category: 'system', action: 'syslog.udp' });
    await waitFor(() => got.find((m) => m.includes('syslog.udp')));
    const msg = got.find((m) => m.includes('syslog.udp'));
    assert.match(msg, /^<86>1 /, 'authpriv (10) * 8 + informational (6)');
  } finally {
    forward.stop();
    sock.close();
  }
});

test('forwarding status and the test event are available to administrators', async () => {
  const sink = await httpSink();
  try {
    forward.start({ auditHttp: { url: sink.url, authToken: 'tok-secret', format: 'json' } });
    const c = client();
    await c.login('admin', 'adminpass123');
    const test = await c.call('/api/admin/audit/forwarding/test', { method: 'POST' });
    assert.equal(test.status, 200);
    assert.equal(test.json.sinks[0].sink, 'http');
    assert.ok(sink.got.some((g) => g.body.includes('audit.forward.test')));
    const status = await c.call('/api/admin/audit/forwarding');
    assert.equal(status.json.sinks[0].pending, 0);
    assert.ok(!JSON.stringify(status.json).includes('tok-secret'), 'credentials are never shown');
  } finally {
    forward.stop();
    await sink.close();
  }
});

test('events recorded while a delivery is in flight are still delivered, and flush waits for them', async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => setTimeout(() => { got.push(...JSON.parse(body).map((e) => e.action)); res.end('ok'); }, 80));
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    forward.start({ auditHttp: { url: `http://127.0.0.1:${srv.address().port}/`, format: 'json' } });
    audit.record({ category: 'system', action: 'burst.1' });
    await new Promise((r) => setTimeout(r, 120)); // first delivery is now waiting on the slow server
    audit.record({ category: 'system', action: 'burst.2' });
    audit.record({ category: 'system', action: 'burst.stop' });
    await forward.flush(); // what shutdown does: must not return before the last event is out
    assert.deepEqual(got.filter((a) => a.startsWith('burst.')), ['burst.1', 'burst.2', 'burst.stop']);
  } finally {
    forward.stop();
    srv.close();
  }
});
