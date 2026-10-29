const crypto = require('crypto');
const { parse: parseCsv } = require('csv-parse/sync');
const db = require('../db');
const roles = require('../roles');
const policies = require('../policies');
const bulkUsers = require('../bulk-users');
const userService = require('../user-service');
const attributeDefs = require('../attribute-defs');
const messaging = require('../messaging');
const auditLog = require('../audit');
const gm = require('../group-membership');
const { audit: groupAudit } = require('../group-audit');
const { safeRequest } = require('../safe-fetch');
const { USER_FIELDS } = require('../admin-data');
const { GUID_RE } = require('../guid');
const { resource } = require('../user-api');
const reportFunctions = require('../reports/functions');
const files = require('../files/store');
const compromise = require('../compromise');
const identity = require('../identity');
const sftp = require('./sftp');
const directories = require('../directories');
const dirSessions = require('../directory-sessions');
const dirUsers = require('../directory-users');
const { DirectoryError } = require('../ldap');

// What a script can ask the server to do. The script runs in a worker that has no access to the database, the network or
// the file system; everything below is the whole of its reach, and each function names the scope an integration must have
// been given. Like the user API, a script can touch only ordinary local accounts: never an administrator, never a user an
// external directory owns, and it cannot grant roles.

const SCOPES = {
  'users:read': 'Look up and search users',
  'users:write': 'Create, change, deactivate and delete ordinary users',
  'groups:read': 'List groups and their members',
  'groups:write': 'Add and remove members of local groups',
  http: 'Call outside web services (public addresses only)',
  files: 'Read and write files in its own folder and in the directories granted to it (see Files and SFTP)',
  'directory:read': 'Connect to an external directory (LDAP / Active Directory) and look people up',
  'directory:write': 'Create, change and delete people in an external directory that allows scripts to change it',
  sftp: 'Fetch and send files on other systems over SFTP (public addresses only)',
  messaging: 'Send email and text messages',
  identity: 'Start and check identity verifications for self-service resets (Settings → Identity verification)',
};

// Limits per run, so a loop in a script cannot flood the database, an outside service or someone's phone.
const LIMITS = { calls: 2000, sftp: 20, directory: 200, http: 50, messages: 25, sleepMs: 10000, csvChars: 1024 * 1024, httpBytes: 1024 * 1024 };

class ScriptError extends Error {}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
function require_(cond, message) { if (!cond) throw new ScriptError(message); }

/* ---------------------------------- Users ---------------------------------- */

// A user named by GUID or username.
function userOf(ref) {
  const r = text(typeof ref === 'object' && ref ? ref.id || ref.username : ref);
  require_(r, 'Name the user by id or username.');
  const u = GUID_RE.test(r) ? db.get('SELECT * FROM users WHERE guid = ?', r) : db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', r);
  require_(u, `No such user: ${r}.`);
  return u;
}

function writable(u) {
  require_(!u.directory_id, `${u.username} is managed by an external directory.`);
  require_(!roles.permissionsOf(u.id).size, `${u.username} has administrative access and cannot be changed by a script.`);
}

const byActor = (ctx) => ({ type: 'integration', id: ctx.integration.id, name: `integration:${ctx.integration.name}` });

/* ------------------------------ Identity verification ------------------------------ */

// Scripts start and check the verification the administrator configured under Settings → Identity verification. They always use the
// configured provider (Persona or the REST service), never the verification integration itself, so a script cannot run its own gate.
const identityStart = async (ctx, who, purpose) => {
  const r = await identity.start(userOf(who), purpose || 'password_reset', { actor: byActor(ctx), builtinOnly: true });
  require_(!r.error, r.error);
  return r.verification;
};
const identityLatest = async (ctx, who, purpose) => identity.current(userOf(who).id, purpose || 'password_reset', { builtinOnly: true });
const identityStatus = async (ctx, id) => {
  const row = db.get('SELECT * FROM identity_verifications WHERE id = ?', Number(id));
  require_(row, 'No such verification.');
  const r = await identity.refresh(row, { builtinOnly: true });
  require_(!r.error, r.error);
  return identity.view(r);
};
const userTarget = (u) => ({ type: 'user', id: u.id, name: u.username });
const withoutLocation = (u) => { const { location: _l, ...rest } = resource(u); return rest; };

