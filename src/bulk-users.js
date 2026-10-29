const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const db = require('./db');
const { USER_FIELDS, str } = require('./admin-data');
const { hashPasswordAsync } = require('./crypto');
const attributeDefs = require('./attribute-defs');
const userService = require('./user-service');
const policies = require('./policies');
const auditLog = require('./audit');

// Creating many accounts from a CSV file or a JSON list. Every row is checked first (a dry run stops there); then rows are
// created one at a time ('skip': bad rows are reported and the rest are created) or all together ('abort': one bad row
// creates nothing). Roles are never set here, so a file cannot grant access; groups need the groups.manage permission.

const MAX_ROWS = 1000;
const MAX_AT_ONCE = 4;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const LIST_COLUMNS = ['emails', 'groups'];
const COLUMNS = new Set([...USER_FIELDS, 'personal_email', 'password', 'emails', 'groups', 'active', 'mfa_required', 'attributes']);
// Symbols are included so a generated password can meet a policy that requires one.
const GENERATED_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#%+-=?@';
const GENERATED_LENGTH = 16;
const GENERATE_TRIES = 10;

class BulkError extends Error {}

const generatePassword = (length) => Array.from({ length }, () => GENERATED_ALPHABET[crypto.randomInt(GENERATED_ALPHABET.length)]).join('');

