const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const userService = require('../user-service');
const guests = require('../guests');
const factors = require('../factors');
const recovery = require('../recovery');
const risk = require('../risk');
const authlog = require('../authlog');
const geoip = require('../geoip');
const device = require('../device');
const mfaRemember = require('../mfa-remember');
const compromise = require('../compromise');
const factorSettings = require('../factors/settings');
const identitySettings = require('../identity/settings');
const identity = require('../identity');
// The sign-in methods a policy may allow: each way a channel is on is its own method, and a channel name allows all of its ways.
const FACTOR_METHODS = factorSettings.METHODS.map((m) => m.id);
const FACTOR_CHOICES = [...FACTOR_METHODS, ...factorSettings.CHANNELS];
const attributeDefs = require('../attribute-defs');
const messagingSettings = require('../messaging/settings');
const messaging = require('../messaging');
const messageTemplates = require('../messaging/templates');
const bulkUsers = require('../bulk-users');
const scheduler = require('../user-scheduler');
const sps = require('../sps');
const apps = require('../apps');
const attrs = require('../attributes');
const duo = require('../duo');
const totp = require('../totp');
const fonts = require('../fonts');
const assets = require('../assets');
const { verifyPasswordAsync, dummyPasswordHash, BusyError, hashPassword, fingerprints } = require('../crypto');
const throttle = require('../throttle');
const security = require('../security-settings');
const { newGuid } = require('../guid');
const { buildMetadata } = require('../saml/metadata');
const { parseSpMetadata } = require('../saml/sp-metadata');
const { NAMEID_FORMATS, SIGNATURE_ALGORITHMS, ENCRYPTION_ALGORITHMS, KEY_TRANSPORT_ALGORITHMS } = require('../config');
const { buildAttributes, nameIdFor } = require('../saml/response');
const { normalizeCertificate } = require('../saml/encrypt');
const { parseRules } = require('../transform');
const { str, toArr, USER_FIELDS, customText, readUser, saveMemberships, saveRoles, saveCustom } = require('../admin-data');
const roles = require('../roles');
const settings = require('../settings');
const appSettings = require('../app-settings');
const scim = require('../scim');
const gm = require('../group-membership');
const acl = require('../group-acl');
const { audit } = require('../group-audit');
const auditLog = require('../audit');
const forwarder = require('../audit-forward');
const directories = require('../directories');
const ldap = require('../ldap');
const { safeFetchText } = require('../safe-fetch');
const { PERMISSIONS, normalize, isSubset } = require('../permissions');
const policies = require('../policies');
const passwordRules = require('../password-rules');
const search = require('../search');
const ldapFilterLib = require('../ldap-filter');
const { LdapFilterError } = ldapFilterLib;
const groupRules = require('../group-rules');
const ieGroups = require('../group-include-exclude');
const { groupErrors } = require('../group-naming');
const { rolesOf } = require('../group-pipeline');
const integrations = require('../integrations');

// JSON API used by the React front-end. Mirrors the HTML routes in auth.js and admin.js,
// which are retired once the SPA owns every screen.

const router = express.Router();
const ISSUER = 'PonsIdentity';
const MAX_MFA_ATTEMPTS = 5;

const { safeNext } = require('../safe-redirect');
const svgDataUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

// `method` is the second factor just completed ({ id, type }), or null for a password alone. It is kept on the session so an
// application policy can tell which factor was used (app-policies.js), and remembered for the browser when the policy says so.
function establishSession(req, user, amr, done, method = null, { remember = true } = {}) {
  const pending = req.session.pending;
  // The risk assessed at the password step travels in the half-finished sign-in; keep it for the sign-in log.
  req.risk = req.risk || (req.session.mfa && req.session.mfa.risk) || (req.session.duo && req.session.duo.risk) || null;
  req.session.regenerate((err) => {
    if (err) return done(err);
    req.session.userId = user.id;
    req.session.amr = amr;
    req.session.method = method;
    req.session.authnInstant = new Date().toISOString();
    if (pending) req.session.pending = pending;
    if (remember && method) mfaRemember.remember(req, user, method, amr);
    auditLog.user('login.success', { req, actor: auditLog.who(user), detail: { amr, remembered: !remember } });
    done(null);
  });
}

function currentUser(req) {
  const user = req.session.userId ? db.get('SELECT * FROM users WHERE id = ?', req.session.userId) : null;
  // A guest whose time is up is signed out wherever they are.
  return guests.expired(user) ? null : user;
}

// While a password change is required (an administrator enforced new password rules), only these account routes work.
const PASSWORD_CHANGE_PATHS = new Set(['/account/password', '/account/password-rules', '/account/mfa']);
const passwordChangePending = (res) => res.status(403).json({ error: 'You must choose a new password before continuing.', password_change_required: true });

function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  if (user.password_change_required && !PASSWORD_CHANGE_PATHS.has(req.path)) return passwordChangePending(res);
  req.user = user;
  next();
}

// The admin console is open to anyone holding at least one permission; each route then asks for its own.
function requireAdmin(req, res, next) {
  const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', req.session.userId || 0);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  if (user.password_change_required) return passwordChangePending(res);
  const perms = roles.permissionsOf(user.id);
  if (!perms.size) return res.status(403).json({ error: 'Administrator access is required.' });
  req.user = user;
  req.perms = perms;
  next();
}

const need = (permission) => (req, res, next) => {
  if (req.perms.has(permission)) return next();
  auditLog.admin('access.denied', { outcome: 'failure', actor: auditLog.who(req.user), detail: { permission, method: req.method, path: req.originalUrl.split('?')[0] } });
  return res.status(403).json({ error: 'You do not have permission to do that.' });
};

/* ------------------------------- Bootstrap -------------------------------- */

// The first-run setup wizard (setup.js): open only while there is nobody to sign in, or to someone holding setup.run.
router.use('/setup', require('./setup'));

router.get('/session', (req, res) => {
  const user = currentUser(req);
  const permissions = user && user.active ? [...roles.permissionsOf(user.id)] : [];
  res.json({
    // is_admin: may open the admin console (holds at least one permission).
    me: user && {
      id: user.id, username: user.username, display_name: user.display_name, is_admin: permissions.length > 0, permissions,
      // True after an administrator enforced new password rules: the front end sends the person to choose a new password.
      password_change_required: Boolean(user.password_change_required),
      // The person's own color theme ('light', 'dark' or 'system'): the front end applies it on every device.
      color_mode: user.active ? user.color_mode : 'system',
      manages_groups: user.active ? acl.delegatedGroups(user.id).length > 0 : false,
      self_service: user.active ? acl.available(user.id).length > 0 : false,
      hosts_guests: user.active ? guests.canHost(user) || guests.guestsOf(user.id).length > 0 : false,
      host: (() => { const h = guests.hostOf(user.id); return h ? { id: h.id, username: h.username, display_name: h.display_name } : null; })(),
      runs_integrations: user.active ? integrations.runnableBy(user.id).length > 0 : false,
    },
    csrf: res.locals.csrf,
    // True while the first-run wizard is open (nobody can sign in yet): the front end sends every visitor to /setup.
    setupRequired: require('../setup').required(),
    config: { duoEnabled: duo.enabled(), tls: !!settings.tls, federationLogin: appSettings.federationSp().enabled, passwordRecovery: recovery.available(), mfaReset: recovery.available() && identity.required('mfa_reset'), deviceGeolocation: risk.get().mode !== 'off' && risk.get().signals.device_geo.enabled },
    branding: appSettings.publicBranding(),
  });
});

// Institutions a person can sign in from. Public: it is the list on the sign-in page, drawn from public federation metadata.
router.get('/federation/idps', (req, res) => {
  res.json({ idps: require('../federation/sp').listIdps({ q: String(req.query.q || '').slice(0, 100), limit: Math.min(Number(req.query.limit) || 50, 100) }) });
});

router.get('/apps', requireLogin, (req, res) => {
  res.json(sps.listSps().map((s) => ({ ...s, launch: `/saml/${s.id}/init` })));
});

/* ------------------- Integrations a person's groups may run ---------------- */

// An administrator can allow a group to run an integration (without editing it). These routes serve those people; the script runs
// with the integration's own scopes, which is the point: a help desk can reset a password without being given user management.
const integrationInputs = (row) => JSON.parse(row.inputs || '[]').map((i) => ({ name: i.name, variable: i.variable }));

router.get('/my/integrations', requireLogin, (req, res) => {
  res.json(integrations.runnableBy(req.user.id).map((r) => ({ id: r.id, name: r.name, description: r.description, inputs: integrationInputs(r) })));
});

router.post('/my/integrations/:id/run', requireLogin, async (req, res, next) => {
  try {
    const row = integrations.runnableBy(req.user.id).find((r) => String(r.id) === String(req.params.id));
    if (!row) return res.status(404).json({ error: 'No such integration.' });
    const input = req.body && typeof req.body.input === 'object' && req.body.input !== null ? req.body.input : {};
    const { run } = await integrations.execute(row, { input, trigger: 'manual', actor: req.user.username });
    auditLog.user('integration.run_by_group', { actor: auditLog.who(req.user), target: { type: 'integration', id: row.id, name: row.name }, detail: { status: run.status } });
    // The runner sees how it went; the stored input and the run history stay with administrators.
    res.json({ run: { id: run.id, status: run.status, started_at: run.started_at, duration_ms: run.duration_ms, result: run.result, output: run.output, logs: run.logs, error: run.error } });
  } catch (e) { next(e); }
});

/* ---------------------------------- Login --------------------------------- */

// Verified Duo Push: when Duo requires it, the preauth answer has a transaction, a number to show, and when both expire.
// Times are kept in seconds, as Duo sends them.
const VERIFIED_PUSH_MARGIN_S = 10;
const verifiedOf = (verdict) => (verdict.txid && verdict.verification_code
  ? { txid: verdict.txid, code: verdict.verification_code, expires: Number(verdict.expiration) } : null);
const verifiedLive = (d) => Boolean(d.verified && d.verified.expires - VERIFIED_PUSH_MARGIN_S > Date.now() / 1000);

function beginDuo(req, user, verdict, next, riskInfo = null) {
  const pending = req.session.pending;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      if (pending) req.session.pending = pending;
      const canPush = (verdict.devices || []).some((d) => (d.capabilities || []).includes('push'));
      req.session.duo = { userId: user.id, next, canPush, attempts: 0, txid: null, verified: verifiedOf(verdict), error: null, risk: riskInfo };
      resolve();
    });
  });
}

// `factors` are the ids of the factors this sign-in may use ('totp', 'f<id>'); `enrollOptions` is what someone with no factor
// yet may set up now ('totp', 'webauthn'). Both are fixed here so they cannot change during the step.
function beginMfa(req, user, next, { factors: usable = [], enrollOptions = [], risk: riskInfo = null } = {}) {
  const pending = req.session.pending;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      if (pending) req.session.pending = pending;
      req.session.mfa = { userId: user.id, enroll: enrollOptions.includes('totp'), enrollOptions, factors: usable, next, attempts: 0, failures: 0, sends: 0, risk: riskInfo };
      resolve();
    });
  });
}

router.use('/login', device.read);

// A browser's own report of where it is (optional; asked for only when that signal is on). Rounded, and only ever used to raise risk.
function readDeviceGeo(v) {
  if (!v || typeof v !== 'object') return null;
  const lat = Number(v.lat); const lon = Number(v.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat: authlog.round(lat), lon: authlog.round(lon) } : null;
}

router.post('/login', async (req, res, next) => {
  try {
    const { username = '', password = '' } = req.body;
    const typed = typeof username === 'string' ? username.trim() : '';
    const nextUrl = safeNext(req.body.next);
    req.deviceGeo = readDeviceGeo(req.body.device_geo);
    // Failures are counted per typed name and per address, in the database, before anything about the account is looked up.
    const who = { account: typed, ip: req.ip };
    const COUNTED = new Set(['bad_credentials', 'unknown_user', 'inactive', 'directory_rejected']);
    // The response is always the same; the audit entry says why, which the person signing in must not learn.
    const bad = (reason = 'bad_credentials', target) => {
      if (COUNTED.has(reason)) throttle.fail('password', who);
      auditLog.user('login.failure', { outcome: 'failure', actor: { type: 'anonymous', name: typed }, target, detail: { reason } });
      return res.status(401).json({ error: 'Invalid username or password.' });
    };
    if (!typed || typeof password !== 'string') return bad('missing_credentials');
    const limited = throttle.check('password', who);
    if (limited.blocked) {
      auditLog.user('login.failure', { outcome: 'failure', actor: { type: 'anonymous', name: typed }, detail: { reason: 'throttled' } });
      res.set('Retry-After', String(limited.retryAfter));
      return res.status(429).json({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
    }

    let user = db.get('SELECT * FROM users WHERE username = ? OR email = ? OR id IN (SELECT user_id FROM user_emails WHERE email = ?) ORDER BY username = ? DESC', typed, typed, typed, typed);
    // Accounts owned by an LDAP/AD directory are checked there; unknown names may be created from one.
    let federated;
    try {
      federated = await directories.signIn(user, typed, password);
    } catch (e) {
      if (!(e instanceof ldap.DirectoryError)) throw e;
      console.error('Directory sign-in failed:', e.message);
      auditLog.user('login.failure', { outcome: 'failure', actor: { type: 'anonymous', name: typed }, detail: { reason: 'directory_unavailable' } });
      return res.status(503).json({ error: 'The directory is unavailable. Try again later.' });
    }
    if (federated) {
      if (federated.rejected) return bad('directory_rejected');
      user = federated.user;
      if (!user.active) return bad('inactive', { type: 'user', id: user.id, name: user.username });
    } else {
      // Every name costs the same work: one that does not exist (or is switched off) is checked against a hash nobody can match.
      const stored = user && user.active ? user.password_hash : '';
      let matched;
      try {
        matched = await verifyPasswordAsync(password, stored || dummyPasswordHash());
      } catch (e) {
        if (!(e instanceof BusyError)) throw e;
        res.set('Retry-After', '5');
        return res.status(503).json({ error: 'The server is busy. Try again shortly.' });
      }
      if (!(user && user.active && stored && matched)) {
        if (!user) return bad('unknown_user');
        return bad(user.active ? 'bad_credentials' : 'inactive', { type: 'user', id: user.id, name: user.username });
      }
    }
    throttle.reset('password', who);

    // A guest signs in only while the person hosting them is active.
    const host = guests.hostOf(user.id);
    if (guests.expired(user)) return bad('guest_expired', { type: 'user', id: user.id, name: user.username });
    if (host && !host.active) return bad('host_inactive', { type: 'user', id: user.id, name: user.username });

    const policy = policies.effectivePolicy(user.id);
    if (policy.blockSignIn) {
      auditLog.user('login.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { reason: 'blocked_by_policy' } });
      return res.status(403).json({ error: 'Sign-in is not permitted for this account.' });
    }
    // An account in lockdown signs in only from its allowed networks. Refused like a block, so the reply tells nobody why.
    const lockdown = compromise.lockdownFor(user.id);
    if (lockdown && !compromise.allowedFrom(lockdown, req.ip)) {
      auditLog.user('login.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { reason: 'compromise_lockdown' } });
      return res.status(403).json({ error: 'Sign-in is not permitted for this account.' });
    }

    // The password is right: make sure this browser has a device cookie, then ask how risky the sign-in looks.
    device.ensure(req, res);
    const riskCfg = risk.get();
    const enforcing = riskCfg.mode === 'enforce';
    let rr = { admin: false, block: false, forceMfa: false, extra: {}, narrows: false };
    if (riskCfg.mode !== 'off') {
      const a = risk.assess(user, { ip: req.ip, geo: geoip.lookup(req.ip), deviceId: req.deviceId, deviceGeo: req.deviceGeo });
      const action = risk.actionFor(a.level, policy, riskCfg);
      req.risk = { ...a, action: enforcing ? action : `report:${action}` };
      if (a.score > 0) {
        auditLog.user('risk.assessed', { actor: auditLog.who(user), detail: { score: a.score, level: a.level, action, mode: riskCfg.mode, reasons: a.reasons.map((r) => r.code) } });
      }
      if (enforcing) rr = risk.restriction(action, user);
    }
    authlog.record(req, { type: 'password', outcome: 'success', user, risk: req.risk });

    if (rr.block) {
      auditLog.user('login.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { reason: 'blocked_by_risk', score: req.risk.score } });
      return res.status(403).json({ error: 'Sign-in is not permitted right now. Contact an administrator.' });
    }
    const riskInfo = req.risk || null;

    // A second factor this browser completed recently, within the policy's remember period, is not asked for again.
    const remembered = rr.forceMfa || rr.narrows ? null : mfaRemember.rememberedFor(req, user, policy);
    if (remembered) {
      return establishSession(req, user, remembered.amr, (err) => {
        if (err) return next(err);
        res.json({ mfa: null, next: nextUrl, remembered: true });
      }, remembered.method, { remember: false });
    }

    // Duo cannot be narrowed to phishing-resistant methods, so a sign-in that must be phishing resistant uses our own factors.
    if (duo.enabled() && !rr.narrows) {
      let verdict;
      try {
        verdict = await duo.preauth(user.username, req.ip);
      } catch (e) {
        console.error('Duo preauth failed:', e.message);
        auditLog.user('login.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { reason: 'duo_unavailable' } });
        return res.status(503).json({ error: 'The second-factor service is unavailable. Try again later.' });
      }
      if (verdict.result === 'deny') auditLog.user('login.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { reason: 'duo_denied' } });
      if (verdict.result === 'deny') return res.status(403).json({ error: 'Sign-in is not permitted for this account.' });
      if (verdict.result === 'auth') {
        await beginDuo(req, user, verdict, nextUrl, riskInfo);
        return res.json({ mfa: 'duo' });
      }
    }

    const enrolled = factors.enrolled(user);
    for (let pass = 0; pass < 2; pass++) {
      if (!enrolled.length && !user.mfa_enabled && !policy.requireMfa && !rr.forceMfa) {
        return establishSession(req, user, ['pwd'], (err) => {
          if (err) return next(err);
          res.json({ mfa: null, next: nextUrl });
        });
      }

      const usable = factors.eligible(user, policy, rr.extra);
      if (usable.length) {
        await beginMfa(req, user, nextUrl, { factors: usable.map((f) => f.id), risk: riskInfo });
        return res.json({ mfa: 'totp', enroll: false });
      }

      if (rr.forceMfa || rr.narrows) {
        // The risk rules want more than the person has. Never let someone set up a method now (that is what a thief with the
        // password would do), and refuse. Administrators are not locked out by a score: for them the risk rules step aside,
        // and that is logged.
        if (rr.admin && pass === 0) {
          auditLog.user('risk.admin_fallback', { actor: auditLog.who(user), detail: { score: riskInfo && riskInfo.score, action: riskInfo && riskInfo.action } });
          rr = { admin: true, block: false, forceMfa: false, extra: {}, narrows: false };
          continue;
        }
        auditLog.user('login.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { reason: 'risk_no_permitted_factor', score: riskInfo && riskInfo.score } });
        return res.status(403).json({ error: 'This sign-in needs extra verification that your account cannot provide from here. Contact an administrator.' });
      }

      // Nothing set up: offer to set up a method that is allowed. Someone who has factors, none of them allowed (a policy now
      // demands a stronger one), is refused rather than let in with less; an administrator can reset their factors so they
      // can set up a permitted one.
      const options = enrolled.length ? [] : factors.signInEnrollment(policy);
      if (!options.length) {
        auditLog.user('login.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { reason: 'no_permitted_factor' } });
        return res.status(403).json({ error: 'None of your sign-in methods is allowed for your account. Contact an administrator.' });
      }
      await beginMfa(req, user, nextUrl, { enrollOptions: options, risk: riskInfo });
      return res.json({ mfa: 'totp', enroll: options.includes('totp') });
    }
  } catch (e) {
    next(e);
  }
});

// State for the TOTP page: the username, and the enrollment QR when the user must set up an authenticator.
router.get('/login/mfa', async (req, res, next) => {
  const m = req.session.mfa;
  if (!m) return res.status(404).json({ error: 'No sign-in in progress.' });
  try {
    const user = db.get('SELECT * FROM users WHERE id = ?', m.userId);
    let enroll = null;
    if (m.enroll) {
      if (!m.secret) m.secret = totp.generateSecret();
      const uri = totp.otpauthUri(ISSUER, user.email || user.username, m.secret);
      enroll = { secret: m.secret, qr: svgDataUrl(await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 })) };
    }
    const cfg = factorSettings.get();
    res.json({
      username: user.username, enroll,
      factors: (m.factors || ['totp']).map((id) => factors.optionById(user, id, cfg)).filter(Boolean).map((f) => factors.describe(f, cfg)),
      enroll_options: m.enrollOptions || (m.enroll ? ['totp'] : []),
      code_length: cfg.codeLength,
      number_length: cfg.numberLength,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/login/mfa', (req, res, next) => {
  const m = req.session.mfa;
  if (!m) return res.status(404).json({ error: 'No sign-in in progress.' });
  const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', m.userId);
  if (!user) { req.session.mfa = null; return res.status(404).json({ error: 'No sign-in in progress.' }); }
  if (!m.enroll && !(m.factors || ['totp']).includes('totp')) return res.status(400).json({ error: 'An authenticator app cannot be used for this sign-in.' });
  // Counted per account in the database, so signing in again (which makes a fresh session and a fresh attempt count) does not
  // give more guesses.
  const who = { account: user.id };
  const limited = throttle.check('totp', who);
  if (limited.blocked) {
    req.session.mfa = null;
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: 'totp', reason: 'throttled' } });
    res.set('Retry-After', String(limited.retryAfter));
    return res.status(429).json({ error: 'Too many incorrect codes. Try again in a few minutes.' });
  }
  if (++m.attempts > MAX_MFA_ATTEMPTS) {
    req.session.mfa = null;
    throttle.fail('totp', who);
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: 'totp', reason: 'lockout' } });
    return res.status(429).json({ error: 'Too many incorrect codes. Sign in again.' });
  }
  const secret = m.enroll ? m.secret : user.totp_secret;
  const step = totp.verify(secret, req.body.code, user.totp_last_step);
  if (step === null) {
    throttle.fail('totp', who);
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: 'totp', reason: 'bad_code' } });
    return res.status(401).json({ error: 'Incorrect or expired code.' });
  }
  throttle.reset('totp', who);

  if (m.enroll) {
    auditLog.user('mfa.enroll', { actor: auditLog.who(user), detail: { method: 'totp', via: 'sign-in' } });
    db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ?', secret, step, user.id);
  } else {
    db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
  }
  const nextUrl = m.next;
  req.risk = m.risk;
  req.session.mfa = null;
  establishSession(req, user, ['pwd', 'otp', 'mfa'], (err) => {
    if (err) return next(err);
    res.json({ next: nextUrl });
  }, { id: 'totp', type: 'totp' });
});

/* Duo second factor: a Duo Push (approved on the phone, polled) or a passcode. */

const duoUser = (d) => db.get('SELECT * FROM users WHERE id = ? AND active = 1', d.userId);

router.get('/login/duo', (req, res) => {
  const d = req.session.duo;
  if (!d) return res.status(404).json({ error: 'No sign-in in progress.' });
  const user = duoUser(d);
  if (!user) { req.session.duo = null; return res.status(404).json({ error: 'No sign-in in progress.' }); }
  const error = d.error;
  d.error = null;
  // The number to match in the Duo app. It is shown only while its transaction is still live.
  const verificationCode = verifiedLive(d) ? d.verified.code : null;
  res.json({ username: user.username, canPush: d.canPush, waiting: Boolean(d.txid), verificationCode, error });
});

router.post('/login/duo/push', async (req, res) => {
  const d = req.session.duo;
  const user = d && duoUser(d);
  if (!user) return res.status(404).json({ error: 'No sign-in in progress.' });
  try {
    // A Verified Push transaction lasts 60 seconds. If the person waited too long on this page, ask Duo for a fresh one.
    if (d.verified && !verifiedLive(d)) {
      const verdict = await duo.preauth(user.username, req.ip);
      if (verdict.result !== 'auth') throw new Error(`preauth returned ${verdict.result}`);
      d.verified = verifiedOf(verdict);
    }
    d.txid = (await duo.startPush(user.username, req.ip, d.verified && d.verified.txid)).txid;
    res.json({ waiting: true });
  } catch (e) {
    console.error('Duo push failed:', e.message);
    res.status(502).json({ error: 'Could not send a Duo Push. Try a passcode instead.' });
  }
});

router.get('/login/duo/status', async (req, res, next) => {
  const d = req.session.duo;
  const user = d && d.txid && duoUser(d);
  if (!user) return res.status(400).json({ result: 'error' });
  let r;
  try {
    r = await duo.pollPush(d.txid);
  } catch (e) {
    console.error('Duo status failed:', e.message);
    return res.status(503).json({ result: 'waiting' });
  }
  if (r.result === 'waiting') return res.json({ result: 'waiting' });
  d.txid = null;
  d.verified = null; // a finished transaction is never reused
  if (r.result !== 'allow') {
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: 'duo_push', reason: 'denied' } });
    d.error = 'The Duo Push was denied or timed out.';
    return res.json({ result: 'deny' });
  }
  const dest = d.next;
  establishSession(req, user, ['pwd', 'mfa'], (err) => {
    if (err) return next(err);
    res.json({ result: 'allow', next: dest });
  }, { id: 'duo', type: 'duo' });
});

