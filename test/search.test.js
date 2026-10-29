process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const ldapFilter = require('../src/ldap-filter');

seedAdmin();

const mkUser = (username, fields = {}) => {
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO users (guid, username, password_hash, active${cols.map((c) => `, ${c}`).join('')})
                        VALUES (?, ?, ?, 1${cols.map(() => ', ?').join('')})`,
  newGuid(), username, hashPassword(`pw-${username}`), ...cols.map((c) => fields[c])).lastInsertRowid);
};
const alice = mkUser('alice', { first_name: 'Alice', last_name: 'Adams', display_name: 'Alice Adams', email: 'alice@example.net', department: 'Underwater Basket-Weaving', title: 'Master Weaver' });
const bob = mkUser('bob', { display_name: 'Bob Baker', email: 'bob@example.net', department: 'Pottery', employee_id: '1001' });
mkUser('carol', { display_name: 'Carol Clark', email: 'carol@other.org', department: 'Underwater Basket-Weaving' });
db.run("INSERT INTO user_emails (user_id, email) VALUES (?, 'alice.alt@example.net')", alice);

const basketWeavingGroup = Number(db.run("INSERT INTO groups (name, description) VALUES ('underwater-basket-weaving-staff', 'Everyone in the underwater basket-weaving department')").lastInsertRowid);
db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', basketWeavingGroup, alice);
db.run("INSERT INTO groups (name, description) VALUES ('library', 'Library staff')");

// A role that can only see groups, to check that search leaves out what the caller may not open.
const groupsOnly = Number(db.run("INSERT INTO roles (key, name, description) VALUES ('groups-only', 'Groups only', '')").lastInsertRowid);
db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'groups.view')", groupsOnly);
const gina = mkUser('gina');
db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', gina, groupsOnly);

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = '';
  let csrf = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const login = async (username, password) => {
    csrf = (await call('/api/session')).json.csrf;
    const r = await call('/api/login', { method: 'POST', body: { username, password } });
    csrf = (await call('/api/session')).json.csrf;
    return r;
  };
  return { call, login };
}

const admin = client();
test('the admin signs in', async () => {
  const r = await admin.login('admin', 'adminpass123');
  assert.strictEqual(r.status, 200);
});

const usernames = (rows) => rows.map((u) => u.username).sort();

/* ------------------------------ LDAP filters ------------------------------ */

test('an LDAP filter matches people by attribute, including several addresses', async () => {
  const r = await admin.call(`/api/admin/users?q=${encodeURIComponent('(&(department=Underwater Basket-Weaving)(mail=*))')}`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(usernames(r.json), ['alice', 'carol']);

  const alt = await admin.call(`/api/admin/users?q=${encodeURIComponent('(mail=alice.alt@example.net)')}`);
  assert.deepStrictEqual(usernames(alt.json), ['alice']);

  const wild = await admin.call(`/api/admin/users?q=${encodeURIComponent('(mail=*@example.net)')}`);
  assert.deepStrictEqual(usernames(wild.json), ['alice', 'bob']);
});

test('LDAP filters can match group membership and use negation', async () => {
  const member = await admin.call(`/api/admin/users?q=${encodeURIComponent('(memberOf=underwater-basket-weaving-staff)')}`);
  assert.deepStrictEqual(usernames(member.json), ['alice']);

  const notBasketWeaving = await admin.call(`/api/admin/users?q=${encodeURIComponent('(!(department=Underwater Basket-Weaving))')}`);
  assert.ok(notBasketWeaving.json.some((u) => u.username === 'bob'));
  assert.ok(!notBasketWeaving.json.some((u) => u.username === 'alice'));
});

test('a malformed or unknown LDAP filter is a 400 that names the problem', async () => {
  const bad = await admin.call(`/api/admin/users?q=${encodeURIComponent('(cn=alice')}`);
  assert.strictEqual(bad.status, 400);
  assert.match(bad.json.error, /Expected "\)"/);

  const unknown = await admin.call(`/api/admin/users?q=${encodeURIComponent('(nickname=al*)')}`);
  assert.strictEqual(unknown.status, 400);
  assert.match(unknown.json.error, /Unknown attribute "nickname"/);
});

test('free text needs every word to match, across name, email and ID fields', async () => {
  assert.deepStrictEqual(usernames((await admin.call('/api/admin/users?q=alice')).json), ['alice']);
  assert.deepStrictEqual(usernames((await admin.call('/api/admin/users?q=bob%20example')).json), ['bob']);
  assert.deepStrictEqual(usernames((await admin.call('/api/admin/users?q=1001')).json), ['bob']);
  assert.deepStrictEqual(usernames((await admin.call('/api/admin/users?q=nobody-here')).json), []);
  assert.strictEqual((await admin.call('/api/admin/users')).json.length, 5, 'admin, alice, bob, carol and gina');
});

test('a text search lists the fields whose whole value equals it, ignoring case', async () => {
  const byUsername = (await admin.call('/api/admin/users?q=ALICE')).json.find((u) => u.username === 'alice');
  assert.deepStrictEqual(byUsername.matched, ['username', 'first_name']);

  const byAddress = (await admin.call('/api/admin/users?q=alice.alt%40example.net')).json;
  assert.deepStrictEqual(byAddress.map((u) => [u.username, u.matched]), [['alice', ['emails']]]);

  const partial = (await admin.call('/api/admin/users?q=alic')).json.find((u) => u.username === 'alice');
  assert.deepStrictEqual(partial.matched, []);
});

test('people rows carry no password or secret fields', async () => {
  const r = await admin.call('/api/admin/users?q=alice');
  assert.strictEqual(r.json[0].password_hash, undefined);
  assert.strictEqual(r.json[0].totp_secret, undefined);
  assert.strictEqual(r.json[0].is_admin, false);
});

/* ------------------------------ Other lists -------------------------------- */

test('groups are searched by name and description', async () => {
  const byDescription = await admin.call('/api/admin/groups?q=underwater basket-weaving');
  assert.deepStrictEqual(byDescription.json.map((g) => g.name), ['underwater-basket-weaving-staff']);
  const byName = await admin.call('/api/admin/groups?q=LIBRARY');
  assert.deepStrictEqual(byName.json.map((g) => g.name), ['library']);
});

test('the integrations and applications lists accept a search', async () => {
  assert.strictEqual((await admin.call('/api/admin/applications?q=no-such-app')).json.length, 0);
  assert.deepStrictEqual((await admin.call('/api/admin/integrations?q=no-such-integration')).json.integrations, []);
});

/* ------------------------------- Global search ----------------------------- */

test('global search returns matches from each area the caller can open', async () => {
  const r = await admin.call('/api/admin/search?q=underwater basket-weaving');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(usernames(r.json.people.results), ['alice', 'carol']);
  assert.deepStrictEqual(r.json.groups.results.map((g) => g.name), ['underwater-basket-weaving-staff']);
  assert.ok(r.json.applications && r.json.integrations && r.json.audit);
  assert.ok(Array.isArray(r.json.audit.results));
});

test('global search leaves out sections the caller has no permission for', async () => {
  const gina_ = client();
  assert.strictEqual((await gina_.login('gina', 'pw-gina')).status, 200);
  const r = await gina_.call('/api/admin/search?q=underwater basket-weaving');
  assert.deepStrictEqual(Object.keys(r.json), ['groups']);
  assert.deepStrictEqual(r.json.groups.results.map((g) => g.name), ['underwater-basket-weaving-staff']);
});

test('global search needs at least two characters and reports a bad filter in its own section', async () => {
  assert.deepStrictEqual((await admin.call('/api/admin/search?q=a')).json, {});

  const r = await admin.call(`/api/admin/search?q=${encodeURIComponent('(cn=al')}`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.people.results, []);
  assert.match(r.json.people.error, /Expected/);
  assert.ok(r.json.groups, 'the other sections still answer');
});

/* ----------------------------- Filter compiler ----------------------------- */

test('the compiler matches the RFC 4515 forms and rejects the rest', () => {
  const rec = { cn: ['Alice Adams'], mail: ['a@x.net'] };
  const attrs = { cn: (r) => r.cn, mail: (r) => r.mail };
  const t = (f) => ldapFilter.compile(f, attrs)(rec);
  assert.strictEqual(t('(cn=alice adams)'), true);
  assert.strictEqual(t('(cn=*ams)'), true);
  assert.strictEqual(t('(cn=a*m*s)'), true);
  assert.strictEqual(t('(cn=a*z*s)'), false);
  assert.strictEqual(t('(cn=\\41lice*)'), true, 'a hex escape is a literal character');
  assert.strictEqual(t('(cn=Alice\\2a)'), false, 'an escaped asterisk is not a wildcard');
  assert.strictEqual(t('(cn>=Alice)'), true);
  assert.strictEqual(t('(cn~=aliceadams)'), true);
  assert.strictEqual(t('(|(cn=zed)(mail=A@X.NET))'), true);
  assert.strictEqual(t('(!(cn=*))'), false);
  assert.throws(() => t('(cn=a(b)'), ldapFilter.LdapFilterError);
  assert.throws(() => t('(&)'), ldapFilter.LdapFilterError);
  assert.throws(() => t('(cn=a\\zz)'), ldapFilter.LdapFilterError);
  assert.throws(() => t(`(cn=${'a'.repeat(600)})`), ldapFilter.LdapFilterError);
});
