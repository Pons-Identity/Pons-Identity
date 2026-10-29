const db = require('../db');
const gm = require('../group-membership');
const auditLog = require('../audit');
const authlog = require('../authlog');

// What a report script can read through report.*. Every function checks the permissions of the person running the report
// (ctx.perms), not the person who wrote it, so writing reports never widens anyone's view. Nothing here changes anything.

class ReportError extends Error {}

const MAX_ROWS = 20000;
const MAX_LOG_ROWS = 5000;
const MAX_DAYS = 365;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const need = (ctx, permission, what) => {
  if (!ctx.perms.has(permission)) throw new ReportError(`${what} needs the "${permission}" permission, which you do not have.`);
};
const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
const sqlTime = (s) => (s ? new Date(`${s}Z`).toISOString() : null);

function days(o, fallback) {
  const n = o.days === undefined ? fallback : Number(o.days);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DAYS) throw new ReportError(`days must be between 1 and ${MAX_DAYS}.`);
  return n;
}

function limit(o, fallback, max) {
  const n = o.limit === undefined ? fallback : Number(o.limit);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ReportError(`limit must be a whole number from 1 to ${max}.`);
  return n;
}

function options(o) {
  if (o === undefined || o === null) return {};
  if (!isObject(o)) throw new ReportError('Pass an object of options, such as { days: 7 }.');
  return o;
}

function users(ctx, o) {
  need(ctx, 'users.view', 'report.users');
  o = options(o);
  const max = limit(o, MAX_ROWS, MAX_ROWS);
  const where = o.active === undefined ? '' : `WHERE active = ${o.active ? 1 : 0}`;
  const rows = db.all(`SELECT * FROM users ${where} ORDER BY username COLLATE NOCASE LIMIT ?`, max);

  const groups = new Map();
  for (const r of db.all('SELECT m.user_id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id ORDER BY g.name')) {
    if (!groups.has(r.user_id)) groups.set(r.user_id, []);
    groups.get(r.user_id).push(r.name);
  }
  const attributes = new Map();
  for (const r of db.all('SELECT user_id, name, value FROM user_attributes ORDER BY name')) {
    if (!attributes.has(r.user_id)) attributes.set(r.user_id, {});
    attributes.get(r.user_id)[r.name] = r.value;
  }
  // The sign-in log is audit data, so a last sign-in is only filled in for someone who may see it.
  const lastSignIn = new Map();
  if (ctx.perms.has('audit.view')) {
    for (const r of db.all("SELECT user_id, MAX(ts) AS ts FROM auth_events WHERE type = 'signin' AND outcome = 'success' AND user_id IS NOT NULL GROUP BY user_id")) lastSignIn.set(r.user_id, r.ts);
  }

  return rows.map((u) => ({
    id: u.guid, username: u.username, first_name: u.first_name, last_name: u.last_name, display_name: u.display_name,
    email: u.email, employee_id: u.employee_id, department: u.department, title: u.title, company: u.company, manager: u.manager,
    active: Boolean(u.active), mfa_required: Boolean(u.mfa_enabled), source: u.directory_id ? 'directory' : 'local',
    groups: groups.get(u.id) || [], attributes: attributes.get(u.id) || {},
    password_changed_at: sqlTime(u.password_changed_at), created_at: sqlTime(u.created_at), last_sign_in: iso(lastSignIn.get(u.id)),
  }));
}

function groups(ctx) {
  need(ctx, 'groups.view', 'report.groups');
  return db.all('SELECT * FROM groups ORDER BY name COLLATE NOCASE').map((g) => ({
    name: g.name, description: g.description, source: g.source, members: gm.effectiveMembers(g.id).size,
  }));
}

