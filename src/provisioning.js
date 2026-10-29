const { parse: parseCsv } = require('csv-parse/sync');
const db = require('./db');
const auditLog = require('./audit');
const directories = require('./directories');
const transform = require('./transform');
const userService = require('./user-service');
const roles = require('./roles');
const { USER_FIELDS } = require('./admin-data');
const { safeFetchText } = require('./safe-fetch');
const { lastAdmin } = require('./user-scheduler');

// Provisioning feeds. An HR, ERP, payroll or other system of record keeps the people a directory owns up to date:
// it creates them, changes them, puts them in groups and, when they leave, deactivates and eventually deletes them.
// Nothing here knows about a particular product. The feed is a list of flat or nested records (CSV or JSON), delivered
// by the system pushing it to /directory/v1/feed, by this server fetching a URL on a schedule, or by an administrator
// uploading a file. A mapping, written in the same expression language as SAML attribute transformations, turns each
// record into a person. The directory's own `external_id` is the join key, so local accounts are never touched.

const FORMATS = ['csv', 'json'];
const MODES = ['full', 'delta'];
const MAX_RECORDS = 50000;
const MAX_FIELD = 512;
const MAX_GROUPS = 500;
const MAX_REPORT = 500;
const KEEP_RUNS = 50;
const PULL_MAX_BYTES = 25 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEADER_RE = /^[A-Za-z0-9-]+$/;
const CUSTOM_RE = /^custom:[A-Za-z_][\w.:\-/]{0,199}$/;
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 't', 'active', 'enabled', 'a']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'f', 'inactive', 'disabled', 'terminated', 'i']);
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

class FeedError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

/** The names a mapping rule may assign to, with what each one means. The console prints this next to the editor. */
const TARGETS = [
  { name: 'external_id', required: true, description: 'The source system’s permanent identifier for the person (an employee or badge number). It joins a record to an account, so it must never change or repeat.' },
  { name: 'username', required: true, description: 'The sign-in name. Used when the account is created; an existing account keeps its username so nobody is locked out by a rename.' },
  ...USER_FIELDS.filter((f) => f !== 'username').map((f) => ({ name: f, description: `Profile field ${f}.` })),
  { name: 'active', description: 'Whether the person is currently employed or enrolled: true/yes/active/1 or false/no/inactive/terminated/0. If you map this, a record that produces no value counts as inactive, so extract("^Active$") style rules work. Left unmapped, everyone in the feed is active.' },
  { name: 'start_date', description: 'First day (ISO 8601, e.g. 2026-09-01). The account is created inactive and switches on when the date arrives. A date without a time starts at 00:00 UTC.' },
  { name: 'end_date', description: 'Last day (ISO 8601). The account switches off after it. A date without a time lasts through the end of that day (UTC).' },
  { name: 'groups', description: 'Group names the person belongs to. Write several rules to add several groups; they are combined. Groups are created on demand, belong to this directory and are read-only in the console.' },
  { name: 'custom:<name>', description: 'A custom user attribute, for example custom:badge_number.' },
];

const EXAMPLE_RULES = `# One "target = expression" per line. Source columns are written as names; use attr("Column Name") when a
# name has spaces. Functions: ${Object.keys(transform.FUNCTIONS).join(', ')}.
external_id = attr("Employee ID")
first_name  = attr("Legal First Name")
last_name   = attr("Legal Last Name")
username    = lower(concat(first_name, ".", last_name))
email       = lower(attr("Work Email"))
department  = attr("Department")
title       = attr("Job Title")
active      = extract(attr("Worker Status"), "^(Active|Leave)$")
start_date  = attr("Hire Date")
end_date    = attr("Termination Date")
groups      = concat("dept-", lower(department))
groups      = "Employees"
groups      = extract(attr("Worker Type"), "^(Contractor)$")
custom:badge_number = attr("Badge")
`;

const DEFAULTS = {
  enabled: false,
  format: 'csv',
  recordsPath: '',
  mode: 'full',
  rules: '',
  leaverAction: 'deactivate',
  deleteAfterDays: 0,
  maxRemovalPercent: 20,
  usernameCollision: 'error',
  pull: { url: '', authHeader: 'Authorization', authValue: '', intervalMinutes: 0 },
};

/* ------------------------------ Configuration ------------------------------ */

function config(directoryId) {
  const row = db.get('SELECT config FROM provisioning_feeds WHERE directory_id = ?', directoryId);
  let saved = {};
  try { saved = row ? JSON.parse(row.config) : {}; } catch { /* use defaults */ }
  return { ...DEFAULTS, ...saved, pull: { ...DEFAULTS.pull, ...(saved.pull || {}) } };
}

