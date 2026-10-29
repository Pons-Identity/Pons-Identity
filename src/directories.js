const crypto = require('crypto');
const auditLog = require('./audit');
const db = require('./db');
const ldap = require('./ldap');
const { USER_FIELDS } = require('./admin-data');
const { newGuid } = require('./guid');

// External directories. A directory can do either or both of:
//   * federate sign-in: users authenticate by binding to its LDAP / Active Directory server, and are
//     created here on first sign-in (just in time) or by the REST API;
//   * update identities: an external system calls the REST API (directory-api.js) with the directory's
//     bearer token to create, change and remove the users that directory owns.
// A user belongs to at most one directory (users.directory_id). Local accounts, and every account a
// directory does not own, are out of its reach.

const TYPES = ['ldap', 'ad'];

const DEFAULT_FILTER = {
  ad: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))',
  ldap: '(&(objectClass=inetOrgPerson)(uid={username}))',
};

const DEFAULT_ATTRIBUTE_MAP = {
  ad: {
    username: 'sAMAccountName', first_name: 'givenName', last_name: 'sn', display_name: 'displayName', email: 'mail',
    employee_id: 'employeeID', department: 'department', title: 'title', phone: 'telephoneNumber',
    upn: 'userPrincipalName', sam_account_name: 'sAMAccountName', distinguished_name: 'distinguishedName',
    mail_nickname: 'mailNickname', company: 'company', manager: 'manager', office: 'physicalDeliveryOfficeName',
    mobile: 'mobile', street_address: 'streetAddress', city: 'l', state: 'st', postal_code: 'postalCode',
    country: 'c', description: 'description',
  },
  ldap: {
    username: 'uid', first_name: 'givenName', last_name: 'sn', display_name: 'displayName', email: 'mail',
    employee_id: 'employeeNumber', department: 'departmentNumber', title: 'title', phone: 'telephoneNumber',
    mobile: 'mobile', office: 'roomNumber', street_address: 'street', city: 'l', state: 'st',
    postal_code: 'postalCode', country: 'c', description: 'description',
  },
};

const CONFIG_DEFAULTS = {
  url: '', startTls: false, rejectUnauthorized: true, caCertificate: '', bindDn: '', bindPassword: '', baseDn: '',
  userFilter: '', attributeMap: {}, groupAttribute: '', autoProvision: true, timeoutSeconds: 10, scriptAccess: 'off',
};

// What integration scripts may do with the directory (directory:read / directory:write scopes still apply on top).
const SCRIPT_ACCESS = ['off', 'read', 'write'];

const defaultConfig = (type) => ({
  ...CONFIG_DEFAULTS, userFilter: DEFAULT_FILTER[type], attributeMap: { ...DEFAULT_ATTRIBUTE_MAP[type] },
  groupAttribute: type === 'ad' ? 'memberOf' : '',
});

/* ------------------------------ Reading rows ------------------------------- */

function hydrate(row) {
  if (!row) return null;
  let saved = {};
  try { saved = JSON.parse(row.config); } catch { /* fall back to defaults */ }
  return { ...row, enabled: Boolean(row.enabled), config: { ...defaultConfig(row.type), ...saved } };
}

const get = (id) => hydrate(db.get('SELECT * FROM directories WHERE id = ?', Number(id) || 0));
const list = () => db.all('SELECT * FROM directories ORDER BY name').map(hydrate);
const usesLdap = (dir) => Boolean(dir.config.url);

/** The console's view of a directory. The bind password and token hash are never included. */
function view(dir) {
  const { bindPassword, ...config } = dir.config;
  return {
    id: dir.id,
    name: dir.name,
    type: dir.type,
    enabled: dir.enabled,
    config: { ...config, bindPasswordSet: Boolean(bindPassword) },
    tokenSet: Boolean(dir.token_hash),
    tokenCreatedAt: dir.token_created_at,
    lastActivity: { at: dir.last_activity_at, summary: dir.last_activity },
    userCount: db.get('SELECT COUNT(*) AS n FROM users WHERE directory_id = ?', dir.id).n,
    groupCount: db.get('SELECT COUNT(*) AS n FROM groups WHERE directory_id = ?', dir.id).n,
  };
}

const recordActivity = (id, summary) => db.run(
  'UPDATE directories SET last_activity_at = ?, last_activity = ? WHERE id = ?', new Date().toISOString(), summary, id);

/* ------------------------------ Validating input --------------------------- */

const LDAP_NAME = /^[A-Za-z][A-Za-z0-9-]*(;[A-Za-z0-9-]+)*$|^dn$/i;

/**
 * Validate a submitted directory. `existing` supplies the bind password when the form leaves it blank.
 * Returns { data: { name, type, enabled, config }, errors }.
 */
