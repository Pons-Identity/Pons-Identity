const db = require('./db');
const factors = require('./factors');
const settings = require('./factors/settings');
const auditLog = require('./audit');

// Application policies: what sign-in must look like before an application (OpenID Connect, OAuth 2.0, CAS) or a SAML service
// provider may be given a sign-in. Each policy names the applications it covers and requires MFA, phishing-resistant factors,
// or one of a set of factors. Several policies can cover the same application; each rule takes the strictest value.
//
// When a signed-in person's current sign-in does not meet the rule, they are asked for a second factor that does (a step-up),
// and sent back to the application afterwards. If they have no such factor, they are refused.

const FACTOR_NAMES = { totp: 'authenticator app', webauthn: 'security key or passkey', email: 'email', sms: 'text message', voice: 'phone call' };
const MODE_NAMES = { code: 'code', number_match: 'number matching', yes_no: 'yes or no', yes_no_verified: 'yes or no with the code' };
// A method is 'totp', 'webauthn' or 'channel:mode' (factors/settings.js). A whole channel name also means each of its ways.
const nameOf = (method) => {
  const [type, mode] = method.split(':');
  return mode ? `${FACTOR_NAMES[type]} ${MODE_NAMES[mode]}` : FACTOR_NAMES[type];
};
const TABLES = { app: { table: 'app_policy_apps', column: 'app_id' }, sp: { table: 'app_policy_sps', column: 'sp_id' } };

function combine(rows) {
  const allowed = rows.filter((r) => r.allowed_factors).map((r) => r.allowed_factors.split(',')).reduce((a, b) => (a ? a.filter((t) => b.includes(t)) : b), null);
  const requirePhishingResistant = rows.some((r) => r.require_phishing_resistant);
  return {
    // Naming factors, or requiring phishing resistance, already means a second factor is needed.
    requireMfa: rows.some((r) => r.require_mfa) || requirePhishingResistant || allowed !== null,
    requirePhishingResistant,
    allowedFactors: allowed,
    sources: rows.map((r) => r.name),
  };
}

/** The application policies that cover one application ('app') or service provider ('sp'). */
function policiesCovering(kind, id) {
  const { table, column } = TABLES[kind];
  return db.all(`SELECT p.* FROM app_policies p JOIN ${table} t ON t.policy_id = p.id WHERE t.${column} = ? ORDER BY p.name`, id);
}

/** The combined requirements for one application ('app') or service provider ('sp'), or null when no policy covers it. */
function requirementsFor(kind, id) {
  const rows = policiesCovering(kind, id);
  return rows.length ? combine(rows) : null;
}

/** Does the sign-in's method (`{ id, type }`, or null for a password alone) meet the requirements (null = none)? */
function satisfies(method, reqs) {
  if (!reqs) return true;
  if (!method) return !reqs.requireMfa;
  if (reqs.allowedFactors && !factors.allows(reqs.allowedFactors, method.type)) return false;
  return !reqs.requirePhishingResistant || settings.phishingResistant(method.type);
}

function describe(reqs) {
  const parts = [];
  if (reqs.allowedFactors) parts.push(`one of these: ${reqs.allowedFactors.map(nameOf).join(', ')}`);
  else if (reqs.requirePhishingResistant) parts.push('a phishing-resistant factor');
  else parts.push('a second factor');
  return `This application requires ${parts.join(', ')} for sign-in.`;
}

/**
 * Checks the application policies for a signed-in person about to get a sign-in for `kind`/`id` ('app' or 'sp'). Returns null
 * when they may go ahead. Otherwise returns { stepUp: true } after starting a second-factor step that returns to `next`, or
 * { stepUp: false, message } when they have no factor that meets the rules. The caller answers the request.
 */
async function check(req, user, kind, id, next) {
  const reqs = requirementsFor(kind, id);
  if (satisfies(req.session.method, reqs)) return null;
  const usable = factors.eligible(user, { allowedFactors: reqs.allowedFactors, requirePhishingResistant: reqs.requirePhishingResistant }).map((f) => f.id);
  const message = describe(reqs);
  auditLog.user('sso.app_policy', { req, outcome: usable.length ? 'success' : 'failure', actor: auditLog.who(user), target: { type: kind === 'sp' ? 'service_provider' : 'application', id, name: '' },
    detail: { policies: reqs.sources, step_up: usable.length > 0 } });
  if (!usable.length) return { stepUp: false, message: `${message} Your account has no sign-in method that meets this. Contact an administrator.` };
  // Same shape as the sign-in's second step (api.js beginMfa), so the sign-in page can finish it and send the person on to `next`.
  const pending = req.session.pending;
  await new Promise((resolve, reject) => req.session.regenerate((err) => {
    if (err) return reject(err);
    if (pending) req.session.pending = pending;
    req.session.mfa = { userId: user.id, enroll: false, enrollOptions: [], factors: usable, next, attempts: 0, failures: 0, sends: 0, risk: null };
    resolve();
  }));
  return { stepUp: true };
}

module.exports = { requirementsFor, policiesCovering, satisfies, check, describe, nameOf };