const lastPull = (directoryId) => (db.get('SELECT last_pull_at AS t FROM provisioning_feeds WHERE directory_id = ?', directoryId) || { t: 0 }).t;

function saveConfig(directoryId, cfg) {
  db.run(`INSERT INTO provisioning_feeds (directory_id, config) VALUES (?, ?)
          ON CONFLICT(directory_id) DO UPDATE SET config = excluded.config`, directoryId, JSON.stringify(cfg));
}

const targetOk = (t) => t === 'external_id' || t === 'groups' || ['active', 'start_date', 'end_date'].includes(t) || USER_FIELDS.includes(t) || CUSTOM_RE.test(t);

/** Parses mapping text. Returns { rules, errors }; rules for `groups` are renamed so that several of them add up. */
function prepareRules(text) {
  const { rules, errors } = transform.parseRules(text);
  let g = 0;
  const out = [];
  for (const r of rules) {
    if (!targetOk(r.target)) {
      errors.push(`Line ${r.line}: "${r.target}" is not something a feed can set. Use external_id, username, a profile field, active, start_date, end_date, groups or custom:<name>.`);
      continue;
    }
    out.push(r.target === 'groups' ? { ...r, target: `groups\u0000${g++}` } : r);
  }
  return { rules: out, errors };
}

/** Validates a submitted feed configuration. A blank pull secret keeps the stored one. */
function parseConfig(body = {}, current = DEFAULTS) {
  const errors = [];
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const int = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const p = body.pull || {};
  const cfg = {
    enabled: Boolean(body.enabled),
    format: FORMATS.includes(body.format) ? body.format : 'csv',
    recordsPath: text(body.recordsPath),
    mode: MODES.includes(body.mode) ? body.mode : 'full',
    rules: typeof body.rules === 'string' ? body.rules.replace(/\r\n?/g, '\n') : '',
    leaverAction: body.leaverAction === 'none' ? 'none' : 'deactivate',
    deleteAfterDays: int(body.deleteAfterDays, 0),
    maxRemovalPercent: int(body.maxRemovalPercent, 20),
    usernameCollision: body.usernameCollision === 'suffix' ? 'suffix' : 'error',
    pull: {
      url: text(p.url),
      authHeader: text(p.authHeader) || 'Authorization',
      authValue: text(p.authValue) || (current.pull || {}).authValue || '',
      intervalMinutes: int(p.intervalMinutes, 0),
    },
  };
  if (!/^[A-Za-z0-9_.-]*$/.test(cfg.recordsPath)) errors.push('Records path may contain letters, digits, dots, dashes and underscores only (for example data.workers).');
  if (!Number.isInteger(cfg.deleteAfterDays) || cfg.deleteAfterDays < 0 || cfg.deleteAfterDays > 3650) errors.push('Delete after must be a whole number of days from 0 (never) to 3650.');
  if (!Number.isInteger(cfg.maxRemovalPercent) || cfg.maxRemovalPercent < 0 || cfg.maxRemovalPercent > 100) errors.push('The removal limit must be a whole percentage from 0 to 100.');
  if (cfg.pull.url) {
    let u = null;
    try { u = new URL(cfg.pull.url); } catch { /* reported below */ }
    if (!u || !/^https?:$/.test(u.protocol)) errors.push('The feed URL must be an http(s) address.');
  }
  if (!HEADER_RE.test(cfg.pull.authHeader)) errors.push('The authentication header name is not valid.');
  if (!Number.isInteger(cfg.pull.intervalMinutes) || (cfg.pull.intervalMinutes !== 0 && (cfg.pull.intervalMinutes < 5 || cfg.pull.intervalMinutes > 10080))) {
    errors.push('Fetch every must be 0 (do not fetch on a schedule) or between 5 and 10080 minutes.');
  }
  if (cfg.pull.intervalMinutes > 0 && !cfg.pull.url) errors.push('A fetch schedule needs a feed URL.');
  if (cfg.rules.length > 20000) errors.push('The mapping is too long.');
  const prepared = prepareRules(cfg.rules);
  errors.push(...prepared.errors);
  const targets = new Set(prepared.rules.map((r) => r.target));
  if (cfg.rules.trim() && !prepared.errors.length) {
    if (!targets.has('external_id')) errors.push('The mapping must set external_id, the permanent identifier that joins a record to an account.');
    if (!targets.has('username')) errors.push('The mapping must set username.');
  }
  if (cfg.enabled && !cfg.rules.trim()) errors.push('Write a mapping before enabling the feed.');
  return { data: cfg, errors };
}