function signIns(ctx, o) {
  need(ctx, 'audit.view', 'report.signIns');
  o = options(o);
  const filters = { from: Math.floor(Date.now() / 1000) - days(o, 7) * 86400 };
  for (const k of ['type', 'outcome', 'username', 'country', 'ip']) if (o[k] !== undefined) filters[k] = String(o[k]);
  return authlog.query(filters, limit(o, 1000, MAX_LOG_ROWS)).map((r) => ({
    time: iso(r.ts), type: r.type, outcome: r.outcome, reason: r.reason, username: r.username, factor: r.factor,
    ip: r.ip, country: r.country, city: r.city, browser: r.browser, os: r.os, device_type: r.device_type,
    risk_level: r.risk_level, risk_score: r.risk_score,
  }));
}

function audit(ctx, o) {
  need(ctx, 'audit.view', 'report.audit');
  o = options(o);
  const filters = { from: Math.floor(Date.now() / 1000) - days(o, 7) * 86400 };
  for (const k of ['category', 'action', 'outcome', 'actor']) if (o[k] !== undefined) filters[k] = String(o[k]);
  return auditLog.query(filters, limit(o, 1000, MAX_LOG_ROWS)).map((r) => ({
    time: iso(r.ts), category: r.category, action: r.action, outcome: r.outcome, actor: r.actor_name,
    target_type: r.target_type, target: r.target_name, ip: r.ip, detail: r.detail,
  }));
}

// name -> function(ctx, ...args). host.js registers these under the "report:read" scope, which only reports are given.
const FUNCTIONS = { 'report.users': users, 'report.groups': groups, 'report.signIns': signIns, 'report.audit': audit };

// For the console's reference panel.
const REFERENCE = [
  { signature: 'await report.users({ active?, limit? })', requires: 'users.view', returns: 'ReportUser[]', description: 'Every user, local and from external directories, oldest field first by username. last_sign_in is filled in only if you also hold audit.view.', example: 'const users = await report.users({ active: true });\nreturn users.filter((u) => !u.mfa_required);' },
  { signature: 'await report.groups()', requires: 'groups.view', returns: '{ name, description, source, members }[]', description: 'Every group with its number of members, including members who belong through nested groups.', example: 'return (await report.groups()).filter((g) => g.members === 0);' },
  { signature: 'await report.signIns({ days?, type?, outcome?, username?, country?, ip?, limit? })', requires: 'audit.view', returns: '{ time, type, outcome, reason, username, factor, ip, country, city, browser, os, device_type, risk_level, risk_score }[]', description: 'The sign-in log, newest first. days defaults to 7 (at most 365); limit defaults to 1000 (at most 5000).', example: 'return await report.signIns({ days: 1, outcome: "failure" });' },
  { signature: 'await report.audit({ days?, category?, action?, outcome?, actor?, limit? })', requires: 'audit.view', returns: '{ time, category, action, outcome, actor, target_type, target, ip, detail }[]', description: 'The audit log, newest first, with the same defaults and limits as report.signIns.', example: 'return await report.audit({ days: 30, action: "user.delete" });' },
];

const USER_FIELDS = [
  ['id', 'string', 'The GUID.'], ['username', 'string', ''], ['first_name', 'string', ''], ['last_name', 'string', ''], ['display_name', 'string', ''],
  ['email', 'string', ''], ['employee_id', 'string', ''], ['department', 'string', ''], ['title', 'string', ''], ['company', 'string', ''], ['manager', 'string', ''],
  ['active', 'boolean', 'false means the person cannot sign in.'], ['mfa_required', 'boolean', 'Whether a second factor is required.'],
  ['source', 'string', '"local" or "directory".'], ['groups', 'string[]', 'Groups the person was directly added to.'], ['attributes', 'object', 'Name → value.'],
  ['password_changed_at', 'string | null', 'ISO time.'], ['created_at', 'string', 'ISO time.'], ['last_sign_in', 'string | null', 'ISO time of the last successful sign-in; needs audit.view.'],
];

module.exports = { FUNCTIONS, REFERENCE, USER_FIELDS, ReportError, MAX_ROWS };
