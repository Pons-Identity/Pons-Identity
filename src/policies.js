const db = require('./db');
const { effectiveRoleIds, roleIdsGrantedBy } = require('./roles');
const { effectiveGroupsOf, groupsOfDraft } = require('./group-membership');
const passwordRules = require('./password-rules');
const appSettings = require('./app-settings');

// A policy is a set of sign-in and password rules attached to one role or to one or more groups. Everyone holding the
// role or belonging to the group (directly or through nesting) is subject to it. When several policies apply
// to a person the strictest value of each rule wins, so adding someone to a group can only tighten their rules.
//
// A global policy applies to every account and takes part in that same strictest-wins merge. A sign-in policy may
// be less strict than the global policy on some rules, but only when an administrator accepts that it reduces
// security. Such an override holds only while the global value is the one it was accepted against: change the
// global rule and the override stops, so the stricter global value applies again.

// Least to most strict; '' means the policy says nothing about risk.
const RISK_ORDER = ['', 'allow', 'require_mfa', 'phishing_resistant', 'webauthn_only', 'block'];
// The built-in minimum. An administrator may overwrite it (Policies → Password policies), down to MIN_PASSWORD_FLOOR; the console warns when lowered.
const DEFAULT_MIN_PASSWORD = 12;
const MIN_PASSWORD_FLOOR = 8;
const MAX_MIN_PASSWORD = 128;
// The longest a second factor may be remembered for a browser (30 days).
const MAX_REMEMBER_HOURS = 720;
const GLOBAL_NAME = 'Global policy';

// The rules an override can relax, with the label the console shows for each. A global policy cannot block sign-in, so blocking is not here.
const OVERRIDE_RULES = {
  mfa: 'Require a second factor',
  phishing: 'Require a phishing-resistant factor',
  factors: 'Limit the sign-in factors',
  recovery: 'Turn off password recovery',
  risk_medium: 'Response to medium risk',
  risk_high: 'Response to high risk',
  remember: 'Remember a second factor',
  password: 'Password rules',
};

/** The minimum length in force for every password: the global password rules' minimum, or the built-in default. */
const minimumPasswordLength = () => appSettings.globalPasswordRules()?.min_length || DEFAULT_MIN_PASSWORD;

// The sign-in rules of a global policy when none is set: every rule off.
const NO_SIGN_IN = {
  name: GLOBAL_NAME, description: '', block_sign_in: 0, require_mfa: 0, require_phishing_resistant: 0, allowed_factors: '',
  disable_password_recovery: 0, risk_medium_action: '', risk_high_action: '', remember_mfa_hours: null, password_policy_id: null,
};

/** The global sign-in policy as a policies-shaped row, or null when none is set. */
function globalSignInRow() {
  const saved = appSettings.globalPolicy();
  if (!saved) return null;
  return {
    name: GLOBAL_NAME, description: saved.description || '', block_sign_in: 0, require_mfa: saved.require_mfa ? 1 : 0,
    require_phishing_resistant: saved.require_phishing_resistant ? 1 : 0, allowed_factors: saved.allowed_factors || '',
    disable_password_recovery: saved.disable_password_recovery ? 1 : 0, risk_medium_action: saved.risk_medium_action || '',
    risk_high_action: saved.risk_high_action || '', remember_mfa_hours: saved.remember_mfa_hours ?? null,
    password_policy_id: saved.password_policy_id ?? null,
  };
}

/**
 * The global policy as a policies-shaped row, or null when neither its sign-in rules nor its password rules are set. The password
 * rules ride along as `inlinePassword`, which passwordRowsOf picks up.
 */
function globalPolicy() {
  const signIn = globalSignInRow();
  const inline = appSettings.globalPasswordRules();
  if (!signIn && !inline) return null;
  return { ...NO_SIGN_IN, ...(signIn || {}), inlinePassword: inline ? passwordRules.normalize(inline) : null };
}