router.post('/login/duo/passcode', async (req, res, next) => {
  const d = req.session.duo;
  const user = d && duoUser(d);
  if (!user) return res.status(404).json({ error: 'No sign-in in progress.' });
  if (++d.attempts > MAX_MFA_ATTEMPTS) {
    req.session.duo = null;
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: 'duo_passcode', reason: 'lockout' } });
    return res.status(429).json({ error: 'Too many incorrect codes. Sign in again.' });
  }
  const code = String(req.body.code || '').replace(/\s+/g, '');
  let r;
  try {
    r = await duo.checkPasscode(user.username, code, req.ip);
  } catch (e) {
    if (!(e instanceof duo.DuoError)) return next(e);
    r = { result: 'deny' };
  }
  if (r.result !== 'allow') {
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: 'duo_passcode', reason: 'bad_code' } });
    return res.status(401).json({ error: 'Incorrect or expired code.' });
  }
  const dest = d.next;
  establishSession(req, user, ['pwd', 'otp', 'mfa'], (err) => {
    if (err) return next(err);
    res.json({ next: dest });
  }, { id: 'duo', type: 'duo' });
});

/* ------------------------------ Account MFA ------------------------------- */

function accountView(req) {
  const u = req.user;
  return { username: u.username, totp_enabled: !!u.totp_enabled, mfa_enabled: !!u.mfa_enabled, can_change_password: !u.directory_id,
    password: userService.passwordInfo(u), personal_email: require('./recovery').personalView(u) };
}

async function accountEnroll(req) {
  if (req.user.totp_enabled) return null;
  if (!req.session.setupSecret) req.session.setupSecret = totp.generateSecret();
  const uri = totp.otpauthUri(ISSUER, req.user.email || req.user.username, req.session.setupSecret);
  return { secret: req.session.setupSecret, qr: svgDataUrl(await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 })) };
}

router.get('/account/mfa', requireLogin, async (req, res, next) => {
  try {
    res.json({ user: accountView(req), enroll: await accountEnroll(req) });
  } catch (e) {
    next(e);
  }
});

router.post('/account/mfa/enable', requireLogin, async (req, res, next) => {
  const secret = req.session.setupSecret;
  const step = secret && totp.verify(secret, req.body.code, 0);
  if (step === null || !secret) {
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(req.user), detail: { method: 'totp', reason: 'bad_code', during: 'enable' } });
    return res.status(400).json({ error: 'Incorrect or expired code.' });
  }
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ?', secret, step, req.user.id);
  auditLog.user('mfa.enable', { actor: auditLog.who(req.user), detail: { method: 'totp', via: 'account' } });
  req.session.setupSecret = null;
  req.user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  try {
    res.json({ user: accountView(req), enroll: await accountEnroll(req), notice: 'Authenticator enabled. It will be required at your next sign-in.' });
  } catch (e) {
    next(e);
  }
});

router.post('/account/mfa/disable', requireLogin, (req, res) => {
  const u = req.user;
  if (u.mfa_enabled || policies.effectivePolicy(u.id).requireMfa) {
    return res.status(409).json({ error: 'An administrator requires MFA for your account, so it cannot be disabled.' });
  }
  const who = { account: u.id };
  const limited = throttle.check('totp', who);
  if (limited.blocked) {
    res.set('Retry-After', String(limited.retryAfter));
    return res.status(429).json({ error: 'Too many incorrect codes. Try again in a few minutes.' });
  }
  const step = totp.verify(u.totp_secret, req.body.code, u.totp_last_step);
  if (step === null) {
    throttle.fail('totp', who);
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(u), detail: { method: 'totp', reason: 'bad_code', during: 'disable' } });
    return res.status(400).json({ error: 'Incorrect or expired code.' });
  }
  throttle.reset('totp', who);
  db.run("UPDATE users SET totp_secret = '', totp_enabled = 0, totp_last_step = 0 WHERE id = ?", u.id);
  auditLog.user('mfa.disable', { actor: auditLog.who(u), detail: { method: 'totp' } });
  req.user = db.get('SELECT * FROM users WHERE id = ?', u.id);
  res.json({ user: accountView(req), enroll: null, notice: 'Authenticator removed.' });
});

// Directory-owned accounts keep their password in the directory, so only local accounts can change it here.
router.post('/account/password', requireLogin, async (req, res, forward) => {
  const u = req.user;
  if (u.directory_id) return res.status(409).json({ error: 'Your password is managed by your directory.' });
  const { current_password: current, new_password: next } = req.body;
  // The current password is a password guess too, so it shares the sign-in limits (and cannot be used to get around them).
  const who = { account: u.username, ip: req.ip };
  const limited = throttle.check('password', who);
  if (limited.blocked) {
    res.set('Retry-After', String(limited.retryAfter));
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  let currentOk = false;
  try {
    currentOk = typeof current === 'string' && typeof next === 'string' && await verifyPasswordAsync(current, u.password_hash);
  } catch (e) {
    if (!(e instanceof BusyError)) return forward(e);
    return res.status(503).json({ error: 'The server is busy. Try again shortly.' });
  }
  if (!currentOk) {
    throttle.fail('password', who);
    auditLog.user('password.change', { outcome: 'failure', actor: auditLog.who(u), detail: { reason: 'bad_current_password' } });
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  throttle.reset('password', who);
  let problems;
  try { problems = await policies.passwordErrors(u.id, next); } catch (e) { return forward(e); }
  if (problems.length) {
    auditLog.user('password.change', { outcome: 'failure', actor: auditLog.who(u), detail: { reason: 'policy' } });
    return res.status(400).json({ error: problems.join(' '), errors: problems });
  }
  userService.setPassword(u.id, next, { by: u.id, via: 'self' });
  // Whoever else is signed in as this person (a stolen session, a forgotten browser) is signed out; this browser stays.
  userService.revokeSessions(u.id, { except: req.sessionID });
  auditLog.user('password.change', { actor: auditLog.who(u) });
  req.user = db.get('SELECT * FROM users WHERE id = ?', u.id);
  res.json({ notice: 'Password changed.', user: accountView(req) });
});

// The rules the signed-in person's password must meet, for the change-password form.
router.get('/account/password-rules', requireLogin, (req, res) => res.json(policies.passwordGuidance(req.user.id)));

// Saves the signed-in person's color theme to their account (the speed dial and the profile page both use it).
router.post('/account/color-mode', requireLogin, (req, res) => {
  const mode = req.body?.color_mode;
  if (!['light', 'dark', 'system'].includes(mode)) return res.status(400).json({ error: 'Choose light, dark or system.' });
  db.run('UPDATE users SET color_mode = ? WHERE id = ?', mode, req.user.id);
  res.json({ color_mode: mode });
});

// Asks for the second factor again at the next password sign-in, from every browser (the remember period ends at once).
router.post('/account/mfa/forget', requireLogin, (req, res) => {
  const cleared = mfaRemember.forget(req.user.id);
  auditLog.user('mfa.remember_cleared', { req, actor: auditLog.who(req.user), detail: { browsers: cleared } });
  res.json({ browsers: cleared });
});

router.use(require('./factors')({ establishSession, requireLogin, accountView }));
router.use(require('./recovery')({ requireLogin }));

/* ----------------------- My groups (per-group delegation) ----------------------- */

// People who hold a grant on a group but no admin role manage just those groups here.
router.use('/my/groups', (req, res, next) => requireLogin(req, res, (err) => {
  if (err || res.headersSent) return undefined;
  return req.user.active ? next() : res.status(401).json({ error: 'Sign in required.' });
}), require('./groups')({ delegated: true }));

/* ------------------------------------ Guests ------------------------------------ */

router.use('/my/guests', (req, res, next) => requireLogin(req, res, (err) => {
  if (err || res.headersSent) return undefined;
  return req.user.active ? next() : res.status(401).json({ error: 'Sign in required.' });
}), require('./guests')());

/* ---------------------------------- Admin --------------------------------- */

const admin = express.Router();
admin.use(requireAdmin);

const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });

// Sign-in figures for the dashboard. A step counts as failed or denied when a password, sign-in or second step was refused.
const SIGN_IN_BUCKET_SECONDS = 15 * 60;
const SIGN_IN_BUCKETS = 96; // 24 hours in 15-minute buckets
const FAILED_STEP = "outcome = 'failure' AND type IN ('password', 'signin', 'mfa')";

function signInStats(now) {
  const bucketStart = (Math.floor(now / SIGN_IN_BUCKET_SECONDS) - (SIGN_IN_BUCKETS - 1)) * SIGN_IN_BUCKET_SECONDS;
  const buckets = Array.from({ length: SIGN_IN_BUCKETS }, (_, i) => ({ ts: bucketStart + i * SIGN_IN_BUCKET_SECONDS, succeeded: 0, failed: 0 }));
  const perBucket = db.all(`SELECT CAST((ts - ?) / ${SIGN_IN_BUCKET_SECONDS} AS INTEGER) AS bucket,
      SUM(CASE WHEN type = 'signin' AND outcome = 'success' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN ${FAILED_STEP} THEN 1 ELSE 0 END) AS failed
    FROM auth_events WHERE ts >= ? AND ts <= ? GROUP BY bucket`, bucketStart, bucketStart, now);
  for (const r of perBucket) {
    if (buckets[r.bucket]) Object.assign(buckets[r.bucket], { succeeded: r.succeeded, failed: r.failed });
  }
  return {
    succeeded: buckets.reduce((n, b) => n + b.succeeded, 0),
    failed: buckets.reduce((n, b) => n + b.failed, 0),
    usersSignedIn: db.get("SELECT COUNT(DISTINCT user_id) AS n FROM auth_events WHERE type = 'signin' AND outcome = 'success' AND user_id IS NOT NULL AND ts >= ?", bucketStart).n,
    buckets,
  };
}

admin.get('/dashboard', (req, res) => {
  const count = (sql) => db.get(sql).n;
  const body = {
    users: count('SELECT COUNT(*) AS n FROM users'),
    activeUsers: count('SELECT COUNT(*) AS n FROM users WHERE active = 1'),
    groups: count('SELECT COUNT(*) AS n FROM groups'),
    sps: count('SELECT COUNT(*) AS n FROM service_providers') + count('SELECT COUNT(*) AS n FROM apps'),
    roles: count('SELECT COUNT(*) AS n FROM roles'),
  };
  // The sign-in log is for people with audit access, so the figures about sign-ins are too.
  if (req.perms.has('audit.view')) body.signIns = signInStats(Math.floor(Date.now() / 1000));
  res.json(body);
});

// Option lists for pickers and the SP form.
admin.get('/options', (req, res) => {
  res.json({
    attributes: attrs.listAttributes(),
    nameIdSources: attrs.listNameIdSources(),
    groups: db.all('SELECT id, name, source FROM groups ORDER BY name'),
    roles: db.all('SELECT id, name FROM roles ORDER BY name'),
    nameIdFormats: NAMEID_FORMATS,
    signatureAlgorithms: SIGNATURE_ALGORITHMS,
    encryptionAlgorithms: ENCRYPTION_ALGORITHMS,
    keyTransportAlgorithms: KEY_TRANSPORT_ALGORITHMS,
  });
});

/* Grouper */

function grouperView() {
  const g = appSettings.grouper();
  return {
    enabled: g.enabled,
    attributeName: g.attributeName,
    tokenSet: Boolean(g.tokenHash),
    tokenCreatedAt: g.tokenCreatedAt,
    scimUrl: `${settings.baseUrl}${scim.BASE}`,
    groupCount: db.get("SELECT COUNT(*) AS n FROM groups WHERE source = 'grouper'").n,
    lastActivity: appSettings.grouperActivity(),
    roleMappings: db.all(`SELECT m.group_name, m.role_id, r.name AS role_name FROM grouper_role_map m
                          JOIN roles r ON r.id = m.role_id ORDER BY m.group_name, r.name`),
  };
}

