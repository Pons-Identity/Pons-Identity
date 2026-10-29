const { immutableId } = require('./guid');
const db = require('./db');
const { resolveEdu } = require('./federation/edu-attributes');
const { effectiveGroupsOf } = require('./group-membership');

// IdP-side attributes an admin can map to an SP's SAML attribute names.
const BUILTIN = [
  { key: 'guid', label: 'GUID (objectGUID)' },
  { key: 'immutable_id', label: 'Immutable ID (base64 GUID)' },
  { key: 'username', label: 'Username' },
  { key: 'email', label: 'Email address' },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'display_name', label: 'Display name' },
  { key: 'employee_id', label: 'Employee / ID number' },
  { key: 'department', label: 'Department' },
  { key: 'title', label: 'Title' },
  { key: 'phone', label: 'Phone' },
  // Active Directory attributes (LDAP name in parentheses)
  { key: 'upn', label: 'User principal name (userPrincipalName)' },
  { key: 'sam_account_name', label: 'sAMAccountName' },
  { key: 'distinguished_name', label: 'Distinguished name (distinguishedName)' },
  { key: 'mail_nickname', label: 'Mail nickname (mailNickname)' },
  { key: 'company', label: 'Company (company)' },
  { key: 'manager', label: 'Manager (manager)' },
  { key: 'office', label: 'Office (physicalDeliveryOfficeName)' },
  { key: 'mobile', label: 'Mobile (mobile)' },
  { key: 'street_address', label: 'Street address (streetAddress)' },
  { key: 'city', label: 'City (l)' },
  { key: 'state', label: 'State / province (st)' },
  { key: 'postal_code', label: 'Postal code (postalCode)' },
  { key: 'country', label: 'Country (c)' },
  { key: 'description', label: 'Description (description)' },
  { key: 'groups', label: 'Group names (multi-valued)' },
  { key: 'grouper_groups', label: 'Grouper group names (multi-valued)' },
  // Federation attributes, computed from the federation settings (scope, affiliation mapping) and the SP served.
  { key: 'eduperson_principal_name', label: 'eduPersonPrincipalName (user@scope)' },
  { key: 'eduperson_affiliation', label: 'eduPersonAffiliation (multi-valued)' },
  { key: 'eduperson_scoped_affiliation', label: 'eduPersonScopedAffiliation (multi-valued)' },
  { key: 'eduperson_targeted_id', label: 'eduPersonTargetedID (per service provider)' },
  { key: 'persistent_id', label: 'Persistent identifier (per service provider)' },
  { key: 'pairwise_id', label: 'pairwise-id (per service provider)' },
  { key: 'subject_id', label: 'subject-id' },
  { key: 'schac_home_organization', label: 'schacHomeOrganization' },
];

const MULTI_VALUED = new Set(['groups', 'grouper_groups', 'eduperson_affiliation', 'eduperson_scoped_affiliation']);

function listAttributes() {
  const custom = db.all('SELECT name FROM user_attributes UNION SELECT name FROM attribute_defs ORDER BY name')
    .map((r) => ({ key: `custom:${r.name}`, label: `Custom: ${r.name}` }));
  return [...BUILTIN, ...custom];
}

// NameID sources exclude multi-valued attributes.
function listNameIdSources() {
  return listAttributes().filter((a) => !MULTI_VALUED.has(a.key));
}

function userGroups(userId) {
  return effectiveGroupsOf(userId);
}

function userCustom(userId) {
  return Object.fromEntries(db.all('SELECT name, value FROM user_attributes WHERE user_id = ?', userId)
    .map((r) => [r.name, r.value]));
}

// Returns an array of string values (possibly empty).
function resolve(user, key, ctx) {
  if (key === 'groups') return ctx.groups.map((g) => g.name);
  if (key === 'grouper_groups') return ctx.groups.filter((g) => g.source === 'grouper').map((g) => g.name);
  const edu = resolveEdu(user, key, ctx);
  if (edu) return edu;
  if (key === 'immutable_id') return [immutableId(user.guid)];
  if (key.startsWith('custom:')) {
    const v = ctx.custom[key.slice(7)];
    return v ? [v] : [];
  }
  const v = user[key];
  return v === undefined || v === null || v === '' ? [] : [String(v)];
}

// Like resolve, but only for attributes listed in the picker, so a rule cannot read e.g. password_hash.
const KNOWN = new Set(BUILTIN.map((a) => a.key));
function resolveKnown(user, key, ctx) {
  return KNOWN.has(key) || key.startsWith('custom:') ? resolve(user, key, ctx) : [];
}

module.exports = { resolveKnown, listAttributes, listNameIdSources, userGroups, userCustom, resolve, MULTI_VALUED };