/** What the console sees: the pull secret becomes a flag. */
function view(directoryId) {
  const cfg = config(directoryId);
  const { authValue, ...pull } = cfg.pull;
  const pending = db.get('SELECT COUNT(*) AS n FROM provisioning_state WHERE directory_id = ? AND reason = ?', directoryId, 'prehire').n;
  const missing = db.get('SELECT COUNT(*) AS n FROM provisioning_state WHERE directory_id = ? AND missing_since IS NOT NULL', directoryId).n;
  return {
    config: { ...cfg, pull: { ...pull, authValueSet: Boolean(authValue) } },
    managed: db.get('SELECT COUNT(*) AS n FROM provisioning_state WHERE directory_id = ?', directoryId).n,
    pendingStart: pending,
    missing,
    lastPullAt: lastPull(directoryId),
    runs: db.all('SELECT id, started_at, via, mode, status, actor, summary FROM provisioning_runs WHERE directory_id = ? ORDER BY id DESC LIMIT 20', directoryId)
      .map((r) => ({ ...r, summary: JSON.parse(r.summary) })),
  };
}

const reference = () => ({
  targets: TARGETS, functions: Object.keys(transform.FUNCTIONS), example: EXAMPLE_RULES, formats: FORMATS, modes: MODES,
  trueValues: [...TRUE_WORDS], falseValues: [...FALSE_WORDS],
});

/* ------------------------------ Reading records ---------------------------- */

const flat = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v.flatMap(flat) : typeof v === 'object' ? [] : [String(v).trim()]);

/** The values of a source field: an exact column or key, else a dotted path into nested JSON, else a case-insensitive key. */
function pick(record, name) {
  if (Object.hasOwn(record, name)) return flat(record[name]).filter(Boolean);
  if (name.includes('.')) {
    let cur = record;
    for (const part of name.split('.')) {
      if (cur === null || typeof cur !== 'object') { cur = undefined; break; }
      cur = Array.isArray(cur) ? cur.map((x) => (x && typeof x === 'object' ? x[part] : undefined)) : cur[part];
    }
    if (cur !== undefined) return flat(cur).filter(Boolean);
  }
  const lower = name.toLowerCase();
  const key = Object.keys(record).find((k) => k.toLowerCase() === lower);
  return key === undefined ? [] : flat(record[key]).filter(Boolean);
}

/** Text or an already parsed JSON value to a list of record objects. Throws FeedError. */
function parseRecords(input, { format, recordsPath }) {
  let records;
  if (format === 'csv') {
    try {
      records = parseCsv(String(input), { columns: true, skip_empty_lines: true, bom: true, trim: true, relax_column_count: true });
    } catch (e) {
      throw new FeedError(400, `The CSV could not be read: ${e.message}`);
    }
  } else {
    let doc = input;
    if (typeof input === 'string') {
      try { doc = JSON.parse(input.replace(/^﻿/, '')); } catch { throw new FeedError(400, 'The feed is not valid JSON.'); }
    }
    for (const part of recordsPath ? recordsPath.split('.') : []) {
      doc = doc !== null && typeof doc === 'object' ? doc[part] : undefined;
    }
    if (!Array.isArray(doc)) {
      throw new FeedError(400, recordsPath ? `Nothing at "${recordsPath}" is a list of records.` : 'The JSON must be a list of records. If they are inside an object, set the records path.');
    }
    records = doc;
  }
  if (records.length > MAX_RECORDS) throw new FeedError(413, `A feed can hold at most ${MAX_RECORDS} records.`);
  return records;
}

/* -------------------------------- Mapping ---------------------------------- */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const one = (attrs, k) => (attrs.get(k) || [])[0] || '';

function parseDate(v, label, endOfDay) {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(v);
  let t = NaN;
  if (m) {
    const zone = !m[4] || m[4] === 'Z' ? 'Z' : m[4].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
    t = Date.parse(m[2] ? `${m[1]}T${m[2]}:${m[3] || '00'}${zone}` : `${m[1]}T00:00:00Z`);
  }
  if (!Number.isFinite(t)) throw new Error(`${label} "${v.slice(0, 40)}" is not an ISO 8601 date such as 2026-09-01.`);
  // A date with no time means the whole day: a last day is still a working day.
  return Math.floor(t / 1000) + (endOfDay && !m[2] ? DAY : 0);
}

/**
 * Turns one source record into the person it describes. Returns { errors, ... } or the values: fields (only those the
 * mapping sets), externalId, username, srcActive, startAt, endAt, groups (undefined when the mapping has no groups rule),
 * custom (name -> value, '' to remove).
 */
