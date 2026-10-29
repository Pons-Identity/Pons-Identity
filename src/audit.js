const crypto = require('crypto');
const db = require('./db');
const context = require('./audit-context');

const SECRET_KEY = /pass(word)?|secret|token|totp|private|credential|authorization|bindPassword|apikey|api_key/i;
const MAX_DEPTH = 6;

// Drop anything that looks like a credential, at any depth, before it is stored or sent anywhere.
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

const sinks = [];
/** Forwarders register here; each is called with the stored row after it commits. */
const onRecord = (fn) => { sinks.push(fn); };

// users.id/username for the signed-in session of the current request, if any.
function sessionActor(ctx) {
  const userId = ctx && ctx.req && ctx.req.session && ctx.req.session.userId;
  if (!userId) return null;
  const u = ctx.req.user && ctx.req.user.id === userId ? ctx.req.user : db.get('SELECT id, username FROM users WHERE id = ?', userId);
  return u ? { type: 'user', id: u.id, name: u.username } : null;
}

/**
 * Append an event. Never throws: a failure to audit must not break the action being audited.
 *   category: 'system' | 'admin' | 'user'      action: dotted name, e.g. 'login.failure'
 *   actor:  { type, id, name } (defaults to the signed-in user of the current request, else anonymous/system)
 *   target: { type, id, name }                 detail: JSON-able object (redacted)
 */
function record({ category, action, outcome = 'success', actor, target, detail, ip, req } = {}) {
  try {
    const ctx = context.current();
    const a = actor || sessionActor(req ? { req } : ctx) || { type: ctx ? 'anonymous' : 'system', name: '' };
    const t = target || {};
    const sess = (req || (ctx && ctx.req));
    const sid = sess && sess.sessionID ? crypto.createHash('sha256').update(sess.sessionID).digest('hex').slice(0, 16) : '';
    const row = {
      ts: Math.floor(Date.now() / 1000),
      category, action, outcome,
      actor_type: a.type || 'system',
      actor_id: a.id == null ? null : a.id,
      actor_name: a.name || '',
      target_type: t.type || '',
      target_id: t.id == null ? '' : String(t.id),
      target_name: t.name || '',
      ip: ip || (ctx && ctx.ip) || '',
      user_agent: (ctx && ctx.userAgent) || '',
      session_id: sid,
      request_id: (ctx && ctx.requestId) || '',
      detail: JSON.stringify(redact(detail || {})),
    };
    const info = db.run(
      `INSERT INTO audit_log (ts, category, action, outcome, actor_type, actor_id, actor_name, target_type, target_id,
                              target_name, ip, user_agent, session_id, request_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.ts, row.category, row.action, row.outcome, row.actor_type, row.actor_id, row.actor_name, row.target_type,
      row.target_id, row.target_name, row.ip, row.user_agent, row.session_id, row.request_id, row.detail);
    row.id = Number(info.lastInsertRowid);
    for (const fn of sinks) {
      try { fn(row); } catch (e) { console.error('audit sink failed:', e.message); }
    }
    return row.id;
  } catch (e) {
    console.error('audit record failed:', e.message);
    return null;
  }
}

// Convenience wrappers that fix the category.
const system = (action, o = {}) => record({ ...o, category: 'system', action, actor: o.actor || { type: 'system', name: 'system' } });
const admin = (action, o = {}) => record({ ...o, category: 'admin', action });
const user = (action, o = {}) => record({ ...o, category: 'user', action });

/** `user` shaped for an actor/target argument. */
const who = (u) => (u ? { type: 'user', id: u.id, name: u.username } : undefined);

const FILTERS = {
  category: 'category = ?', action: 'action = ?', outcome: 'outcome = ?', actor: 'actor_name = ?',
  actorId: 'actor_id = ?', targetType: 'target_type = ?', targetId: 'target_id = ?', ip: 'ip = ?',
};

function where(f) {
  const clauses = [];
  const args = [];
  for (const [k, sql] of Object.entries(FILTERS)) {
    if (f[k] !== undefined && f[k] !== '') { clauses.push(sql); args.push(f[k]); }
  }
  if (f.from) { clauses.push('ts >= ?'); args.push(Number(f.from)); }
  if (f.to) { clauses.push('ts <= ?'); args.push(Number(f.to)); }
  if (f.before) { clauses.push('id < ?'); args.push(Number(f.before)); }
  if (f.q) {
    const like = `%${String(f.q).replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push(`(action LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR target_name LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')`);
    args.push(like, like, like, like);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/** Newest first; pass the last returned id as `before` for the next page. */
function query(filters = {}, limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 5000);
  const w = where(filters);
  return db.all(`SELECT * FROM audit_log ${w.sql} ORDER BY id DESC LIMIT ?`, ...w.args, n)
    .map((r) => ({ ...r, detail: safeParse(r.detail) }));
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/** Delete rows older than `days` days. 0 keeps everything. Returns the number removed. */
function prune(days) {
  if (!days || days <= 0) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return Number(db.run('DELETE FROM audit_log WHERE ts < ?', cutoff).changes);
}

module.exports = { record, system, admin, user, who, redact, query, prune, onRecord, safeParse };