// Calls fn on each item, a few at a time, so a large import does not send all its hashing or breach checks at once.
async function forEachLimited(items, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_AT_ONCE, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// CSV text to row objects. Header names are case-insensitive except attr.<name> columns, which carry attribute values.
function parseCsv(text) {
  let records;
  try {
    records = parse(String(text || ''), { columns: (h) => h.map((x) => { const t = x.trim(); return t.toLowerCase().startsWith('attr.') ? `attr.${t.slice(5)}` : t.toLowerCase(); }),
      skip_empty_lines: true, bom: true, trim: true });
  } catch (e) {
    throw new BulkError(`The CSV could not be read: ${e.message}`);
  }
  if (!records.length) throw new BulkError('The file has no rows.');
  const unknown = Object.keys(records[0]).filter((c) => !COLUMNS.has(c) && !c.startsWith('attr.'));
  if (unknown.length) throw new BulkError(`Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
  return records.map((r) => {
    const row = { ...r };
    const attributes = {};
    for (const k of Object.keys(row)) {
      if (k.startsWith('attr.')) { attributes[k.slice(5)] = row[k]; delete row[k]; }
    }
    return Object.keys(attributes).length ? { ...row, attributes } : row;
  });
}

const list = (v) => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[;\n]/)).map((x) => x.trim()).filter(Boolean);

function flag(v, fallback, label, errors) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  errors.push(`${label} must be true or false.`);
  return fallback;
}

function groupLookup() {
  const map = new Map();
  for (const g of db.all("SELECT id, name FROM groups WHERE source = 'local' AND id NOT IN (SELECT group_id FROM group_composites)")) map.set(g.name.toLowerCase(), g.id);
  return map;
}

/**
 * Checks rows without writing anything. Returns one result per row: { row, username, status: 'valid' | 'error',
 * errors, spec, generated }. `row` is the position the person sees (CSV line number or list position).
 * Each password is checked against the policy its account would get from its groups (policies.draftPolicy).
 * Options: canGroups; generatePasswords (give rows with no password one that meets the policy); trustedHash (rows carry
 * password_hash from an earlier hashing, used when a scheduled import runs); hash (compute password hashes for valid
 * rows, skipped for a dry run).
 */
async function prepare(rows, { canGroups = false, generatePasswords = false, trustedHash = false, hash = true, firstRow = 1 } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new BulkError('There are no rows.');
  if (rows.length > MAX_ROWS) throw new BulkError(`At most ${MAX_ROWS} users can be imported at once.`);
  const groups = groupLookup();
  const seenUsers = new Map();
  const seenEmails = new Map();
  const results = rows.map((raw, i) => {
    const row = i + firstRow;
    const errors = [];
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (r !== raw) errors.push('Row is not an object.');
    for (const k of Object.keys(r)) if (!COLUMNS.has(k) && !(trustedHash && k === 'password_hash')) errors.push(`Unknown field: ${k}.`);

    const fields = Object.fromEntries(USER_FIELDS.map((f) => [f, str(r[f])]));
    if (!fields.username) errors.push('Username is required.');
    else if (fields.username.length > 255) errors.push('Username is too long.');
    else if (db.get('SELECT 1 FROM users WHERE username = ?', fields.username)) errors.push('That username already exists.');
    else if (seenUsers.has(fields.username.toLowerCase())) errors.push(`Username repeats row ${seenUsers.get(fields.username.toLowerCase())}.`);
    else seenUsers.set(fields.username.toLowerCase(), row);
    if (!fields.display_name) fields.display_name = `${fields.first_name} ${fields.last_name}`.trim();

    // emails may be "a;b" text, or a list of strings or { email, primary } objects.
    const listed = (Array.isArray(r.emails) ? r.emails : list(r.emails)).map((e) => (e && typeof e === 'object' ? { email: String(e.email ?? '').trim(), primary: Boolean(e.primary) } : { email: String(e).trim(), primary: false }))
      .filter((e) => e.email && e.email.toLowerCase() !== fields.email.toLowerCase());
    const em = userService.readEmails({ emails: [...(fields.email ? [{ email: fields.email, primary: true }] : []), ...listed] }, '');
    errors.push(...em.errors);
    for (const e of em.emails) {
      const k = e.email.toLowerCase();
      if (seenEmails.has(k) && seenEmails.get(k) !== row) errors.push(`"${e.email}" repeats row ${seenEmails.get(k)}.`);
      else seenEmails.set(k, row);
    }
    fields.email = (em.emails.find((e) => e.primary) || { email: '' }).email;

    // A recovery address from a trusted source (an administrator's file, an onboarding system) counts as verified.
    const personal = str(r.personal_email);
    const personalErr = userService.personalEmailError(null, personal);
    if (personalErr) errors.push(personalErr);
    else if (personal && em.emails.some((e) => e.email.toLowerCase() === personal.toLowerCase())) errors.push('The recovery address must be different from the organizational addresses.');

    const active = flag(r.active, true, 'Active', errors);
    const mfa = flag(r.mfa_required, false, 'MFA required', errors);

    const typed = typeof r.password === 'string' ? r.password : '';
    // A scheduled import carries hashes that were checked when the import was made.
    const hashed = trustedHash && r.password_hash;
    if (!hashed && !typed && !generatePasswords) errors.push('Password is required.');

    const supplied = r.attributes && typeof r.attributes === 'object' ? r.attributes : {};
    const defined = {}; const free = [];
    const defNames = new Set(attributeDefs.list().map((d) => d.name));
    for (const [k, v] of Object.entries(supplied)) {
      if (defNames.has(k)) defined[k] = v;
      else if (!NAME_RE.test(k)) errors.push(`Attribute name "${k}" is not valid.`);
      else if (String(v ?? '').trim()) free.push(`${k}=${String(v).replace(/[\r\n]+/g, ' ').trim()}`);
    }
    const attrs = attributeDefs.resolve(defined, { isNew: true });
    errors.push(...attrs.errors);

    const groupIds = [];
    const names = list(r.groups);
    if (names.length && !canGroups) errors.push('You do not have permission to assign groups.');
    else for (const n of names) {
      const id = groups.get(n.toLowerCase());
      if (id) groupIds.push(id); else errors.push(`No such group: ${n}.`);
    }

    // The password is checked once the groups are known, below. Only a row that is still valid needs it, and it holds the
    // typed password, so it is dropped as soon as the row is settled.
    const status = errors.length ? 'error' : 'valid';
    const pending = status === 'valid' && !hashed && (typed || generatePasswords)
      ? { policy: policies.draftPolicy({ groupIds }), profile: fields, typed: typed || null } : null;
    return { row, username: fields.username, status, errors, generated: null, pending,
      // What a scheduled import stores: the row as written, with the password replaced by its hash (set below).
      raw: status === 'valid' ? { ...fields, personal_email: personal, emails: em.emails.map((e) => e.email), groups: names, active, mfa_required: mfa, attributes: supplied,
        password_hash: hashed || null } : null,
      spec: status === 'valid' ? { fields, mfa_enabled: mfa, active, plain: null, passwordHash: hashed || null,
        emails: em.emails, personalEmail: personal, custom: free.join('\n'), attributes: attrs.values, groupIds } : null };
  });

  // Password rules read the database and, for breach checks, the network, so they run after the pass above. A row that is
  // already refused is skipped, so its password is never sent anywhere (the same order password-rules.js uses).
  await forEachLimited(results.filter((r) => r.status === 'valid' && r.pending), (r) => settlePassword(r));
  if (hash) await forEachLimited(results.filter((r) => r.spec && !r.spec.passwordHash), async (r) => {
    r.spec.passwordHash = await hashPasswordAsync(r.spec.plain);
    r.raw.password_hash = r.spec.passwordHash;
  });
  return results;
}

// Checks a typed password, or generates one that meets the policy, and turns the row into an error if it cannot be accepted.
async function settlePassword(r) {
  const { policy, profile, typed } = r.pending;
  if (typed) {
    r.errors.push(...await policies.passwordErrorsUnder(policy, typed, { profile }));
    if (!r.errors.length) r.spec.plain = typed;
  } else {
    // The policy's minimum length applies to generated passwords too, so a long minimum still gets a long one.
    const length = Math.max(GENERATED_LENGTH, policy.minPasswordLength);
    let candidate = null;
    for (let i = 0; i < GENERATE_TRIES && !candidate; i++) {
      const c = generatePassword(length);
      if (!(await policies.passwordErrorsUnder(policy, c, { profile })).length) candidate = c;
    }
    if (candidate) { r.spec.plain = candidate; r.generated = candidate; } else r.errors.push('No password that meets the policy could be generated. Supply one instead.');
  }
  r.pending = null;
  if (r.errors.length) { r.status = 'error'; r.spec = null; r.raw = null; r.generated = null; }
}

/** Creates the valid rows from `prepare` (which must have hashed). Mutates and returns the results. */
function commit(results, { by = null, onError = 'skip', via = 'bulk' } = {}) {
  const bad = results.filter((r) => r.status === 'error');
  if (onError === 'abort' && bad.length) {
    for (const r of results) if (r.status === 'valid') r.status = 'skipped', r.errors = ['Not created because other rows have errors.'];
    return results;
  }
  const make = (r) => { r.id = userService.insertUser(r.spec, { by, via }); r.status = 'created'; };
  if (onError === 'abort') {
    try {
      db.tx(() => results.forEach(make));
    } catch (e) {
      for (const r of results) { r.id = undefined; r.status = 'error'; r.errors = ['Nothing was created because a row could not be saved.']; }
    }
  } else {
    for (const r of results) {
      if (r.status !== 'valid') continue;
      try { make(r); } catch { r.status = 'error'; r.errors = ['The row could not be saved.']; }
    }
  }
  return results;
}

const strip = (r) => ({ row: r.row, username: r.username, status: r.status, errors: r.errors, ...(r.id ? { id: r.id } : {}) });
const summarize = (results) => ({
  total: results.length,
  created: results.filter((r) => r.status === 'created').length,
  failed: results.filter((r) => r.status === 'error').length,
  valid: results.filter((r) => r.status === 'valid').length,
});

/**
 * Runs a whole import. `input` is { csv } or { users: [...] }. Returns { dry_run, job_id?, summary, rows, generated }; generated
 * passwords are returned here once and kept nowhere else.
 */
async function run(input, { by = null, byName = '', canGroups = false, actor = null, via = 'bulk' } = {}) {
  const who = actor || (by ? { type: 'user', id: by, name: byName } : undefined);
  const rows = input.csv !== undefined ? parseCsv(input.csv) : input.users;
  const dryRun = input.dry_run === true || input.dry_run === 'true';
  const onError = input.on_error === 'abort' ? 'abort' : 'skip';
  const results = await prepare(rows, { canGroups, generatePasswords: Boolean(input.generate_passwords), hash: !dryRun, firstRow: input.csv !== undefined ? 2 : 1 });
  if (dryRun) return { dry_run: true, summary: summarize(results), rows: results.map(strip), generated: [] };

  commit(results, { by, onError, via });
  const summary = summarize(results);
  const report = results.map(strip);
  const jobId = Number(db.run('INSERT INTO bulk_jobs (created_at, actor_id, actor_name, on_error, total, created, failed, report) VALUES (?,?,?,?,?,?,?,?)',
    Math.floor(Date.now() / 1000), by, byName, onError, summary.total, summary.created, summary.failed, JSON.stringify(report)).lastInsertRowid);
  for (const r of results.filter((x) => x.status === 'created')) {
    auditLog.admin('user.create', { actor: who, target: { type: 'user', id: r.id, name: r.username },
      detail: { active: r.spec.active, mfa_required: r.spec.mfa_enabled, via, job: jobId } });
  }
  auditLog.admin('user.bulk_create', { actor: who, target: { type: 'bulk_job', id: jobId, name: `import #${jobId}` },
    detail: { ...summary, on_error: onError } });
  return { dry_run: false, job_id: jobId, summary, rows: report,
    generated: results.filter((r) => r.status === 'created' && r.generated).map((r) => ({ username: r.username, password: r.generated })) };
}