const mappingKey = (m) => `${String(m.group_name).toLowerCase()}\0${m.role_id}`;

// Parse submitted role mappings. Granting a role this way is granting it, so it takes Manage roles
// and the administrator must hold every permission the role carries (as when assigning it to a person).
function roleMappingChanges(req) {
  if (req.body.roleMappings === undefined) return { errors: [] };
  if (!Array.isArray(req.body.roleMappings)) return { errors: ['Role mappings must be a list.'] };
  const errors = [];
  const next = new Map();
  for (const m of req.body.roleMappings) {
    const group_name = str(m && m.group_name);
    const role_id = Number(m && m.role_id);
    if (!group_name && !m?.role_id) continue; // blank row
    if (!group_name || group_name.length > 512) errors.push('Each role mapping needs a Grouper group name.');
    else if (!db.get('SELECT 1 FROM roles WHERE id = ?', role_id)) errors.push(`Choose a role for "${group_name}".`);
    else next.set(mappingKey({ group_name, role_id }), { group_name, role_id });
  }
  const current = new Map(db.all('SELECT group_name, role_id FROM grouper_role_map').map((m) => [mappingKey(m), m]));
  const changed = [...next].filter(([k]) => !current.has(k)).concat([...current].filter(([k]) => !next.has(k))).map(([, m]) => m);
  if (changed.length && !req.perms.has('roles.manage')) errors.push('Changing role mappings needs the Manage roles permission.');
  else errors.push(...new Set(roles.assignmentErrors(req.user.id, [], [...new Set(changed.map((m) => m.role_id))])));
  return { errors, next: [...next.values()], changed: changed.length > 0 };
}

admin.get('/grouper', need('grouper.manage'), (req, res) => res.json(grouperView()));

admin.put('/grouper', need('grouper.manage'), (req, res) => {
  const { data, errors } = appSettings.parseGrouper(req.body);
  if (data.enabled && !appSettings.grouper().tokenHash) errors.push('Create a provisioning token before enabling the integration.');
  const mappings = roleMappingChanges(req);
  errors.push(...mappings.errors);
  if (errors.length) return fail(res, errors);
  db.tx(() => {
    appSettings.saveGrouper(data);
    if (mappings.next) {
      db.run('DELETE FROM grouper_role_map');
      for (const m of mappings.next) db.run('INSERT INTO grouper_role_map (group_name, role_id) VALUES (?, ?)', m.group_name, m.role_id);
    }
  });
  auditLog.admin('settings.grouper', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'grouper' },
    detail: { enabled: Boolean(data.enabled), role_mappings_changed: mappings.changed } });
  res.json(grouperView());
});

// Creating a token replaces the previous one; the plaintext is returned only here.
admin.post('/grouper/token', need('grouper.manage'), (req, res) => {
  const { token, hash } = scim.newToken();
  appSettings.saveGrouper({ tokenHash: hash, tokenCreatedAt: new Date().toISOString() });
  auditLog.admin('token.grouper.create', { actor: auditLog.who(req.user), target: { type: 'token', name: 'grouper provisioning' } });
  res.json({ ...grouperView(), token });
});

admin.delete('/grouper/token', need('grouper.manage'), (req, res) => {
  appSettings.saveGrouper({ tokenHash: '', tokenCreatedAt: '', enabled: false });
  auditLog.admin('token.grouper.delete', { actor: auditLog.who(req.user), target: { type: 'token', name: 'grouper provisioning' } });
  res.json(grouperView());
});

admin.use(require('./data')(need));
admin.use('/directories', require('./directories')(need));
admin.use('/groups', require('./groups')());
admin.use('/group-folders', require('./group-folders')(need));
admin.use('/group-api', require('./group-api-admin')(need));
admin.use('/user-api', require('./user-api-admin')(need));
admin.use('/integrations', require('./integrations')(need));
admin.use('/files', require('./files')(need));
admin.use('/service-accounts', require('./service-accounts')(need));
admin.use('/reports', require('./reports')(need));
admin.use('/calculators', require('./calculators')(need));
admin.use('/grouper/export', require('./grouper-export')(need));
admin.use('/grouper/loader', require('./grouper-loader')(need));
admin.use('/grouper/cutover', require('./grouper-cutover')(need));
admin.use('/federation', require('./federation')(need));

/* User attribute definitions */

admin.get('/attribute-defs', need('users.view'), (req, res) => res.json(attributeDefs.list()));

admin.post('/attribute-defs', need('attributes.manage'), (req, res) => {
  const { data, errors } = attributeDefs.parseDef(req.body);
  if (errors.length) return fail(res, errors);
  db.run('INSERT INTO attribute_defs (name, label, type, options, required, default_value) VALUES (?,?,?,?,?,?)',
    data.name, data.label, data.type, JSON.stringify(data.options), data.required ? 1 : 0, data.default_value);
  auditLog.admin('attribute.create', { actor: auditLog.who(req.user), target: { type: 'attribute', name: data.name }, detail: { type: data.type, required: data.required } });
  res.status(201).json(attributeDefs.find(data.name));
});

admin.put('/attribute-defs/:name', need('attributes.manage'), (req, res) => {
  const existing = attributeDefs.find(req.params.name);
  if (!existing) return res.status(404).json({ error: 'No such attribute.' });
  const { data, errors } = attributeDefs.parseDef(req.body, existing);
  if (errors.length) return fail(res, errors);
  db.run('UPDATE attribute_defs SET label = ?, type = ?, options = ?, required = ?, default_value = ? WHERE name = ?',
    data.label, data.type, JSON.stringify(data.options), data.required ? 1 : 0, data.default_value, existing.name);
  auditLog.admin('attribute.update', { actor: auditLog.who(req.user), target: { type: 'attribute', name: existing.name }, detail: { type: data.type, required: data.required } });
  res.json(attributeDefs.find(existing.name));
});

// Deleting a definition keeps the stored values: they become free-form attributes again.
admin.delete('/attribute-defs/:name', need('attributes.manage'), (req, res) => {
  if (!attributeDefs.find(req.params.name)) return res.status(404).json({ error: 'No such attribute.' });
  db.run('DELETE FROM attribute_defs WHERE name = ?', req.params.name);
  auditLog.admin('attribute.delete', { actor: auditLog.who(req.user), target: { type: 'attribute', name: req.params.name } });
  res.status(204).end();
});

/* Users */

/* Bulk import and scheduled account changes */

const clientError = (res, e) => {
  if (e instanceof bulkUsers.BulkError || e instanceof scheduler.ScheduleError) return fail(res, e.message);
  return null;
};

admin.get('/users/bulk/template', need('users.manage'), (req, res) => {
  res.type('text/csv').set('content-disposition', 'attachment; filename="users-template.csv"').send(bulkUsers.TEMPLATE_CSV);
});

admin.get('/users/bulk', need('users.manage'), (req, res) => res.json(bulkUsers.jobs()));

admin.get('/users/bulk/:id', need('users.manage'), (req, res) => {
  const j = bulkUsers.job(Number(req.params.id));
  if (!j) return res.status(404).json({ error: 'No such import.' });
  if (req.query.format === 'csv') return res.type('text/csv').set('content-disposition', `attachment; filename="import-${j.id}-errors.csv"`).send(bulkUsers.errorCsv(j));
  res.json(j);
});

// Body: { csv } or { users: [...] }, plus dry_run, on_error ('skip' | 'abort'), generate_passwords and, to run later
// instead of now, run_at. A dry run changes nothing. Generated passwords are in the response only, and only once.
admin.post('/users/bulk', need('users.manage'), async (req, res, next) => {
  try {
    const canGroups = req.perms.has('groups.manage');
    if (req.body.run_at) {
      if (!req.perms.has('users.schedule')) return res.status(403).json({ error: 'You do not have permission to do that.' });
      const rows = req.body.csv !== undefined ? bulkUsers.parseCsv(req.body.csv) : req.body.users;
      const s = await scheduler.schedule({ action: 'create', run_at: req.body.run_at, rows, on_error: req.body.on_error }, { id: req.user.id, name: req.user.username, canGroups });
      return res.status(201).json({ scheduled: s });
    }
    res.json(await bulkUsers.run(req.body, { by: req.user.id, byName: req.user.username, canGroups }));
  } catch (e) {
    if (!clientError(res, e)) next(e);
  }
});

const needSchedule = [need('users.manage'), need('users.schedule')];

admin.get('/schedules', need('users.schedule'), (req, res) => {
  if (req.query.user_id) return res.json(scheduler.forUser(Number(req.query.user_id)));
  if (req.query.group_id) return res.json(scheduler.forGroup(Number(req.query.group_id)));
  res.json(scheduler.list({ status: typeof req.query.status === 'string' ? req.query.status : undefined }));
});

admin.post('/schedules', ...needSchedule, async (req, res, next) => {
  try {
    const s = await scheduler.schedule(req.body, { id: req.user.id, name: req.user.username, canGroups: req.perms.has('groups.manage') });
    res.status(201).json(s);
  } catch (e) {
    if (!clientError(res, e)) next(e);
  }
});

admin.delete('/schedules/:id', ...needSchedule, (req, res) => {
  try {
    const s = scheduler.cancel(Number(req.params.id), { id: req.user.id, name: req.user.username });
    if (!s) return res.status(404).json({ error: 'No such schedule.' });
    res.json(s);
  } catch (e) {
    if (!clientError(res, e)) throw e;
  }
});

// ?q= is free text, or an LDAP filter when it starts with "(" (see search.js). A bad filter is the caller's error.
admin.get('/users', need('users.view'), (req, res) => {
  try {
    const { results } = search.searchPeople({ q: req.query.q });
    res.json(results.map((u) => ({ ...u, is_admin: roles.isAdmin(u.id) })));
  } catch (e) {
    if (!(e instanceof LdapFilterError)) throw e;
    res.status(400).json({ error: e.message });
  }
});

function userDetail(id) {
  const u = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) return null;
  const { password_hash, totp_secret, totp_last_step, password_changed_at, password_changed_by, password_changed_via, ...safe } = u;
  return {
    ...safe,
    password_info: userService.passwordInfo(u),
    emails: userService.emailsOf(id),
    factors: factors.enrolled(u).map((f) => factors.describe(f)),
    attributes: attributeDefs.valuesOf(id),
    custom: customText(id),
    group_ids: db.all('SELECT group_id FROM group_members WHERE user_id = ?', id).map((r) => r.group_id),
    memberships: gm.membershipsOf(id),
    compromise: compromise.userView(id),
    role_ids: roles.roleIds(id),
    grouper_role_ids: roles.grantedRoleIds(id),
    is_admin: roles.isAdmin(id),
    expires_at: u.expires_at,
    host: (() => { const h = guests.hostOf(id); return h ? { id: h.id, username: h.username, display_name: h.display_name } : null; })(),
    directory: u.directory_id ? (({ id: did, name, config }) => ({ id: did, name, federated: Boolean(config.url) }))(directories.get(u.directory_id)) : null,
  };
}

// Whether each listed person must use a second factor under the policies that apply to them. Kept apart from the user list so the
// list loads without the policy lookup; the console asks for the people it is showing. Policy names come back only to someone who can view policies.
admin.get('/users/mfa-required', need('users.view'), (req, res) => {
  const ids = [...new Set(String(req.query.ids || '').split(',').filter((s) => /^\d+$/.test(s)).map(Number))].slice(0, 500);
  const names = req.perms.has('policies.view');
  const out = {};
  for (const id of ids) {
    if (!db.get('SELECT 1 FROM users WHERE id = ?', id)) continue;
    const policy = policies.effectivePolicy(id);
    out[id] = names ? { required: policy.requireMfa, sources: policy.sources } : { required: policy.requireMfa };
  }
  res.json(out);
});

admin.get('/users/:id', need('users.view'), (req, res) => {
  const u = userDetail(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  res.json(u);
});

// Role and group assignments on a user record need their own permissions; without them the
// submitted lists are ignored, so editing a user never changes what you could not change directly.
const canAssign = (req) => ({ roles: req.perms.has('roles.manage'), groups: req.perms.has('groups.manage') });

const notAllowed = (res) => res.status(403).json({ error: 'You cannot modify a user who has more access than you.' });

function validateUser(d, password, { id = null, current = null, isNew }, req, body) {
  const errors = [];
  if (!d.username) errors.push('Username is required.');
  if (d.username && db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', d.username, id || 0)) {
    errors.push('That username already exists.');
  }
  const owner = !isNew && current && current.directory_id && directories.get(current.directory_id);
  if (password && owner && directories.usesLdap(owner)) errors.push(`This user signs in against "${owner.name}", so their password is managed there.`);
  const selfEdit = !isNew && current && current.id === req.user.id;
  if (selfEdit && !d.active) errors.push('You cannot deactivate yourself.');
  if (canAssign(req).roles) {
    const next = toArr(body.role_ids).map(Number);
    errors.push(...roles.assignmentErrors(req.user.id, isNew ? [] : roles.roleIds(current.id), next));
    if (selfEdit && !isSubset(req.perms, roles.permissionsOfRoles([...next, ...roles.grantedRoleIds(current.id)]))) errors.push('You cannot remove your own admin access.');
    // A guest may only be given roles their host holds in full.
    if (!isNew && current.host_id) errors.push(...guests.roleErrors(current.host_id, next.filter((id) => !roles.roleIds(current.id).includes(id))));
  }
  return errors;
}

const userTarget = (u) => ({ type: 'user', id: u.id, name: u.username });
const setDiff = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });

admin.post('/users', need('users.manage'), async (req, res, next) => {
  try {
  const d = readUser(req.body);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const em = userService.readEmails(req.body, d.email);
  const attrs = attributeDefs.resolve(req.body.attributes, { isNew: true });
  const personalErr = userService.personalEmailError(null, req.body.personal_email, em.emails);
  // The account has no id yet, so the rules it will be under come from the roles and groups this request gives it.
  const draft = { roleIds: canAssign(req).roles ? toArr(req.body.role_ids).map(Number) : [], groupIds: canAssign(req).groups ? toArr(req.body.group_ids).map(Number) : [] };
  const primary = (em.emails.find((e) => e.primary) || { email: '' }).email;
  const passwordProblems = await policies.draftPasswordErrors(draft, password, { ...d, email: primary });
  const errors = [...validateUser(d, password, { isNew: true }, req, req.body), ...passwordProblems, ...em.errors, ...attrs.errors, ...(personalErr ? [personalErr] : [])];
  if (errors.length) return fail(res, errors);
  d.email = primary;
  const id = userService.insertUser(
    { fields: d, mfa_enabled: d.mfa_enabled, active: Boolean(d.active), passwordHash: hashPassword(password), emails: em.emails, custom: req.body.custom, attributes: attrs.values },
    { by: req.user.id, via: 'admin' },
    (uid) => {
      // An administrator who enters a recovery address is vouching for it.
      if (typeof req.body.personal_email === 'string' && req.body.personal_email.trim()) userService.setPersonalEmail(uid, req.body.personal_email, { verified: true });
      if (canAssign(req).groups) saveMemberships(uid, req.body);
      if (canAssign(req).roles) saveRoles(uid, req.body);
    });
  auditLog.admin('user.create', { actor: auditLog.who(req.user), target: userTarget({ id, username: d.username }),
    detail: { active: Boolean(d.active), mfa_required: Boolean(d.mfa_enabled), roles: canAssign(req).roles ? roles.roleIds(id) : [] } });
  res.status(201).json(userDetail(id));
  } catch (e) { next(e); }
});

admin.put('/users/:id', need('users.manage'), async (req, res, next) => {
  try {
  const current = db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!current) return res.status(404).json({ error: 'No such user.' });
  if (!roles.outranks(req.user.id, current.id)) return notAllowed(res);
  const d = readUser(req.body);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const em = userService.readEmails(req.body, d.email, current.id);
  const attrs = attributeDefs.resolve(req.body.attributes, { isNew: false });
  const personalErr = req.body.personal_email === undefined ? null : userService.personalEmailError(current.id, req.body.personal_email, em.emails);
  const passwordProblems = password ? await policies.passwordErrors(current.id, password) : [];
  const errors = [...validateUser(d, password, { id: current.id, current, isNew: false }, req, req.body), ...passwordProblems, ...em.errors, ...attrs.errors, ...(personalErr ? [personalErr] : [])];
  if (errors.length) return fail(res, errors);
  d.email = (em.emails.find((e) => e.primary) || { email: '' }).email;
  let personalChanged = false;
  const rolesBefore = roles.roleIds(current.id);
  const groupsBefore = db.all('SELECT group_id FROM group_members WHERE user_id = ?', current.id).map((r) => r.group_id);
  db.tx(() => {
    db.run(`UPDATE users SET ${USER_FIELDS.map((f) => `${f} = ?`).join(', ')}, mfa_enabled = ?, active = ? WHERE id = ?`,
      ...USER_FIELDS.map((f) => d[f]), d.mfa_enabled, d.active, current.id);
    if (password) userService.setPassword(current.id, password, { by: req.user.id, via: 'admin' });
    userService.saveEmails(current.id, em.emails);
    if (typeof req.body.personal_email === 'string' && req.body.personal_email.trim().toLowerCase() !== (current.personal_email || '').toLowerCase()) {
      userService.setPersonalEmail(current.id, req.body.personal_email, { verified: true });
      personalChanged = true;
    }
    if (canAssign(req).groups) saveMemberships(current.id, req.body);
    if (canAssign(req).roles) saveRoles(current.id, req.body);
    saveCustom(current.id, req.body.custom, attrs.values);
  });
  // Field names only: values can be personal data, and password changes are recorded as such.
  const after = { ...d, mfa_enabled: d.mfa_enabled, active: d.active };
  const changed = [...USER_FIELDS, 'mfa_enabled', 'active'].filter((f) => String(current[f] ?? '') !== String(after[f] ?? ''));
  const groupsAfter = db.all('SELECT group_id FROM group_members WHERE user_id = ?', current.id).map((r) => r.group_id);
  auditLog.admin('user.update', { actor: auditLog.who(req.user), target: userTarget(current), detail: {
    changed, ...(current.active !== d.active ? { active: Boolean(d.active) } : {}),
    roles: setDiff(rolesBefore, roles.roleIds(current.id)), groups: setDiff(groupsBefore, groupsAfter) } });
  if (personalChanged) auditLog.admin('user.recovery_address_set', { actor: auditLog.who(req.user), target: userTarget(current), detail: { cleared: !req.body.personal_email.trim() } });
  if (password) auditLog.admin('user.password_reset', { actor: auditLog.who(req.user), target: userTarget(current) });
  res.json(userDetail(current.id));
  } catch (e) { next(e); }
});

