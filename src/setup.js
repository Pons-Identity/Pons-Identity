const crypto = require('crypto');
const db = require('./db');
const startup = require('./settings');
const appSettings = require('./app-settings');
const security = require('./security-settings');
const auditLog = require('./audit');
const policies = require('./policies');
const roles = require('./roles');
const userService = require('./user-service');
const throttle = require('./throttle');
const { hashPassword } = require('./crypto');
const { newGuid } = require('./guid');

// The first-run setup wizard.
//
// It is on whenever the database has no users: a new install, or one whose data was cleared. Everything it offers (the first
// administrator, branding, session limits, importing from another identity provider) is protected by a one-time token that is
// printed to the server's console and held only in memory, so someone who can reach the port but cannot read the console cannot
// claim the server. As soon as an administrator exists the wizard is off: its endpoints answer 404 and the token is discarded.
//
// It is switched off, not deleted. A person holding the `setup.run` permission can run it again from the console (it then
// skips the administrator step, and the token is not needed because they are already signed in). The `setup` setting keeps when
// and by whom it last ran.
const KEY = 'setup';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

let tokenHash = null;

const state = () => appSettings.read(KEY);
const hasUsers = () => Boolean(db.get('SELECT 1 FROM users LIMIT 1'));

/** Is the first-run wizard open? True exactly when there is nobody to sign in. */
const required = () => !hasUsers();

/** Installs that set ADMIN_PASSWORD, or turn the wizard off, are configured by the operator and never show it. */
const unattended = () => Boolean(startup.adminPassword) || startup.setupWizard === false;

function record(via, by) {
  const prev = state() || {};
  appSettings.write(KEY, { completedAt: new Date().toISOString(), completedBy: by, via, runs: (prev.runs || 0) + 1 });
}

/** Makes a one-time token (replacing any earlier one) and prints it. Returns it for callers that show it themselves. */
function issueToken({ print = true } = {}) {
  const t = crypto.randomBytes(12).toString('hex').match(/.{4}/g).join('-');
  tokenHash = sha256(t);
  auditLog.system('setup.token_issued');
  if (print) {
    console.log(`\n  ${appSettings.productName()} has no users yet, so the setup wizard is open.`);
    console.log(`  Open ${startup.baseUrl}/setup and enter this one-time setup token:\n`);
    console.log(`    ${t}\n`);
    console.log('  The token is shown only here and changes every time the server starts.\n');
  }
  return t;
}

/** Keeps the token in step with `required()`: makes one when the wizard is open, drops it when it is not. */
function sync() {
  if (!required()) { tokenHash = null; return false; }
  if (!tokenHash) issueToken();
  return true;
}

/** Called once at start-up. Returns true when the wizard is waiting for someone, false when an administrator was created. */
function begin() {
  if (!state() && hasUsers()) record(startup.adminPassword ? 'unattended' : 'existing-install', 'system');
  if (required() && unattended()) return false;
  return sync();
}

/** { ok } or { ok: false, retryAfter } for a token typed into the wizard. Wrong guesses are counted per address. */
function checkToken(candidate, ip) {
  if (!required() || !tokenHash) return { ok: false, closed: true };
  const gate = throttle.check('setup', { ip });
  if (gate.blocked) return { ok: false, retryAfter: gate.retryAfter };
  const ok = typeof candidate === 'string' && candidate.length > 0 && candidate.length < 200
    && crypto.timingSafeEqual(sha256(candidate.trim()), tokenHash);
  if (!ok) { throttle.fail('setup', { ip }); auditLog.system('setup.token_rejected', { detail: { ip } }); }
  return { ok };
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** What the wizard shows first: the current branding and session limits, and the address it was opened from. */
function defaults() {
  const b = appSettings.branding();
  const sec = security.get();
  return {
    branding: { appName: b.appName, primaryColor: b.primaryColor, headerColor: b.headerColor, fontFamily: b.fontFamily },
    session: { sessionHours: sec.sessionHours, idleMinutes: sec.idleMinutes || 30 },
    baseUrl: startup.baseUrl,
    tls: Boolean(startup.tls),
  };
}

/** Checks what the wizard submitted, without writing anything. Returns { errors, admin, branding, session }. */
async function validate(body, { needAdmin }) {
  const errors = [];
  const out = {};
  if (needAdmin) {
    const a = body.admin || {};
    const admin = {
      username: str(a.username), first_name: str(a.first_name), last_name: str(a.last_name), email: str(a.email), password: typeof a.password === 'string' ? a.password : '',
    };
    admin.display_name = `${admin.first_name} ${admin.last_name}`.trim() || admin.username;
    if (!USERNAME_RE.test(admin.username)) errors.push('Choose a username of letters, digits, dots, dashes and underscores (up to 64 characters).');
    if (!EMAIL_RE.test(admin.email)) errors.push('Enter a valid email address for the administrator.');
    if (admin.password !== (typeof a.confirm === 'string' ? a.confirm : admin.password)) errors.push('The two passwords do not match.');
    if (!errors.length) {
      const draft = policies.draftPolicy({ roleIds: [roles.adminRoleId()] });
      errors.push(...await policies.passwordErrorsUnder(draft, admin.password, { profile: { username: admin.username, first_name: admin.first_name, last_name: admin.last_name, display_name: admin.display_name, email: admin.email } }));
    }
    out.admin = admin;
  }
  if (body.branding) {
    const r = appSettings.parseBranding({ ...appSettings.branding(), ...body.branding });
    errors.push(...r.errors);
    out.branding = r.data;
  }
  if (body.session) {
    const r = security.parseSession(body.session);
    errors.push(...r.errors);
    out.session = r.data;
  }
  return { errors, ...out };
}

/**
 * Applies a validated submission in one transaction. `mode` is 'initial' (creates the administrator; refused when anybody exists)
 * or 'rerun' (a signed-in person with `setup.run`). `imports` runs after the account exists, inside the same transaction, so a
 * failed import leaves nothing half-made. Returns { admin, imported }.
 */
function apply(v, { mode, actor, imports }) {
  return db.tx(() => {
    let adminId = null;
    if (mode === 'initial') {
      if (hasUsers()) { const e = new Error('Setup has already been completed.'); e.status = 409; throw e; }
      const a = v.admin;
      adminId = userService.insertUser({
        fields: { username: a.username, first_name: a.first_name, last_name: a.last_name, display_name: a.display_name, email: a.email },
        passwordHash: hashPassword(a.password), emails: [{ email: a.email, primary: true }],
      }, { by: null, via: 'admin' }, (id) => {
        db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', id, roles.adminRoleId());
      });
    }
    if (v.branding) appSettings.saveBranding(v.branding);
    if (v.session) security.save({ ...security.get(), ...v.session });
    const imported = imports ? imports() : null;
    const by = mode === 'initial' ? v.admin.username : actor.username;
    record(mode, by);
    auditLog.admin(mode === 'initial' ? 'setup.complete' : 'setup.rerun', {
      actor: mode === 'initial' ? { type: 'user', id: adminId, name: by } : auditLog.who(actor),
      detail: { branding: Boolean(v.branding), session: Boolean(v.session), imported: imported ? imported.counts : null },
    });
    return { adminId, imported };
  });
}

/** After the transaction: closes the wizard. */
const finish = () => { tokenHash = null; };

module.exports = { required, unattended, begin, sync, issueToken, checkToken, defaults, validate, apply, finish, state };
