const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const auditLog = require('../audit');
const policies = require('../policies');
const recovery = require('../recovery');
const identity = require('../identity');
const messaging = require('../messaging');
const userService = require('../user-service');
const appSettings = require('../app-settings');
const { verifyPassword } = require('../crypto');

// Password recovery (public) and the personal recovery address (signed in). Mounted under /api by routes/api.js.

const IP_LIMIT = 10;
const IP_WINDOW_MS = 3600 * 1000;
const hits = new Map();
const ipAllowed = (ip) => {
  const t = Date.now();
  const recent = (hits.get(ip) || []).filter((x) => t - x < IP_WINDOW_MS);
  if (recent.length >= IP_LIMIT) { hits.set(ip, recent); return false; }
  recent.push(t);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < IP_WINDOW_MS)) hits.delete(k);
  return true;
};

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_TRIES = 5;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = function recoveryRoutes({ requireLogin }) {
  const router = express.Router();

  /* --------------------------------- Public --------------------------------- */

  // A recovery request: a password link (the default) or, when identity verification is required for it, an MFA link.
  const askForLink = (purpose) => (req, res) => {
    if (!recovery.available()) return res.status(404).json({ error: 'Password recovery is not available.' });
    if (!ipAllowed(req.ip)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    if (purpose === 'mfa' && !identity.required('mfa_reset')) return res.status(404).json({ error: 'Password recovery is not available.' });
    // The answer never depends on the account, and does not wait for delivery.
    recovery.request(req.body.identifier, { ip: req.ip, purpose }).catch((e) => console.error('Recovery request failed:', e.message));
    res.json({ ok: true, message: 'If we found an account with a recovery address, we have sent a link to it. It works for 30 minutes.' });
  };
  router.post('/recover', askForLink('password'));
  router.post('/recover/mfa', askForLink('mfa'));

  // What the link leads to: the kind of reset, and whether an identity verification must pass first (and where it is).
  const linkView = (found) => {
    const state = recovery.identityState(found.row, found.user);
    const waiting = identity.latest(found.user.id, found.row.purpose === 'mfa' ? 'mfa_reset' : 'password_reset');
    return {
      purpose: found.row.purpose,
      identity: { ...state, available: identity.available(), url: waiting && waiting.status === 'pending' && waiting.url ? waiting.url : '' },
    };
  };

  router.get('/recover/:token', async (req, res, next) => {
    const found = recovery.lookup(req.params.token);
    if (!found) return res.status(404).json({ error: 'This link has expired or was already used.' });
    // A waiting verification is asked about once more, so the page shows where it stands.
    if (identity.required(found.row.purpose === 'mfa' ? 'mfa_reset' : 'password_reset')) {
      try { await identity.current(found.user.id, found.row.purpose === 'mfa' ? 'mfa_reset' : 'password_reset'); } catch (e) { return next(e); }
    }
    res.json({ username: found.user.username, min_length: policies.effectivePolicy(found.user.id).minPasswordLength, rules: policies.passwordGuidance(found.user.id), ...linkView(found) });
  });

  // Opens the identity verification for this link (or returns the one already waiting).
  router.post('/recover/identity', async (req, res, next) => {
    const found = recovery.lookup(req.body.token);
    if (!found) return res.status(404).json({ error: 'This link has expired or was already used.' });
    const purpose = found.row.purpose === 'mfa' ? 'mfa_reset' : 'password_reset';
    if (!identity.required(purpose)) return res.status(400).json({ error: 'Identity verification is not needed for this reset.' });
    if (recovery.identityState(found.row, found.user).status === 'approved') return res.json(linkView(found));
    try {
      const waiting = identity.latest(found.user.id, purpose);
      if (!(waiting && waiting.status === 'pending' && waiting.created_at >= found.row.created_at)) {
        const r = await identity.start(found.user, purpose);
        if (r.error) return res.status(503).json({ error: r.error });
      }
    } catch (e) { return next(e); }
    return res.json(linkView(found));
  });

  // Asks the provider where the verification stands.
  router.post('/recover/identity/check', async (req, res, next) => {
    const found = recovery.lookup(req.body.token);
    if (!found) return res.status(404).json({ error: 'This link has expired or was already used.' });
    try { await identity.current(found.user.id, found.row.purpose === 'mfa' ? 'mfa_reset' : 'password_reset'); } catch (e) { return next(e); }
    return res.json(linkView(found));
  });

  router.post('/recover/reset', async (req, res, next) => {
    let r;
    try { r = await recovery.complete(req.body.token, req.body.new_password, { ip: req.ip }); } catch (e) { return next(e); }
    if (r.ok) return res.json({ ok: true, message: 'Your password has been changed. Sign in with it now.' });
    if (r.error === 'weak') return res.status(400).json({ error: r.message });
    if (r.error === 'identity') return res.status(403).json({ error: r.message, identity_required: true });
    return res.status(404).json({ error: 'This link has expired or was already used.' });
  });

  // Removes the second factors for an MFA link, once identity verification has passed.
  router.post('/recover/mfa/reset', async (req, res, next) => {
    let r;
    try { r = await recovery.completeMfaReset(req.body.token, { ip: req.ip }); } catch (e) { return next(e); }
    if (r.ok) return res.json({ ok: true, message: 'Your second factors were removed. Sign in and set up a new one.' });
    if (r.error === 'identity') return res.status(403).json({ error: r.message, identity_required: true });
    if (r.error === 'disabled') return res.status(404).json({ error: 'Password recovery is not available.' });
    return res.status(404).json({ error: 'This link has expired or was already used.' });
  });

  /* --------------------------- Signed in: my address --------------------------- */

  const view = (req) => ({ recovery_available: recovery.available() && !req.user.directory_id, personal_email: personalView(req.user) });
  router.get('/account/personal-email', requireLogin, (req, res) => res.json(view(req)));

  const needPassword = (req, res) => {
    if (req.user.directory_id) { res.status(409).json({ error: 'Your password is managed by your directory, so it cannot be recovered here.' }); return false; }
    if (!(typeof req.body.current_password === 'string' && verifyPassword(req.body.current_password, req.user.password_hash))) {
      auditLog.user('recovery.address_failure', { outcome: 'failure', actor: auditLog.who(req.user), detail: { reason: 'bad_current_password' } });
      res.status(400).json({ error: 'Current password is incorrect.' });
      return false;
    }
    return true;
  };

  // Step 1: a code goes to the new address; nothing is saved until it is entered.
  router.post('/account/personal-email', requireLogin, async (req, res, next) => {
    if (!recovery.available()) return res.status(404).json({ error: 'Password recovery is not available.' });
    if (!needPassword(req, res)) return undefined;
    const email = String(req.body.email || '').trim();
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const bad = email ? userService.personalEmailError(req.user.id, email) : 'Enter a valid personal email address.';
    if (bad) return res.status(400).json({ error: bad });
    try {
      await messaging.send('email', email, {
        subject: `Confirm your recovery address for ${appSettings.productName()}`,
        text: `Your confirmation code is ${code}. It expires in 10 minutes. If you did not ask for this, ignore this message.`,
      }, { rateKey: `recovery-address:${req.user.id}` });
    } catch (e) {
      if (e instanceof messaging.MessagingError) return res.status(e.status === 429 ? 429 : 502).json({ error: e.status === 429 ? e.message : 'The message could not be sent.' });
      return next(e);
    }
    req.session.personalEmailSetup = { email, hash: sha(`${email}:${code}`), expires: Date.now() + CODE_TTL_MS, tries: 0 };
    auditLog.user('recovery.address_code_sent', { actor: auditLog.who(req.user) });
    return res.json({ sent_to: recovery.mask(email) });
  });

  // Step 2: the code proves the address belongs to the person.
  router.post('/account/personal-email/verify', requireLogin, (req, res) => {
    const s = req.session.personalEmailSetup;
    if (!s || s.expires < Date.now()) { req.session.personalEmailSetup = null; return res.status(400).json({ error: 'That code has expired. Start again.' }); }
    const given = sha(`${s.email}:${String(req.body.code || '').replace(/\s+/g, '')}`);
    if (++s.tries > MAX_CODE_TRIES || given !== s.hash) {
      auditLog.user('recovery.address_failure', { outcome: 'failure', actor: auditLog.who(req.user), detail: { reason: 'bad_code' } });
      if (s.tries >= MAX_CODE_TRIES) { req.session.personalEmailSetup = null; return res.status(429).json({ error: 'Too many incorrect codes. Start again.' }); }
      return res.status(401).json({ error: 'Incorrect code.' });
    }
    const before = req.user;
    const err = userService.setPersonalEmail(req.user.id, s.email, { verified: true });
    req.session.personalEmailSetup = null;
    if (err) return res.status(400).json({ error: err });
    auditLog.user('recovery.address_set', { actor: auditLog.who(before), detail: { replaced: Boolean(before.personal_email) } });
    notifyOldAddress(before, 'changed');
    req.user = db.get('SELECT * FROM users WHERE id = ?', before.id);
    return res.json(view(req));
  });

  router.delete('/account/personal-email', requireLogin, (req, res) => {
    if (!needPassword(req, res)) return undefined;
    const before = req.user;
    userService.setPersonalEmail(before.id, '', { verified: false });
    auditLog.user('recovery.address_removed', { actor: auditLog.who(before) });
    notifyOldAddress(before, 'removed');
    req.user = db.get('SELECT * FROM users WHERE id = ?', before.id);
    return res.json(view(req));
  });

  return router;
};

function notifyOldAddress(user, what) {
  if (!user.personal_email || !user.personal_email_verified) return;
  const app = appSettings.productName();
  messaging.send('email', user.personal_email, {
    subject: `Your ${app} recovery address was ${what}`,
    text: `The recovery address on the account "${user.username}" at ${app} was ${what}. If this was not you, contact your administrator right away.`,
  }, { rateKey: `recovery-notice:${user.id}` }).catch(() => {});
}

function personalView(u) {
  return u.personal_email ? { hint: recovery.mask(u.personal_email), verified: Boolean(u.personal_email_verified) } : null;
}
module.exports.personalView = personalView;
module.exports.resetIpLimits = () => hits.clear();
