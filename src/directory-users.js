const { Attribute, Change } = require('ldapts');
const ldap = require('./ldap');
const ldapFilter = require('./ldap-filter');
const { USER_FIELDS } = require('./admin-data');

// Reading and writing people in an external directory over an open connection (see directory-sessions.js), for integration
// scripts. Everything is confined to the directory's search base and to entries its user filter recognises as people, so a script
// cannot reach groups, computers or the rest of the tree, and cannot change the service account it is bound as.

class UserOpError extends Error {}

const fail = (message) => { throw new UserOpError(message); };
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

const MAX_LIMIT = 200;
const OBJECT_CLASSES = {
  ad: ['top', 'person', 'organizationalPerson', 'user'],
  ldap: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'],
};
const UAC_DISABLED = 0x2;
const UAC_NORMAL = 0x200;
const ATTR_NAME = /^[A-Za-z][A-Za-z0-9-]*(;[A-Za-z0-9-]+)*$/;
const PROFILE_FIELDS = USER_FIELDS.filter((f) => f !== 'username');

// Attributes a script may not write directly: identity and credentials have their own safe inputs.
const PROTECTED = new Set(['objectclass', 'dn', 'distinguishedname', 'userpassword', 'unicodepwd', 'useraccountcontrol', 'memberof', 'objectguid', 'objectsid', 'entryuuid']);

/* --------------------------------- Names ----------------------------------- */

const splitDn = (dn) => String(dn).split(/(?<!\\),/).map((r) => r.trim().replace(/\s*=\s*/, '=').toLowerCase()).filter(Boolean);
const sameDn = (a, b) => splitDn(a).join(',') === splitDn(b).join(',');
function within(dn, base) {
  const d = splitDn(dn); const b = splitDn(base);
  return d.length >= b.length && d.slice(d.length - b.length).join(',') === b.join(',');
}

