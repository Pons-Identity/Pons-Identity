process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const ldap = require('../src/ldap');
const sessions = require('../src/directory-sessions');
const engine = require('../src/integrations/engine');
const { seedAdmin } = require('../src/server');

seedAdmin();

/* An in-memory directory standing in for ldapts. `open` counts connections that were made and not yet unbound. */
const BASE = 'DC=example,DC=com';
const entries = new Map();
const put = (cn, attrs) => entries.set(`cn=${cn},ou=staff,${BASE}`.toLowerCase(), { dn: `CN=${cn},OU=Staff,${BASE}`, objectClass: ['top', 'person', 'user'], ...attrs });
put('Alice Adams', { sAMAccountName: 'alice', givenName: 'Alice', sn: 'Adams', mail: 'alice@example.com', userAccountControl: '512', memberOf: [`CN=Weavers,OU=Groups,${BASE}`] });
entries.set('cn=svc,dc=example,dc=com', { dn: 'CN=svc,DC=example,DC=com', objectClass: ['top', 'person', 'user'], sAMAccountName: 'svc', userAccountControl: '512' });
entries.set(`cn=weavers,ou=groups,${BASE}`.toLowerCase(), { dn: `CN=Weavers,OU=Groups,${BASE}`, objectClass: ['top', 'group'] });

