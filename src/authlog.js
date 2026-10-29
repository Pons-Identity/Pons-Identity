const db = require('./db');
const auditLog = require('./audit');
const context = require('./audit-context');
const geoip = require('./geoip');
const ua = require('./ua');

// The sign-in log: one row per step of signing in, with the network and device details an investigator needs (address, place,
// network, browser, device, how it was verified, how risky it looked). Most rows are made from the audit events the sign-in code
// already records (so every code path that logs a failure appears here), plus one written directly when a password is accepted.
// Rows are searchable and exportable by administrators with audit access; a person sees their own recent activity.

const CREDENTIAL_REASONS = new Set(['bad_credentials', 'unknown_user', 'directory_rejected', 'missing_credentials']);
const FACTOR_OF_AMR = [['hwk', 'webauthn'], ['sms', 'sms'], ['tel', 'voice'], ['otp', 'otp'], ['mfa', 'mfa']];
const factorOf = (amr) => (FACTOR_OF_AMR.find(([k]) => amr.includes(k)) || [null, ''])[1];

const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/** Writes one row for the request. `ev`: { type, outcome, reason, user, username, factor, amr, risk, sessionId }. Never throws. */
function record(req, ev) {
  try {
    const ip = (req && req.ip) || '';
    const geo = geoip.lookup(ip);
    const agent = String((req && req.get && req.get('user-agent')) || '').slice(0, 300);
    const parsed = ua.parse(agent);
    const userId = ev.user ? ev.user.id : (ev.userId ?? null);
    const deviceId = (req && req.deviceId) || '';
    // Known = this browser has completed a sign-in for this account before (checked before this row exists).
    const known = userId && deviceId
      ? (db.get("SELECT 1 FROM auth_events WHERE user_id = ? AND type = 'signin' AND outcome = 'success' AND device_id = ? LIMIT 1", userId, deviceId) ? 1 : 0)
      : null;
    const dg = req && req.deviceGeo;
    const risk = ev.risk || (req && req.risk) || null;
    db.run(`INSERT INTO auth_events (ts, type, outcome, reason, user_id, username, factor, amr, ip, country, country_name, region, city, lat, lon, asn, asn_org,
                                     device_id, device_known, user_agent, browser, os, device_type, device_lat, device_lon,
                                     risk_score, risk_level, risk_reasons, risk_action, session_id, request_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    Math.floor(Date.now() / 1000), ev.type, ev.outcome, ev.reason || '', userId, ev.username || (ev.user && ev.user.username) || '', ev.factor || '',
    JSON.stringify(ev.amr || []), ip, geo.country, geo.country_name, geo.region, geo.city, geo.lat, geo.lon, geo.asn, geo.asn_org,
    deviceId, known, agent, parsed.browser, parsed.os, parsed.device_type, dg ? dg.lat : null, dg ? dg.lon : null,
    risk ? risk.score : null, risk ? risk.level : '', JSON.stringify(risk ? risk.reasons : []), risk ? risk.action || '' : '',
    ev.sessionId || '', (context.current() && context.current().requestId) || '');
  } catch (e) {
    console.error('auth log failed:', e.message);
  }
}

// Turns the audit events that are part of signing in into rows. Runs inside the request that made the event, so the request's
// device and risk details are at hand.
auditLog.onRecord((row) => {
  const d = auditLog.safeParse(row.detail);
  let ev;
  switch (row.action) {
    case 'login.failure': ev = { type: CREDENTIAL_REASONS.has(d.reason) ? 'password' : 'signin', outcome: 'failure', reason: d.reason || '' }; break;
    case 'login.success': ev = { type: 'signin', outcome: 'success', amr: d.amr || [], factor: factorOf(d.amr || []) }; break;
    case 'mfa.failure': if (d.during) return; ev = { type: 'mfa', outcome: 'failure', reason: d.reason || 'failed', factor: d.method || '' }; break;
    case 'federated_login.success': ev = { type: 'signin', outcome: 'success', amr: d.amr || [], factor: 'federation' }; break;
    case 'federated_login.failure': ev = { type: 'signin', outcome: 'failure', reason: d.reason || 'federated_failed', factor: 'federation' }; break;
    case 'recovery.complete': ev = { type: 'recovery', outcome: 'success' }; break;
    default: return;
  }
  const named = row.target_type === 'user' ? { id: Number(row.target_id), name: row.target_name } : row.actor_type === 'user' ? { id: row.actor_id, name: row.actor_name } : null;
  const ctx = context.current();
  record(ctx && ctx.req, { ...ev, userId: named ? named.id : null, username: named ? named.name : row.actor_name, sessionId: row.session_id });
});

const FILTERS = { user_id: 'user_id = ?', username: 'username = ? COLLATE NOCASE', ip: 'ip = ?', country: 'country = ?', asn: 'asn = ?', device_id: 'device_id = ?', type: 'type = ?', outcome: 'outcome = ?', risk_level: 'risk_level = ?' };

function where(f) {
  const clauses = []; const args = [];
  for (const [k, sql] of Object.entries(FILTERS)) if (f[k] !== undefined && f[k] !== '') { clauses.push(sql); args.push(f[k]); }
  if (f.from) { clauses.push('ts >= ?'); args.push(Number(f.from)); }
  if (f.to) { clauses.push('ts <= ?'); args.push(Number(f.to)); }
  if (f.before) { clauses.push('id < ?'); args.push(Number(f.before)); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

const view = (r) => ({ ...r, amr: JSON.parse(r.amr), risk_reasons: JSON.parse(r.risk_reasons), device_known: r.device_known === null ? null : Boolean(r.device_known) });

/** Newest first; pass the last id as `before` for the next page. */
function query(filters = {}, limit = 100) {
  const w = where(filters);
  return db.all(`SELECT * FROM auth_events ${w.sql} ORDER BY id DESC LIMIT ?`, ...w.args, Math.min(Math.max(Number(limit) || 100, 1), 5000)).map(view);
}

/** What the last 90 days look like for one account, for the top of the investigation view. */
function summary(userId, now = Math.floor(Date.now() / 1000)) {
  const since = now - 90 * 86400;
  const ok = db.all("SELECT * FROM auth_events WHERE user_id = ? AND type = 'signin' AND outcome = 'success' AND ts >= ? ORDER BY id DESC", userId, since);
  const distinct = (key) => [...new Set(ok.map((r) => r[key]).filter((v) => v !== '' && v !== null))];
  const failures = db.get("SELECT COUNT(*) AS n FROM auth_events WHERE user_id = ? AND outcome = 'failure' AND ts >= ?", userId, now - 86400).n;
  return {
    last_success: ok[0] ? { ts: ok[0].ts, ip: ok[0].ip, city: ok[0].city, country: ok[0].country } : null,
    sign_ins_90d: ok.length, failures_24h: failures,
    countries: distinct('country'), asns: ok.filter((r) => r.asn).map((r) => ({ asn: r.asn, org: r.asn_org })).filter((v, i, a) => a.findIndex((x) => x.asn === v.asn) === i),
    ips: distinct('ip').length, devices: distinct('device_id').length,
    risky_90d: ok.filter((r) => r.risk_level && r.risk_level !== 'low').length,
  };
}

function prune(days) {
  if (!days || days <= 0) return 0;
  return Number(db.run('DELETE FROM auth_events WHERE ts < ?', Math.floor(Date.now() / 1000) - days * 86400).changes);
}

/** What a person may see about themselves: completed sign-ins and failed attempts, without internals. */
function activityFor(userId, limit = 30) {
  return db.all("SELECT ts, type, outcome, reason, factor, ip, city, country_name, browser, os, device_type, device_known FROM auth_events WHERE user_id = ? AND type IN ('signin', 'password', 'mfa') AND NOT (type = 'signin' AND outcome = 'failure' AND reason = '') ORDER BY id DESC LIMIT ?", userId, limit)
    .map((r) => ({ ...r, device_known: r.device_known === null ? null : Boolean(r.device_known) }));
}

module.exports = { record, query, summary, prune, activityFor, round, CREDENTIAL_REASONS };