function parse(body, existing = null) {
  const errors = [];
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const name = text(body.name);
  const type = TYPES.includes(body.type) ? body.type : (existing ? existing.type : 'ldap');
  const c = body.config && typeof body.config === 'object' ? body.config : {};

  if (!name) errors.push('Name is required.');
  else if (name.length > 80) errors.push('Name must be 80 characters or fewer.');
  else if (db.get('SELECT 1 FROM directories WHERE name = ? AND id != ?', name, existing ? existing.id : 0)) {
    errors.push('Another directory already has that name.');
  }

  const config = {
    url: text(c.url),
    startTls: Boolean(c.startTls),
    rejectUnauthorized: c.rejectUnauthorized !== false,
    caCertificate: text(c.caCertificate),
    bindDn: text(c.bindDn),
    bindPassword: typeof c.bindPassword === 'string' && c.bindPassword !== ''
      ? c.bindPassword : (existing ? existing.config.bindPassword : ''),
    baseDn: text(c.baseDn),
    userFilter: text(c.userFilter),
    attributeMap: {},
    groupAttribute: text(c.groupAttribute),
    autoProvision: c.autoProvision !== false,
    timeoutSeconds: Number.isInteger(Number(c.timeoutSeconds)) ? Number(c.timeoutSeconds) : 10,
    scriptAccess: SCRIPT_ACCESS.includes(c.scriptAccess) ? c.scriptAccess : (existing && existing.config.scriptAccess) || 'off',
  };

  // LDAP sign-in is optional: a directory with no URL is a REST-only source of identities.
  if (config.url) {
    let url = null;
    try { url = new URL(config.url); } catch { /* reported below */ }
    if (!url || !['ldap:', 'ldaps:'].includes(url.protocol) || !url.hostname || url.pathname.length > 1 || url.search) {
      errors.push('Server URL must look like ldaps://dc.example.com:636 or ldap://dc.example.com:389.');
    } else if (url.protocol === 'ldap:' && !config.startTls) {
      errors.push('Passwords would be sent unencrypted. Use an ldaps:// URL, or keep ldap:// and turn on StartTLS.');
    }
    if (!config.baseDn) errors.push('Search base DN is required.');
    if (!config.userFilter) errors.push('User search filter is required.');
    else if (!config.userFilter.includes('{username}')) errors.push('User search filter must contain {username}.');
    else if (!/^\(.*\)$/.test(config.userFilter)) errors.push('User search filter must be wrapped in parentheses.');
    if (config.bindDn && !config.bindPassword) errors.push('A service account password is required with a bind DN.');
    if (config.scriptAccess === 'write' && !config.bindDn) errors.push('Scripts can change the directory only through a service account. Enter a bind DN, or choose read-only script access.');
    if (config.timeoutSeconds < 1 || config.timeoutSeconds > 60) errors.push('Timeout must be between 1 and 60 seconds.');
    if (config.caCertificate && !/-----BEGIN CERTIFICATE-----/.test(config.caCertificate)) {
      errors.push('The CA certificate must be in PEM format.');
    }
    if (config.groupAttribute && !LDAP_NAME.test(config.groupAttribute)) errors.push('Group attribute is not a valid LDAP attribute name.');

    const submitted = c.attributeMap && typeof c.attributeMap === 'object' ? c.attributeMap : defaultConfig(type).attributeMap;
    for (const field of USER_FIELDS) {
      const attr = text(submitted[field]);
      if (!attr) continue;
      if (!LDAP_NAME.test(attr)) errors.push(`"${attr}" is not a valid LDAP attribute name (for ${field}).`);
      else config.attributeMap[field] = attr;
    }
    if (!config.attributeMap.username) errors.push('An LDAP attribute must be mapped to the username.');
  } else {
    config.userFilter = defaultConfig(type).userFilter;
    config.attributeMap = defaultConfig(type).attributeMap;
  }

  return { data: { name, type, enabled: Boolean(body.enabled), config }, errors };
}

/* ------------------------------ Writing identities ------------------------- */

const SYNC_FIELDS = USER_FIELDS.filter((f) => f !== 'username');

/**
 * Create or update one of a directory's users from attribute values (any subset of USER_FIELDS plus
 * `active` and `external_id`), then replace its attributes and group memberships when supplied.
 * `user` is the existing row, or null to create. Throws on a username that another account holds.
 */