/** The password rule rows in force for a list of policies-shaped rows: their named password policies and any inline global rules. */
function passwordRowsOf(rows) {
  const ids = [...new Set(rows.map((p) => p.password_policy_id).filter((id) => id != null))];
  const named = ids.length ? db.all(`SELECT * FROM password_policies WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  return [...rows.filter((p) => p.inlinePassword).map((p) => p.inlinePassword), ...named];
}

// Canonical text for password rules, so two rule sets compare equal whatever order their word lists came in.
const canonical = (rules) => JSON.stringify(rules, (k, v) => (Array.isArray(v) ? [...v].sort() : v));

/** What the global policy says for each overridable rule, as text. An override is valid only while this still matches what was accepted. */
function globalFingerprints(global) {
  if (!global) return {};
  const pw = passwordRowsOf([global]).map((r) => { const { id, name, description, ...rules } = passwordRules.view(r); return rules; });
  return {
    mfa: JSON.stringify([Boolean(global.require_mfa), Boolean(global.require_phishing_resistant)]),
    phishing: JSON.stringify(Boolean(global.require_phishing_resistant)),
    factors: JSON.stringify(global.allowed_factors || ''),
    recovery: JSON.stringify(Boolean(global.disable_password_recovery)),
    risk_medium: JSON.stringify(global.risk_medium_action || ''),
    risk_high: JSON.stringify(global.risk_high_action || ''),
    remember: JSON.stringify(global.remember_mfa_hours ?? null),
    password: canonical([global.password_policy_id ?? null, ...pw]),
  };
}

// Least to most strict rank of a risk response.
const riskRank = (action) => RISK_ORDER.indexOf(action || '');
const factorList = (text) => (text ? text.split(',') : null);

/**
 * The overridable rules that `row` (a policies-shaped sign-in policy) makes less strict than the global policy.
 * Empty when there is no global policy or the row is at least as strict on every rule.
 */
function weakenedBy(row, global) {
  if (!global) return [];
  const weak = [];
  const globalMfa = Boolean(global.require_mfa || global.require_phishing_resistant);
  const rowMfa = Boolean(row.require_mfa || row.require_phishing_resistant);
  if (globalMfa && !rowMfa) weak.push('mfa');
  if (global.require_phishing_resistant && !row.require_phishing_resistant) weak.push('phishing');
  const allowed = factorList(global.allowed_factors);
  const own = factorList(row.allowed_factors);
  // No limit on the row is weaker than any limit; a limit is weaker when it lets through a factor the global policy does not.
  if (allowed && (!own || own.some((t) => !allowed.includes(t)))) weak.push('factors');
  if (global.disable_password_recovery && !row.disable_password_recovery) weak.push('recovery');
  if (riskRank(row.risk_medium_action) < riskRank(global.risk_medium_action)) weak.push('risk_medium');
  if (riskRank(row.risk_high_action) < riskRank(global.risk_high_action)) weak.push('risk_high');
  // Remembering is the shortest period wins, so a longer period on the row is weaker only where the global policy sets one.
  if (global.remember_mfa_hours != null && row.remember_mfa_hours != null && row.remember_mfa_hours > global.remember_mfa_hours) weak.push('remember');
  // Adding the global password rules to the row's would change nothing only if the row is already at least as strict.
  const rowRules = passwordRules.combine(passwordRowsOf([row]));
  if (canonical(passwordRules.combine(passwordRowsOf([global, row]))) !== canonical(rowRules)) weak.push('password');
  return weak;
}

/** The overrides an accepted row carries forward: each weakened rule mapped to the global value it is accepted against. */
function acceptanceFor(row, global) {
  const fingerprints = globalFingerprints(global);
  return Object.fromEntries(weakenedBy(row, global).map((k) => [k, fingerprints[k]]));
}

/** Parses a stored override. Anything unreadable accepts nothing. */
function acceptedOverrides(row) {
  try {
    const v = JSON.parse(row.global_override || 'null');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * The state of a sign-in policy against the global policy: `weakens` lists the rules it makes weaker now, `active` the overrides
 * currently in force, and `needsAcceptance` the weakened rules that no accepted override covers.
 */
function overrideState(row, global) {
  const weakens = weakenedBy(row, global);
  const accepted = acceptedOverrides(row);
  const fingerprints = globalFingerprints(global);
  const active = weakens.filter((k) => accepted[k] !== undefined && accepted[k] === fingerprints[k]);
  return { weakens, active, needsAcceptance: weakens.filter((k) => !active.includes(k)) };
}

/** Policies whose role is one of `roleIds` or that name any group in `groupIds` (both Sets of ids). */
function policiesWith(roleIds, groupIds) {
  const groupsOf = new Map();
  for (const r of db.all('SELECT policy_id, group_id FROM policy_groups')) {
    if (!groupsOf.has(r.policy_id)) groupsOf.set(r.policy_id, []);
    groupsOf.get(r.policy_id).push(r.group_id);
  }
  return db.all('SELECT * FROM policies ORDER BY name')
    .filter((p) => (p.role_id !== null && roleIds.has(p.role_id)) || (groupsOf.get(p.id) || []).some((g) => groupIds.has(g)));
}

/** Policies that apply to the user, via the roles they hold and the groups they belong to. */
const policiesFor = (userId) => policiesWith(new Set(effectiveRoleIds(userId)), new Set(effectiveGroupsOf(userId).map((g) => g.id)));

/**
 * The combined rules for a set of applied sign-in policies and the global policy (or null), plus the names of the policies they came from.
 * A rule takes the global value into account unless an applied policy overrides it, in which case only the applied policies count for it.
 */
function combine(applied, global = null) {
  const overridden = new Set(applied.flatMap((p) => overrideState(p, global).active));
  const rowsFor = (key) => (global && !overridden.has(key) ? [global, ...applied] : applied);

  const rememberHours = rowsFor('remember').map((p) => p.remember_mfa_hours).filter((h) => h != null);
  const password = passwordRules.combine(passwordRowsOf(rowsFor('password')));
  // Requiring a phishing-resistant factor means a password alone can never be enough.
  const requirePhishingResistant = rowsFor('phishing').some((p) => p.require_phishing_resistant);
  return {
    blockSignIn: applied.some((p) => p.block_sign_in),
    requireMfa: requirePhishingResistant || rowsFor('mfa').some((p) => p.require_mfa),
    // null = no limit. Where several policies list factors, only types every one of them lists remain.
    allowedFactors: rowsFor('factors').filter((p) => p.allowed_factors).map((p) => p.allowed_factors.split(',')).reduce((a, b) => (a ? a.filter((t) => b.includes(t)) : b), null),
    // Recovery is on only where nothing that applies to the person turns it off.
    disablePasswordRecovery: rowsFor('recovery').some((p) => p.disable_password_recovery),
    riskMediumAction: rowsFor('risk_medium').map((p) => p.risk_medium_action).reduce((a, b) => (riskRank(b) > riskRank(a) ? b : a), ''),
    riskHighAction: rowsFor('risk_high').map((p) => p.risk_high_action).reduce((a, b) => (riskRank(b) > riskRank(a) ? b : a), ''),
    requirePhishingResistant,
    // How long a second factor stays good for a browser (hours). Only policies that set a period count; the shortest wins, and
    // when none sets one nothing is remembered (0).
    rememberMfaHours: rememberHours.length ? Math.min(...rememberHours) : 0,
    minPasswordLength: Math.max(minimumPasswordLength(), password.minLength),
    // The strictest of the password policies in force (password-rules.js).
    password,
    sources: [...(global ? [global.name] : []), ...applied.map((p) => p.name)],
  };
}

/** The combined rules for a user, plus the names of the policies they came from. */
const effectivePolicy = (userId) => combine(policiesFor(userId), globalPolicy());

/**
 * The combined rules for an account that does not exist yet: the policies its roles and groups would give it. Groups
 * are resolved as if it were already a member (nesting and composites count), and `groupIds` must exist to matter.
 */
function draftPolicy({ roleIds = [], groupIds = [] }) {
  const groups = groupsOfDraft(groupIds);
  return combine(policiesWith(new Set([...roleIds, ...roleIdsGrantedBy(groups)]), new Set(groups.map((g) => g.id))), globalPolicy());
}

/**
 * Why `password` is not acceptable under `policy` (empty = fine). `userId` names an existing person; `profile` (username,
 * first_name, last_name, display_name, email) describes an account being created. Async because a policy may check breaches.
 */
const passwordErrorsUnder = (policy, password, { userId = null, profile = null } = {}) => passwordRules.evaluate(userId, password, policy.password, {
  minLength: policy.minPasswordLength, profile,
});

/** Why `password` is not acceptable for this person (empty = fine). */
const passwordErrors = (userId, password) => passwordErrorsUnder(effectivePolicy(userId), password, { userId });

/** Why `password` is not acceptable for an account being created with these roles and groups (empty = fine). */
const draftPasswordErrors = (draft, password, profile) => passwordErrorsUnder(draftPolicy(draft), password, { profile });

/** What to tell the person about the rules, for the password form. */
const passwordGuidance = (userId) => {
  const { minPasswordLength, password: rules } = effectivePolicy(userId);
  return passwordRules.describe(rules, minPasswordLength);
};

module.exports = {
  DEFAULT_MIN_PASSWORD, MIN_PASSWORD_FLOOR, MAX_MIN_PASSWORD, MAX_REMEMBER_HOURS, OVERRIDE_RULES, GLOBAL_NAME, minimumPasswordLength,
  globalPolicy, globalSignInRow, combine, riskRank, weakenedBy, acceptanceFor, overrideState, policiesFor, effectivePolicy, draftPolicy, passwordErrors, passwordErrorsUnder,
  draftPasswordErrors, passwordGuidance,
};