let open = 0;
let hang = false;
const log = [];
const values = (e, k) => { const key = Object.keys(e).find((x) => x.toLowerCase() === k.toLowerCase()); return key ? [].concat(e[key]).map(String) : []; };
// Understands (&...), (|...), (attr=value) and (attr=*) -- all the fake needs.
function matches(e, f) {
  f = f.trim();
  if (f.startsWith('(&')) return splitTop(f.slice(2, -1)).every((p) => matches(e, p));
  if (f.startsWith('(|')) return splitTop(f.slice(2, -1)).some((p) => matches(e, p));
  const [, attr, raw] = /^\(([^=]+)=(.*)\)$/.exec(f);
  const unescape = (x) => x.replace(/\\([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const have = values(e, attr);
  if (raw === '*') return have.length > 0;
  if (raw.includes('*')) { const re = new RegExp(`^${raw.split('*').map((x) => unescape(x).replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'); return have.some((x) => re.test(x)); }
  return have.some((x) => x.toLowerCase() === unescape(raw).toLowerCase());
}
function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; cur += ch; if (depth === 0 && cur) { out.push(cur); cur = ''; } }
  return out;
}
ldap.setClientFactory(() => {
  let counted = false;
  return {
    async startTLS() {},
    async bind(dn, pw) {
      if (hang) await new Promise(() => {});
      if (dn !== `CN=svc,DC=example,DC=com` || pw !== 'svc-pass') throw new Error('Invalid credentials');
      if (!counted) { counted = true; open++; }
    },
    async search(base, o) {
      log.push(`search ${o.scope} ${o.filter}`);
      let list = [...entries.values()].filter((e) => e.dn.toLowerCase().endsWith(base.toLowerCase()) && (o.scope !== 'base' || e.dn.toLowerCase() === base.toLowerCase()));
      list = list.filter((e) => matches(e, o.filter));
      if (list.length > o.sizeLimit) throw Object.assign(new Error('Size limit exceeded'), { name: 'SizeLimitExceededError' });
      return { searchEntries: list };
    },
    async add(dn, attrs) {
      if (entries.has(dn.toLowerCase())) throw new Error('Entry Already Exists');
      const e = { dn, objectCategory: 'person' }; // the server fills this in
      for (const a of attrs) e[a.type] = a.values.map((v) => (Buffer.isBuffer(v) ? v : String(v)));
      entries.set(dn.toLowerCase(), e);
      log.push(`add ${dn}`);
    },
    async modify(dn, changes) {
      const e = entries.get(dn.toLowerCase());
      if (!e) throw new Error('No such object');
      for (const c of [].concat(changes)) {
        if (c.modification.type === 'unicodePwd' && process.env.FAKE_REFUSE_PWD) throw new Error('Unwilling to perform');
        const key = Object.keys(e).find((k) => k.toLowerCase() === c.modification.type.toLowerCase()) || c.modification.type;
        if (c.modification.values.length) e[key] = c.modification.values; else delete e[key];
      }
      log.push(`modify ${dn}`);
    },
    async del(dn) { if (!entries.delete(dn.toLowerCase())) throw new Error('No such object'); log.push(`del ${dn}`); },
    async unbind() { if (counted) { counted = false; open--; } },
  };
});

const cfg = (over = {}) => ({
  url: 'ldaps://dc.example.com', baseDn: BASE, bindDn: 'CN=svc,DC=example,DC=com', bindPassword: 'svc-pass',
  userFilter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))',
  attributeMap: { username: 'sAMAccountName', first_name: 'givenName', last_name: 'sn', display_name: 'displayName', email: 'mail', department: 'department' },
  groupAttribute: 'memberOf', timeoutSeconds: 5, scriptAccess: 'write', ...over,
});
let seq = 0;
const addDirectory = (over, type = 'ad') => {
  const name = `Corp ${++seq}`;
  db.run('INSERT INTO directories (name, type, enabled, config) VALUES (?,?,1,?)', name, type, JSON.stringify(cfg(over)));
  return name;
};
const run = (script, scopes = ['directory:read', 'directory:write'], timeoutSeconds = 3) => engine.run({ id: 0, name: 'direct', script, scopes, timeoutSeconds }, {});
const settle = () => new Promise((r) => setTimeout(r, 30));

// The fake treats person entries as those with objectClass user; the guard `(objectCategory=person)` needs the attribute.
for (const e of entries.values()) if (e.objectClass.includes('user')) e.objectCategory = 'person';

test('read: find by username, DN and email; search; closed at the end', async () => {
  const name = addDirectory();
  const r = await run(`
    const dir = await directory.connect(${JSON.stringify(name)});
    const a = await dir.find('alice');
    const byMail = await dir.find({ email: 'alice@example.com' });
    const byDn = await dir.find({ dn: a.dn });
    const none = await dir.find('nobody');
    const hits = await dir.search({ q: 'ali' });
    const filtered = await dir.search({ filter: '(givenName=Alice)' });
    await dir.close();
    return { a, same: byMail.dn === a.dn && byDn.dn === a.dn, none, hits: hits.length, filtered: filtered.length, access: dir.access };
  `);
  assert.strictEqual(r.status, 'ok', JSON.stringify(r.error));
  const out = JSON.parse(r.result);
  assert.deepStrictEqual({ u: out.a.username, g: out.a.groups, active: out.a.active, first: out.a.first_name }, { u: 'alice', g: ['Weavers'], active: true, first: 'Alice' });
  assert.ok(out.same);
  assert.strictEqual(out.none, null);
  assert.strictEqual(out.hits, 1);
  assert.strictEqual(out.filtered, 1);
  await settle();
  assert.strictEqual(open, 0);
  assert.strictEqual(sessions.count(), 0);
});

test('a username cannot rewrite the filter, and groups are out of reach', async () => {
  const name = addDirectory();
  const r = await run(`
    const dir = await directory.connect(${JSON.stringify(name)});
    const star = await dir.find('*');
    const inj = await dir.find('alice)(objectClass=*');
    let outside = null;
    outside = await dir.find({ dn: 'CN=Weavers,OU=Groups,${BASE}' });
    let elsewhere = null;
    try { await dir.find({ dn: 'CN=x,DC=other,DC=org' }); } catch (e) { elsewhere = e.message; }
    return { star, inj, outside, elsewhere };
  `);
  assert.strictEqual(r.status, 'ok', JSON.stringify(r.error));
  const out = JSON.parse(r.result);
  assert.strictEqual(out.star, null);
  assert.strictEqual(out.inj, null);
  assert.strictEqual(out.outside, null, 'a group is not a person');
  assert.match(out.elsewhere, /outside this directory/);
});

test('create, update and delete (Active Directory)', async () => {
  const name = addDirectory();
  const r = await run(`
    return await directory.use(${JSON.stringify(name)}, async (dir) => {
      const made = await dir.create({ username: 'bwilson', first_name: 'Bea', last_name: 'Wilson', email: 'bea@example.com', password: 'Str0ng-pass!', parentDn: 'OU=Staff,${BASE}', attributes: { title: 'Welder' } });
      let dup = null;
      try { await dir.create({ username: 'bwilson' }); } catch (e) { dup = e.message; }
      const changed = await dir.update('bwilson', { department: 'Hull', active: false, attributes: { title: null } });
      const off = await dir.find('bwilson', { attributes: ['title'] });
      await dir.update('bwilson', { active: true });
      const on = await dir.find('bwilson');
      const gone = await dir.delete('bwilson');
      return { made, dup, changed: changed.changed, off, on: on.active, gone, after: await dir.find('bwilson') };
    });
  `);
  assert.strictEqual(r.status, 'ok', JSON.stringify(r.error));
  const out = JSON.parse(r.result);
  assert.strictEqual(out.made.created, true);
  assert.strictEqual(out.made.dn, `cn=Bea Wilson,OU=Staff,${BASE}`);
  assert.strictEqual(out.made.active, true);
  assert.match(out.dup, /already exists/);
  assert.deepStrictEqual(out.changed, ['department', 'title', 'active']);
  assert.strictEqual(out.off.active, false);
  assert.strictEqual(out.off.department, 'Hull');
  assert.deepStrictEqual(out.off.attributes, { title: [] });
  assert.strictEqual(out.on, true);
  assert.strictEqual(out.after, null);
  const pwd = [...entries.values()].some((e) => e.dn.includes('Bea'));
  assert.strictEqual(pwd, false);
  await settle();
  assert.strictEqual(open, 0);
});

test('safeguards: scopes, script access, protected entries and attributes', async () => {
  const readOnly = addDirectory({ scriptAccess: 'read' });
  const off = addDirectory({ scriptAccess: 'off' });
  const full = addDirectory();

  assert.strictEqual((await run(`await directory.connect(${JSON.stringify(full)}); return 1;`, [])).status, 'error');
  assert.match((await run(`await directory.connect(${JSON.stringify(off)});`)).error.message, /does not allow scripts/);
  assert.match((await run('await directory.connect("Nope");')).error.message, /No directory named/);

  const noWrite = await run(`const d = await directory.connect(${JSON.stringify(full)}); await d.delete('alice');`, ['directory:read']);
  assert.match(noWrite.error.message, /directory:write/);
  const ro = await run(`const d = await directory.connect(${JSON.stringify(readOnly)}); await d.update('alice', { department: 'x' });`);
  assert.match(ro.error.message, /does not allow scripts to change/);

  const guarded = await run(`
    const d = await directory.connect(${JSON.stringify(full)});
    const tries = [];
    for (const f of [() => d.update('svc', { department: 'x' }), () => d.delete('svc'), () => d.update('alice', { attributes: { unicodePwd: 'x' } }),
      () => d.update('alice', { username: 'mallory' }), () => d.create({ username: 'x', parentDn: 'DC=other,DC=org' }), () => d.create({ username: 'x', bogus: 1 }),
      () => d.find({ email: 'a', username: 'b' }), () => d.search({ filter: '(broken' })]) {
      try { await f(); tries.push('allowed'); } catch (e) { tries.push(e.message); }
    }
    return tries;
  `);
  const tries = JSON.parse(guarded.result);
  assert.ok(tries.every((t) => t !== 'allowed'), JSON.stringify(tries));
  assert.match(tries[0], /service account/);
  assert.match(tries[2], /cannot be set this way/);
  await settle();
  assert.strictEqual(open, 0);
  assert.ok(entries.has('cn=svc,dc=example,dc=com'));
});

test('a failed password step does not leave an account behind', async () => {
  const name = addDirectory();
  process.env.FAKE_REFUSE_PWD = '1';
  const r = await run(`const d = await directory.connect(${JSON.stringify(name)}); await d.create({ username: 'carl', password: 'x', parentDn: 'OU=Staff,${BASE}' });`);
  delete process.env.FAKE_REFUSE_PWD;
  assert.match(r.error.message, /was not created/);
  assert.ok(![...entries.values()].some((e) => /carl/i.test(e.dn)));
  await settle();
  assert.strictEqual(open, 0);
});

test('connections are closed when the script forgets, fails, or is stopped', async () => {
  const name = addDirectory();
  // Forgets to close.
  await run(`await directory.connect(${JSON.stringify(name)}); await directory.connect(${JSON.stringify(name)}); return 1;`);
  await settle();
  assert.strictEqual(open, 0, 'forgotten connections are closed at the end of the run');

  // Throws while connected.
  const failed = await run(`await directory.connect(${JSON.stringify(name)}); throw new Error('boom');`);
  assert.strictEqual(failed.status, 'error');
  await settle();
  assert.strictEqual(open, 0);

  // Stuck in a loop and killed by the time limit.
  const stuck = await run(`await directory.connect(${JSON.stringify(name)}); while (true) {}`, undefined, 1);
  assert.strictEqual(stuck.status, 'timeout');
  await settle();
  assert.strictEqual(open, 0, 'a run stopped by its time limit still closes its connection');

  // Stopped while the connection is still being made.
  hang = true;
  const slow = await run(`await directory.connect(${JSON.stringify(name)});`, undefined, 1);
  assert.strictEqual(slow.status, 'timeout');
  hang = false;
  await settle();
  assert.strictEqual(sessions.count(), 0);
  assert.strictEqual(open, 0);
});

test('use() closes the connection even when the work throws; at most three at once', async () => {
  const name = addDirectory();
  const r = await run(`
    try { await directory.use(${JSON.stringify(name)}, async () => { throw new Error('inside'); }); } catch (e) { log(e.message); }
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await directory.connect(${JSON.stringify(name)}));
    let fourth = null;
    try { await directory.connect(${JSON.stringify(name)}); } catch (e) { fourth = e.message; }
    await held[0].close();
    const again = await directory.connect(${JSON.stringify(name)});
    let afterClose = null;
    try { await held[0].find('alice'); } catch (e) { afterClose = e.message; }
    return { fourth, afterClose, again: again.directory === ${JSON.stringify(name)}, twice: await held[0].close() };
  `);
  const out = JSON.parse(r.result);
  assert.match(out.fourth, /at most 3/);
  assert.match(out.afterClose, /closed/);
  assert.strictEqual(out.again, true);
  assert.strictEqual(out.twice, false);
  await settle();
  assert.strictEqual(open, 0);
});

test('an idle connection is closed by the server, and shutdown closes everything', async () => {
  const name = addDirectory();
  const dir = require('../src/directories').list().find((d) => d.name === name);
  const owner = { closed: false };
  const s = await sessions.open(owner, dir, 'read');
  assert.strictEqual(open, 1);
  await sessions.closeAll();
  assert.strictEqual(open, 0);
  assert.strictEqual(s.closed, true);
  assert.throws(() => sessions.get(owner, s.id), /closed/);
  assert.strictEqual(sessions.IDLE_MS > 0 && sessions.IDLE_MS <= 60000, true);
});

test('directory settings: script access is validated and kept', () => {
  const directories = require('../src/directories');
  const base = { name: 'Settings check', config: cfg({ scriptAccess: 'write', bindDn: '' }) };
  assert.ok(directories.parse(base).errors.some((e) => /service account/.test(e)));
  assert.strictEqual(directories.parse({ name: 'Ok', config: cfg({ scriptAccess: 'nonsense' }) }).data.config.scriptAccess, 'off');
  assert.strictEqual(directories.parse({ name: 'Ok2', config: cfg({ scriptAccess: 'read' }) }).data.config.scriptAccess, 'read');
});