function mapRecord(prepared, record) {
  const errors = [];
  if (!isObject(record)) return { errors: ['The record is not an object.'] };
  const attrs = new Map();
  for (const e of transform.applyRules(prepared.rules, attrs, (n) => pick(record, n))) errors.push(e);
  const targets = new Set(prepared.rules.map((r) => r.target));
  const out = { errors, fields: {}, custom: {}, externalId: one(attrs, 'external_id'), srcActive: true, startAt: null, endAt: null, groups: undefined };

  for (const f of USER_FIELDS) {
    if (!targets.has(f)) continue;
    const v = one(attrs, f);
    if (v.length > MAX_FIELD) errors.push(`${f} is longer than ${MAX_FIELD} characters.`);
    else if (CONTROL.test(v)) errors.push(`${f} contains control characters.`);
    else out.fields[f] = v;
  }
  out.username = out.fields.username || '';
  if (out.fields.email && !/^[^\s@]+@[^\s@]+$/.test(out.fields.email)) errors.push(`email "${out.fields.email.slice(0, 60)}" is not a valid address.`);
  if (!out.externalId) errors.push('external_id is empty.');
  else if (out.externalId.length > MAX_FIELD || CONTROL.test(out.externalId)) errors.push('external_id is not valid.');

  if (targets.has('active')) {
    const v = one(attrs, 'active').toLowerCase();
    if (!v) out.srcActive = false;
    else if (TRUE_WORDS.has(v)) out.srcActive = true;
    else if (FALSE_WORDS.has(v)) out.srcActive = false;
    else errors.push(`active "${v.slice(0, 40)}" is not one of: ${[...TRUE_WORDS, ...FALSE_WORDS].join(', ')}.`);
  }
  try { out.startAt = targets.has('start_date') ? parseDate(one(attrs, 'start_date'), 'start_date', false) : null; } catch (e) { errors.push(e.message); }
  try { out.endAt = targets.has('end_date') ? parseDate(one(attrs, 'end_date'), 'end_date', true) : null; } catch (e) { errors.push(e.message); }

  const groupKeys = [...targets].filter((t) => t.startsWith('groups\u0000'));
  if (groupKeys.length) {
    out.groups = [...new Set(groupKeys.flatMap((k) => attrs.get(k) || []))];
    if (out.groups.length > MAX_GROUPS) errors.push(`More than ${MAX_GROUPS} groups.`);
    else if (out.groups.some((g) => g.length > MAX_FIELD || CONTROL.test(g))) errors.push('A group name is too long or contains control characters.');
  }
  for (const t of targets) {
    if (!CUSTOM_RE.test(t)) continue;
    const v = one(attrs, t);
    if (v.length > MAX_FIELD || CONTROL.test(v)) errors.push(`${t} is too long or contains control characters.`);
    else out.custom[t.slice(7)] = v;
  }
  return out;
}

/* -------------------------------- Lifecycle -------------------------------- */

/** Whether an account should be switched on, and why not. `s` holds the signals the feed last gave for a person. */
function lifecycle(s, now, cfg) {
  if (s.missing && cfg.leaverAction === 'deactivate') return { active: false, reason: 'missing' };
  if (!s.srcActive) return { active: false, reason: 'inactive' };
  if (s.endAt && s.endAt <= now) return { active: false, reason: 'ended' };
  if (s.startAt && s.startAt > now) return { active: false, reason: 'prehire' };
  return { active: true, reason: '' };
}

const signalsOf = (row) => ({ srcActive: Boolean(row.src_active), startAt: row.start_at, endAt: row.end_at, missing: Boolean(row.missing_since) });

const actorOf = (dir) => ({ type: 'integration', id: dir.id, name: dir.name });
const userTarget = (u) => ({ type: 'user', id: u.id, name: u.username });

/** Saves a person's signals and, if the decision changed, switches the account. Returns 'deactivated', 'reactivated' or ''. */
function settle(dir, cfg, user, prev, signals, now) {
  const want = lifecycle(signals, now, cfg);
  const was = prev ? Boolean(prev.desired) : Boolean(user.active);
  let change = '';
  let inactiveSince = prev ? prev.inactive_since : null;
  if (want.active !== was) {
    if (!want.active && lastAdmin(user.id)) {
      auditLog.admin('provisioning.user_skipped', { outcome: 'failure', actor: actorOf(dir), target: userTarget(user), detail: { reason: 'last active administrator' } });
      return '';
    }
    db.run('UPDATE users SET active = ? WHERE id = ?', want.active ? 1 : 0, user.id);
    if (!want.active) userService.revokeSessions(user.id);
    change = want.active ? 'reactivated' : 'deactivated';
  }
  // The clock for deleting a leaver starts when they stop being active and is not restarted by a change of reason.
  if (want.active || want.reason === 'prehire') inactiveSince = null;
  else if (!inactiveSince) inactiveSince = now;
  db.run(`INSERT INTO provisioning_state (user_id, directory_id, src_active, start_at, end_at, missing_since, desired, reason, inactive_since)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET src_active = excluded.src_active, start_at = excluded.start_at, end_at = excluded.end_at,
            missing_since = excluded.missing_since, desired = excluded.desired, reason = excluded.reason, inactive_since = excluded.inactive_since`,
  user.id, dir.id, signals.srcActive ? 1 : 0, signals.startAt, signals.endAt, signals.missing ? (prev && prev.missing_since) || now : null,
  want.active ? 1 : 0, want.reason, inactiveSince);
  if (change) auditLog.admin(`provisioning.user_${change === 'deactivated' ? 'deactivate' : 'reactivate'}`, { actor: actorOf(dir), target: userTarget(user), detail: { reason: want.reason || 'active again' } });
  return change;
}