function findUser(ctx, q) {
  require_(isObject(q), 'users.find takes an object such as { username: "sam" } or { email: "sam@example.net" }.');
  let u = null;
  if (q.id) u = db.get('SELECT * FROM users WHERE guid = ?', text(q.id));
  else if (q.username) u = db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', text(q.username));
  else if (q.email) {
    const e = text(q.email);
    u = db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE OR id IN (SELECT user_id FROM user_emails WHERE email = ? COLLATE NOCASE) LIMIT 1', e, e);
  } else if (q.employee_id) u = db.get('SELECT * FROM users WHERE employee_id = ? AND employee_id != \'\' LIMIT 1', text(q.employee_id));
  else throw new ScriptError('users.find needs one of id, username, email or employee_id.');
  return u ? withoutLocation(u) : null;
}

function searchUsers(ctx, q = {}) {
  const term = text(isObject(q) ? q.q : q);
  const limit = Math.min(Math.max(Number(isObject(q) ? q.limit : 0) || 50, 1), 200);
  const where = term ? 'WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?' : '';
  const params = term ? Array(3).fill(`%${term.replace(/[%_]/g, '')}%`) : [];
  return db.all(`SELECT * FROM users ${where} ORDER BY username LIMIT ?`, ...params, limit).map(withoutLocation);
}

const CREATE_KEYS = new Set([...bulkUsers.COLUMNS, 'generate_password']);

async function createUser(ctx, spec) {
  require_(isObject(spec), 'users.create takes an object such as { username: "sam", email: "sam@example.net", generate_password: true }.');
  const unknown = Object.keys(spec).filter((k) => !CREATE_KEYS.has(k));
  require_(!unknown.length, `Unknown field: ${unknown.join(', ')}.`);
  const { generate_password: generate, ...row } = spec;
  const [r] = await bulkUsers.prepare([row], { canGroups: true, generatePasswords: generate === true });
  if (r.status === 'error') throw new ScriptError(r.errors.join(' '));
  bulkUsers.commit([r], { by: null, onError: 'skip', via: 'api' });
  require_(r.status === 'created', 'The user could not be saved.');
  auditLog.admin('user.create', { actor: byActor(ctx), target: { type: 'user', id: r.id, name: r.username }, detail: { active: r.spec.active, mfa_required: r.spec.mfa_enabled, via: 'integration' } });
  return { ...withoutLocation(db.get('SELECT * FROM users WHERE id = ?', r.id)), ...(r.generated ? { generated_password: r.generated } : {}) };
}

const UPDATE_KEYS = new Set([...USER_FIELDS, 'personal_email', 'password', 'emails', 'active', 'mfa_required', 'attributes']);