function writeUser(dir, user, values, { custom, groups, skipConflicts } = {}) {
  const clash = (username, exceptId) => db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', username, exceptId || 0);
  if (values.username !== undefined && clash(values.username, user && user.id)) {
    throw Object.assign(new Error(`The username "${values.username}" is already in use.`), { status: 409 });
  }
  if (values.external_id && db.get('SELECT 1 FROM users WHERE directory_id = ? AND external_id = ? AND id != ?',
    dir.id, values.external_id, user ? user.id : 0)) {
    throw Object.assign(new Error(`external_id "${values.external_id}" is already in use.`), { status: 409 });
  }

  const cols = [...USER_FIELDS, 'external_id', 'active'].filter((f) => values[f] !== undefined);
  let id;
  if (user) {
    if (cols.length) db.run(`UPDATE users SET ${cols.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...cols.map((f) => values[f]), user.id);
    if (values.password_hash !== undefined) db.run('UPDATE users SET password_hash = ? WHERE id = ?', values.password_hash, user.id);
    id = user.id;
  } else {
    const all = ['guid', 'directory_id', 'password_hash', ...cols];
    id = Number(db.run(`INSERT INTO users (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`,
      newGuid(), dir.id, values.password_hash || '', ...cols.map((f) => values[f])).lastInsertRowid);
  }
  if (custom) {
    db.run('DELETE FROM user_attributes WHERE user_id = ?', id);
    for (const [k, v] of Object.entries(custom)) db.run('INSERT INTO user_attributes (user_id, name, value) VALUES (?,?,?)', id, k, v);
  }
  if (groups) setGroups(dir, id, groups, { skipConflicts });
  return db.get('SELECT * FROM users WHERE id = ?', id);
}

/** Make the user a member of exactly these directory groups (by name). Other groups are not touched.
 *  With skipConflicts, a name held by a group this directory does not manage is ignored instead of refused. */
function setGroups(dir, userId, names, { skipConflicts = false } = {}) {
  db.run('DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT id FROM groups WHERE directory_id = ?)', userId, dir.id);
  for (const name of names) {
    let g = db.get('SELECT * FROM groups WHERE name = ?', name);
    if (!g) {
      const r = db.run("INSERT INTO groups (name, description, source, directory_id) VALUES (?, '', 'directory', ?)", name, dir.id);
      g = { id: Number(r.lastInsertRowid) };
    } else if (g.directory_id !== dir.id) {
      if (skipConflicts) continue;
      throw Object.assign(new Error(`A group named "${name}" already exists and is not managed by this directory.`), { status: 409 });
    }
    db.run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', g.id, userId);
  }
}

/* ------------------------------ Federated sign-in -------------------------- */

const ldapDirectories = () => list().filter((d) => d.enabled && usesLdap(d));

/** Copy a sign-in result onto the user record: directory-supplied fields only, never roles or `active`. */
function applySignIn(dir, user, found) {
  const values = { ...found.attributes };
  for (const f of SYNC_FIELDS) if (!values[f] && !dir.config.attributeMap[f]) delete values[f];
  if (!values.username) delete values.username;
  const groups = dir.config.groupAttribute ? found.groups : undefined;
  return db.tx(() => writeUser(dir, user, values, { groups, skipConflicts: true }));
}

/**
 * Check a sign-in against the directories.
 * - A user already owned by an LDAP directory authenticates there only (a disabled directory fails closed).
 * - A user with no local record may be created from a directory that has autoProvision on.
 * - Any other existing account uses its local password, which the caller checks.
 * Resolves to { user } on success, { rejected: true } on a wrong password or an unusable account, or
 * null when the caller should use the local password. Throws ldap.DirectoryError if a directory is down.
 */
async function signIn(existing, username, password) {
  if (existing) {
    if (!existing.directory_id) return null;
    const dir = get(existing.directory_id);
    if (!dir || !usesLdap(dir)) return null; // REST-only directory: local password, if it has one
    if (!dir.enabled) return { rejected: true };
    const found = await ldap.authenticate(dir.config, existing.username, password);
    if (!found) return { rejected: true };
    try {
      return { user: applySignIn(dir, existing, found) };
    } catch (e) {
      if (e.status === 409) return { rejected: true };
      throw e;
    }
  }

  let down = null;
  for (const dir of ldapDirectories()) {
    if (!dir.config.autoProvision) continue;
    let found;
    try {
      found = await ldap.authenticate(dir.config, username, password);
    } catch (e) {
      if (!(e instanceof ldap.DirectoryError)) throw e;
      down = down || e;
      continue;
    }
    if (!found) continue;
    if (!found.attributes.username) return { rejected: true };
    try {
      const user = applySignIn(dir, null, { ...found, attributes: { ...found.attributes, active: 1 } });
      recordActivity(dir.id, `Created ${user.username} at first sign-in`);
      auditLog.user('user.auto_provision', { actor: { type: 'user', id: user.id, name: user.username }, target: { type: 'directory', id: dir.id, name: dir.name } });
      return { user };
    } catch (e) {
      if (e.status === 409) return { rejected: true }; // the name belongs to another account
      throw e;
    }
  }
  if (down) throw down;
  return null;
}

module.exports = {
  TYPES, SCRIPT_ACCESS, DEFAULT_FILTER, DEFAULT_ATTRIBUTE_MAP, defaultConfig, get, list, usesLdap, view, parse, recordActivity,
  writeUser, setGroups, signIn,
  newToken: () => {
    const token = `dpt_${crypto.randomBytes(32).toString('base64url')}`;
    return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
  },
};
