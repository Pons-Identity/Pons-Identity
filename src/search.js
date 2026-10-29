const db = require('./db');
const attributeDefs = require('./attribute-defs');
const sps = require('./sps');
const apps = require('./apps');
const integrations = require('./integrations');
const ldapFilter = require('./ldap-filter');

// Search over the things an administrator manages. Each search takes the text the person typed and returns
// { results, total }: `results` is the first `limit` matches (all of them by default), `total` every match.
// Free text needs every word to appear in one of the record's fields. Text that starts with "(" is an LDAP filter
// (people only, see PERSON_ATTRIBUTES); a bad filter throws ldap-filter's LdapFilterError.

const MAX_QUERY = 512;

const clean = (q) => String(q ?? '').trim().slice(0, MAX_QUERY);

function matchesText(text, fields) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = fields.map((f) => String(f ?? '').toLowerCase());
  return words.every((w) => haystack.some((h) => h.includes(w)));
}

const pageOf = (matches, limit, shape = (r) => r) => ({ results: matches.slice(0, limit).map(shape), total: matches.length });

/* ---------------------------------- People --------------------------------- */

// LDAP attribute names (case-insensitive) and the field each reads. `mail` and `memberOf` are lists (every address,
// every group name); the rest are single values.
const PERSON_ATTRIBUTES = {
  uid: 'username', cn: 'display_name', displayName: 'display_name', givenName: 'first_name', sn: 'last_name',
  mail: 'emails', mailNickname: 'mail_nickname', memberOf: 'groups', employeeNumber: 'employee_id',
  department: 'department', title: 'title', telephoneNumber: 'phone', mobile: 'mobile', company: 'company',
  manager: 'manager', physicalDeliveryOfficeName: 'office', streetAddress: 'street_address', l: 'city', st: 'state',
  postalCode: 'postal_code', c: 'country', description: 'description', sAMAccountName: 'sam_account_name',
  userPrincipalName: 'upn', distinguishedName: 'distinguished_name', entryUUID: 'guid',
};

// Fields that free-text search looks in. Administrator-defined attribute values are searched too.
const PERSON_TEXT_FIELDS = ['username', 'display_name', 'first_name', 'last_name', 'emails', 'employee_id', 'department', 'title', 'upn', 'sam_account_name'];

const listOf = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x ?? '')).filter((x) => x !== '');

const PERSON_TESTS = Object.fromEntries(Object.entries(PERSON_ATTRIBUTES).map(([name, field]) => [name.toLowerCase(), (p) => listOf(p[field])]));

// The LDAP attributes a people filter understands: the built-in ones, then each administrator-defined attribute by its
// name. A built-in name wins over a defined attribute with the same name.
function personTests() {
  const tests = { ...PERSON_TESTS };
  for (const def of attributeDefs.list()) {
    const key = def.name.toLowerCase();
    if (!Object.hasOwn(tests, key)) tests[key] = (p) => listOf(p.attributes[def.name]);
  }
  return tests;
}

// Every person with the columns above, plus their addresses, group names and defined attribute values. Read once per search.
function loadPeople() {
  const columns = ['username', 'display_name', 'first_name', 'last_name', 'email', 'employee_id', 'department', 'title', 'upn',
    'sam_account_name', 'mail_nickname', 'phone', 'mobile', 'company', 'manager', 'office', 'street_address', 'city', 'state',
    'postal_code', 'country', 'description', 'distinguished_name', 'guid', 'active', 'mfa_enabled', 'totp_enabled'];
  const byUser = (rows) => {
    const map = new Map();
    for (const r of rows) map.set(r.user_id, [...(map.get(r.user_id) || []), r.value]);
    return map;
  };
  const emails = byUser(db.all('SELECT user_id, email AS value FROM user_emails ORDER BY id'));
  const groups = byUser(db.all('SELECT m.user_id, g.name AS value FROM group_members m JOIN groups g ON g.id = m.group_id ORDER BY g.name'));
  const attributes = new Map();
  for (const r of db.all('SELECT a.user_id, a.name, a.value FROM user_attributes a JOIN attribute_defs d ON d.name = a.name')) {
    attributes.set(r.user_id, { ...attributes.get(r.user_id), [r.name]: r.value });
  }
  return db.all(`SELECT u.id, ${columns.map((c) => `u.${c}`).join(', ')},
                        (SELECT COUNT(*) FROM group_members m WHERE m.user_id = u.id) AS group_count,
                        (SELECT d.name FROM directories d WHERE d.id = u.directory_id) AS directory,
                        (EXISTS (SELECT 1 FROM account_lockdowns l WHERE l.user_id = u.id)) AS locked_down
                 FROM users u ORDER BY u.username`)
    .map((u) => ({
      ...u,
      emails: [...new Set([u.email, ...(emails.get(u.id) || [])].filter(Boolean))],
      groups: groups.get(u.id) || [],
      attributes: attributes.get(u.id) || {},
    }));
}

