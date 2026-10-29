const db = require('../db');
const settings = require('./settings');

// What a person can sign in with beyond their password, and which of those they may use right now. The authenticator app is
// not a row in user_factors: it stays on the users row (totp_*), and appears here as the factor 'totp'. An email, SMS or voice
// row is one destination; each way that is on for its channel (see settings.js) is a separate option to sign in with.
//
// An option has an id: 'totp', 'f<row>' for a security key, or 'f<row>:<mode>' for a channel. Policies and the sign-in step
// refer to options by these ids, and a method ('webauthn', 'email:yes_no', ...) is the same thing without the destination.

const hint = (type, dest) => {
  if (type === 'email') { const [u, d] = dest.split('@'); return `${u.slice(0, 1)}${'*'.repeat(Math.max(u.length - 1, 1))}@${d}`; }
  if (type === 'sms' || type === 'voice') return `${'*'.repeat(Math.max(dest.length - 4, 1))}${dest.slice(-4)}`;
  return '';
};

const LABEL = { webauthn: 'Security key', email: 'Email', sms: 'Text message', voice: 'Phone call' };
const OPTION_LABEL = {
  code: 'enter a code',
  number_match: 'match a number',
  yes_no: 'reply yes or no',
  yes_no_verified: 'reply with the code on screen',
};

/** Every verified factor the person has set up: [{ id, type, label, hint, row }]. Security keys are listed one by one. */
function enrolled(user) {
  const out = [];
  if (user.totp_enabled) out.push({ id: 'totp', type: 'totp', label: 'Authenticator app' });
  for (const r of db.all('SELECT * FROM user_factors WHERE user_id = ? AND verified = 1 ORDER BY id', user.id)) {
    out.push({ id: `f${r.id}`, type: r.type, label: r.label || LABEL[r.type], hint: hint(r.type, r.destination), row: r });
  }
  return out;
}

/** Does the policy (and, later, a risk decision) leave this method usable? `limits` = { allowed: [methods]|null, phishingResistant }. */
function permitted(method, limits, cfg = settings.get()) {
  if (!settings.methodEnabled(method, cfg)) return false;
  if (limits.allowed && !allows(limits.allowed, method)) return false;
  if (limits.phishingResistant && !settings.phishingResistant(method, cfg)) return false;
  return true;
}

// A policy may name a whole channel ('email') to allow every way it is on, or one way ('email:yes_no').
const allows = (allowed, method) => allowed.includes(method) || allowed.includes(method.split(':')[0]);

const limitsOf = (policy, extra = {}) => ({
  allowed: extra.allowed ? (policy.allowedFactors ? policy.allowedFactors.filter((t) => extra.allowed.includes(t)) : extra.allowed) : policy.allowedFactors,
  phishingResistant: Boolean(policy.requirePhishingResistant || extra.phishingResistant),
});

/** Every sign-in option the person has: one per enrolled factor, and one per way a channel is on. */
function options(user, cfg = settings.get()) {
  const out = [];
  for (const f of enrolled(user)) {
    if (!f.row) { out.push({ ...f, method: f.type, mode: undefined }); continue; }
    if (f.type === 'webauthn') { out.push({ ...f, method: 'webauthn', mode: undefined }); continue; }
    for (const mode of settings.modesOf(f.type, cfg)) {
      out.push({ ...f, id: `${f.id}:${mode}`, method: `${f.type}:${mode}`, mode, label: `${f.label}: ${OPTION_LABEL[mode]}` });
    }
  }
  return out;
}

/** The sign-in options the person may use now. `extra` lets a caller narrow further (risk-based limits). */
function eligible(user, policy, extra = {}, cfg = settings.get()) {
  const limits = limitsOf(policy, extra);
  return options(user, cfg).filter((o) => permitted(o.method, limits, cfg));
}

/**
 * The option with this id for this person, or null. A channel's bare id ('f5') means its first way that is on, so a caller that
 * does not name a way still gets one.
 */
function optionById(user, id, cfg = settings.get()) {
  const all = options(user, cfg);
  return all.find((o) => o.id === id) || all.find((o) => o.id.startsWith(`${id}:`)) || null;
}

/** What someone with no factor at all may set up while signing in: only methods that need nothing delivered to them. */
function signInEnrollment(policy, extra = {}, cfg = settings.get()) {
  const limits = limitsOf(policy, extra);
  return ['totp', 'webauthn'].filter((t) => permitted(t, limits, cfg));
}

/** For the console and the profile: what each factor is and whether it resists phishing. */
const describe = (f, cfg = settings.get()) => ({
  id: f.id, type: f.type, label: f.label, hint: f.hint || '',
  method: f.method, mode: f.mode,
  phishing_resistant: settings.phishingResistant(f.method || f.type, cfg),
  modes: ['email', 'sms', 'voice'].includes(f.type) ? settings.modesOf(f.type, cfg) : undefined,
  created_at: f.row ? f.row.created_at : undefined, last_used_at: f.row ? f.row.last_used_at : undefined,
});

const touch = (factorId) => db.run("UPDATE user_factors SET last_used_at = datetime('now') WHERE id = ?", factorId);

module.exports = { enrolled, options, eligible, optionById, signInEnrollment, permitted, allows, limitsOf, describe, touch, hint };