/* --------------------------------- Planning -------------------------------- */

const attrsOf = (id) => Object.fromEntries(db.all('SELECT name, value FROM user_attributes WHERE user_id = ?', id).map((r) => [r.name, r.value]));
const groupsOf = (id, dirId) => db.all('SELECT g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? AND g.directory_id = ? ORDER BY g.name', id, dirId).map((r) => r.name);

/**
 * Works out what a feed would do without doing it. Returns { items, summary, blocked }.
 * items: { row, action: 'create' | 'update' | 'unchanged' | 'error', ... }.
 */
function plan(dir, cfg, records, { mode, now = nowSec() }) {
  const prepared = prepareRules(cfg.rules);
  if (prepared.errors.length || !prepared.rules.length) throw new FeedError(400, 'The mapping is not valid.', prepared.errors.length ? prepared.errors : ['The mapping is empty.']);

  const owned = new Map(db.all("SELECT * FROM users WHERE directory_id = ? AND external_id != ''", dir.id).map((u) => [u.external_id, u]));
  const states = new Map(db.all('SELECT * FROM provisioning_state WHERE directory_id = ?', dir.id).map((s) => [s.user_id, s]));
  const taken = new Set();
  const seenIds = new Map();
  const seenUsers = new Set();
  const items = [];

  records.forEach((record, i) => {
    const row = i + 1;
    const m = mapRecord(prepared, record);
    const item = { row, external_id: m.externalId || '', username: m.username || '', action: 'error', changes: [], errors: [...m.errors], warnings: [] };
    items.push(item);
    if (m.externalId && seenIds.has(m.externalId)) item.errors.push(`external_id "${m.externalId}" repeats row ${seenIds.get(m.externalId)}.`);
    else if (m.externalId) seenIds.set(m.externalId, row);
    if (item.errors.length) return;

    const user = owned.get(m.externalId) || null;
    const prev = user ? states.get(user.id) || null : null;
    if (user) seenUsers.add(user.id);
    const signals = { srcActive: m.srcActive, startAt: m.startAt, endAt: m.endAt, missing: false };
    const want = lifecycle(signals, now, cfg);
    Object.assign(item, { signals, want, custom: m.custom, newGroups: m.groups });

    // Email addresses must be valid and unused; the person's other addresses are kept.
    const emailChanged = m.fields.email !== undefined && (!user || m.fields.email.toLowerCase() !== (user.email || '').toLowerCase());
    if (emailChanged && m.fields.email) {
      const e = userService.readEmails({ emails: [{ email: m.fields.email, primary: true }, ...(user ? userService.emailsOf(user.id).filter((x) => x.email.toLowerCase() !== m.fields.email.toLowerCase()).map((x) => ({ email: x.email, primary: false })) : [])] }, '', user ? user.id : null);
      if (e.errors.length) { item.errors.push(...e.errors); return; }
      item.emails = e.emails;
    } else if (emailChanged) item.clearEmail = true;

    if (m.groups) {
      const clash = m.groups.filter((g) => { const x = db.get('SELECT directory_id FROM groups WHERE name = ?', g); return x && x.directory_id !== dir.id; });
      if (clash.length) item.warnings.push(`Not added, because a group with that name is not managed by this directory: ${clash.join(', ')}.`);
    }

    if (!user) {
      if (!m.username) { item.errors.push('username is empty.'); return; }
      let name = m.username;
      const exists = (n) => taken.has(n.toLowerCase()) || db.get('SELECT 1 FROM users WHERE username = ?', n);
      if (exists(name) && cfg.usernameCollision === 'suffix') {
        for (let n = 2; n < 100 && exists(name); n++) name = `${m.username}${n}`;
        if (name !== m.username) item.warnings.push(`Username ${m.username} was taken; using ${name}.`);
      }
      if (exists(name)) { item.errors.push(`The username "${name}" belongs to another account.`); return; }
      taken.add(name.toLowerCase());
      Object.assign(item, { action: 'create', username: name, fields: { ...m.fields, username: name }, changes: ['new account'] });
      if (!want.active) item.warnings.push(want.reason === 'prehire' ? 'Created inactive until the start date.' : `Created inactive (${want.reason}).`);
      return;
    }

    item.username = user.username;
    const changes = [];
    const values = {};
    for (const [f, v] of Object.entries(m.fields)) {
      if (f === 'username') continue;
      if ((user[f] || '') !== v) { values[f] = v; changes.push(f); }
    }
    item.fields = values;
    const have = attrsOf(user.id);
    const custom = { ...have };
    for (const [k, v] of Object.entries(m.custom)) {
      if (v) custom[k] = v; else delete custom[k];
    }
    if (JSON.stringify(Object.entries(custom).sort()) !== JSON.stringify(Object.entries(have).sort())) { item.mergedCustom = custom; changes.push('attributes'); }
    // Group names are unique ignoring case, so they are compared that way.
    const names = (list) => JSON.stringify(list.map((g) => g.toLowerCase()).sort());
    if (m.groups && names(m.groups) !== names(groupsOf(user.id, dir.id))) changes.push('groups');
    const was = prev ? Boolean(prev.desired) : Boolean(user.active);
    if (want.active !== was) changes.push(want.active ? 'reactivated' : 'deactivated');
    else if (!prev || prev.src_active !== (m.srcActive ? 1 : 0) || prev.start_at !== m.startAt || prev.end_at !== m.endAt || prev.missing_since) changes.push('status');
    item.changes = changes;
    item.action = changes.length ? 'update' : 'unchanged';
    item.userId = user.id;
  });

  // People the feed owns but did not mention. In a full feed that is a leaver.
  const missing = [];
  if (mode === 'full') {
    for (const [uid, s] of states) {
      if (!seenUsers.has(uid) && !s.missing_since) missing.push(uid);
    }
  }

  const count = (a) => items.filter((x) => x.action === a).length;
  const summary = {
    records: records.length, created: count('create'), updated: count('update'), unchanged: count('unchanged'), errors: count('error'),
    deactivated: items.filter((x) => x.changes.includes('deactivated')).length, reactivated: items.filter((x) => x.changes.includes('reactivated')).length,
    leavers: cfg.leaverAction === 'deactivate' ? missing.length : 0, absent: missing.length,
  };

  let blocked = '';
  if (mode === 'full' && !records.length) blocked = 'The feed has no records. Applying it would treat everyone as having left.';
  else if (records.length && summary.errors > records.length / 2) blocked = `${summary.errors} of ${records.length} records could not be processed, which usually means the mapping or the file format is wrong.`;
  else if (cfg.leaverAction === 'deactivate' && missing.length && states.size && cfg.maxRemovalPercent < 100
    && (missing.length / states.size) * 100 > cfg.maxRemovalPercent) {
    blocked = `${missing.length} of ${states.size} people are missing from this feed (${Math.round((missing.length / states.size) * 100)}%), more than the ${cfg.maxRemovalPercent}% limit.`;
  }
  return { items, missing, summary, blocked, mode, now };
}