/** RFC 4514 escaping for the value of a relative DN. */
const escapeDnValue = (v) => String(v).replace(/[\\,+"<>;=]/g, '\\$&').replace(/^[ #]/, '\\$&').replace(/ $/, '\\ ').replace(/\0/g, '\\00');

/* --------------------------------- Mapping --------------------------------- */

// A filter that matches any person the directory's user filter would find: {username} becomes "any value".
const personGuard = (cfg) => cfg.userFilter.replace(/\{username\}/g, '*');

const isAd = (dir) => dir.type === 'ad';

function toUser(entry, dir, extra = []) {
  const cfg = dir.config;
  const user = { dn: entry.dn };
  for (const [field, attr] of Object.entries(cfg.attributeMap)) {
    const v = ldap.firstValue(entry, attr).trim();
    if (v) user[field] = v;
  }
  user.groups = ldap.groupNames(entry, cfg);
  if (isAd(dir)) {
    const uac = Number(ldap.firstValue(entry, 'userAccountControl'));
    if (Number.isFinite(uac) && uac) user.active = !(uac & UAC_DISABLED);
  }
  if (extra.length) user.attributes = Object.fromEntries(extra.map((a) => [a, ldap.allValues(entry, a)]));
  return user;
}

const wantedAttributes = (dir, extra = []) => [...new Set([...ldap.requestedAttributes(dir.config), ...(isAd(dir) ? ['userAccountControl'] : []), ...extra])];

function extraAttributes(o) {
  if (o === undefined) return [];
  if (!Array.isArray(o) || o.some((a) => typeof a !== 'string' || !ATTR_NAME.test(a))) fail('attributes must be a list of LDAP attribute names.');
  if (o.some((a) => /password|pwd/i.test(a))) fail('Password attributes cannot be read.');
  return o;
}

/* --------------------------------- Searching ------------------------------- */

async function run(s, filter, { scope = 'sub', base, limit = 2, attributes = [] } = {}) {
  const cfg = s.dir.config;
  try {
    const { searchEntries } = await s.client.search(base || cfg.baseDn, { scope, filter, attributes: wantedAttributes(s.dir, attributes), sizeLimit: limit, timeLimit: cfg.timeoutSeconds || 10 });
    return searchEntries.filter((e) => e.dn && within(e.dn, cfg.baseDn));
  } catch (e) {
    if (/size ?limit/i.test(`${e.name} ${e.message}`)) fail(`More than ${limit} entries match. Narrow the search.`);
    if (/no ?such ?object/i.test(`${e.name} ${e.message}`)) return [];
    throw new UserOpError(`The directory search failed: ${e.message}`);
  }
}

/** One person's entry from `ref`: a username, or { username | dn | a mapped field such as email }. Null if there is none. */
async function entryOf(s, ref, attributes = []) {
  const cfg = s.dir.config;
  const q = typeof ref === 'string' ? { username: ref } : ref;
  if (!isObject(q)) fail('Name the user by username, or with an object such as { username }, { dn } or { email }.');
  const keys = Object.keys(q).filter((k) => q[k] !== undefined);
  if (keys.length !== 1) fail('Give exactly one of username, dn or a mapped field such as email.');
  const [key] = keys;
  const value = text(q[key]);
  if (!value) fail(`${key} cannot be empty.`);
  let found;
  if (key === 'username') found = await run(s, ldap.buildFilter(cfg.userFilter, value), { attributes });
  else if (key === 'dn') {
    if (!within(value, cfg.baseDn)) fail('That DN is outside this directory\'s search base.');
    found = await run(s, personGuard(cfg), { scope: 'base', base: value, attributes });
  } else {
    const attr = PROFILE_FIELDS.includes(key) ? cfg.attributeMap[key] : null;
    if (!attr || attr.toLowerCase() === 'dn') fail(`${key} is not a field mapped to an attribute of this directory.`);
    found = await run(s, `(&${personGuard(cfg)}(${attr}=${ldap.escapeFilterValue(value)}))`, { attributes });
  }
  if (found.length > 1) fail(`More than one person matches ${key} "${value}".`);
  return found[0] || null;
}

async function find(s, ref, o) {
  const extra = extraAttributes(isObject(o) ? o.attributes : undefined);
  const entry = await entryOf(s, ref, extra);
  return entry ? toUser(entry, s.dir, extra) : null;
}

async function search(s, q = {}) {
  const cfg = s.dir.config;
  const o = typeof q === 'string' ? { q } : q;
  if (!isObject(o)) fail('search takes text or an object such as { filter, q, limit }.');
  const limit = Math.min(Math.max(Number(o.limit) || 50, 1), MAX_LIMIT);
  const parts = [personGuard(cfg)];
  if (o.filter !== undefined) {
    if (typeof o.filter !== 'string' || !o.filter.trim()) fail('filter must be an LDAP filter such as (department=Sailing).');
    try { ldapFilter.parse(o.filter.trim()); } catch (e) { fail(`The filter is not valid: ${e.message}`); }
    parts.push(o.filter.trim());
  }
  if (o.q !== undefined) {
    const term = ldap.escapeFilterValue(text(o.q));
    if (!term) fail('q cannot be empty.');
    const attrs = ['username', 'display_name', 'email'].map((f) => cfg.attributeMap[f]).filter((a) => a && a.toLowerCase() !== 'dn');
    parts.push(`(|${attrs.map((a) => `(${a}=*${term}*)`).join('')})`);
  }
  const extra = extraAttributes(o.attributes);
  const entries = await run(s, `(&${parts.join('')})`, { limit, attributes: extra });
  return entries.map((e) => toUser(e, s.dir, extra));
}

/* --------------------------------- Writing --------------------------------- */

function mustWrite(s) {
  if (s.access !== 'write') fail(`${s.dir.name} does not allow scripts to change it. Set Script access to "Read and write" on the directory.`);
}

// Active Directory takes a password only as UTF-16LE text in quotes, and only over an encrypted connection (the config requires one).
const unicodePwd = (password) => new Attribute({ type: 'unicodePwd', values: [Buffer.from(`"${password}"`, 'utf16le')] });

function checkPassword(v) {
  if (typeof v !== 'string' || !v) fail('password must be a non-empty string.');
  if (v.length > 256) fail('password is too long.');
}

/** { attribute: value } for the profile fields in `spec`, through the directory's attribute map. */
function mapped(s, spec, fields) {
  const out = {};
  for (const field of fields) {
    if (spec[field] === undefined) continue;
    if (typeof spec[field] !== 'string') fail(`${field} must be a string.`);
    const attr = s.dir.config.attributeMap[field];
    if (!attr || attr.toLowerCase() === 'dn') fail(`${field} is not mapped to an attribute of this directory, so it cannot be written.`);
    out[attr] = spec[field].trim();
  }
  return out;
}

function rawAttributes(o) {
  if (o === undefined) return {};
  if (!isObject(o)) fail('attributes must be an object of LDAP attribute names and values.');
  const out = {};
  for (const [name, v] of Object.entries(o)) {
    if (!ATTR_NAME.test(name)) fail(`"${name}" is not a valid LDAP attribute name.`);
    if (PROTECTED.has(name.toLowerCase())) fail(`${name} cannot be set this way. Use the dedicated field (password, active) or the identity fields.`);
    const values = v === null ? [] : [].concat(v);
    if (values.some((x) => typeof x !== 'string')) fail(`${name} must be a string, a list of strings, or null to remove it.`);
    out[name] = values.map((x) => x.trim()).filter(Boolean);
  }
  return out;
}

const replace = (type, values) => new Change({ operation: 'replace', modification: new Attribute({ type, values }) });

const CREATE_KEYS = [...USER_FIELDS, 'password', 'active', 'attributes', 'parentDn', 'objectClass'];

async function create(s, spec) {
  mustWrite(s);
  const { dir } = s;
  const cfg = dir.config;
  if (!isObject(spec)) fail('create takes an object such as { username: "sam", first_name: "Sam", last_name: "Rivera", password: "…" }.');
  const unknown = Object.keys(spec).filter((k) => !CREATE_KEYS.includes(k));
  if (unknown.length) fail(`Unknown field: ${unknown.join(', ')}.`);
  const username = text(spec.username);
  if (!username || username.length > 64 || /[\0\r\n]/.test(username)) fail('A username of up to 64 characters is required.');
  if (spec.active !== undefined && typeof spec.active !== 'boolean') fail('active must be true or false.');
  if (spec.active === false && !isAd(dir)) fail('active: false is supported only for Active Directory directories.');
  if (spec.password !== undefined) checkPassword(spec.password);
  const parent = spec.parentDn === undefined ? cfg.baseDn : text(spec.parentDn);
  if (!parent || !within(parent, cfg.baseDn)) fail('parentDn must be inside this directory\'s search base.');
  const classes = spec.objectClass === undefined ? OBJECT_CLASSES[dir.type] || OBJECT_CLASSES.ldap : [].concat(spec.objectClass);
  if (!classes.length || classes.some((c) => typeof c !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(c))) fail('objectClass must be a list of class names.');

  const display = text(spec.display_name) || `${text(spec.first_name)} ${text(spec.last_name)}`.trim() || username;
  const cn = isAd(dir) ? display : username;
  const rdnAttr = isAd(dir) ? 'cn' : cfg.attributeMap.username;
  if (!rdnAttr || rdnAttr.toLowerCase() === 'dn') fail('The directory\'s username attribute cannot be used to name a new entry.');
  const dn = `${rdnAttr}=${escapeDnValue(isAd(dir) ? cn : username)},${parent}`;

  const attrs = { objectClass: classes, cn: [cn], sn: [text(spec.last_name) || username] };
  for (const [attr, v] of Object.entries(mapped(s, { ...spec, username }, USER_FIELDS))) if (v) attrs[attr] = [v];
  for (const [attr, v] of Object.entries(rawAttributes(spec.attributes))) if (v.length) attrs[attr] = v;
  if (isAd(dir)) attrs.userAccountControl = [String(UAC_NORMAL | UAC_DISABLED)]; // enabled once the password is set
  else if (spec.password !== undefined) attrs.userPassword = [spec.password];

  if (await entryOf(s, { username })) fail(`A user named ${username} already exists in ${dir.name}.`);
  try {
    await s.client.add(dn, Object.entries(attrs).map(([type, values]) => new Attribute({ type, values })));
  } catch (e) {
    throw new UserOpError(`The directory refused to create ${dn}: ${e.message}`);
  }
  if (isAd(dir) && spec.password !== undefined) {
    try {
      await s.client.modify(dn, new Change({ operation: 'replace', modification: unicodePwd(spec.password) }));
      if (spec.active !== false) await s.client.modify(dn, replace('userAccountControl', [String(UAC_NORMAL)]));
    } catch (e) {
      // Never leave a half-made account behind.
      await s.client.del(dn).catch(() => {});
      throw new UserOpError(`The directory refused the new account's password or status, so it was not created: ${e.message}`);
    }
  }
  const made = await entryOf(s, { dn });
  return { ...(made ? toUser(made, dir) : { dn, username }), created: true };
}

const UPDATE_KEYS = [...PROFILE_FIELDS, 'password', 'active', 'attributes'];

async function update(s, ref, patch) {
  mustWrite(s);
  const { dir } = s;
  const cfg = dir.config;
  if (!isObject(patch)) fail('update takes the user and an object of the fields to change.');
  if (patch.username !== undefined) fail('A username cannot be changed.');
  const unknown = Object.keys(patch).filter((k) => !UPDATE_KEYS.includes(k));
  if (unknown.length) fail(`Unknown field: ${unknown.join(', ')}.`);
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') fail('active must be true or false.');
    if (!isAd(dir)) fail('active is supported only for Active Directory directories.');
  }
  if (patch.password !== undefined) checkPassword(patch.password);
  const profile = mapped(s, patch, PROFILE_FIELDS);
  const raw = rawAttributes(patch.attributes);
  const entry = await entryOf(s, ref);
  if (!entry) fail('No such user in this directory.');
  if (cfg.bindDn && sameDn(entry.dn, cfg.bindDn)) fail('The service account this connection uses cannot be changed by a script.');

  const changes = [];
  const changed = [];
  for (const [attr, v] of Object.entries(profile)) changes.push(replace(attr, v ? [v] : []));
  changed.push(...Object.keys(patch).filter((k) => PROFILE_FIELDS.includes(k)));
  for (const [attr, v] of Object.entries(raw)) { changes.push(replace(attr, v)); changed.push(attr); }
  if (patch.active !== undefined) {
    const current = (await run(s, '(objectClass=*)', { scope: 'base', base: entry.dn, attributes: ['userAccountControl'], limit: 1 }))[0] || {};
    const uac = Number(ldap.firstValue(current, 'userAccountControl')) || UAC_NORMAL;
    changes.push(replace('userAccountControl', [String(patch.active ? uac & ~UAC_DISABLED : uac | UAC_DISABLED)]));
    changed.push('active');
  }
  if (patch.password !== undefined) {
    changes.push(isAd(dir) ? new Change({ operation: 'replace', modification: unicodePwd(patch.password) }) : replace('userPassword', [patch.password]));
    changed.push('password');
  }
  if (!changes.length) return { ...toUser(entry, dir), changed };
  try {
    await s.client.modify(entry.dn, changes);
  } catch (e) {
    throw new UserOpError(`The directory refused the change: ${e.message}`);
  }
  const after = await entryOf(s, { dn: entry.dn });
  return { ...toUser(after || entry, dir), changed };
}

async function remove(s, ref) {
  mustWrite(s);
  const { dir } = s;
  const entry = await entryOf(s, ref);
  if (!entry) fail('No such user in this directory.');
  if (dir.config.bindDn && sameDn(entry.dn, dir.config.bindDn)) fail('The service account this connection uses cannot be deleted by a script.');
  try {
    await s.client.del(entry.dn);
  } catch (e) {
    throw new UserOpError(`The directory refused to delete ${entry.dn}: ${e.message}`);
  }
  return { dn: entry.dn, username: ldap.firstValue(entry, dir.config.attributeMap.username) };
}

module.exports = { find, search, create, update, remove, UserOpError, within, sameDn, escapeDnValue, personGuard };