// What the console tells an administrator while they set someone's password: that person's combined rules.
admin.get('/users/:id/password-rules', need('users.manage'), (req, res) => {
  if (!db.get('SELECT 1 FROM users WHERE id = ?', Number(req.params.id))) return res.status(404).json({ error: 'No such user.' });
  res.json(policies.passwordGuidance(Number(req.params.id)));
});

admin.post('/users/:id/reset-totp', need('users.manage'), (req, res) => {
  if (!db.get('SELECT 1 FROM users WHERE id = ?', req.params.id)) return res.status(404).json({ error: 'No such user.' });
  if (!roles.outranks(req.user.id, Number(req.params.id))) return notAllowed(res);
  db.run("UPDATE users SET totp_secret = '', totp_enabled = 0, totp_last_step = 0 WHERE id = ?", req.params.id);
  auditLog.admin('user.totp_reset', { actor: auditLog.who(req.user), target: userTarget(db.get('SELECT id, username FROM users WHERE id = ?', req.params.id)) });
  res.json(userDetail(req.params.id));
});

// Locks down an account that may be compromised: runs the built-in lockdown integration with the steps its policies set (compromise.js).
// Nobody locks down their own account, or an account with more access than they have, or one with any administrative access.
admin.post('/users/:id/lockdown', need('users.manage'), async (req, res, next) => {
  try {
    const target = db.get('SELECT id, username FROM users WHERE id = ?', Number(req.params.id));
    if (!target) return res.status(404).json({ error: 'No such user.' });
    if (target.id === req.user.id) return res.status(409).json({ error: 'You cannot lock down your own account.' });
    if (!roles.outranks(req.user.id, target.id)) return notAllowed(res);
    if (roles.permissionsOf(target.id).size) return res.status(409).json({ error: 'This account has administrative access and cannot be locked down from here.' });
    const result = await compromise.runLockdown(target, { actor: auditLog.who(req.user), via: 'console' });
    if (result.error) return res.status(409).json({ error: result.error });
    if (!result.ok) return res.status(500).json({ error: `The lockdown did not finish${result.error ? `: ${result.error}` : ''}. Some steps may have run; see run ${result.run.id}.`, user: userDetail(target.id) });
    res.json(userDetail(target.id));
  } catch (e) { next(e); }
});

// Ends a lockdown. Turns the account back on if the lockdown turned it off; sign-in methods and the password are not restored.
admin.delete('/users/:id/lockdown', need('users.manage'), (req, res) => {
  const target = db.get('SELECT id, username FROM users WHERE id = ?', Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'No such user.' });
  if (!roles.outranks(req.user.id, target.id)) return notAllowed(res);
  const ended = compromise.endLockdown(target.id);
  if (!ended) return res.status(404).json({ error: 'That account is not in lockdown.' });
  auditLog.admin('user.lockdown_end', { actor: auditLog.who(req.user), target: userTarget(target), detail: { reactivated: ended.reactivated } });
  res.json(userDetail(target.id));
});

// Removes one sign-in factor ('totp' or 'f<id>'), or all of them with 'all', for someone who has lost their device. They can then
// sign in with a password and set a new one up.
admin.delete('/users/:id/factors/:factor', need('users.manage'), (req, res) => {
  const target = db.get('SELECT id, username FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).json({ error: 'No such user.' });
  if (!roles.outranks(req.user.id, target.id)) return notAllowed(res);
  const f = req.params.factor;
  if (f === 'totp' || f === 'all') db.run("UPDATE users SET totp_secret = '', totp_enabled = 0, totp_last_step = 0 WHERE id = ?", target.id);
  if (f === 'all') db.run('DELETE FROM user_factors WHERE user_id = ?', target.id);
  else if (/^f\d+$/.test(f)) db.run('DELETE FROM user_factors WHERE id = ? AND user_id = ?', Number(f.slice(1)), target.id);
  else if (f !== 'totp') return res.status(400).json({ error: 'Unknown factor.' });
  auditLog.admin('user.factor_reset', { actor: auditLog.who(req.user), target: userTarget(target), detail: { factor: f } });
  res.json(userDetail(target.id));
});

admin.delete('/users/:id', need('users.manage'), (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ errors: ['You cannot delete your own account.'] });
  if (!roles.outranks(req.user.id, Number(req.params.id))) return notAllowed(res);
  const gone = db.get('SELECT id, username FROM users WHERE id = ?', req.params.id);
  db.run('DELETE FROM users WHERE id = ?', req.params.id);
  if (gone) auditLog.admin('user.delete', { actor: auditLog.who(req.user), target: userTarget(gone) });
  res.status(204).end();
});

/* Groups */

admin.get('/groups', need('groups.view'), (req, res) => {
  const graph = gm.loadGraph();
  const memo = new Map();
  const roles = rolesOf(graph);
  res.json(search.searchGroups({ q: req.query.q }).results
    .map((g) => ({ ...g, role: roles.get(g.id), effective_count: gm.effectiveMembers(g.id, undefined, graph, memo).size })));
});

// The include and exclude groups of a group, as { include, exclude } of { id, name, source }.
function groupIncludeExcludeOf(id) {
  const p = ieGroups.pairOf(id);
  const ref = (gid) => db.get('SELECT id, name, source FROM groups WHERE id = ?', gid);
  return { include: ref(p.include_id), exclude: ref(p.exclude_id) };
}

function groupDetail(id) {
  const g = db.get('SELECT * FROM groups WHERE id = ?', id);
  if (!g) return null;
  const members = db.all('SELECT u.id, u.username, u.display_name, u.email, m.pinned, m.via_grouper, m.via_rule FROM users u JOIN group_members m ON m.user_id = u.id WHERE m.group_id = ? ORDER BY u.username', id);
  // In a Grouper group, someone Grouper provides can still be pinned.
  const candidates = db.all(`SELECT id, username, display_name FROM users WHERE id NOT IN
    (SELECT user_id FROM group_members WHERE group_id = ? AND (? = 0 OR pinned = 1)) ORDER BY username`, id, g.source === 'grouper' ? 1 : 0);
  return { group: g, members, candidates, role: rolesOf().get(g.id), include_exclude: ieGroups.pairOf(id) && groupIncludeExcludeOf(id) };
}

const COMPOSITE_OPS = ['union', 'intersect', 'minus'];

// Creates a group with its starting membership: people to add directly (user_ids), optionally an LDAP query (rule), or
// instead a composite of two groups (composite: { op, left_id, right_id }). Everything is checked before anything is
// saved, so a bad request leaves no half-made group behind.
admin.post('/groups', need('groups.manage'), (req, res) => {
  const name = str(req.body.name);
  if (!name) return fail(res, 'Name is required.');
  if (db.get('SELECT 1 FROM groups WHERE name = ?', name)) return fail(res, 'Group already exists.');
  let rule = null;
  if (req.body.rule && str(req.body.rule.filter)) {
    const { data, errors } = groupRules.parse(req.body.rule, { id: null, source: 'local' });
    if (errors) return fail(res, errors);
    rule = data;
  }
  let composite = null;
  if (req.body.composite) {
    const { op, left_id: leftId, right_id: rightId } = req.body.composite;
    if (rule || toArr(req.body.user_ids).length) {
      return fail(res, 'A composite group takes its members from two other groups; it cannot also have people added or a query.');
    }
    if (!COMPOSITE_OPS.includes(op)) return fail(res, `Operation must be one of: ${COMPOSITE_OPS.join(', ')}.`);
    const left = Number.isInteger(Number(leftId)) ? db.get('SELECT id, name FROM groups WHERE id = ?', Number(leftId)) : null;
    const right = Number.isInteger(Number(rightId)) ? db.get('SELECT id, name FROM groups WHERE id = ?', Number(rightId)) : null;
    if (!left || !right) return fail(res, 'Choose both factor groups.');
    if (left.id === right.id) return fail(res, 'The two factors must be different groups.');
    composite = { op, left, right };
  }
  const errors = groupErrors({ name, description: req.body.description });
  if (errors.length) return fail(res, errors);
  const clash = ieGroups.nameError(name);
  if (clash) return res.status(409).json({ errors: [clash] });
  const r = db.run('INSERT INTO groups (name, description) VALUES (?, ?)', name, str(req.body.description));
  const id = Number(r.lastInsertRowid);
  const g = { id, name };
  audit(req.user.username, g, 'group.create');
  ieGroups.create({ id, name, folder_id: null, source: 'local' }, req.user.username);
  if (composite) {
    db.run('INSERT INTO group_composites (group_id, op, left_id, right_id) VALUES (?, ?, ?, ?)', id, composite.op, composite.left.id, composite.right.id);
    audit(req.user.username, g, 'composite.set', `${composite.left.name} ${composite.op} ${composite.right.name}`);
  }
  for (const uid of toArr(req.body.user_ids)) {
    const u = db.get('SELECT username FROM users WHERE id = ?', Number(uid));
    if (!u) continue;
    gm.addDirect(id, Number(uid));
    audit(req.user.username, g, 'member.add', u.username);
  }
  let ran = null;
  if (rule) {
    groupRules.save(id, rule, req.user.username);
    audit(req.user.username, g, 'rule.set', `${rule.mode}: ${rule.filter}`);
    ran = groupRules.run(id, { by: req.user.username, force: true });
  }
  res.status(201).json({ ...groupDetail(id), ran });
});

admin.get('/groups/:id', need('groups.view'), (req, res) => {
  const g = groupDetail(req.params.id);
  if (!g) return res.status(404).json({ error: 'No such group.' });
  res.json(g);
});

// Groups provisioned by Grouper or an external directory are changed there; edits here would be overwritten on its next sync.
const fromGrouper = (req, res, next) => (db.get("SELECT 1 FROM groups WHERE id = ? AND source != 'local'", req.params.id)
  ? res.status(409).json({ error: `This group is managed outside ${appSettings.productName()} (Grouper or an external directory). Change it there.` })
  : next());

admin.put('/groups/:id', need('groups.manage'), fromGrouper, (req, res) => {
  const name = str(req.body.name);
  if (!name) return fail(res, 'Name is required.');
  if (db.get('SELECT 1 FROM groups WHERE name = ? AND id != ?', name, req.params.id)) {
    return fail(res, 'Another group already has that name.');
  }
  const before = db.get('SELECT name FROM groups WHERE id = ?', req.params.id);
  const errors = groupErrors({ name, description: req.body.description }, { system: Boolean(ieGroups.ownerOf(req.params.id)) });
  if (errors.length) return fail(res, errors);
  // A group's include and exclude groups follow its name, so the new name must leave their names free too.
  if (before.name !== name && ieGroups.pairOf(req.params.id)) {
    const clash = ieGroups.nameError(name);
    if (clash) return fail(res, clash);
  }
  db.run('UPDATE groups SET name = ?, description = ? WHERE id = ?', name, str(req.body.description), req.params.id);
  if (before.name !== name) ieGroups.rename(req.params.id, name, req.user.username);
  audit(req.user.username, { id: Number(req.params.id), name }, 'group.update', before && before.name !== name ? `renamed from ${before.name}` : '');
  res.json(groupDetail(req.params.id));
});

function auditMember(req, action, uid) {
  const g = db.get('SELECT id, name FROM groups WHERE id = ?', req.params.id);
  const u = db.get('SELECT username FROM users WHERE id = ?', Number(uid));
  if (g && u) audit(req.user.username, g, action, u.username);
}

const isGrouperGroup = (id) => !!db.get("SELECT 1 FROM groups WHERE id = ? AND source = 'grouper'", id);
// Other externally managed groups stay read-only; Grouper groups accept pinned members (below).
const notExternal = (req, res, next) => (!isGrouperGroup(req.params.id) ? fromGrouper(req, res, next) : next());

// Pinned members are an override: Grouper can neither add nor remove them, so a mapped role or app
// access survives a bad Grouper sync. Pinning into a group that carries a role needs that role's permissions.
admin.post('/groups/:id/members', need('groups.manage'), notExternal, (req, res) => {
  const grouper = isGrouperGroup(req.params.id);
  if (db.get('SELECT 1 FROM group_composites WHERE group_id = ?', req.params.id)) {
    return fail(res, 'This is a composite group; its members come from its two factor groups.');
  }
  if (grouper) {
    const g = db.get('SELECT name FROM groups WHERE id = ?', req.params.id);
    const mapped = db.all('SELECT role_id FROM grouper_role_map WHERE group_name = ?', g.name).map((m) => m.role_id);
    const errors = roles.assignmentErrors(req.user.id, [], mapped);
    if (errors.length) return fail(res, errors);
  }
  for (const uid of toArr(req.body.user_ids)) {
    if (grouper) {
      db.run(`INSERT INTO group_members (group_id, user_id, pinned) SELECT ?, id, 1 FROM users WHERE id = ?
              ON CONFLICT(group_id, user_id) DO UPDATE SET pinned = 1`, req.params.id, Number(uid));
    } else {
      if (db.get('SELECT 1 FROM users WHERE id = ?', Number(uid))) gm.addDirect(req.params.id, uid);
    }
    auditMember(req, 'member.add', uid);
  }
  res.json(groupDetail(req.params.id));
});

admin.delete('/groups/:id/members/:uid', need('groups.manage'), notExternal, (req, res) => {
  auditMember(req, 'member.remove', req.params.uid);
  if (isGrouperGroup(req.params.id)) {
    // Unpinning leaves the membership Grouper provides, if any.
    db.run('UPDATE group_members SET pinned = 0 WHERE group_id = ? AND user_id = ?', req.params.id, req.params.uid);
    db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND via_grouper = 0', req.params.id, req.params.uid);
  } else {
    db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', req.params.id, req.params.uid);
  }
  res.json(groupDetail(req.params.id));
});

admin.delete('/groups/:id', need('groups.manage'), (req, res) => {
  const g = db.get('SELECT id, name FROM groups WHERE id = ?', req.params.id);
  const owner = g && ieGroups.ownerOf(g.id);
  if (owner) return res.status(409).json({ errors: [`This is the include or exclude group of ${owner.name}. Delete ${owner.name} to remove it.`] });
  if (g) {
    ieGroups.removeFor(g.id, req.user.username);
    audit(req.user.username, g, 'group.delete');
  }
  db.run('DELETE FROM groups WHERE id = ?', req.params.id);
  res.status(204).end();
});

/* LDAP queries: checking one, and using one to build a group's membership */

// Says whether text is a valid LDAP filter and, for the people filters this IdP understands, who it matches. `scope` is 'people'
// (default: attributes are checked and matches counted) or 'syntax' (only the form is checked, for filters aimed at another server;
// a {username} placeholder is allowed). Needs a permission that uses LDAP queries.
admin.post('/ldap-query/check', (req, res, next) => (['users.view', 'groups.manage', 'directories.manage'].some((p) => req.perms.has(p)) ? next() : need('users.view')(req, res, next)), (req, res) => {
  const text = typeof req.body.filter === 'string' ? req.body.filter.trim() : '';
  const attributes = search.personAttributeNames();
  if (req.body.scope === 'syntax') {
    try {
      ldapFilterLib.parse(text.replace(/\{username\}/g, 'x'));
      return res.json({ ok: true, attributes });
    } catch (e) {
      if (!(e instanceof LdapFilterError)) throw e;
      return res.json({ ok: false, error: e.message, attributes });
    }
  }
  const r = groupRules.preview(text);
  // Who matched is shown only to someone who may see people.
  if (!req.perms.has('users.view')) { delete r.sample; }
  res.json({ ...r, attributes });
});

admin.get('/groups/:id/rule', need('groups.view'), (req, res) => {
  const g = db.get('SELECT * FROM groups WHERE id = ?', req.params.id);
  if (!g) return res.status(404).json({ error: 'No such group.' });
  res.json({ rule: groupRules.view(groupRules.ruleOf(g.id)), unsuitable: groupRules.unsuitable(g), attributes: search.personAttributeNames() });
});

admin.put('/groups/:id/rule', need('groups.manage'), (req, res) => {
  const g = db.get('SELECT * FROM groups WHERE id = ?', req.params.id);
  if (!g) return res.status(404).json({ error: 'No such group.' });
  const { data, errors } = groupRules.parse(req.body || {}, g);
  if (errors) return fail(res, errors);
  const r = groupRules.save(g.id, data, req.user.username);
  audit(req.user.username, g, r.created ? 'rule.set' : 'rule.update', `${data.mode}: ${data.filter}`);
  const ran = req.body.run === false ? null : groupRules.run(g.id, { by: req.user.username, force: true });
  res.json({ rule: groupRules.view(groupRules.ruleOf(g.id)), ran });
});

admin.post('/groups/:id/rule/run', need('groups.manage'), (req, res) => {
  const g = db.get('SELECT * FROM groups WHERE id = ?', req.params.id);
  if (!g || !groupRules.ruleOf(g.id)) return res.status(404).json({ error: 'This group has no query.' });
  const ran = groupRules.run(g.id, { by: req.user.username, force: true });
  if (ran.error) return fail(res, ran.error);
  res.json({ rule: groupRules.view(groupRules.ruleOf(g.id)), ran });
});

admin.delete('/groups/:id/rule', need('groups.manage'), (req, res) => {
  const g = db.get('SELECT * FROM groups WHERE id = ?', req.params.id);
  if (!g) return res.status(404).json({ error: 'No such group.' });
  const keepMembers = req.query.keep_members !== '0';
  const r = groupRules.remove(g.id, { keepMembers });
  if (r.removed) audit(req.user.username, g, 'rule.remove', keepMembers ? 'members kept' : `${r.dropped} members removed`);
  res.json({ rule: null });
});

/* Service providers */

admin.get('/sps', need('sps.view'), (req, res) => res.json(sps.listSps()));

admin.get('/sps/blank', need('sps.manage'), (req, res) => res.json(sps.blankSp()));

function spDetail(sp) {
  const { private_key_pem, ...safe } = sp;
  return { sp: safe, fingerprints: fingerprints(sp.cert_pem), metadata: buildMetadata(sp) };
}

admin.get('/sps/:id', need('sps.view'), (req, res) => {
  const sp = sps.getSp(req.params.id);
  if (!sp) return res.status(404).json({ error: 'No such service provider.' });
  res.json(spDetail(sp));
});

const spTarget = (sp) => ({ type: 'service_provider', id: sp.id, name: sp.name || sp.entity_id });

// Same field names as the HTML form, so the SPA can post its state as JSON.
admin.post('/sps', need('sps.manage'), (req, res) => {
  const { data, errors } = sps.parseForm(req.body, { draft: req.body.draft === true });
  if (errors.length) return fail(res, errors);
  const id = sps.createSp(data);
  auditLog.admin('sp.create', { actor: auditLog.who(req.user), target: spTarget(sps.getSp(id)) });
  res.status(201).json(spDetail(sps.getSp(id)));
});