/* ---------------------------------- Applying ------------------------------- */

function apply(dir, cfg, p) {
  const { now } = p;
  db.tx(() => {
    for (const it of p.items) {
      if (it.action === 'create') {
        const f = { ...it.fields, external_id: it.external_id, active: it.want.active ? 1 : 0 };
        const user = directories.writeUser(dir, null, f, { custom: Object.fromEntries(Object.entries(it.custom).filter(([, v]) => v)), groups: it.newGroups, skipConflicts: true });
        if (it.emails) userService.saveEmails(user.id, it.emails);
        settle(dir, cfg, user, null, it.signals, now);
        auditLog.admin('provisioning.user_create', { actor: actorOf(dir), target: userTarget(user), detail: { external_id: it.external_id, active: it.want.active, groups: it.newGroups } });
      } else if (it.action === 'update') {
        const user = db.get('SELECT * FROM users WHERE id = ?', it.userId);
        const prev = db.get('SELECT * FROM provisioning_state WHERE user_id = ?', it.userId) || null;
        const writes = Object.keys(it.fields).length || it.mergedCustom || it.changes.includes('groups');
        const fresh = writes ? directories.writeUser(dir, user, it.fields, { custom: it.mergedCustom, groups: it.changes.includes('groups') ? it.newGroups : undefined, skipConflicts: true }) : user;
        if (it.emails) userService.saveEmails(user.id, it.emails);
        else if (it.clearEmail) userService.saveEmails(user.id, userService.emailsOf(user.id).filter((e) => !e.primary));
        settle(dir, cfg, fresh, prev, it.signals, now);
      }
    }
    for (const uid of p.missing) {
      const user = db.get('SELECT * FROM users WHERE id = ?', uid);
      const prev = db.get('SELECT * FROM provisioning_state WHERE user_id = ?', uid);
      if (user) settle(dir, cfg, user, prev, { ...signalsOf(prev), missing: true }, now);
    }
  });
}

