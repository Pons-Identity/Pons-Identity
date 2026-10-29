const db = require('./db');
const apps = require('./apps');
const auditLog = require('./audit');
const { effectivePolicy } = require('./policies');

// What CAS and OpenID Connect/OAuth 2.0 endpoints share when a browser arrives: who is signed in, and whether they may use the app.

const target = (app) => ({ type: 'application', id: app.id, name: app.name });

/** The signed-in, active user for this session, or null. */
function sessionUser(req) {
  return req.session.userId ? db.get('SELECT * FROM users WHERE id = ? AND active = 1', req.session.userId) || null : null;
}

/** The page that makes a person choose a new password (after an administrator enforced new rules), coming back to `resume`. */
const passwordChangeUrl = (resume) => `/account/profile?next=${encodeURIComponent(resume)}`;

/** Seconds since the person last authenticated in this session. */
function sessionAge(req) {
  const t = Date.parse(req.session.authnInstant);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((Date.now() - t) / 1000));
}

const authTime = (req) => Math.floor(Date.now() / 1000) - sessionAge(req);

/** Sign-in policy and per-app access. Returns null when allowed, else the reason ('blocked_by_policy' | 'no_access'). */
function denial(app, user) {
  if (effectivePolicy(user.id).blockSignIn) return 'blocked_by_policy';
  if (!apps.userHasAccess(app, user.id)) return 'no_access';
  return null;
}

function auditDenied(req, app, user, reason) {
  auditLog.user('sso.denied', { outcome: 'failure', req, actor: auditLog.who(user), target: target(app), detail: { protocol: app.protocol, reason } });
}

function auditIssued(req, app, user, detail = {}) {
  auditLog.user('sso.assertion_issued', { req, actor: auditLog.who(user), target: target(app), detail: { protocol: app.protocol, amr: req.session.amr, ...detail } });
}

module.exports = { passwordChangeUrl, sessionUser, sessionAge, authTime, denial, auditDenied, auditIssued, target };
