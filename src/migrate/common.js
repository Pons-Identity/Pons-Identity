const { parse } = require('csv-parse/sync');

// Shared by the importers: the shape every importer produces, and the readers for tables (CSV) and JSON.
//
// A bundle is what an importer found, in Pons Identity's own terms:
//   users:  { username, first_name, ..., active, groups: [name] }            (the USER_FIELDS of admin-data.js)
//   groups: { name, description, members: [username | dn], parents: [name] }  (parents: groups this one is nested in)
//   sps:    { name, entityId, acsUrls, sloUrl, nameidFormat, signingCert, encryptionCert, maps, signResponse, signAssertion, encrypt, nameidSource }
//   apps:   { protocol, name, description, redirectUris, postLogoutUris, grantTypes, confidential, clientId }
//   notes:  messages for the administrator (what could not be carried over, and what to do next)

const emptyBundle = () => ({ users: [], groups: [], sps: [], apps: [], notes: [] });

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const arr = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const flat = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

// Column names (any case, any punctuation) from the exports we know, to a user field.
const ALIASES = {
  username: ['username', 'login', 'samaccountname', 'userid', 'uid', 'accountname', 'useraccount'],
  upn: ['userprincipalname', 'upn'],
  first_name: ['firstname', 'givenname', 'first'],
  last_name: ['lastname', 'surname', 'familyname', 'sn', 'last'],
  display_name: ['displayname', 'fullname', 'name', 'cn'],
  email: ['email', 'mail', 'emailaddress', 'primaryemail', 'workemail'],
  employee_id: ['employeeid', 'employeenumber', 'employeeid2', 'staffid'],
  department: ['department', 'dept'],
  title: ['title', 'jobtitle'],
  phone: ['phone', 'primaryphone', 'telephonenumber', 'officephone', 'businessphones', 'workphone'],
  mobile: ['mobile', 'mobilephone', 'cellphone'],
  sam_account_name: ['samaccountname', 'onpremisessamaccountname'],
  distinguished_name: ['distinguishedname', 'dn', 'onpremisesdistinguishedname'],
  mail_nickname: ['mailnickname'],
  company: ['company', 'companyname', 'organization', 'organisation'],
  manager: ['manager', 'managerid'],
  office: ['office', 'officelocation', 'physicaldeliveryofficename'],
  street_address: ['streetaddress', 'street'],
  city: ['city', 'l', 'locality'],
  state: ['state', 'st', 'province', 'stateorprovince'],
  postal_code: ['postalcode', 'zipcode', 'zip'],
  country: ['country', 'countrycode', 'c', 'co'],
  description: ['description'],
  status: ['status', 'accountenabled', 'enabled', 'active'],
  groups: ['groups', 'memberof', 'groupnames'],
};
const FIELD_OF = new Map();
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) if (!FIELD_OF.has(n)) FIELD_OF.set(n, field);
// 'username' by login wins over sAMAccountName's second use as the account name.
FIELD_OF.set('samaccountname', 'sam_account_name');

/** A user row from any record whose keys are export column names. Returns null when it has nothing to identify the person by. */
function userFromRecord(rec, { usernameFrom = 'auto' } = {}) {
  const u = {};
  const raw = {};
  for (const [k, v] of Object.entries(rec)) {
    const f = FIELD_OF.get(flat(k));
    if (f && str(v) !== '' && raw[f] === undefined) raw[f] = Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : str(v);
  }
  Object.assign(u, raw);
  const sam = raw.sam_account_name || '';
  // The name people sign in with: the explicit login column, then the account name, then the principal name, then the email.
  const explicit = [...Object.keys(rec)].some((k) => ['username', 'login', 'userid', 'uid'].includes(flat(k)));
  u.username = (explicit ? raw.username : '') || sam || raw.upn || raw.email || raw.username || '';
  if (!u.username) return null;
  if (usernameFrom === 'local') u.username = u.username.split('@')[0];
  u.username = u.username.toLowerCase();
  if (!u.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.upn || '')) u.email = raw.upn;
  if (!u.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.username)) u.email = u.username;
  u.active = activeFrom(raw.status);
  u.groups = raw.groups ? raw.groups.split(/[;|]/).map((x) => x.trim()).filter(Boolean) : [];
  delete u.status;
  return u;
}

// Okta says ACTIVE, SUSPENDED, DEPROVISIONED; Entra and AD say true or false (or 1/0, "Enabled").
function activeFrom(v) {
  if (v === undefined || v === '') return true;
  const s = flat(v);
  if (['false', '0', 'no', 'disabled', 'suspended', 'deprovisioned', 'inactive', 'locked', 'lockedout'].includes(s)) return false;
  return true;
}

/** Rows of a CSV as objects keyed by the header row. */
function csvRecords(text) {
  const rows = parse(String(text), { skip_empty_lines: true, bom: true, relax_column_count: true, relax_quotes: true, trim: true });
  if (rows.length < 2) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

function jsonValue(text) {
  try { return JSON.parse(String(text).replace(/^﻿/, '')); } catch { return undefined; }
}

/** A JSON export's list of items: a bare array, or the array under value / users / groups / apps / items / data. */
function listOf(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const k of ['value', 'users', 'groups', 'apps', 'applications', 'items', 'data', 'results']) if (Array.isArray(json[k])) return json[k];
  }
  return [];
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

module.exports = { emptyBundle, userFromRecord, activeFrom, csvRecords, jsonValue, listOf, flat, str, arr, isEmail, FIELD_OF };