/* ------------------------------- Running a feed ---------------------------- */

const running = new Set();

function record(dir, { via, mode, status, actor, summary, rows }) {
  const id = Number(db.run('INSERT INTO provisioning_runs (directory_id, started_at, via, mode, status, actor, summary, report) VALUES (?,?,?,?,?,?,?,?)',
    dir.id, nowSec(), via, mode, status, actor || '', JSON.stringify(summary), JSON.stringify(rows || [])).lastInsertRowid);
  db.run('DELETE FROM provisioning_runs WHERE directory_id = ? AND id NOT IN (SELECT id FROM provisioning_runs WHERE directory_id = ? ORDER BY id DESC LIMIT ?)', dir.id, dir.id, KEEP_RUNS);
  return id;
}

const reportRows = (items) => items.filter((x) => x.action !== 'unchanged').slice(0, MAX_REPORT)
  .map((x) => ({ row: x.row, external_id: x.external_id, username: x.username, action: x.action, changes: x.changes, errors: x.errors, warnings: x.warnings }));

/**
 * Applies (or, with dryRun, only previews) one delivery of a feed. `input` is the CSV or JSON text, or a parsed JSON value.
 * Options: via ('push' | 'pull' | 'upload'), format (overrides the configured one), mode, dryRun, force (ignore the safety
 * limits), actor (a name for the run history). Resolves to { status: 'applied' | 'preview' | 'blocked', ... }.
 */
async function run(dir, input, { via, format, mode, dryRun = false, force = false, actor = '' } = {}) {
  const cfg = config(dir.id);
  if (running.has(dir.id)) throw new FeedError(409, 'A run for this directory is already in progress.');
  running.add(dir.id);
  try {
    const m = MODES.includes(mode) ? mode : cfg.mode;
    let p;
    try {
      const records = parseRecords(input, { format: format || cfg.format, recordsPath: cfg.recordsPath });
      p = plan(dir, cfg, records, { mode: m });
    } catch (e) {
      if (e instanceof FeedError && !dryRun) record(dir, { via, mode: m, status: 'failed', actor, summary: { error: e.message, errors: e.errors } });
      throw e;
    }
    const rows = reportRows(p.items);
    const base = { mode: m, summary: p.summary, rows, shown: rows.length, hidden: Math.max(0, p.items.filter((x) => x.action !== 'unchanged').length - rows.length) };
    if (dryRun) return { status: 'preview', blocked: p.blocked || undefined, ...base };
    if (p.blocked && !force) {
      const id = record(dir, { via, mode: m, status: 'blocked', actor, summary: { ...p.summary, blocked: p.blocked }, rows });
      auditLog.admin('provisioning.run', { outcome: 'failure', actor: actorOf(dir), target: { type: 'directory', id: dir.id, name: dir.name }, detail: { via, mode: m, blocked: p.blocked, ...p.summary } });
      return { status: 'blocked', blocked: p.blocked, run_id: id, ...base };
    }
    apply(dir, cfg, p);
    const id = record(dir, { via, mode: m, status: 'applied', actor, summary: p.summary, rows });
    auditLog.admin('provisioning.run', { actor: actorOf(dir), target: { type: 'directory', id: dir.id, name: dir.name }, detail: { via, mode: m, forced: force && Boolean(p.blocked), by: actor || undefined, ...p.summary } });
    directories.recordActivity(dir.id, `Feed: ${p.summary.created} created, ${p.summary.updated} updated, ${p.summary.leavers + p.summary.deactivated} deactivated`);
    lifecycleTick(nowSec(), dir.id);
    return { status: 'applied', run_id: id, ...base };
  } finally {
    running.delete(dir.id);
  }
}