const job = (id) => {
  const j = db.get('SELECT * FROM bulk_jobs WHERE id = ?', id);
  return j && { id: j.id, created_at: j.created_at, actor: j.actor_name, on_error: j.on_error, summary: { total: j.total, created: j.created, failed: j.failed }, rows: JSON.parse(j.report) };
};
const jobs = () => db.all('SELECT id, created_at, actor_name AS actor, total, created, failed FROM bulk_jobs ORDER BY id DESC LIMIT 100');

// CSV of the rows that were not created, for fixing and re-uploading.
function errorCsv(j) {
  // A leading = + - @ would be run as a formula by spreadsheet programs.
  const q = (v) => `"${(/^[=+\-@\t\r]/.test(String(v)) ? "'" : '') + String(v).replace(/"/g, '""')}"`;
  return ['row,username,status,errors', ...j.rows.filter((r) => r.status !== 'created').map((r) => [r.row, q(r.username), r.status, q(r.errors.join(' '))].join(','))].join('\n');
}

const TEMPLATE_CSV = 'username,password,first_name,last_name,email,emails,personal_email,groups,department,title,active,mfa_required\n'
  + 'srivera,ChangeMe-123,Sam,Rivera,srivera@example.net,sam.rivera@example.org,sam@home.example,Staff;Weavers,Underwater Basket-Weaving,Foreman,true,false\n';

module.exports = { parseCsv, prepare, commit, run, job, jobs, errorCsv, BulkError, MAX_ROWS, TEMPLATE_CSV, COLUMNS };