// What the people lists and the API return for each person (no password or secret fields).
const personRow = (p) => ({
  id: p.id, username: p.username, display_name: p.display_name, email: p.email, emails: p.emails, first_name: p.first_name,
  last_name: p.last_name, upn: p.upn, sam_account_name: p.sam_account_name, department: p.department, title: p.title,
  employee_id: p.employee_id, active: p.active, mfa_enabled: p.mfa_enabled, totp_enabled: p.totp_enabled,
  group_count: p.group_count, directory: p.directory, locked_down: Boolean(p.locked_down), attributes: p.attributes,
});

// The text fields whose whole value is exactly the search text (ignoring case), so the list can show their columns.
// A defined attribute is named `attr:<name>`, the same key the list uses for its column.
const wholeValueMatches = (p, text) => [
  ...PERSON_TEXT_FIELDS.filter((f) => listOf(p[f]).some((v) => v.toLowerCase() === text)),
  ...Object.keys(p.attributes).filter((n) => p.attributes[n].toLowerCase() === text).map((n) => `attr:${n}`),
];

/** People matching `q`. Text, or an LDAP filter such as (&(department=Underwater Basket-Weaving)(mail=*)). Text rows list `matched`: the fields that equal it. */
function searchPeople({ q, limit } = {}) {
  const text = clean(q);
  if (text.startsWith('(')) return pageOf(loadPeople().filter(ldapFilter.compile(text, personTests())), limit, personRow);
  const needle = text.toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  const matches = loadPeople().filter((p) => {
    const haystack = [...PERSON_TEXT_FIELDS.flatMap((f) => listOf(p[f])), ...Object.values(p.attributes)].map((v) => v.toLowerCase());
    return words.every((w) => haystack.some((h) => h.includes(w)));
  });
  return pageOf(matches, limit, (p) => ({ ...personRow(p), matched: wholeValueMatches(p, needle) }));
}

/* ---------------------------------- Groups --------------------------------- */

function searchGroups({ q, limit } = {}) {
  const text = clean(q);
  const all = db.all(`SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
                      FROM groups g ORDER BY g.name`);
  return pageOf(all.filter((g) => matchesText(text, [g.name, g.description])), limit);
}

/* ------------------------------- Applications ------------------------------ */

// SAML service providers and the CAS, OpenID Connect and OAuth 2.0 applications, as one list.
function searchApplications({ q, limit } = {}) {
  const text = clean(q);
  const all = [
    ...sps.listSps().map((s) => ({ id: s.id, protocol: 'saml', name: s.name, identifier: s.sp_entity_id, to: `/admin/sps/${s.id}` })),
    ...apps.listApps().map((a) => ({ id: a.id, protocol: a.protocol, name: a.name, identifier: a.client_id || '', to: `/admin/apps/${a.id}` })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return pageOf(all.filter((a) => matchesText(text, [a.name, a.identifier, a.protocol])), limit);
}

/* ------------------------------- Integrations ------------------------------ */

function searchIntegrations({ q, limit } = {}) {
  const text = clean(q);
  return pageOf(integrations.list().filter((i) => matchesText(text, [i.name, i.description])), limit);
}

/** The people matching an LDAP filter (not free text), as full records. A bad filter throws ldap-filter's LdapFilterError. */
function peopleMatchingFilter(filterText) {
  const test = ldapFilter.compile(String(filterText).trim(), personTests());
  return loadPeople().filter(test);
}

/** The LDAP attribute names a people filter understands, defined attributes included. */
const personAttributeNames = () => [...Object.keys(PERSON_ATTRIBUTES), ...attributeDefs.list().map((d) => d.name).filter((n) => !Object.hasOwn(PERSON_TESTS, n.toLowerCase()))];

module.exports = { peopleMatchingFilter, personAttributeNames, searchPeople, searchGroups, searchApplications, searchIntegrations };