admin.put('/sps/:id', need('sps.manage'), (req, res) => {
  const existing = sps.getSp(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such service provider.' });
  const { data, errors } = sps.parseForm(req.body);
  if (errors.length) return fail(res, errors);
  sps.updateSp(existing.id, data);
  auditLog.admin('sp.update', { actor: auditLog.who(req.user), target: spTarget(sps.getSp(existing.id)), detail: { renamed_from: existing.name !== data.name ? existing.name : undefined } });
  res.json(spDetail(sps.getSp(existing.id)));
});

admin.post('/sps/:id/regenerate-cert', need('sps.manage'), (req, res) => {
  const existing = sps.getSp(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such service provider.' });
  sps.regenerateCert(existing.id);
  auditLog.admin('sp.cert.regenerate', { actor: auditLog.who(req.user), target: spTarget(existing) });
  res.json(spDetail(sps.getSp(existing.id)));
});

admin.delete('/sps/:id', need('sps.manage'), (req, res) => {
  const sp = sps.getSp(req.params.id);
  if (!sp) return res.status(404).json({ error: 'No such service provider.' });
  sps.deleteSp(req.params.id);
  auditLog.admin('sp.delete', { actor: auditLog.who(req.user), target: spTarget(sp) });
  res.status(204).end();
});

// Auto-populate: parse pasted SP metadata XML or fetch it from a URL.
admin.post('/sps/parse-metadata', need('sps.manage'), async (req, res) => {
  try {
    let xml = str(req.body.xml);
    const url = str(req.body.url);
    if (!xml && url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Metadata URL must be http(s).');
      try {
        xml = (await safeFetchText(url)).text;
      } catch (e) {
        throw new Error(`Fetching metadata failed: ${e.message}`);
      }
    }
    if (!xml) throw new Error('Paste metadata XML or enter a metadata URL.');
    const parsed = parseSpMetadata(xml);
    for (const k of ['encryption_cert_pem', 'signing_cert_pem']) {
      if (!parsed[k]) continue;
      try {
        parsed[k] = normalizeCertificate(parsed[k]);
      } catch {
        parsed[k] = '';
      }
    }
    res.json(parsed);
  } catch (e) {
    fail(res, e.message);
  }
});

// Preview the SAML attributes a user would receive with the (possibly unsaved) form values, rules included.
admin.post('/sps/preview', need('sps.manage'), (req, res) => {
  const user = db.get('SELECT * FROM users WHERE id = ?', Number(req.body.user_id) || 0);
  if (!user) return fail(res, 'Choose a user to preview.');
  const { data } = sps.parseForm(req.body);
  const draft = {
    ...data,
    roles: data.roles.flatMap((r) => {
      const g = db.get('SELECT name FROM groups WHERE id = ?', r.group_id);
      return g ? [{ ...r, role_value: r.role_value || g.name }] : [];
    }),
  };
  const ctx = { groups: attrs.userGroups(user.id), custom: attrs.userCustom(user.id) };
  const ruleErrors = draft.transform_enabled ? [...parseRules(draft.transform_rules).errors] : [];
  const transformed = new Map();
  const attributes = buildAttributes(draft, user, ctx, ['pwd'], ruleErrors, transformed);
  let nameId = null;
  try {
    nameId = nameIdFor(draft, user, ctx, transformed);
  } catch (e) {
    ruleErrors.push(e.message);
  }
  res.json({ attributes, nameId, errors: ruleErrors });
});

/* CAS, OpenID Connect and OAuth 2.0 applications. They share the service-provider permissions. */

const appTarget = (a) => ({ type: 'application', id: a.id, name: a.name });
// The client secret is returned once, when it is created or rotated, and is never readable again.
const appDetail = (a, secret) => ({ app: a, ...(secret ? { secret } : {}) });

admin.get('/apps', need('sps.view'), (req, res) => res.json(apps.listApps()));

// Every application, SAML and the others together, for the Applications list and search.
admin.get('/applications', need('sps.view'), (req, res) => res.json(search.searchApplications({ q: req.query.q }).results));

admin.get('/apps/blank', need('sps.manage'), (req, res) => {
  if (!apps.PROTOCOLS.includes(req.query.protocol)) return fail(res, 'Choose CAS, OpenID Connect or OAuth 2.0.');
  res.json(apps.blankApp(req.query.protocol));
});

admin.get('/apps/:id', need('sps.view'), (req, res) => {
  const a = apps.getApp(req.params.id);
  if (!a) return res.status(404).json({ error: 'No such application.' });
  res.json(appDetail(a));
});

admin.post('/apps', need('sps.manage'), (req, res) => {
  const { data, errors } = apps.parseForm(req.body);
  if (errors.length) return fail(res, errors);
  const { id, secret } = apps.createApp(data);
  const a = apps.getApp(id);
  auditLog.admin('app.create', { actor: auditLog.who(req.user), target: appTarget(a), detail: { protocol: a.protocol } });
  res.status(201).json(appDetail(a, secret));
});

admin.put('/apps/:id', need('sps.manage'), (req, res) => {
  const existing = apps.getApp(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such application.' });
  const { data, errors } = apps.parseForm(req.body, existing);
  if (errors.length) return fail(res, errors);
  const secret = apps.updateApp(existing.id, data);
  auditLog.admin('app.update', { actor: auditLog.who(req.user), target: appTarget(existing),
    detail: { renamed_from: existing.name !== data.name ? existing.name : undefined, secret_issued: Boolean(secret) || undefined } });
  res.json(appDetail(apps.getApp(existing.id), secret));
});

admin.post('/apps/:id/rotate-secret', need('sps.manage'), (req, res) => {
  const existing = apps.getApp(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such application.' });
  if (!existing.confidential) return fail(res, 'This is a public client; it has no secret.');
  const secret = apps.rotateSecret(existing.id);
  auditLog.admin('app.secret.rotate', { actor: auditLog.who(req.user), target: appTarget(existing) });
  res.json(appDetail(apps.getApp(existing.id), secret));
});

admin.delete('/apps/:id', need('sps.manage'), (req, res) => {
  const a = apps.getApp(req.params.id);
  if (!a) return res.status(404).json({ error: 'No such application.' });
  apps.deleteApp(a.id);
  auditLog.admin('app.delete', { actor: auditLog.who(req.user), target: appTarget(a), detail: { protocol: a.protocol } });
  res.status(204).end();
});

/* Roles */

const ADMIN_NOTE = 'The Administrator role always holds every permission and cannot be edited.';

function roleDetail(id) {
  const role = db.get('SELECT * FROM roles WHERE id = ?', id);
  if (!role) return null;
  const members = db.all('SELECT u.id, u.username, u.display_name FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE ur.role_id = ? ORDER BY u.username', id);
  const candidates = db.all('SELECT id, username, display_name FROM users WHERE id NOT IN (SELECT user_id FROM user_roles WHERE role_id = ?) ORDER BY username', id);
  return {
    role: { id: role.id, name: role.name, description: role.description, builtin: role.key === roles.ADMIN_ROLE, permissions: [...roles.rolePermissions(role)] },
    members,
    candidates,
  };
}

admin.get('/roles', need('roles.view'), (req, res) => {
  const list = db.all(`SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS member_count
                       FROM roles r ORDER BY r.key = 'admin' DESC, r.name`);
  res.json({
    permissions: PERMISSIONS.map(({ key, group, label, description, implies }) => ({ key, group, label, description, implies: implies || [] })),
    roles: list.map((r) => ({
      id: r.id, name: r.name, description: r.description, member_count: r.member_count,
      builtin: r.key === roles.ADMIN_ROLE, permissions: [...roles.rolePermissions(r)],
    })),
  });
});

// Starting point for the "new role" form: every user is a candidate member.
admin.get('/roles/blank', need('roles.view'), (req, res) => res.json({
  role: { id: null, name: '', description: '', builtin: false, permissions: [] },
  members: [],
  candidates: db.all('SELECT id, username, display_name FROM users ORDER BY username'),
}));

admin.get('/roles/:id', need('roles.view'), (req, res) => {
  const r = roleDetail(req.params.id);
  if (!r) return res.status(404).json({ error: 'No such role.' });
  res.json(r);
});

// Shared by create and update. You may only grant, change or revoke what you hold yourself, and you
// may not reduce your own access; both are checked inside the transaction so a failure rolls back.
function saveRole(req, res, existing) {
  const builtin = existing && existing.key === roles.ADMIN_ROLE;
  const name = builtin ? existing.name : str(req.body.name);
  const description = builtin ? existing.description : str(req.body.description);
  const wanted = builtin ? new Set(roles.rolePermissions(existing)) : normalize(toArr(req.body.permissions));
  const userIds = [...new Set(toArr(req.body.user_ids).map(Number))].filter((n) => Number.isInteger(n));

  const errors = [];
  if (!name) errors.push('Name is required.');
  if (name && db.get('SELECT 1 FROM roles WHERE name = ? AND id != ?', name, existing ? existing.id : 0)) errors.push('Another role already has that name.');
  if (errors.length) { fail(res, errors); return null; }

  try {
    const id = db.tx(() => {
      const before = existing ? roles.rolePermissions(existing) : new Set();
      const members = existing ? db.all('SELECT user_id FROM user_roles WHERE role_id = ?', existing.id).map((r) => r.user_id) : [];
      let roleId;
      if (existing) {
        roleId = existing.id;
        if (!builtin) db.run('UPDATE roles SET name = ?, description = ? WHERE id = ?', name, description, roleId);
      } else {
        roleId = Number(db.run('INSERT INTO roles (key, name, description) VALUES (?, ?, ?)', roles.newRoleKey(), name, description).lastInsertRowid);
      }
      if (!builtin) roles.setRolePermissions(roleId, [...wanted]);
      const changedMembers = members.some((m) => !userIds.includes(m)) || userIds.some((u) => !members.includes(u));
      db.run('DELETE FROM user_roles WHERE role_id = ?', roleId);
      for (const uid of userIds) db.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT id, ? FROM users WHERE id = ?', roleId, uid);

      const touched = new Set([...before, ...wanted]);
      const permsChanged = before.size !== wanted.size || [...before].some((p) => !wanted.has(p));
      if ((permsChanged || changedMembers) && !isSubset(touched, req.perms)) {
        throw Object.assign(new Error(), { errors: ['You can only change roles that carry permissions you hold yourself.'] });
      }
      if (!isSubset(req.perms, roles.permissionsOf(req.user.id))) {
        throw Object.assign(new Error(), { errors: ['You cannot remove your own access.'] });
      }
      return roleId;
    });
    return { id };
  } catch (e) {
    if (!e.errors) throw e;
    fail(res, e.errors);
    return null;
  }
}

admin.post('/roles', need('roles.manage'), (req, res) => {
  const r = saveRole(req, res, null);
  if (r) {
    const role = db.get('SELECT id, name FROM roles WHERE id = ?', r.id);
    auditLog.admin('role.create', { actor: auditLog.who(req.user), target: { type: 'role', id: role.id, name: role.name }, detail: { permissions: [...roles.rolePermissions(role)] } });
    res.status(201).json(roleDetail(r.id));
  }
});

admin.put('/roles/:id', need('roles.manage'), (req, res) => {
  const existing = db.get('SELECT * FROM roles WHERE id = ?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such role.' });
  const permsBefore = [...roles.rolePermissions(existing)];
  const r = saveRole(req, res, existing);
  if (r) {
    const role = db.get('SELECT id, name FROM roles WHERE id = ?', r.id);
    auditLog.admin('role.update', { actor: auditLog.who(req.user), target: { type: 'role', id: role.id, name: role.name },
      detail: { permissions: setDiff(permsBefore, [...roles.rolePermissions(role)]), renamed_from: existing.name !== role.name ? existing.name : undefined } });
    res.json(roleDetail(r.id));
  }
});

admin.delete('/roles/:id', need('roles.manage'), (req, res) => {
  const existing = db.get('SELECT * FROM roles WHERE id = ?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such role.' });
  if (existing.key === roles.ADMIN_ROLE) return fail(res, ADMIN_NOTE);
  if (!isSubset(roles.rolePermissions(existing), req.perms)) return fail(res, 'You can only delete roles that carry permissions you hold yourself.');
  try {
    db.tx(() => {
      db.run('DELETE FROM roles WHERE id = ?', existing.id);
      if (!isSubset(req.perms, roles.permissionsOf(req.user.id))) throw new Error('lockout');
    });
  } catch (e) {
    if (e.message !== 'lockout') throw e;
    return fail(res, 'You cannot delete a role that gives you access you would otherwise lose.');
  }
  auditLog.admin('role.delete', { actor: auditLog.who(req.user), target: { type: 'role', id: existing.id, name: existing.name } });
  res.status(204).end();
});

/* Policies */

// How a sign-in policy stands against the global policy: the rules it weakens, the overrides in force, and any weakening still awaiting acceptance.
const overrideView = (p) => {
  const { weakens, active, needsAcceptance } = policies.overrideState(p, policies.globalPolicy());
  return { weakens, active, needs_acceptance: needsAcceptance, accepted_by: p.global_override_by || null, accepted_at: p.global_override_at || null };
};

const policyGroups = (id) => db.all('SELECT g.id, g.name FROM policy_groups pg JOIN groups g ON g.id = pg.group_id WHERE pg.policy_id = ? ORDER BY g.name', id);

const policyView = (p) => {
  const groups = p.role_id !== null ? [] : policyGroups(p.id);
  return {
  id: p.id, name: p.name, description: p.description, global_override: overrideView(p),
  subject_type: p.role_id !== null ? 'role' : 'group',
  subject_id: p.role_id !== null ? p.role_id : groups[0]?.id ?? null,
  subject_name: p.role_id !== null ? p.role_name : groups.map((g) => g.name).join(', '),
  group_ids: groups.map((g) => g.id), groups,
  block_sign_in: Boolean(p.block_sign_in), require_mfa: Boolean(p.require_mfa),
  allowed_factors: p.allowed_factors ? p.allowed_factors.split(',') : [], require_phishing_resistant: Boolean(p.require_phishing_resistant),
  disable_password_recovery: Boolean(p.disable_password_recovery), risk_medium_action: p.risk_medium_action || '', risk_high_action: p.risk_high_action || '',
  password_policy_id: p.password_policy_id, password_policy_name: p.password_policy_name || null,
  remember_mfa_hours: p.remember_mfa_hours ?? null,
  };
};

const POLICY_SQL = `SELECT p.*, r.name AS role_name, pp.name AS password_policy_name FROM policies p
                    LEFT JOIN roles r ON r.id = p.role_id
                    LEFT JOIN password_policies pp ON pp.id = p.password_policy_id`;

const policyById = (id) => db.get(`${POLICY_SQL} WHERE p.id = ?`, Number(id));

// The global policy as the console shows it, or null when none is set.
const globalView = () => {
  const g = policies.globalSignInRow();
  if (!g) return null;
  return {
    description: g.description, block_sign_in: false, require_mfa: Boolean(g.require_mfa), require_phishing_resistant: Boolean(g.require_phishing_resistant),
    allowed_factors: g.allowed_factors ? g.allowed_factors.split(',') : [], disable_password_recovery: Boolean(g.disable_password_recovery),
    risk_medium_action: g.risk_medium_action, risk_high_action: g.risk_high_action, remember_mfa_hours: g.remember_mfa_hours,
    password_policy_id: g.password_policy_id,
    password_policy_name: g.password_policy_id != null ? db.get('SELECT name FROM password_policies WHERE id = ?', g.password_policy_id)?.name ?? null : null,
  };
};

admin.get('/policies', need('policies.view'), (req, res) => {
  res.json({
    policies: db.all(`${POLICY_SQL} ORDER BY p.name`).map(policyView),
    global: globalView(),
    override_rules: policies.OVERRIDE_RULES,
    global_password_set: appSettings.globalPasswordRules() !== null,
    roles: db.all('SELECT id, name FROM roles ORDER BY name'),
    groups: db.all('SELECT id, name, source FROM groups ORDER BY name'),
    factor_types: factorSettings.METHODS.map((m) => m.id),
    factor_names: Object.fromEntries(factorSettings.METHODS.map((m) => [m.id, m.label])),
    risk_actions: risk.ACTIONS,
    password_policies: db.all('SELECT id, name FROM password_policies ORDER BY name'),
  });
});

// The sign-in rules shared by sign-in policies and the global policy.
function parseSignInRules(body) {
  const errors = [];
  const passwordPolicyId = body.password_policy_id === '' || body.password_policy_id == null ? null : Number(body.password_policy_id);
  if (passwordPolicyId !== null && !db.get('SELECT 1 FROM password_policies WHERE id = ?', passwordPolicyId)) errors.push('Choose a password policy from the list, or none.');
  const wanted = Array.isArray(body.allowed_factors) ? body.allowed_factors : [];
  if (wanted.some((t) => !FACTOR_CHOICES.includes(t))) errors.push('Unknown sign-in factor.');
  // Listing every type is the same as no limit, and an empty list means no limit.
  const allowed = wanted.length && wanted.length < FACTOR_METHODS.length ? FACTOR_CHOICES.filter((t) => wanted.includes(t)).join(',') : '';
  // Empty = no rule for remembering a second factor; 0 = always ask.
  const remember = body.remember_mfa_hours === '' || body.remember_mfa_hours == null ? null : Number(body.remember_mfa_hours);
  if (remember !== null && (!Number.isInteger(remember) || remember < 0 || remember > policies.MAX_REMEMBER_HOURS)) errors.push(`Remember the second factor for a whole number of hours from 0 to ${policies.MAX_REMEMBER_HOURS} (0 = always ask).`);
  return {
    errors,
    data: {
      passwordPolicyId, allowed, remember, phishingResistant: body.require_phishing_resistant ? 1 : 0, noRecovery: body.disable_password_recovery ? 1 : 0,
      riskMedium: risk.ACTIONS.includes(body.risk_medium_action) ? body.risk_medium_action : '', riskHigh: risk.ACTIONS.includes(body.risk_high_action) ? body.risk_high_action : '',
      block: body.block_sign_in ? 1 : 0, mfa: body.require_mfa ? 1 : 0,
    },
  };
}

// The parsed rules as a policies row, for the checks against the global policy.
const ruleRow = (d) => ({
  block_sign_in: d.block, require_mfa: d.mfa, allowed_factors: d.allowed, require_phishing_resistant: d.phishingResistant,
  disable_password_recovery: d.noRecovery, risk_medium_action: d.riskMedium, risk_high_action: d.riskHigh,
  remember_mfa_hours: d.remember, password_policy_id: d.passwordPolicyId,
});

function parsePolicy(body, existing) {
  const errors = [];
  const name = str(body.name);
  const type = body.subject_type;
  // A role policy names one role (`subject_id`); a group policy names one or more groups (`group_ids`, or a lone `subject_id`).
  const subjectId = Number(body.subject_id);
  const groupIds = type === 'group' ? [...new Set((Array.isArray(body.group_ids) ? body.group_ids : [body.subject_id]).map(Number))] : [];
  if (!name) errors.push('Name is required.');
  if (name && db.get('SELECT 1 FROM policies WHERE name = ? AND id != ?', name, existing ? existing.id : 0)) errors.push('Another policy already has that name.');
  if (type !== 'role' && type !== 'group') errors.push('Choose whether the policy applies to a role or a group.');
  else if (type === 'role') {
    if (!Number.isInteger(subjectId) || !db.get('SELECT 1 FROM roles WHERE id = ?', subjectId)) errors.push('Choose a role for the policy.');
    else if (db.get('SELECT 1 FROM policies WHERE role_id = ? AND id != ?', subjectId, existing ? existing.id : 0)) errors.push('That role already has a policy. Edit it instead.');
  } else if (!groupIds.length || !groupIds.every((id) => Number.isInteger(id) && db.get('SELECT 1 FROM groups WHERE id = ?', id))) {
    errors.push('Choose at least one group for the policy.');
  }
  const rules = parseSignInRules(body);
  return { errors: [...errors, ...rules.errors], data: { ...rules.data, name, description: str(body.description), type, subjectId, groupIds } };
}

const blockedUserIds = () => new Set(db.all('SELECT id FROM users').map((u) => u.id).filter((id) => policies.effectivePolicy(id).blockSignIn));

// Blocking sign-in is a lockout tool, so it may not newly block yourself, any administrator, or anyone with more access than you.
function lockoutErrors(req, before) {
  const errors = [];
  for (const id of blockedUserIds()) {
    if (before.has(id)) continue;
    if (id === req.user.id) errors.push('This policy would block your own sign-in.');
    else if (roles.isAdmin(id)) errors.push('Administrators cannot be blocked from signing in.');
    else if (!roles.outranks(req.user.id, id)) errors.push('This policy would block someone with more access than you.');
  }
  return [...new Set(errors)];
}

function savePolicy(req, res, existing) {
  const { errors, data } = parsePolicy(req.body, existing);
  if (errors.length) { fail(res, errors); return null; }
  // A policy applies to reference or application groups, never to a basis group straight from a source (Grouper's guidance).
  const basis = data.groupIds.filter((id) => rolesOf().get(id) === 'basis').map((id) => db.get('SELECT name FROM groups WHERE id = ?', id)?.name).filter(Boolean);
  if (basis.length) {
    fail(res, [`${basis.join(', ')} ${basis.length === 1 ? 'is a basis group' : 'are basis groups'}, fed from a source. Apply the policy to reference or application groups instead.`]);
    return null;
  }
  // Less strict than the global policy on any rule needs an explicit acceptance, which is kept with who gave it and when.
  const global = policies.globalPolicy();
  const weakened = policies.weakenedBy(ruleRow(data), global);
  if (weakened.length && req.body.accept_global_override !== true) {
    fail(res, [`This policy is less secure than the global policy (${weakened.map((k) => policies.OVERRIDE_RULES[k]).join('; ')}). Confirm that you accept it reduces security to save it.`]);
    return null;
  }
  const override = weakened.length
    ? { json: JSON.stringify(policies.acceptanceFor(ruleRow(data), global)), by: req.user.username, at: new Date().toISOString() }
    : { json: null, by: null, at: null };
  try {
    return db.tx(() => {
      const before = blockedUserIds();
      const role = data.type === 'role' ? data.subjectId : null;
      let id;
      if (existing) {
        id = existing.id;
        db.run(`UPDATE policies SET name = ?, description = ?, role_id = ?, block_sign_in = ?, require_mfa = ?,
                allowed_factors = ?, require_phishing_resistant = ?, disable_password_recovery = ?, password_policy_id = ?, remember_mfa_hours = ?,
                global_override = ?, global_override_by = ?, global_override_at = ? WHERE id = ?`, data.name, data.description, role, data.block, data.mfa, data.allowed, data.phishingResistant, data.noRecovery, data.passwordPolicyId, data.remember,
        override.json, override.by, override.at, id);
      } else {
        id = Number(db.run(`INSERT INTO policies (name, description, role_id, block_sign_in, require_mfa, allowed_factors, require_phishing_resistant, disable_password_recovery, password_policy_id, remember_mfa_hours,
                            global_override, global_override_by, global_override_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, data.name, data.description, role, data.block, data.mfa, data.allowed, data.phishingResistant, data.noRecovery, data.passwordPolicyId, data.remember,
        override.json, override.by, override.at).lastInsertRowid);
      }
      // Add before removing, so the policy is never without a group part way through (which would delete it).
      for (const g of data.groupIds) db.run('INSERT OR IGNORE INTO policy_groups (policy_id, group_id) VALUES (?, ?)', id, g);
      db.run(`DELETE FROM policy_groups WHERE policy_id = ? AND group_id NOT IN (${data.groupIds.map(() => '?').join(',') || 'NULL'})`, id, ...data.groupIds);
      const problems = lockoutErrors(req, before);
      if (problems.length) throw Object.assign(new Error(), { errors: problems });
      return id;
    });
  } catch (e) {
    if (!e.errors) throw e;
    fail(res, e.errors);
    return null;
  }
}

admin.post('/policies', need('policies.manage'), (req, res) => {
  const id = savePolicy(req, res, null);
  if (id !== null) {
    auditLog.admin('policy.create', { actor: auditLog.who(req.user), target: { type: 'policy', id, name: policyById(id).name }, detail: policyView(policyById(id)) });
    res.status(201).json(policyView(policyById(id)));
  }
});

admin.put('/policies/:id', need('policies.manage'), (req, res) => {
  const existing = policyById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such policy.' });
  const before = policyView(existing);
  const id = savePolicy(req, res, existing);
  if (id !== null) {
    const after = policyView(policyById(id));
    auditLog.admin('policy.update', { actor: auditLog.who(req.user), target: { type: 'policy', id, name: after.name },
      detail: { changed: Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])), now: after } });
    res.json(after);
  }
});

admin.delete('/policies/:id', need('policies.manage'), (req, res) => {
  const gone = policyById(req.params.id);
  if (!gone) return res.status(404).json({ error: 'No such policy.' });
  db.run('DELETE FROM policies WHERE id = ?', Number(req.params.id));
  auditLog.admin('policy.delete', { actor: auditLog.who(req.user), target: { type: 'policy', id: gone.id, name: gone.name }, detail: policyView(gone) });
  res.status(204).end();
});

// Which rules a sign-in policy would weaken against the global policy, as the console edits it. Nothing is saved.
admin.post('/policies/preview', need('policies.manage'), (req, res) => {
  const { data } = parseSignInRules(req.body);
  res.json({ weakens: policies.weakenedBy(ruleRow(data), policies.globalPolicy()) });
});

/* Compromised-account policies: which steps a lockdown runs for each person (compromise.js). The Everyone policy is the default. */
admin.get('/compromise-policies', need('policies.view'), (req, res) => {
  res.json({
    policies: compromise.listPolicies(),
    steps: compromise.STEPS,
    roles: db.all('SELECT id, name FROM roles ORDER BY name COLLATE NOCASE'),
    groups: db.all('SELECT id, name, source FROM groups ORDER BY name COLLATE NOCASE'),
    integration: db.get('SELECT id, name, enabled FROM integrations WHERE builtin = ?', compromise.LOCKDOWN_INTEGRATION) || null,
  });
});

// Saves a compromised-account policy as the console submits it. Returns its id, or null after answering with the errors.
function saveCompromisePolicy(req, res, existing) {
  const { errors, data } = compromise.parsePolicy(req.body, existing);
  if (errors.length) { res.status(400).json({ error: errors[0], errors }); return null; }
  return compromise.savePolicy(data, existing ? existing.id : null);
}

admin.post('/compromise-policies', need('policies.manage'), (req, res) => {
  const id = saveCompromisePolicy(req, res, null);
  if (id === null) return;
  const view = compromise.policyView(compromise.policyById(id));
  auditLog.admin('compromise_policy.create', { actor: auditLog.who(req.user), target: { type: 'policy', id, name: view.name }, detail: view });
  res.status(201).json(view);
});

admin.put('/compromise-policies/:id', need('policies.manage'), (req, res) => {
  const existing = compromise.policyById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such policy.' });
  const before = compromise.policyView(existing);
  const id = saveCompromisePolicy(req, res, existing);
  if (id === null) return;
  const after = compromise.policyView(compromise.policyById(id));
  auditLog.admin('compromise_policy.update', { actor: auditLog.who(req.user), target: { type: 'policy', id, name: after.name },
    detail: { changed: Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])), now: after } });
  res.json(after);
});

admin.delete('/compromise-policies/:id', need('policies.manage'), (req, res) => {
  const gone = compromise.policyById(req.params.id);
  if (!gone) return res.status(404).json({ error: 'No such policy.' });
  compromise.deletePolicy(gone.id);
  auditLog.admin('compromise_policy.delete', { actor: auditLog.who(req.user), target: { type: 'policy', id: gone.id, name: gone.name }, detail: compromise.policyView(gone) });
  res.status(204).end();
});

/* The global policy: sign-in and password rules that hold for every account, unless a sign-in policy overrides one (policies.js). */
admin.put('/global-policy', need('policies.manage'), (req, res) => {
  const { errors, data } = parseSignInRules(req.body);
  if (req.body.block_sign_in) errors.push('A global policy cannot block sign-in. Block people with a role or group policy instead.');
  if (errors.length) return fail(res, errors);
  const before = policies.globalSignInRow();
  appSettings.saveGlobalPolicy({ description: str(req.body.description), ...ruleRow(data) });
  const after = policies.globalSignInRow();
  auditLog.admin('global_policy.update', { actor: auditLog.who(req.user), target: { type: 'policy', name: policies.GLOBAL_NAME },
    detail: { changed: Object.keys(after).filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after[k])), before, now: after } });
  res.json(globalView());
});

admin.delete('/global-policy', need('policies.manage'), (req, res) => {
  const before = policies.globalSignInRow();
  if (!before) return res.status(404).json({ error: 'There is no global policy.' });
  appSettings.saveGlobalPolicy(null);
  auditLog.admin('global_policy.delete', { actor: auditLog.who(req.user), target: { type: 'policy', name: policies.GLOBAL_NAME }, detail: { before } });
  res.status(204).end();
});

/* Application policies: the sign-in an application or SAML service provider requires (app-policies.js). */

const appPolicyView = (p) => ({
  id: p.id, name: p.name, description: p.description,
  require_mfa: Boolean(p.require_mfa), require_phishing_resistant: Boolean(p.require_phishing_resistant),
  allowed_factors: p.allowed_factors ? p.allowed_factors.split(',') : [],
  apps: db.all('SELECT app_id FROM app_policy_apps WHERE policy_id = ? ORDER BY app_id', p.id).map((r) => r.app_id),
  service_providers: db.all('SELECT sp_id FROM app_policy_sps WHERE policy_id = ? ORDER BY sp_id', p.id).map((r) => r.sp_id),
});

const appPolicyById = (id) => {
  const p = db.get('SELECT * FROM app_policies WHERE id = ?', Number(id));
  return p ? appPolicyView(p) : null;
};

admin.get('/app-policies', need('policies.view'), (req, res) => {
  res.json({
    policies: db.all('SELECT * FROM app_policies ORDER BY name').map(appPolicyView),
    apps: db.all('SELECT id, name FROM apps ORDER BY name'),
    service_providers: db.all('SELECT id, name FROM service_providers ORDER BY name'),
    factor_types: factorSettings.METHODS.map((m) => m.id),
    factor_names: Object.fromEntries(factorSettings.METHODS.map((m) => [m.id, m.label])),
  });
});

function parseAppPolicy(body, existing) {
  const errors = [];
  const name = str(body.name);
  if (!name) errors.push('Name is required.');
  if (name && db.get('SELECT 1 FROM app_policies WHERE name = ? AND id != ?', name, existing ? existing.id : 0)) errors.push('Another application policy already has that name.');
  const ids = (list, table) => [...new Set(Array.isArray(list) ? list.map(String) : [])].filter((id) => db.get(`SELECT 1 FROM ${table} WHERE id = ?`, id));
  const apps = ids(body.apps, 'apps');
  const sps = ids(body.service_providers, 'service_providers');
  if (!apps.length && !sps.length) errors.push('Choose at least one application or service provider.');
  const wanted = Array.isArray(body.allowed_factors) ? body.allowed_factors : [];
  if (wanted.some((t) => !FACTOR_CHOICES.includes(t))) errors.push('Unknown sign-in factor.');
  const allowed = wanted.length && wanted.length < FACTOR_METHODS.length ? FACTOR_CHOICES.filter((t) => wanted.includes(t)).join(',') : '';
  return {
    errors,
    data: { name, description: str(body.description), mfa: body.require_mfa ? 1 : 0, phishing: body.require_phishing_resistant ? 1 : 0, allowed, apps, sps },
  };
}

function saveAppPolicy(req, res, existing) {
  const { errors, data } = parseAppPolicy(req.body, existing);
  if (errors.length) { fail(res, errors); return null; }
  return db.tx(() => {
    let id = existing ? existing.id : null;
    if (id) {
      db.run('UPDATE app_policies SET name = ?, description = ?, require_mfa = ?, require_phishing_resistant = ?, allowed_factors = ? WHERE id = ?',
        data.name, data.description, data.mfa, data.phishing, data.allowed, id);
    } else {
      id = Number(db.run('INSERT INTO app_policies (name, description, require_mfa, require_phishing_resistant, allowed_factors) VALUES (?, ?, ?, ?, ?)',
        data.name, data.description, data.mfa, data.phishing, data.allowed).lastInsertRowid);
    }
    db.run('DELETE FROM app_policy_apps WHERE policy_id = ?', id);
    db.run('DELETE FROM app_policy_sps WHERE policy_id = ?', id);
    for (const a of data.apps) db.run('INSERT INTO app_policy_apps (policy_id, app_id) VALUES (?, ?)', id, a);
    for (const s of data.sps) db.run('INSERT INTO app_policy_sps (policy_id, sp_id) VALUES (?, ?)', id, s);
    return id;
  });
}

admin.post('/app-policies', need('policies.manage'), (req, res) => {
  const id = saveAppPolicy(req, res, null);
  if (id !== null) {
    auditLog.admin('app_policy.create', { actor: auditLog.who(req.user), target: { type: 'app_policy', id, name: appPolicyById(id).name }, detail: appPolicyById(id) });
    res.status(201).json(appPolicyById(id));
  }
});

admin.put('/app-policies/:id', need('policies.manage'), (req, res) => {
  const existing = appPolicyById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such application policy.' });
  const id = saveAppPolicy(req, res, existing);
  if (id !== null) {
    const after = appPolicyById(id);
    auditLog.admin('app_policy.update', { actor: auditLog.who(req.user), target: { type: 'app_policy', id, name: after.name },
      detail: { changed: Object.keys(after).filter((k) => JSON.stringify(existing[k]) !== JSON.stringify(after[k])), now: after } });
    res.json(after);
  }
});

admin.delete('/app-policies/:id', need('policies.manage'), (req, res) => {
  const gone = appPolicyById(req.params.id);
  if (!gone) return res.status(404).json({ error: 'No such application policy.' });
  db.run('DELETE FROM app_policies WHERE id = ?', gone.id);
  auditLog.admin('app_policy.delete', { actor: auditLog.who(req.user), target: { type: 'app_policy', id: gone.id, name: gone.name }, detail: gone });
  res.status(204).end();
});

/* Password policies: named sets of password rules that a policy above can use. */

const passwordPolicyById = (id) => db.get('SELECT * FROM password_policies WHERE id = ?', Number(id));
const passwordPolicyUsers = (id) => {
  const names = db.all('SELECT name FROM policies WHERE password_policy_id = ? ORDER BY name', Number(id)).map((r) => r.name);
  return policies.globalPolicy()?.password_policy_id === Number(id) ? [policies.GLOBAL_NAME, ...names] : names;
};

// Words and patterns arrive as arrays or as text with one entry per line.
const lines = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);

// The password rules in a request body, parsed into the columns a rule set stores. Problems are returned, not thrown.
function parsePasswordRules(body) {
  const errors = [];
  const int = (v, label, max) => {
    const n = v === '' || v == null ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) { errors.push(`${label} must be a whole number from 0 to ${max}.`); return 0; }
    return n;
  };
  const words = [...new Set(lines(body.restricted_words).map((w) => w.toLowerCase()))];
  const patterns = [...new Set(lines(body.restricted_patterns))];
  if (words.length > passwordRules.MAX_WORDS) errors.push(`List at most ${passwordRules.MAX_WORDS} restricted words.`);
  if (words.some((w) => w.length > passwordRules.MAX_WORD_LENGTH)) errors.push(`A restricted word is longer than ${passwordRules.MAX_WORD_LENGTH} characters.`);
  if (patterns.length > passwordRules.MAX_PATTERNS) errors.push(`List at most ${passwordRules.MAX_PATTERNS} restricted patterns.`);
  for (const p of patterns) { const bad = passwordRules.patternError(p); if (bad) errors.push(bad); }
  const zxcvbnOn = Boolean(body.zxcvbn_enabled);
  const minLength = int(body.min_length, 'Minimum length', policies.MAX_MIN_PASSWORD);
  return {
    errors,
    data: {
      minLength,
      lower: body.require_lowercase ? 1 : 0, upper: body.require_uppercase ? 1 : 0, digit: body.require_digit ? 1 : 0, symbol: body.require_symbol ? 1 : 0,
      classes: int(body.min_character_classes, 'Character classes', 4), personal: body.block_personal_info ? 1 : 0,
      words: JSON.stringify(words), patterns: JSON.stringify(patterns),
      historyAll: body.history_forbid_all ? 1 : 0,
      // "Never reuse" already covers any count, so the count is only kept when it is the operative rule.
      historyCount: body.history_forbid_all ? 0 : int(body.history_count, 'Password history', passwordRules.MAX_HISTORY_COUNT),
      hibp: body.hibp_enabled ? 1 : 0, hibpMin: Math.max(1, int(body.hibp_min_count, 'Breach count threshold', 1000000) || 1), hibpBlock: body.hibp_block_on_error ? 1 : 0,
      zxcvbn: zxcvbnOn ? 1 : 0, zxcvbnMin: zxcvbnOn ? int(body.zxcvbn_min_score, 'Minimum strength', 4) : 0,
    },
  };
}

// The table columns a password rule set stores, from parsed rules.
const ruleColumns = (d) => ({
  min_length: d.minLength, require_lowercase: d.lower, require_uppercase: d.upper, require_digit: d.digit, require_symbol: d.symbol,
  min_character_classes: d.classes, block_personal_info: d.personal, restricted_words: d.words, restricted_patterns: d.patterns,
  history_count: d.historyCount, history_forbid_all: d.historyAll, hibp_enabled: d.hibp, hibp_min_count: d.hibpMin, hibp_block_on_error: d.hibpBlock,
  zxcvbn_enabled: d.zxcvbn, zxcvbn_min_score: d.zxcvbnMin,
});

function parsePasswordPolicy(body, existing) {
  const errors = [];
  const name = str(body.name);
  if (!name) errors.push('Name is required.');
  if (name && db.get('SELECT 1 FROM password_policies WHERE name = ? AND id != ?', name, existing ? existing.id : 0)) errors.push('Another password policy already has that name.');
  const rules = parsePasswordRules(body);
  return { errors: [...errors, ...rules.errors], data: { ...rules.data, name, description: str(body.description) } };
}

function savePasswordPolicy(req, res, existing) {
  const { errors, data: d } = parsePasswordPolicy(req.body, existing);
  if (errors.length) { fail(res, errors); return null; }
  // Below the minimum every password must meet (the global rule, or the built-in default), a password policy would let anyone it is attached to
  // use shorter passwords, so it needs an explicit acceptance.
  const minimum = policies.minimumPasswordLength();
  if (d.minLength > 0 && d.minLength < minimum && req.body.accept_global_override !== true) {
    fail(res, [`This password policy lowers the minimum length to ${d.minLength}, below the minimum for every password (${minimum}). Confirm that you accept it reduces security to save it.`]);
    return null;
  }
  const cols = { name: d.name, description: d.description, ...ruleColumns(d) };
  const names = Object.keys(cols);
  if (existing) {
    db.run(`UPDATE password_policies SET ${names.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(cols), existing.id);
    return existing.id;
  }
  return Number(db.run(`INSERT INTO password_policies (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, ...Object.values(cols)).lastInsertRowid);
}

// Whether an administrator wants a rule change enforced now (people must choose a compliant password at once) or by attrition (each
// password stays until it is next changed). Attrition is the default, since stored passwords are hashed and cannot be checked afterwards.
const enforceNow = (body) => body.enforce_immediately === true;

// Marks everyone a change reaches as needing a new password and returns how many were marked. `userIds` null = every account.
function enforcePasswordChange(userIds) {
  const ids = userIds ?? db.all('SELECT id FROM users').map((u) => u.id);
  return userService.requirePasswordChange(ids);
}

// Everyone covered by a named password policy through the sign-in policies that use it, directly or via a role or group.
function passwordPolicyMembers(passwordPolicyId) {
  if (policies.globalPolicy()?.password_policy_id === Number(passwordPolicyId)) return null;
  return db.all('SELECT id FROM users').map((u) => u.id)
    .filter((id) => policies.policiesFor(id).some((p) => p.password_policy_id === Number(passwordPolicyId)));
}

const passwordPolicyView = (r) => ({ ...passwordRules.view(r), used_by: passwordPolicyUsers(r.id) });

// The password rules every account is held to, as the console shows them, or null when none are set.
const globalPasswordView = () => {
  const rules = appSettings.globalPasswordRules();
  return rules ? passwordRules.view(passwordRules.normalize(rules)) : null;
};

admin.get('/password-policies', need('policies.view'), (req, res) => {
  res.json({
    password_policies: db.all('SELECT * FROM password_policies ORDER BY name').map(passwordPolicyView),
    global: globalPasswordView(),
    limits: {
      max_length: policies.MAX_MIN_PASSWORD, default_min_length: policies.minimumPasswordLength(), built_in_min_length: policies.DEFAULT_MIN_PASSWORD,
      floor_min_length: policies.MIN_PASSWORD_FLOOR, max_history: passwordRules.MAX_HISTORY_COUNT, history_kept: passwordRules.HISTORY_LIMIT, score_labels: passwordRules.SCORE_LABELS,
    },
  });
});

// The password rules for every account, set in the console's Passwords tab. A policy may relax one only with an accepted override (policies.js).
// The console warns before a minimum below the built-in 12 is saved. A minimum of 0 keeps the built-in one.
admin.put('/global-password-policy', need('policies.manage'), (req, res) => {
  const { errors, data: d } = parsePasswordRules(req.body);
  if (d.minLength && d.minLength < policies.MIN_PASSWORD_FLOOR) errors.push(`The minimum length must be at least ${policies.MIN_PASSWORD_FLOOR}, or 0 to keep the built-in ${policies.DEFAULT_MIN_PASSWORD}.`);
  if (errors.length) return fail(res, errors);
  const before = globalPasswordView();
  appSettings.saveGlobalPasswordRules(ruleColumns(d));
  const after = globalPasswordView();
  const enforced = enforceNow(req.body) ? enforcePasswordChange(null) : 0;
  auditLog.admin('settings.global_password_rules', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'global_password_rules' },
    detail: { changed: Object.keys(after).filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after[k])), before, after, lowered: policies.minimumPasswordLength() < policies.DEFAULT_MIN_PASSWORD,
      enforce_immediately: enforceNow(req.body), password_change_required_for: enforced } });
  res.json({ ...after, enforced });
});

admin.delete('/global-password-policy', need('policies.manage'), (req, res) => {
  const before = globalPasswordView();
  if (!before) return res.status(404).json({ error: 'There are no global password rules.' });
  appSettings.saveGlobalPasswordRules(null);
  auditLog.admin('settings.global_password_rules', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'global_password_rules' }, detail: { before, after: null } });
  res.status(204).end();
});

admin.post('/password-policies', need('policies.manage'), (req, res) => {
  const id = savePasswordPolicy(req, res, null);
  if (id === null) return;
  const view = passwordPolicyView(passwordPolicyById(id));
  auditLog.admin('password_policy.create', { actor: auditLog.who(req.user), target: { type: 'password_policy', id, name: view.name }, detail: view });
  // A new password policy covers nobody until a sign-in policy points at it, so there is no one to enforce it on yet.
  res.status(201).json({ ...view, enforced: 0 });
});

admin.put('/password-policies/:id', need('policies.manage'), (req, res) => {
  const existing = passwordPolicyById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No such password policy.' });
  const before = passwordPolicyView(existing);
  const id = savePasswordPolicy(req, res, existing);
  if (id === null) return;
  const after = passwordPolicyView(passwordPolicyById(id));
  const changed = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const enforced = enforceNow(req.body) ? enforcePasswordChange(passwordPolicyMembers(id)) : 0;
  auditLog.admin('password_policy.update', { actor: auditLog.who(req.user), target: { type: 'password_policy', id, name: after.name },
    detail: { changed, now: after, enforce_immediately: enforceNow(req.body), password_change_required_for: enforced } });
  res.json({ ...after, enforced });
});

admin.delete('/password-policies/:id', need('policies.manage'), (req, res) => {
  const gone = passwordPolicyById(req.params.id);
  if (!gone) return res.status(404).json({ error: 'No such password policy.' });
  const users = passwordPolicyUsers(gone.id);
  if (users.length) return fail(res, [`This password policy is used by ${users.join(', ')}. Choose another password policy there first.`], 409);
  db.run('DELETE FROM password_policies WHERE id = ?', gone.id);
  auditLog.admin('password_policy.delete', { actor: auditLog.who(req.user), target: { type: 'password_policy', id: gone.id, name: gone.name }, detail: passwordPolicyView(gone) });
  res.status(204).end();
});

// What a person's rules come to once every policy that applies to them is combined.
admin.get('/users/:id/policy', need('policies.view'), (req, res) => {
  if (!db.get('SELECT 1 FROM users WHERE id = ?', Number(req.params.id))) return res.status(404).json({ error: 'No such user.' });
  res.json(policies.effectivePolicy(Number(req.params.id)));
});

/* Settings: Duo MFA and branding */

const DUO_HOST_RE = /^api-[a-z0-9]+\.(duosecurity|duofederal)\.com$/i;

function duoView() {
  const c = appSettings.duo();
  return { enabled: c.enabled, apiHost: c.apiHost, integrationKey: c.integrationKey, secretSet: Boolean(c.secretKey), source: c.source, bypassed: c.bypassed };
}

// An empty secret keeps the current one, so the secret never has to travel back to the browser.
function parseDuo(body) {
  const current = appSettings.duo();
  const cfg = {
    enabled: Boolean(body.enabled),
    apiHost: str(body.apiHost).toLowerCase(),
    integrationKey: str(body.integrationKey),
    secretKey: str(body.secretKey) || current.secretKey,
  };
  const errors = [];
  if (cfg.apiHost && !DUO_HOST_RE.test(cfg.apiHost)) errors.push('API hostname must look like api-xxxxxxxx.duosecurity.com.');
  if (cfg.enabled) {
    if (!cfg.apiHost) errors.push('API hostname is required.');
    if (!cfg.integrationKey) errors.push('Integration key is required.');
    if (!cfg.secretKey) errors.push('Secret key is required.');
  }
  return { cfg, errors };
}

async function duoCheck(cfg) {
  try {
    await duo.check(cfg);
    return null;
  } catch (e) {
    return `Duo rejected these settings: ${e.message || 'could not reach Duo'}`;
  }
}

admin.get('/settings/duo', need('duo.manage'), (req, res) => res.json(duoView()));

admin.post('/settings/duo/test', need('duo.manage'), async (req, res) => {
  const { cfg, errors } = parseDuo({ ...req.body, enabled: true });
  if (errors.length) return fail(res, errors);
  const problem = await duoCheck(cfg);
  if (problem) return fail(res, problem);
  res.json({ ok: true });
});

// Turning Duo on is refused unless Duo accepts the credentials: with a bad key every sign-in would fail closed.
admin.put('/settings/duo', need('duo.manage'), async (req, res) => {
  const { cfg, errors } = parseDuo(req.body);
  if (errors.length) return fail(res, errors);
  if (cfg.enabled) {
    const problem = await duoCheck(cfg);
    if (problem) return fail(res, problem);
  }
  const before = appSettings.duo();
  appSettings.saveDuo(cfg);
  // Which fields changed, never their values: the secret key must not reach the log.
  auditLog.admin('settings.duo', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'duo' },
    detail: { enabled: cfg.enabled, changed: ['enabled', 'apiHost', 'integrationKey', 'secretKey'].filter((k) => before[k] !== cfg[k]) } });
  res.json(duoView());
});

/* Settings: log forwarding to a syslog server or SIEM */

const FORWARDING_FIELDS = ['syslog.enabled', 'syslog.url', 'syslog.facility', 'syslog.appName', 'syslog.caFile', 'http.enabled', 'http.url', 'http.format', 'http.authToken'];
const forwardingField = (cfg, path) => { const [group, key] = path.split('.'); return cfg[group][key]; };

admin.get('/settings/audit-forwarding', need('audit.manage'), (req, res) => res.json(appSettings.auditForwardingView()));

// Saving restarts forwarding with the new destinations; each one resumes from its own place in the audit log.
admin.put('/settings/audit-forwarding', need('audit.manage'), (req, res) => {
  const before = appSettings.forwarding();
  const { data, errors } = appSettings.parseAuditForwarding(req.body, before);
  if (errors.length) return fail(res, errors);
  appSettings.saveAuditForwarding(data);
  forwarder.start(appSettings.auditForwardingSinks());
  // Which fields changed, never their values: the access token must not reach the log.
  auditLog.admin('settings.audit_forwarding', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'audit_forwarding' },
    detail: { syslog: data.syslog.enabled, http: data.http.enabled, changed: FORWARDING_FIELDS.filter((k) => forwardingField(before, k) !== forwardingField(data, k)) } });
  res.json(appSettings.auditForwardingView());
});

// A save that leaves a dangerous setting in place is refused (409) until the request lists it in `acknowledge`. The reply says which.
const needAcknowledgement = (res, warnings) => res.status(409).json({
  errors: ['Read the warning and tick the box to accept the risk before saving.'], requires_acknowledgement: true, warnings });

const messagingView = () => ({ ...messagingSettings.view(), warnings: security.status('messaging') });
admin.get('/settings/messaging', need('messaging.manage'), (req, res) => res.json(messagingView()));

admin.put('/settings/messaging', need('messaging.manage'), (req, res) => {
  const before = messagingSettings.messaging();
  const { data, errors } = messagingSettings.parse(req.body, before);
  if (errors.length) return fail(res, errors);
  const unaccepted = security.unacknowledged('messaging', { messaging: data }, req.body.acknowledge);
  if (unaccepted.length) return needAcknowledgement(res, unaccepted);
  messagingSettings.save(data);
  const accepted = security.recordAcknowledgements({ messaging: data }, req.body.acknowledge, req.user.username);
  if (accepted.length) auditLog.admin('settings.risk_acknowledged', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'messaging' }, detail: { risks: accepted } });
  // Channels and providers, never values: the logs must not receive credentials.
  auditLog.admin('settings.messaging', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'messaging' },
    detail: { changed: ['email', 'sms', 'voice'].filter((c) => JSON.stringify(before[c]) !== JSON.stringify(data[c])),
      providers: { email: data.email.provider, sms: data.sms.provider, voice: data.voice.provider } } });
  res.json(messagingView());
});

// Sends a real message with the saved settings so an administrator can see delivery work before relying on it.
admin.post('/settings/messaging/test', need('messaging.manage'), async (req, res, next) => {
  const channel = req.body.channel;
  const to = typeof req.body.to === 'string' ? req.body.to.trim() : '';
  try {
    await messaging.send(channel, to, { subject: 'Test message', text: 'This is a test message from your identity provider.' }, { rateKey: `test:${req.user.id}` });
    auditLog.admin('settings.messaging_test', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'messaging' }, detail: { channel } });
    res.json({ ok: true });
  } catch (e) {
    if (!(e instanceof messaging.MessagingError)) return next(e);
    auditLog.admin('settings.messaging_test', { outcome: 'failure', actor: auditLog.who(req.user), target: { type: 'settings', name: 'messaging' }, detail: { channel, error: e.message } });
    res.status(e.status === 429 ? 429 : 400).json({ errors: [e.message] });
  }
});

// Wording of the MFA and password reset messages. The view carries the variable reference the console displays.
admin.get('/settings/messaging/templates', need('messaging.manage'), (req, res) => res.json(messageTemplates.view()));

admin.put('/settings/messaging/templates', need('messaging.manage'), (req, res) => {
  const before = messageTemplates.templates();
  const { data, errors } = messageTemplates.parse(req.body, before);
  if (errors.length) return fail(res, errors);
  messageTemplates.save(data);
  const changed = [];
  for (const kind of Object.keys(data)) for (const ch of messageTemplates.CHANNELS) if (JSON.stringify(before[kind][ch]) !== JSON.stringify(data[kind][ch])) changed.push(`${kind}.${ch}`);
  auditLog.admin('settings.message_templates', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'message_templates' }, detail: { changed } });
  res.json(messageTemplates.view());
});

// Renders an unsaved draft with sample values, or says what is wrong with it.
admin.post('/settings/messaging/templates/preview', need('messaging.manage'), (req, res) => {
  const { kind, channel, subject, body } = req.body || {};
  const out = messageTemplates.preview(kind, channel, { ...(channel === 'email' ? { subject } : {}), body });
  if (out.errors) return fail(res, out.errors);
  res.json(out);
});

admin.get('/settings/recovery', need('recovery.manage'), (req, res) => res.json({ ...recovery.get(), email_ready: require('../messaging/settings').configured('email') }));

admin.put('/settings/recovery', need('recovery.manage'), (req, res) => {
  const before = recovery.get();
  const { data, errors } = recovery.parse(req.body);
  if (errors.length) return fail(res, errors);
  recovery.save(data);
  auditLog.admin('settings.recovery', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'recovery' }, detail: { before, after: data } });
  res.json({ ...recovery.get(), email_ready: true });
});

// Identity verification for resets (identity/settings.js). The secrets never go back to the console.
admin.get('/guest-policy', need('policies.view'), (req, res) => res.json({ ...guests.settings(), groups: db.all('SELECT id, name FROM groups ORDER BY name') }));

admin.put('/guest-policy', need('policies.manage'), (req, res) => {
  const before = guests.settings();
  const { data, errors } = guests.parseSettings(req.body);
  if (errors.length) return fail(res, errors);
  guests.saveSettings(data);
  auditLog.admin('policy.guests', { actor: auditLog.who(req.user), target: { type: 'policy', name: 'guests' }, detail: { before, after: data } });
  res.json({ ...data, groups: db.all('SELECT id, name FROM groups ORDER BY name') });
});

admin.get('/settings/identity', need('recovery.manage'), (req, res) => res.json(identitySettings.view()));

admin.put('/settings/identity', need('recovery.manage'), (req, res) => {
  const before = identitySettings.get();
  const { data, errors } = identitySettings.parse(req.body);
  if (errors.length) return fail(res, errors);
  identitySettings.save(data);
  const changed = ['provider', 'persona', 'rest', 'requirement'].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(data[k]));
  auditLog.admin('settings.identity', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'identity' }, detail: { changed, provider: data.provider, requirement: data.requirement } });
  res.json(identitySettings.view());
});

const factorsView = () => ({ ...factorSettings.get(), methods: factorSettings.METHODS, warnings: security.status('factors') });
admin.get('/settings/factors', need('factors.manage'), (req, res) => res.json(factorsView()));

admin.put('/settings/factors', need('factors.manage'), (req, res) => {
  const before = factorSettings.get();
  const { data, errors } = factorSettings.parse(req.body);
  if (errors.length) return fail(res, errors);
  const unaccepted = security.unacknowledged('factors', { factors: data }, req.body.acknowledge);
  if (unaccepted.length) return needAcknowledgement(res, unaccepted);
  factorSettings.save(data);
  const accepted = security.recordAcknowledgements({ factors: data }, req.body.acknowledge, req.user.username);
  if (accepted.length) auditLog.admin('settings.risk_acknowledged', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'factors' }, detail: { risks: accepted } });
  auditLog.admin('settings.factors', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'factors' },
    detail: { changed: ['webauthn', ...factorSettings.CHANNELS, 'codeLength', 'phishingResistantMethods'].filter((t) => JSON.stringify(before[t]) !== JSON.stringify(data[t])), settings: data } });
  res.json(factorsView());
});

const sessionView = () => {
  const { sessionHours, idleMinutes } = security.get();
  return { sessionHours, idleMinutes, limits: { hours: security.SESSION_HOURS, idleMinutes: security.IDLE_MINUTES }, warnings: security.status('session') };
};
admin.get('/settings/session', need('sessions.manage'), (req, res) => res.json(sessionView()));

admin.put('/settings/session', need('sessions.manage'), (req, res) => {
  const before = security.get();
  const { data, errors } = security.parseSession(req.body);
  if (errors.length) return fail(res, errors);
  const unaccepted = security.unacknowledged('session', { security: data }, req.body.acknowledge);
  if (unaccepted.length) return needAcknowledgement(res, unaccepted);
  const accepted = security.recordAcknowledgements({ security: data }, req.body.acknowledge, req.user.username);
  auditLog.admin('settings.session', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'session' },
    detail: { sessionHours: data.sessionHours, idleMinutes: data.idleMinutes, before: { sessionHours: before.sessionHours, idleMinutes: before.idleMinutes }, acknowledged: accepted } });
  res.json(sessionView());
});

admin.get('/settings/branding', need('branding.manage'), (req, res) => res.json(appSettings.branding()));

admin.put('/settings/branding', need('branding.manage'), (req, res) => {
  const { data, errors } = appSettings.parseBranding(req.body);
  if (errors.length) return fail(res, errors);
  const before = appSettings.branding();
  appSettings.saveBranding(data);
  // Picking another system font (or the default) frees the Google Fonts that are no longer used.
  if (before.fontFamily.toLowerCase() !== data.fontFamily.toLowerCase()) fonts.forgetRemoved(fonts.pruneGoogle(data.fontFamily));
  auditLog.admin('settings.branding', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'branding' },
    detail: { changed: Object.keys(data).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(data[k])) } });
  res.json(appSettings.branding());
});

// Fonts for the branding: Google Fonts (a short list, downloaded to this server) and uploaded files. Font files come in as the raw
// body, one file per request, with the family, style and weight in the query.
const fontUpload = express.raw({ type: 'application/octet-stream', limit: '4mb' });
const fontErrors = (res, e) => fail(res, e.message, e.status || 500);

admin.get('/settings/fonts', need('branding.manage'), (req, res) => res.json({ families: fonts.installed() }));

admin.get('/settings/google-fonts', need('branding.manage'), async (req, res) => {
  try {
    res.json(await fonts.googleCatalog());
  } catch (e) { fontErrors(res, e); }
});

admin.post('/settings/google-fonts/:family', need('branding.manage'), async (req, res) => {
  try {
    const family = await fonts.installGoogle(req.params.family);
    auditLog.admin('settings.fonts', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'fonts' }, detail: { installed: family, source: 'google' } });
    res.json({ families: fonts.installed(), installed: family });
  } catch (e) { fontErrors(res, e); }
});

admin.post('/settings/fonts', need('branding.manage'), (req, res, next) => fontUpload(req, res, (err) => {
  if (err) return fail(res, 'That font file is larger than 4 MB.', 413);
  return next();
}), (req, res) => {
  try {
    const family = fonts.uploadFace({ family: req.query.family, style: req.query.style, weight: Number(req.query.weight),
      name: req.query.name, data: req.body });
    auditLog.admin('settings.fonts', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'fonts' }, detail: { uploaded: family, style: req.query.style, weight: Number(req.query.weight) } });
    res.json({ families: fonts.installed() });
  } catch (e) { fontErrors(res, e); }
});

admin.delete('/settings/fonts/:family', need('branding.manage'), (req, res) => {
  const family = fonts.removeFamily(req.params.family);
  if (!family) return fail(res, 'That font is not installed.', 404);
  // A removed font cannot stay the system font.
  if (appSettings.branding().fontFamily.toLowerCase() === family.toLowerCase()) appSettings.saveBranding({ ...appSettings.branding(), fontFamily: '' });
  auditLog.admin('settings.fonts', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'fonts' }, detail: { removed: family } });
  res.json({ families: fonts.installed() });
});

// One face (style and weight) of a family, such as the bold italic of an uploaded font.
admin.delete('/settings/fonts/:family/faces/:style/:weight', need('branding.manage'), (req, res) => {
  const style = req.params.style;
  const weight = Number(req.params.weight);
  if (!['normal', 'italic'].includes(style) || !Number.isInteger(weight)) return fail(res, 'That is not a font face.');
  const gone = fonts.removeFace(req.params.family, style, weight);
  if (!gone) return fail(res, 'That font face is not installed.', 404);
  fonts.forgetRemoved(gone);
  auditLog.admin('settings.fonts', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'fonts' }, detail: { removedFace: `${req.params.family} ${style} ${weight}` } });
  res.json({ families: fonts.installed() });
});

// Every Google Font except the one the form has chosen (empty for the browser default). Uploads are kept.
admin.delete('/settings/google-fonts/unused', need('branding.manage'), (req, res) => {
  const removed = fonts.pruneGoogle(typeof req.query.keep === 'string' ? req.query.keep : '');
  fonts.forgetRemoved(removed);
  auditLog.admin('settings.fonts', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'fonts' }, detail: { removedUnused: removed } });
  res.json({ removed, families: fonts.installed() });
});

// The copy-detection choices, with the roles and groups to pick from.
const protectionView = () => ({
  ...appSettings.loginPageProtection(),
  roles: db.all('SELECT id, name FROM roles ORDER BY key = \'admin\' DESC, name'),
  groups: db.all('SELECT id, name FROM groups ORDER BY name'),
  emailConfigured: messaging.configured('email'),
});

// Images for the sign-in page (src/assets.js). One image per request, as the raw body, with its file name in the query.
const assetUpload = express.raw({ type: 'application/octet-stream', limit: '3mb' });
const auditAssets = (req, detail) => auditLog.admin('settings.assets', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'sign-in-images' }, detail });

admin.get('/settings/assets', need('branding.manage'), (req, res) => res.json({ assets: assets.list() }));

admin.post('/settings/assets', need('branding.manage'), (req, res, next) => assetUpload(req, res, (err) => {
  if (err) return fail(res, `That image is larger than ${assets.MAX_IMAGE / (1024 * 1024)} MB.`, 413);
  return next();
}), (req, res) => {
  try {
    const name = assets.upload(req.query.name, req.body);
    auditAssets(req, { uploaded: name });
    res.json({ assets: assets.list(), name });
  } catch (e) { fail(res, e.message, e.status || 500); }
});

admin.delete('/settings/assets/:name', need('branding.manage'), (req, res) => {
  if (!assets.remove(req.params.name)) return fail(res, 'That image is not uploaded.', 404);
  auditAssets(req, { removed: req.params.name });
  res.json({ assets: assets.list() });
});

admin.get('/settings/login-page-protection', need('branding.manage'), (req, res) => res.json(protectionView()));

admin.put('/settings/login-page-protection', need('branding.manage'), (req, res) => {
  const { data, errors } = appSettings.parseLoginPageProtection(req.body,
    (id) => Boolean(db.get('SELECT 1 FROM roles WHERE id = ?', id)),
    (id) => Boolean(db.get('SELECT 1 FROM groups WHERE id = ?', id)));
  if (errors.length) return fail(res, errors);
  appSettings.saveLoginPageProtection(data);
  auditLog.admin('settings.login_page_protection', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'login-page-protection' }, detail: data });
  res.json(protectionView());
});

/* Sign-in log and risk */

const AUTH_FILTERS = ['user_id', 'username', 'ip', 'country', 'asn', 'device_id', 'type', 'outcome', 'risk_level', 'from', 'to', 'before'];
const authFilters = (q) => Object.fromEntries(AUTH_FILTERS.filter((k) => typeof q[k] === 'string' && q[k] !== '').map((k) => [k, q[k]]));

// (csvCell, defined with the audit export below, keeps spreadsheets from running logged text as formulas.)
const AUTH_CSV = ['ts', 'type', 'outcome', 'reason', 'username', 'factor', 'ip', 'country', 'region', 'city', 'asn', 'asn_org', 'browser', 'os', 'device_type', 'device_id', 'device_known', 'risk_score', 'risk_level', 'risk_action', 'session_id', 'request_id'];

function authLogResponse(req, res, extra = {}) {
  const events = authlog.query({ ...authFilters(req.query), ...extra }, req.query.format === 'csv' ? 5000 : Math.min(Number(req.query.limit) || 100, 500));
  if (req.query.format === 'csv') {
    auditLog.admin('authlog.export', { actor: auditLog.who(req.user), detail: { filters: { ...authFilters(req.query), ...extra }, rows: events.length } });
    const lines = [AUTH_CSV.join(','), ...events.map((e) => AUTH_CSV.map((k) => csvCell(k === 'ts' ? new Date(e.ts * 1000).toISOString() : e[k])).join(','))];
    return res.type('text/csv').set('content-disposition', 'attachment; filename="sign-in-log.csv"').send(lines.join('\n'));
  }
  return res.json({ events, next: events.length ? events[events.length - 1].id : null });
}

admin.get('/auth-log', need('audit.view'), (req, res) => authLogResponse(req, res));

admin.get('/users/:id/auth-log', need('audit.view'), (req, res) => {
  const u = db.get('SELECT id, username FROM users WHERE id = ?', req.params.id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  if (req.query.format === 'csv') return authLogResponse(req, res, { user_id: String(u.id) });
  const events = authlog.query({ ...authFilters(req.query), user_id: String(u.id) }, Math.min(Number(req.query.limit) || 100, 500));
  res.json({ user: u, summary: authlog.summary(u.id), events, next: events.length ? events[events.length - 1].id : null });
});

router.get('/account/activity', requireLogin, (req, res) => res.json({ events: authlog.activityFor(req.user.id) }));

const riskView = () => ({ ...risk.get(), geoip: geoip.status(), options: { actions: risk.ACTIONS, modes: risk.MODES, signals: risk.SIGNALS } });

/* RADIUS: this server as an identity server for network devices */

const radius = require('../radius');
const radiusSettings = require('../radius/settings');
const radiusView = () => ({ ...radiusSettings.view(), status: radius.getStatus() });

admin.get('/settings/radius', need('radius.manage'), (req, res) => res.json(radiusView()));

admin.put('/settings/radius', need('radius.manage'), async (req, res, next) => {
  try {
    const before = radiusSettings.get();
    const { data, errors } = radiusSettings.parse(req.body || {}, before);
    if (errors.length) return fail(res, errors);
    radiusSettings.save(data);
    await radius.apply();
    const names = (list) => list.map((c) => c.name).sort();
    // Which clients changed, never their secrets.
    auditLog.admin('settings.radius', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'radius' },
      detail: { enabled: data.enabled, port: data.port, bindAddress: data.bindAddress, clients: names(data.clients),
        secretChanged: data.clients.filter((c) => { const o = before.clients.find((x) => x.id === c.id); return !o || o.secret !== c.secret; }).map((c) => c.name) } });
    res.json(radiusView());
  } catch (e) { next(e); }
});

admin.get('/settings/risk', need('risk.manage'), (req, res) => res.json(riskView()));

admin.put('/settings/risk', need('risk.manage'), async (req, res, next) => {
  try {
    const { data, errors } = risk.parse(req.body);
    const paths = { cityPath: String((req.body.geoip || {}).cityPath || '').trim(), asnPath: String((req.body.geoip || {}).asnPath || '').trim() };
    if (errors.length) return fail(res, errors);
    const before = risk.get();
    risk.save(data);
    geoip.saveConfig(paths);
    const loaded = await geoip.load();
    auditLog.admin('settings.risk', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'risk' }, detail: { before: { mode: before.mode, actions: before.actions }, after: { mode: data.mode, actions: data.actions }, geoip: loaded } });
    res.json({ ...riskView(), geoip_status: loaded });
  } catch (e) { next(e); }
});

// A MaxMind database file, uploaded from the Risk page. The body is the file itself; the City database is tens of megabytes.
admin.put('/settings/risk/geoip/:kind', need('risk.manage'), express.raw({ type: () => true, limit: '256mb' }), async (req, res, next) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) return fail(res, 'Choose a MaxMind database file.');
    let status;
    try {
      status = await geoip.upload(req.params.kind, buf);
    } catch (e) {
      if (e instanceof geoip.InvalidDatabase) return fail(res, e.message);
      throw e;
    }
    auditLog.admin('settings.risk', { actor: auditLog.who(req.user), target: { type: 'settings', name: 'risk' }, detail: { geoip_upload: req.params.kind, size: buf.length, geoip: status } });
    res.json({ ...riskView(), geoip_status: status });
  } catch (e) { next(e); }
});

// What would happen to this person signing in from here? Uses real history and the saved settings; nothing is recorded.
admin.post('/settings/risk/simulate', need('risk.manage'), (req, res) => {
  const u = db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', String(req.body.username || '').trim());
  if (!u) return fail(res, 'No such user.');
  const given = req.body.geo && typeof req.body.geo === 'object' ? req.body.geo : {};
  const looked = req.body.ip ? geoip.lookup(String(req.body.ip)) : geoip.EMPTY;
  const geo = { ...looked, ...Object.fromEntries(['country', 'country_name', 'lat', 'lon', 'asn'].filter((k) => given[k] !== undefined && given[k] !== '').map((k) => [k, ['lat', 'lon', 'asn'].includes(k) ? Number(given[k]) : String(given[k])])) };
  const cfg = risk.get();
  const policy = policies.effectivePolicy(u.id);
  // A browser that is not new is the one the person last signed in from, so a known-browser sign-in can score as usual.
  const lastDevice = db.get("SELECT device_id FROM auth_events WHERE user_id = ? AND type = 'signin' AND outcome = 'success' AND device_id <> '' ORDER BY ts DESC LIMIT 1", u.id);
  const a = risk.assess(u, { ip: String(req.body.ip || ''), geo, deviceId: req.body.new_device ? '' : (req.body.device_id || lastDevice?.device_id || ''), deviceGeo: readDeviceGeo(req.body.device_geo) }, cfg);
  const action = risk.actionFor(a.level, policy, cfg);
  res.json({ ...a, action, mode: cfg.mode, geo, restriction: risk.restriction(action, u) });
});

/* Audit log */

const AUDIT_FILTERS = ['category', 'action', 'outcome', 'actor', 'actorId', 'targetType', 'targetId', 'ip', 'from', 'to', 'before', 'q'];
const auditFilters = (q) => Object.fromEntries(AUDIT_FILTERS.filter((k) => typeof q[k] === 'string' && q[k] !== '').map((k) => [k, q[k]]));

admin.get('/audit', need('audit.view'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = auditLog.query(auditFilters(req.query), limit);
  res.json({ events: rows, next: rows.length === limit ? rows[rows.length - 1].id : null, retentionDays: settings.auditRetentionDays });
});

const csvCell = (v) => {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // stop spreadsheets treating logged text as a formula
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

admin.get('/audit.csv', need('audit.view'), (req, res) => {
  const rows = auditLog.query(auditFilters(req.query), 5000);
  const cols = ['id', 'ts', 'category', 'action', 'outcome', 'actor_type', 'actor_name', 'target_type', 'target_id', 'target_name', 'ip', 'request_id', 'detail'];
  const lines = [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(c === 'ts' ? new Date(r.ts * 1000).toISOString() : c === 'detail' ? JSON.stringify(r.detail) : r[c])).join(',')));
  auditLog.admin('audit.export', { actor: auditLog.who(req.user), detail: { rows: rows.length, filters: auditFilters(req.query) } });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="audit-log.csv"').send(`${lines.join('\r\n')}\r\n`);
});

// The Search button: a few matches from each area the caller may see. Sections for areas they cannot open are left out.
admin.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const out = {};
  if (q.length < 2) return res.json(out);
  const limit = 6;
  // A bad LDAP filter is reported in that section, so the other sections still show.
  const people = () => {
    try {
      return search.searchPeople({ q, limit });
    } catch (e) {
      if (!(e instanceof LdapFilterError)) throw e;
      return { results: [], total: 0, error: e.message };
    }
  };
  if (req.perms.has('users.view')) out.people = people();
  if (req.perms.has('sps.view')) out.applications = search.searchApplications({ q, limit });
  if (req.perms.has('groups.view')) out.groups = search.searchGroups({ q, limit });
  if (req.perms.has('integrations.view')) out.integrations = search.searchIntegrations({ q, limit });
  if (req.perms.has('audit.view')) {
    const events = auditLog.query({ q }, limit).map(({ id, ts, action, outcome, actor_name, target_type, target_name }) => ({ id, ts, action, outcome, actor_name, target_type, target_name }));
    out.audit = { results: events, total: events.length };
  }
  res.json(out);
});

// Values that really occur in a log column, for the filter boxes: typing narrows the list and only a listed value can be chosen.
// Each field names its column, and optionally a column that describes the value. Most frequent first.
const SUGGEST = {
  audit: { table: 'audit_log', fields: { action: ['action'], actor: ['actor_name'], ip: ['ip'] } },
  signins: { table: 'auth_events', fields: { username: ['username'], ip: ['ip'], country: ['country', 'country_name'], asn: ['asn', 'asn_org'] } },
};
function suggest(kind, req, res) {
  const def = SUGGEST[kind].fields[req.query.field];
  if (!def) return fail(res, 'Unknown field.');
  const [col, label] = def;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = db.all(`SELECT ${col} AS value, ${label ? `MAX(${label})` : "''"} AS label, COUNT(*) AS n FROM ${SUGGEST[kind].table}
    WHERE ${col} IS NOT NULL AND ${col} != '' AND (${col} LIKE ? ESCAPE '\\'${label ? ` OR ${label} LIKE ? ESCAPE '\\'` : ''})
    GROUP BY ${col} ORDER BY n DESC, ${col} LIMIT 25`, ...(label ? [like, like] : [like]));
  return res.json(rows.map((r) => ({ value: String(r.value), label: r.label || '', count: r.n })));
}
admin.get('/audit/suggest', need('audit.view'), (req, res) => suggest('audit', req, res));
admin.get('/auth-log/suggest', need('audit.view'), (req, res) => suggest('signins', req, res));

admin.get('/audit/forwarding', need('audit.view'), (req, res) => res.json({ sinks: forwarder.status() }));

admin.post('/audit/forwarding/test', need('audit.view'), async (req, res) => {
  auditLog.system('audit.forward.test', { actor: auditLog.who(req.user), detail: { note: 'Test event sent from the admin console.' } });
  await forwarder.flush();
  res.json({ sinks: forwarder.status() });
});

router.use('/admin', admin);

// Anything else under /api is a JSON 404, never the HTML error page.
router.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Errors from /api handlers are JSON too.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = router;