/** Fetches the configured feed URL and runs it. */
async function pull(dir, opts = {}) {
  const cfg = config(dir.id);
  if (!cfg.pull.url) throw new FeedError(400, 'No feed URL is configured.');
  db.run('UPDATE provisioning_feeds SET last_pull_at = ? WHERE directory_id = ?', nowSec(), dir.id);
  let text;
  try {
    const headers = cfg.pull.authValue ? { [cfg.pull.authHeader]: cfg.pull.authValue } : undefined;
    ({ text } = await safeFetchText(cfg.pull.url, { timeoutMs: 60000, maxBytes: PULL_MAX_BYTES, headers }));
  } catch (e) {
    const message = `The feed could not be fetched: ${String(e.message).replace(/https?:\/\/\S+/g, '[url]')}`;
    if (!opts.dryRun) {
      record(dir, { via: opts.via || 'pull', mode: opts.mode || cfg.mode, status: 'failed', actor: opts.actor, summary: { error: message } });
      auditLog.admin('provisioning.run', { outcome: 'failure', actor: actorOf(dir), target: { type: 'directory', id: dir.id, name: dir.name }, detail: { via: 'pull', error: message } });
    }
    throw new FeedError(502, message);
  }
  return run(dir, text, { via: 'pull', ...opts });
}

/* -------------------------------- Lifecycle job ---------------------------- */

/**
 * Applies the dates and deletions that have come due, without waiting for the next delivery: accounts switch on at their
 * start date and off after their end date, and people deactivated for long enough are deleted. Returns the counts.
 */
function lifecycleTick(now = nowSec(), onlyDirectory = null) {
  const out = { activated: 0, deactivated: 0, deleted: 0 };
  const feeds = db.all('SELECT directory_id FROM provisioning_feeds').map((f) => f.directory_id).filter((id) => !onlyDirectory || id === onlyDirectory);
  for (const id of feeds) {
    const dir = directories.get(id);
    if (!dir) continue;
    const cfg = config(id);
    db.tx(() => {
      for (const s of db.all('SELECT * FROM provisioning_state WHERE directory_id = ?', id)) {
        const user = db.get('SELECT * FROM users WHERE id = ?', s.user_id);
        if (!user) continue;
        const want = lifecycle(signalsOf(s), now, cfg);
        if (want.active !== Boolean(s.desired)) {
          const change = settle(dir, cfg, user, s, signalsOf(s), now);
          if (change === 'reactivated') out.activated++; else if (change === 'deactivated') out.deactivated++;
        }
        if (cfg.deleteAfterDays > 0 && !want.active && want.reason !== 'prehire') {
          const fresh = db.get('SELECT * FROM provisioning_state WHERE user_id = ?', s.user_id);
          if (fresh.inactive_since && fresh.inactive_since + cfg.deleteAfterDays * DAY <= now && !fresh.desired) {
            if (roles.permissionsOf(user.id).size) continue; // an administrator is never deleted by a feed
            userService.revokeSessions(user.id);
            db.run('DELETE FROM users WHERE id = ?', user.id);
            auditLog.admin('provisioning.user_delete', { actor: actorOf(dir), target: userTarget(user), detail: { reason: want.reason, after_days: cfg.deleteAfterDays } });
            out.deleted++;
          }
        }
      }
    });
  }
  return out;
}

/** Fetches the feeds that are due. Returns how many ran. */
async function runDuePulls(now = nowSec()) {
  let n = 0;
  for (const f of db.all('SELECT directory_id, last_pull_at FROM provisioning_feeds')) {
    const cfg = config(f.directory_id);
    const dir = directories.get(f.directory_id);
    if (!dir || !dir.enabled || !cfg.enabled || !cfg.pull.url || !cfg.pull.intervalMinutes) continue;
    if (now - f.last_pull_at < cfg.pull.intervalMinutes * 60) continue;
    try { await pull(dir, { via: 'pull', actor: 'schedule' }); } catch (e) { if (!(e instanceof FeedError)) console.error('Provisioning pull failed:', e.message); }
    n++;
  }
  return n;
}

function startJob({ intervalMs = 60 * 1000, log = console } = {}) {
  let lastTick = 0;
  const tick = async () => {
    await runDuePulls();
    if (nowSec() - lastTick >= 600) {
      lastTick = nowSec();
      const r = lifecycleTick();
      if (r.activated || r.deactivated || r.deleted) log.log(`Provisioning: ${r.activated} activated, ${r.deactivated} deactivated, ${r.deleted} deleted.`);
    }
  };
  const safe = () => tick().catch((e) => log.error('Provisioning job failed:', e.message));
  safe();
  const timer = setInterval(safe, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

const runDetail = (directoryId, id) => {
  const r = db.get('SELECT * FROM provisioning_runs WHERE directory_id = ? AND id = ?', directoryId, Number(id) || 0);
  return r && { ...r, summary: JSON.parse(r.summary), rows: JSON.parse(r.report) };
};

module.exports = {
  FeedError, TARGETS, config, parseConfig, saveConfig, view, reference, prepareRules, parseRecords, mapRecord, plan, run, pull,
  lifecycle, lifecycleTick, runDuePulls, startJob, runDetail, EXAMPLE_RULES,
};