async function updateUser(ctx, ref, patch) {
  const u = userOf(ref);
  writable(u);
  require_(isObject(patch), 'users.update takes the user and an object of the fields to change.');
  const unknown = Object.keys(patch).filter((k) => !UPDATE_KEYS.has(k));
  const errors = unknown.map((k) => `Unknown field: ${k}.`);

  const set = {};
  for (const f of [...USER_FIELDS, 'personal_email']) {
    if (patch[f] === undefined) continue;
    if (typeof patch[f] !== 'string') { errors.push(`${f} must be a string.`); continue; }
    set[f] = patch[f].trim();
  }
  if (set.username !== undefined) {
    if (!set.username) errors.push('Username cannot be empty.');
    else if (db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', set.username, u.id)) errors.push('That username already exists.');
  }
  for (const k of ['active', 'mfa_required']) if (patch[k] !== undefined && typeof patch[k] !== 'boolean') errors.push(`${k} must be true or false.`);
  if (set.personal_email !== undefined) {
    const bad = userService.personalEmailError(u.id, set.personal_email);
    if (bad) errors.push(bad);
  }
  let emails = null;
  if (patch.emails !== undefined || set.email !== undefined) {
    const r = userService.readEmails(patch.emails !== undefined ? { emails: patch.emails } : {}, set.email !== undefined ? set.email : u.email, u.id);
    errors.push(...r.errors);
    emails = r.emails;
  }
  const defined = {}; const free = {};
  if (patch.attributes !== undefined) {
    if (!isObject(patch.attributes)) errors.push('attributes must be an object.');
    else {
      const defs = new Set(attributeDefs.list().map((d) => d.name));
      for (const [k, v] of Object.entries(patch.attributes)) {
        if (defs.has(k)) defined[k] = v;
        else if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(k)) errors.push(`Attribute name "${k}" is not valid.`);
        else free[k] = v === null ? '' : String(v).replace(/[\r\n]+/g, ' ').trim();
      }
    }
  }
  const attrs = attributeDefs.resolve(defined, { isNew: false });
  errors.push(...attrs.errors);
  if (patch.password !== undefined) {
    if (typeof patch.password !== 'string') errors.push('password must be a string.');
    else errors.push(...await policies.passwordErrors(u.id, patch.password));
  }
  require_(!errors.length, [...new Set(errors)].join(' '));

  db.tx(() => {
    if (set.personal_email !== undefined) userService.setPersonalEmail(u.id, set.personal_email, { verified: true });
    const cols = Object.keys(set).filter((k) => k !== 'email' && k !== 'personal_email').map((k) => [k, set[k]]);
    if (patch.active !== undefined) cols.push(['active', patch.active ? 1 : 0]);
    if (patch.mfa_required !== undefined) cols.push(['mfa_enabled', patch.mfa_required ? 1 : 0]);
    if (cols.length) db.run(`UPDATE users SET ${cols.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map(([, v]) => v), u.id);
    if (emails) userService.saveEmails(u.id, emails);
    for (const [k, v] of Object.entries({ ...attrs.values, ...free })) {
      if (v) db.run('INSERT OR REPLACE INTO user_attributes (user_id, name, value) VALUES (?,?,?)', u.id, k, v);
      else db.run('DELETE FROM user_attributes WHERE user_id = ? AND name = ?', u.id, k);
    }
    if (patch.password !== undefined) userService.setPassword(u.id, patch.password, { by: null, via: 'api' });
  });
  if (patch.password !== undefined || patch.active === false) userService.revokeSessions(u.id);
  const changed = [...Object.keys(set), ...(patch.emails ? ['emails'] : []), ...(patch.attributes ? ['attributes'] : []), ...['active', 'mfa_required'].filter((k) => patch[k] !== undefined)];
  auditLog.admin('user.update', { actor: byActor(ctx), target: { type: 'user', id: u.id, name: set.username || u.username }, detail: { changed, via: 'integration' } });
  if (patch.password !== undefined) auditLog.admin('user.password_reset', { actor: byActor(ctx), target: userTarget(u), detail: { via: 'integration' } });
  return withoutLocation(db.get('SELECT * FROM users WHERE id = ?', u.id));
}

function deleteUser(ctx, ref) {
  const u = userOf(ref);
  writable(u);
  userService.revokeSessions(u.id);
  db.run('DELETE FROM users WHERE id = ?', u.id);
  auditLog.admin('user.delete', { actor: byActor(ctx), target: userTarget(u), detail: { via: 'integration' } });
  return true;
}

// Signs a person out of every browser and ends their OAuth and OpenID Connect tokens, so nothing issued before stays usable.
function endSessions(ctx, ref) {
  const u = userOf(ref);
  writable(u);
  userService.revokeSessions(u.id);
  const tokens = db.run('DELETE FROM app_grants WHERE user_id = ?', u.id).changes;
  auditLog.admin('user.sessions_end', { actor: byActor(ctx), target: userTarget(u), detail: { ended: tokens, via: 'integration' } });
  return { browsers: true, tokens };
}

// Removes every sign-in method a person has, so they set them up again at their next sign-in (the lockdown's "remove sign-in methods").
function resetAuthenticators(ctx, ref) {
  const u = userOf(ref);
  writable(u);
  const removed = compromise.resetAuthenticators(u.id);
  auditLog.admin('user.factor_reset', { actor: byActor(ctx), target: userTarget(u), detail: { factor: 'all', removed, via: 'integration' } });
  return { removed };
}

// Makes every browser the person has remembered ask for a second factor again.
function forgetRemembered(ctx, ref) {
  const u = userOf(ref);
  writable(u);
  const browsers = compromise.forgetRemembered(u.id);
  auditLog.admin('mfa.remember_cleared', { actor: byActor(ctx), target: userTarget(u), detail: { browsers, via: 'integration' } });
  return { browsers };
}

// The lockdown procedure that applies to a person: which steps to run, the networks sign-in must match, and the policies it came from.
function lockdownPlan(ctx, ref) {
  const u = userOf(ref);
  const plan = compromise.effectiveFor(u.id);
  return { ...plan.steps, groups: plan.groups.map((g) => g.name), networks: plan.networks, sources: plan.sources };
}

// Records a lockdown for a person: the networks their sign-in must come from, and whether to turn the account off. Sign-in from
// anywhere else is refused until an administrator ends the lockdown. Signs them out too.
function restrictSignIn(ctx, ref, o) {
  const u = userOf(ref);
  writable(u);
  require_(isObject(o), 'compromise.restrict takes the user and { networks, lock }, such as { networks: [["10.0.0.0/8"]], lock: true }.');
  require_(o.networks === undefined || Array.isArray(o.networks), 'networks must be a list of lists of addresses or networks.');
  require_(o.lock === undefined || typeof o.lock === 'boolean', 'lock must be true or false.');
  const lists = (o.networks || []).map((list) => {
    require_(Array.isArray(list), 'networks must be a list of lists of addresses or networks.');
    const parsed = compromise.parseNetworks(list.join('\n'));
    require_(!parsed.errors.length, parsed.errors.join(' '));
    return parsed.networks;
  });
  const lockdown = compromise.restrict(u.id, { networks: lists, lock: o.lock === true });
  auditLog.admin('user.lockdown_restrict', { actor: byActor(ctx), target: userTarget(u), detail: { networks: lists.length, locked_account: lockdown.locked_account, via: 'integration' } });
  return lockdown;
}

// first initial + last name, lower case, letters and digits only, with a number added until it is free.
function suggestUsername(ctx, first, last) {
  const clean = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = (clean(first).slice(0, 1) + clean(last)).slice(0, 40) || clean(first) || 'user';
  let name = base;
  for (let n = 2; db.get('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE', name); n++) name = `${base}${n}`;
  return name;
}

/* --------------------------------- Groups ---------------------------------- */

// A group is named by its name, by its ID number (as a number or digits), or by a Group object. A name wins over an ID number.
const groupOf = (ref) => {
  const r = text(typeof ref === 'object' && ref ? (ref.id ?? ref.name) : ref);
  let g = db.get('SELECT * FROM groups WHERE name = ? COLLATE NOCASE', r);
  if (!g && /^\d+$/.test(r)) g = db.get('SELECT * FROM groups WHERE id = ?', Number(r));
  require_(g, `No such group: ${r}.`);
  return g;
};

const groupView = (g) => ({ id: g.id, name: g.name, description: g.description, source: g.source });

function localGroup(name) {
  const g = groupOf(name);
  require_(g.source === 'local', `${g.name} is managed outside the console (${g.source}) and cannot be changed by a script.`);
  return g;
}

function groupMembers(ctx, name) {
  const g = groupOf(name);
  const ids = gm.effectiveMembers(g.id);
  return db.all('SELECT id, guid, username FROM users ORDER BY username').filter((u) => ids.has(u.id)).map((u) => ({ id: u.guid, username: u.username }));
}

function addMember(ctx, group, ref) {
  const g = localGroup(group);
  const u = userOf(ref);
  const changed = gm.addDirect(g.id, u.id);
  if (changed) groupAudit('', g, 'member.add', u.username, byActor(ctx));
  return changed;
}

function removeMember(ctx, group, ref) {
  const g = localGroup(group);
  const u = userOf(ref);
  const changed = db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', g.id, u.id).changes > 0;
  if (changed) groupAudit('', g, 'member.remove', u.username, byActor(ctx));
  return changed;
}

/* ------------------------------ Outside services --------------------------- */

function count(ctx, key, label) {
  ctx.used[key] = (ctx.used[key] || 0) + 1;
  require_(ctx.used[key] <= LIMITS[key], `A script may make at most ${LIMITS[key]} ${label} per run.`);
}

const HEADER_RE = /^[A-Za-z0-9-]+$/;

async function httpRequest(ctx, o) {
  require_(isObject(o), 'http.request takes an object such as { url, method, headers, body }.');
  count(ctx, 'http', 'web requests');
  const method = text(o.method || 'GET').toUpperCase();
  require_(/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method), 'The method must be GET, POST, PUT, PATCH, DELETE or HEAD.');
  const headers = {};
  for (const [k, v] of Object.entries(isObject(o.headers) ? o.headers : {})) {
    require_(HEADER_RE.test(k), `"${k}" is not a valid header name.`);
    headers[k] = String(v);
  }
  let body;
  if (o.body !== undefined && o.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof o.body === 'string') body = o.body;
    else { body = JSON.stringify(o.body); if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'; }
  }
  let r;
  try {
    r = await safeRequest(o.url, { method, headers, body, timeoutMs: Math.min(Number(o.timeoutMs) || 10000, 30000), maxBytes: LIMITS.httpBytes });
  } catch (e) {
    throw new ScriptError(`Request to ${String(o.url).slice(0, 200)} failed: ${e.cause?.code || e.message}`);
  }
  return r;
}

async function sendMessage(ctx, channel, o) {
  require_(isObject(o), `${channel}.send takes an object with to and text.`);
  count(ctx, 'messages', 'messages');
  const to = text(o.to);
  const body = typeof o.text === 'string' ? o.text : '';
  require_(body, 'The message needs text.');
  try {
    await messaging.send(channel, to, { subject: text(o.subject) || 'Message', text: body });
  } catch (e) {
    throw new ScriptError(e.message);
  }
  auditLog.admin('integration.message', { actor: byActor(ctx), target: { type: 'integration', id: ctx.integration.id, name: ctx.integration.name }, detail: { channel } });
  return true;
}

/* ---------------------------------- Helpers -------------------------------- */

const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomPassword = (ctx, n = 16) => Array.from({ length: Math.min(Math.max(Number(n) || 16, 8), 128) }, () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]).join('');

function csv(ctx, input, o) {
  o = isObject(o) ? o : {};
  const s = String(input ?? '');
  require_(s.length <= LIMITS.csvChars, 'The CSV is too large.');
  try {
    return parseCsv(s, { columns: o.header === false ? false : true, skip_empty_lines: true, bom: true, trim: true, relax_column_count: true });
  } catch (e) {
    throw new ScriptError(`The CSV could not be read: ${e.message}`);
  }
}

// A cell that starts with = + - @ would run as a formula when the file is opened in a spreadsheet, so it gets a leading quote
// unless the script asks for the raw value.
function csvStringify(ctx, rows, o) {
  o = isObject(o) ? o : {};
  require_(Array.isArray(rows), 'csv.stringify takes a list of rows: objects, or lists of values.');
  const objects = rows.length > 0 && rows.every(isObject);
  const columns = Array.isArray(o.columns) ? o.columns.map(String) : objects ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : null;
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (o.safe !== false && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  if (columns && o.header !== false) lines.push(columns.map(cell).join(','));
  for (const r of rows) lines.push((columns && objects ? columns.map((c) => r[c]) : Array.isArray(r) ? r : [r]).map(cell).join(','));
  const out = `${lines.join('\n')}\n`;
  require_(out.length <= LIMITS.csvChars * 10, 'The CSV is too large.');
  return out;
}

/* ----------------------------------- Files --------------------------------- */

const bytesOf = (content, encoding) => {
  require_(typeof content === 'string', 'The content must be a string (use encoding: "base64" for binary data).');
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
};
const textOf = (buf, encoding) => (encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8'));
const fileActor = (ctx) => `integration:${ctx.integration.name}`;

// A path a script names. A relative one (such as "out.csv") is in the integration's own folder; an absolute one ("/exports/x.csv")
// is where the files module keeps it. Either must be inside the folder or a directory granted to the integration (ctx.grants).
const resolveFile = (ctx, p) => files.normalize(p ?? '', ctx.integration.home);
const mayRead = (ctx, p) => {
  const full = resolveFile(ctx, p);
  require_(files.allows(ctx.grants, full, 'read'), `This integration may not read ${full}.`);
  return full;
};
const mayWrite = (ctx, p) => {
  const full = resolveFile(ctx, p);
  require_(files.allows(ctx.grants, full, 'write'), `This integration may not change ${full}.`);
  return full;
};
const mayList = (ctx, p) => {
  const full = resolveFile(ctx, p);
  require_(files.canList(ctx.grants, full), `This integration may not list ${full}.`);
  return full;
};
const entryView = (e) => ({ path: e.path, name: e.name, kind: e.kind, size: e.size, updated_at: e.updated_at });

const filesApi = {
  'files.list': (ctx, dir) => files.visibleIn(ctx.grants, files.list(mayList(ctx, dir))).map(entryView),
  'files.exists': (ctx, p) => {
    const full = resolveFile(ctx, p);
    require_(files.canSee(ctx.grants, full), `This integration may not use ${full}.`);
    return Boolean(files.stat(full));
  },
  'files.read': (ctx, p, o) => {
    const full = mayRead(ctx, p);
    const buf = files.read(full);
    require_(buf, `No such file: ${full}.`);
    return textOf(buf, isObject(o) ? o.encoding : undefined);
  },
  'files.write': (ctx, p, content, o) => {
    o = isObject(o) ? o : {};
    return entryView(files.write(mayWrite(ctx, p), bytesOf(content, o.encoding), { append: o.append === true, by: fileActor(ctx) }));
  },
  'files.delete': (ctx, p, o) => files.remove(mayWrite(ctx, p), { recursive: isObject(o) && o.recursive === true }),
  'files.mkdir': (ctx, p) => { files.mkdir(mayWrite(ctx, p), { by: fileActor(ctx) }); return true; },
};

/* -------------------------------- Directories ------------------------------ */

// A script connects to a directory an administrator configured under External systems → Directories and allowed scripts to use
// (Script access). It then works through the connection and closes it. The connection belongs to the run: directory-sessions.js
// closes whatever is still open when the run ends, however it ends.

const dirTarget = (d) => ({ type: 'directory', id: d.id, name: d.name });

function scriptDirectory(name) {
  const n = text(typeof name === 'object' && name ? name.name : name).toLowerCase();
  require_(n, 'Name the directory, such as directory.connect("Corporate AD").');
  const dir = directories.list().find((d) => d.name.toLowerCase() === n);
  require_(dir && dir.enabled && directories.usesLdap(dir), `No directory named ${n} is available to scripts.`);
  require_(dir.config.scriptAccess !== 'off', `${dir.name} does not allow scripts. An administrator can turn on Script access for it under External systems → Directories.`);
  return dir;
}

async function directoryConnect(ctx, name) {
  const dir = scriptDirectory(name);
  count(ctx, 'directory', 'directory operations');
  // A directory that allows writing is still read-only to an integration without the directory:write scope.
  const access = dir.config.scriptAccess === 'write' && ctx.scopes.has('directory:write') ? 'write' : 'read';
  const s = await dirSessions.open(ctx, dir, access);
  auditLog.admin('directory.script_connect', { actor: byActor(ctx), target: dirTarget(dir), detail: { access, via: 'integration' } });
  return { connection: s.id, directory: dir.name, access };
}

// A function on an open connection: counted, and keeps the connection from going idle while it works.
const onConnection = (fn) => async (ctx, id, ...args) => {
  const s = dirSessions.get(ctx, id);
  count(ctx, 'directory', 'directory operations');
  try { return await fn(ctx, s, ...args); } finally { if (!s.closed) dirSessions.touch(s); }
};

const directoryApi = {
  'directory.list': ['directory:read', () => directories.list()
    .filter((d) => d.enabled && directories.usesLdap(d) && d.config.scriptAccess !== 'off')
    .map((d) => ({ name: d.name, type: d.type, access: d.config.scriptAccess }))],
  'directory.connect': ['directory:read', directoryConnect],
  // Closing needs no scope: a script that was given one must always be able to let go.
  'directory.close': [null, async (ctx, id) => { try { return await dirSessions.close(dirSessions.get(ctx, id)); } catch (e) { if (e instanceof dirSessions.SessionError) return false; throw e; } }],
  'directory.find': ['directory:read', onConnection((ctx, s, ref, o) => dirUsers.find(s, ref, o))],
  'directory.search': ['directory:read', onConnection((ctx, s, q) => dirUsers.search(s, q))],
  'directory.create': ['directory:write', onConnection(async (ctx, s, spec) => {
    const r = await dirUsers.create(s, spec);
    auditLog.admin('directory.script_user_create', { actor: byActor(ctx), target: dirTarget(s.dir), detail: { dn: r.dn, via: 'integration' } });
    return r;
  })],
  'directory.update': ['directory:write', onConnection(async (ctx, s, ref, patch) => {
    const r = await dirUsers.update(s, ref, patch);
    auditLog.admin('directory.script_user_update', { actor: byActor(ctx), target: dirTarget(s.dir), detail: { dn: r.dn, changed: r.changed, via: 'integration' } });
    return r;
  })],
  'directory.delete': ['directory:write', onConnection(async (ctx, s, ref) => {
    const r = await dirUsers.remove(s, ref);
    auditLog.admin('directory.script_user_delete', { actor: byActor(ctx), target: dirTarget(s.dir), detail: { dn: r.dn, via: 'integration' } });
    return r;
  })],
};

/* ----------------------------------- SFTP ---------------------------------- */

function audited(ctx, op, connection, path) {
  count(ctx, 'sftp', 'SFTP operations');
  auditLog.admin('integration.sftp', { actor: byActor(ctx), target: { type: 'integration', id: ctx.integration.id, name: ctx.integration.name },
    detail: { op, host: isObject(connection) ? text(connection.host) : '', path: text(path).slice(0, 300) } });
}

const sftpApi = {
  'sftp.list': async (ctx, c, path) => { audited(ctx, 'list', c, path); return sftp.list(c, path); },
  'sftp.get': async (ctx, c, path, o) => { audited(ctx, 'get', c, path); return textOf(await sftp.get(c, path), isObject(o) ? o.encoding : undefined); },
  'sftp.put': async (ctx, c, path, content, o) => { audited(ctx, 'put', c, path); return sftp.put(c, path, bytesOf(content, isObject(o) ? o.encoding : undefined)); },
  'sftp.delete': async (ctx, c, path) => { audited(ctx, 'delete', c, path); return sftp.remove(c, path); },
  // Straight between the remote server and this integration's files, so a big file never passes through the script.
  'sftp.download': async (ctx, c, path, name) => {
    const dest = mayWrite(ctx, name);
    audited(ctx, 'download', c, path);
    return entryView(files.write(dest, await sftp.get(c, path), { by: fileActor(ctx) }));
  },
  'sftp.upload': async (ctx, c, name, path) => {
    const src = mayRead(ctx, name);
    const buf = files.read(src);
    require_(buf, `No such file: ${src}.`);
    audited(ctx, 'upload', c, path);
    return sftp.put(c, path, buf);
  },
};

const hmac = (ctx, algo, key, data) => crypto.createHmac(algo, String(key)).update(String(data)).digest('hex');

/* ---------------------------------- Reports -------------------------------- */

// report.* belongs to the console's reports, not to integrations: "report:read" is not in SCOPES, so an integration cannot be
// given it. The functions check the permissions of the person running the report.
const reportEntries = Object.fromEntries(Object.entries(reportFunctions.FUNCTIONS).map(([name, fn]) => [name, ['report:read', async (ctx, ...args) => {
  try { return await fn(ctx, ...args); } catch (e) { throw e instanceof reportFunctions.ReportError ? new ScriptError(e.message) : e; }
}]]));

/* ---------------------------------- Registry ------------------------------- */

// name -> [scope or null, function(ctx, ...args)]. The worker builds idp.*, http, mail, sms and util from these names.
const FUNCTIONS = {
  ...reportEntries,
  'users.find': ['users:read', findUser],
  'users.search': ['users:read', searchUsers],
  'users.create': ['users:write', createUser],
  'users.update': ['users:write', updateUser],
  'users.delete': ['users:write', deleteUser],
  'users.endSessions': ['users:write', endSessions],
  'users.resetAuthenticators': ['users:write', resetAuthenticators],
  'users.forgetRemembered': ['users:write', forgetRemembered],
  'compromise.plan': ['users:read', lockdownPlan],
  'compromise.restrict': ['users:write', restrictSignIn],
  'users.suggestUsername': ['users:read', suggestUsername],
  'identity.start': ['identity', identityStart],
  'identity.status': ['identity', identityStatus],
  'identity.latest': ['identity', identityLatest],
  'groups.list': ['groups:read', () => db.all('SELECT * FROM groups ORDER BY name COLLATE NOCASE').map(groupView)],
  'groups.members': ['groups:read', groupMembers],
  'groups.addMember': ['groups:write', addMember],
  'groups.removeMember': ['groups:write', removeMember],
  'http.request': ['http', httpRequest],
  'mail.send': ['messaging', (ctx, o) => sendMessage(ctx, 'email', o)],
  'sms.send': ['messaging', (ctx, o) => sendMessage(ctx, 'sms', o)],
  'util.randomPassword': [null, randomPassword],
  'util.uuid': [null, () => crypto.randomUUID()],
  'util.sha256': [null, (ctx, s) => crypto.createHash('sha256').update(String(s)).digest('hex')],
  'util.hmacSha256': [null, (ctx, key, data) => hmac(ctx, 'sha256', key, data)],
  'util.base64Encode': [null, (ctx, s) => Buffer.from(String(s)).toString('base64')],
  'util.base64Decode': [null, (ctx, s) => Buffer.from(String(s), 'base64').toString('utf8')],
  'csv.parse': [null, csv],
  'csv.stringify': [null, csvStringify],
  ...Object.fromEntries(Object.entries(filesApi).map(([n, f]) => [n, ['files', f]])),
  ...directoryApi,
  ...Object.fromEntries(Object.entries(sftpApi).map(([n, f]) => [n, ['sftp', f]])),
  sleep: [null, async (ctx, ms) => {
    const n = Math.min(Math.max(Number(ms) || 0, 0), LIMITS.sleepMs);
    ctx.slept = (ctx.slept || 0) + n;
    require_(ctx.slept <= LIMITS.sleepMs, `A script may sleep at most ${LIMITS.sleepMs / 1000} seconds in total.`);
    await new Promise((r) => setTimeout(r, n));
    return true;
  }],
};

/**
 * Runs one host function for a script. `ctx` is { integration: { id, name, home }, scopes: Set, used: {} }. Errors a script is
 * meant to see are ScriptErrors; anything else is reported generically so internals do not leak into run history.
 */
async function call(ctx, name, args) {
  const entry = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : null;
  if (!entry) throw new ScriptError(`Unknown function: ${name}.`);
  const [scope, fn] = entry;
  if (scope && !ctx.scopes.has(scope)) throw new ScriptError(`${name} needs the "${scope}" scope, which this integration does not have.`);
  ctx.used.calls = (ctx.used.calls || 0) + 1;
  if (ctx.used.calls > LIMITS.calls) throw new ScriptError(`A script may make at most ${LIMITS.calls} calls per run.`);
  try {
    return await fn(ctx, ...args);
  } catch (e) {
    if (e instanceof ScriptError) throw e;
    if (e instanceof files.FileError || e instanceof sftp.SftpError || e instanceof dirUsers.UserOpError || e instanceof dirSessions.SessionError || e instanceof DirectoryError) throw new ScriptError(e.message);
    console.error(`integration ${ctx.integration.name}: ${name} failed`, e);
    throw new ScriptError(`${name} failed.`);
  }
}

/** Called when a run is over, however it ended: closes the directory connections it still holds. */
const release = (ctx) => { dirSessions.closeOwner(ctx).catch(() => {}); };

module.exports = { call, release, SCOPES, LIMITS, ScriptError };
