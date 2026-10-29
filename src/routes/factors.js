const express = require('express');
const db = require('../db');
const auditLog = require('../audit');
const policies = require('../policies');
const factors = require('../factors');
const factorSettings = require('../factors/settings');
const challenges = require('../factors/challenges');
const webauthn = require('../factors/webauthn');
const appSettings = require('../app-settings');
const { verifyPassword } = require('../crypto');
const { PHONE_RE, EMAIL_RE } = require('../messaging');
const messagingSettings = require('../messaging/settings');
const { twilioSignatureOk } = require('../messaging/twilio-signature');
const { baseUrl } = require('../config');

// Sign-in with security keys and with email / SMS / voice, plus managing those factors from the profile. Mounted under /api by
// routes/api.js, which owns the session and hands over its helpers. The password step has already happened by the time any of
// the sign-in routes run: they only work on a session that is partway through signing in (req.session.mfa).

const AMR = { webauthn: ['pwd', 'hwk', 'mfa'], email: ['pwd', 'otp', 'mfa'], sms: ['pwd', 'sms', 'mfa'], voice: ['pwd', 'tel', 'mfa'] };
// A sign-in option is 'f<row>' or 'f<row>:<mode>' (factors/index.js); the mode is kept with the method for the sign-in log and policies.
const OPTION_RE = /^f(\d+)(?::(code|number_match|yes_no|yes_no_verified))?$/;
const MAX_SENDS = 5;
const MAX_FAILURES = 5;

module.exports = function factorRoutes({ establishSession, requireLogin, accountView }) {
  const router = express.Router();

  /* ---------------------------- During sign-in ----------------------------- */

  // The session partway through signing in, and its user, or a 404 like the other sign-in steps.
  function pending(req, res) {
    const m = req.session.mfa;
    const user = m && db.get('SELECT * FROM users WHERE id = ? AND active = 1', m.userId);
    if (!user) { req.session.mfa = null; res.status(404).json({ error: 'No sign-in in progress.' }); return null; }
    return { m, user };
  }

  const fail = (req, res, user, method, reason, status = 401, message = 'That did not work. Try again.') => {
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method, reason } });
    const m = req.session.mfa;
    if (m && ++m.failures >= MAX_FAILURES) {
      req.session.mfa = null;
      return res.status(429).json({ error: 'Too many failed attempts. Sign in again.' });
    }
    return res.status(status).json({ error: message });
  };

  const done = (req, res, next, user, m, type, factorRow, mode) => {
    if (factorRow) factors.touch(factorRow.id);
    const dest = m.next;
    req.risk = m.risk;
    req.session.mfa = null;
    const method = { id: factorRow && factorRow.id !== undefined ? `f${factorRow.id}` : type, type: mode ? `${type}:${mode}` : type };
    establishSession(req, user, AMR[type], (err) => (err ? next(err) : res.json({ next: dest })), method);
  };

  const allowed = (m, id) => m.factors.includes(id);
  const factorRow = (user, id) => {
    const n = OPTION_RE.exec(String(id || ''));
    return n && db.get('SELECT * FROM user_factors WHERE id = ? AND user_id = ? AND verified = 1', Number(n[1]), user.id);
  };
  const uv = () => factorSettings.get().webauthn.userVerification;

  // Security key sign-in.
  router.post('/login/mfa/webauthn/options', async (req, res, next) => {
    const p = pending(req, res);
    if (!p) return;
    try {
      const rows = db.all("SELECT * FROM user_factors WHERE user_id = ? AND type = 'webauthn' AND verified = 1", p.user.id).filter((r) => allowed(p.m, `f${r.id}`));
      if (!rows.length) return res.status(400).json({ error: 'No security key can be used for this sign-in.' });
      const options = await webauthn.authenticationOptions(rows, uv());
      p.m.webauthn = { challenge: options.challenge, kind: 'auth' };
      res.json(options);
    } catch (e) { next(e); }
  });

  router.post('/login/mfa/webauthn/verify', async (req, res, next) => {
    const p = pending(req, res);
    if (!p) return;
    const { m, user } = p;
    const expected = m.webauthn && m.webauthn.kind === 'auth' ? m.webauthn.challenge : null;
    m.webauthn = null; // a challenge is good for one attempt
    const row = expected && req.body.response && db.get('SELECT * FROM user_factors WHERE credential_id = ? AND user_id = ? AND type = ? AND verified = 1', String(req.body.response.id), user.id, 'webauthn');
    if (!row || !allowed(m, `f${row.id}`)) return fail(req, res, user, 'webauthn', row ? 'not_permitted' : 'unknown_credential');
    try {
      const r = await webauthn.verifyAuthentication(req.body.response, expected, row, uv());
      db.run('UPDATE user_factors SET credential = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(row.credential), counter: r.counter }), row.id);
    } catch (e) {
      return fail(req, res, user, 'webauthn', /counter/i.test(e.message) ? 'counter_regression' : 'bad_assertion');
    }
    done(req, res, next, user, m, 'webauthn', row);
  });

  // Setting up the first factor while signing in (only offered to someone who has none).
  router.post('/login/mfa/webauthn/enroll/options', async (req, res, next) => {
    const p = pending(req, res);
    if (!p) return;
    if (!(p.m.enrollOptions || []).includes('webauthn')) return res.status(400).json({ error: 'Security keys cannot be set up here.' });
    try {
      const options = await webauthn.registrationOptions(p.user, [], uv());
      p.m.webauthn = { challenge: options.challenge, kind: 'reg' };
      res.json(options);
    } catch (e) { next(e); }
  });

  router.post('/login/mfa/webauthn/enroll/verify', async (req, res, next) => {
    const p = pending(req, res);
    if (!p) return;
    const { m, user } = p;
    const expected = m.webauthn && m.webauthn.kind === 'reg' ? m.webauthn.challenge : null;
    m.webauthn = null;
    if (!expected || !(m.enrollOptions || []).includes('webauthn')) return fail(req, res, user, 'webauthn', 'no_challenge');
    let reg;
    try {
      reg = await webauthn.verifyRegistration(req.body.response, expected, uv());
    } catch {
      return fail(req, res, user, 'webauthn', 'bad_registration');
    }
    const id = Number(db.run("INSERT INTO user_factors (user_id, type, label, credential_id, credential, verified) VALUES (?, 'webauthn', ?, ?, ?, 1)",
      user.id, String(req.body.label || '').trim().slice(0, 60) || 'Security key', reg.credentialId, JSON.stringify(reg.credential)).lastInsertRowid);
    auditLog.user('mfa.enroll', { actor: auditLog.who(user), detail: { method: 'webauthn', via: 'sign-in' } });
    done(req, res, next, user, m, 'webauthn', { id });
  });

  // Email, SMS and voice: send, then either check a typed code or wait for the approval made on the other device.
  router.post('/login/mfa/challenge', async (req, res, next) => {
    const p = pending(req, res);
    if (!p) return;
    const { m, user } = p;
    const option = factors.optionById(user, req.body.factor);
    if (!option || !option.mode || !allowed(m, option.id)) return res.status(400).json({ error: 'That method cannot be used for this sign-in.' });
    const row = option.row;
    if (++m.sends > MAX_SENDS) { req.session.mfa = null; return res.status(429).json({ error: 'Too many messages requested. Sign in again.' }); }
    try {
      const c = await challenges.start({ user, factor: row, mode: option.mode });
      m.challenge = { id: c.id, factorId: row.id, type: row.type, mode: c.mode };
      res.json({ mode: c.mode, number: c.number, expires_in: c.expires_in, hint: factors.hint(row.type, row.destination), code_length: factorSettings.codeLength() });
    } catch (e) {
      if (e instanceof challenges.ChallengeError) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/login/mfa/challenge/verify', (req, res, next) => {
    const p = pending(req, res);
    if (!p) return;
    const { m, user } = p;
    const c = m.challenge;
    if (!c || c.mode !== 'code') return res.status(400).json({ error: 'Ask for a code first.' });
    const result = challenges.checkCode(c.id, user.id, req.body.code);
    if (result === 'ok') return done(req, res, next, user, m, c.type, { id: c.factorId }, 'code');
    if (result === 'gone') return res.status(400).json({ error: 'That code has expired. Ask for a new one.' });
    return fail(req, res, user, c.type, result === 'locked' ? 'lockout' : 'bad_code', 401, 'Incorrect code.');
  });

  router.get('/login/mfa/challenge/status', (req, res, next) => {
    const p = pending(req, res);
    if (!p) return;
    const { m, user } = p;
    const c = m.challenge;
    if (!c || c.mode === 'code') return res.status(400).json({ error: 'No approval is pending.' });
    const r = challenges.pollApproval(c.id, user.id);
    if (r === 'waiting') return res.json({ result: 'waiting' });
    if (r === 'approved') return done(req, res, next, user, m, c.type, { id: c.factorId }, c.mode);
    m.challenge = null;
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(user), detail: { method: c.type, reason: 'approval_failed' } });
    res.json({ result: 'failed' });
  });

  /* ------------------ The device that received the message ------------------ */

  // No session and no sign-in here: the unguessable token in the link is the only thing that ties this to a sign-in, and
  // the number has to be read off the sign-in screen, so a link alone approves nothing.
  router.get('/factors/approve/:token', (req, res) => {
    const c = challenges.byToken(req.params.token);
    if (!c) return res.status(404).json({ error: 'This link has expired or was already used.' });
    res.json({ app: appSettings.productName(), expires_in: Math.max(0, c.expires_at - Math.floor(Date.now() / 1000)) });
  });

  router.post('/factors/approve/:token', (req, res) => {
    const r = challenges.approve(req.params.token, req.body.number);
    if (r === 'ok') return res.json({ ok: true });
    if (r === 'bad') return res.status(400).json({ error: 'That is not the number on the sign-in screen.' });
    if (r === 'locked') return res.status(429).json({ error: 'Too many wrong numbers. Start the sign-in again.' });
    return res.status(404).json({ error: 'This link has expired or was already used.' });
  });

  /* ---------------------------- Profile: factors --------------------------- */

  const view = (req) => {
    const cfg = factorSettings.get();
    return {
      factors: factors.enrolled(req.user).map((f) => factors.describe(f, cfg)),
      available: Object.fromEntries(['webauthn', 'email', 'sms', 'voice'].map((t) => [t, { enabled: factorSettings.enabled(t, cfg), modes: factorSettings.modesOf(t, cfg), phishing_resistant: factorSettings.phishingResistant(t, cfg) }])),
      user: accountView(req),
    };
  };

  router.get('/account/factors', requireLogin, (req, res) => res.json(view(req)));

  const requireEnabled = (type) => (req, res, next) => (factorSettings.enabled(type) ? next() : res.status(404).json({ error: 'That method is not available.' }));

  router.post('/account/factors/webauthn/options', requireLogin, requireEnabled('webauthn'), async (req, res, next) => {
    try {
      const rows = db.all("SELECT * FROM user_factors WHERE user_id = ? AND type = 'webauthn' AND verified = 1", req.user.id);
      const options = await webauthn.registrationOptions(req.user, rows, uv());
      req.session.webauthnReg = options.challenge;
      res.json(options);
    } catch (e) { next(e); }
  });

  router.post('/account/factors/webauthn/verify', requireLogin, requireEnabled('webauthn'), async (req, res, next) => {
    const expected = req.session.webauthnReg;
    req.session.webauthnReg = null;
    if (!expected) return res.status(400).json({ error: 'Start again.' });
    try {
      const reg = await webauthn.verifyRegistration(req.body.response, expected, uv());
      db.run("INSERT INTO user_factors (user_id, type, label, credential_id, credential, verified) VALUES (?, 'webauthn', ?, ?, ?, 1)",
        req.user.id, String(req.body.label || '').trim().slice(0, 60) || 'Security key', reg.credentialId, JSON.stringify(reg.credential));
      auditLog.user('mfa.enroll', { actor: auditLog.who(req.user), detail: { method: 'webauthn', via: 'account' } });
      res.json(view(req));
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'That key is already registered.' });
      auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(req.user), detail: { method: 'webauthn', reason: 'bad_registration', during: 'enable' } });
      res.status(400).json({ error: 'The key could not be registered.' });
    }
  });

  // Adding an email address, phone number or phone line: it is not used until a code sent to it has been entered.
  router.post('/account/factors/otp', requireLogin, async (req, res, next) => {
    const type = req.body.type;
    if (!['email', 'sms', 'voice'].includes(type) || !factorSettings.enabled(type)) return res.status(400).json({ error: 'That method is not available.' });
    const destination = String(req.body.destination || '').trim();
    if (!(type === 'email' ? EMAIL_RE : PHONE_RE).test(destination)) {
      return res.status(400).json({ error: type === 'email' ? 'Enter a valid email address.' : 'Enter the number with country code, like +15551234567.' });
    }
    if (db.get('SELECT 1 FROM user_factors WHERE user_id = ? AND type = ? AND destination = ? COLLATE NOCASE AND verified = 1', req.user.id, type, destination)) {
      return res.status(409).json({ error: 'You already use that.' });
    }
    try {
      db.run("DELETE FROM user_factors WHERE user_id = ? AND verified = 0 AND created_at < datetime('now', '-1 hour')", req.user.id);
      let row = db.get('SELECT * FROM user_factors WHERE user_id = ? AND type = ? AND destination = ? COLLATE NOCASE AND verified = 0', req.user.id, type, destination);
      if (!row) {
        const id = Number(db.run('INSERT INTO user_factors (user_id, type, label, destination) VALUES (?,?,?,?)', req.user.id, type, String(req.body.label || '').trim().slice(0, 60), destination).lastInsertRowid);
        row = db.get('SELECT * FROM user_factors WHERE id = ?', id);
      }
      const c = await challenges.start({ user: req.user, factor: row, purpose: 'verify' });
      req.session.factorSetup = { factorId: row.id, challengeId: c.id };
      res.json({ factor_id: row.id, hint: factors.hint(type, destination), expires_in: c.expires_in });
    } catch (e) {
      if (e instanceof challenges.ChallengeError) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/account/factors/otp/verify', requireLogin, (req, res) => {
    const s = req.session.factorSetup;
    if (!s) return res.status(400).json({ error: 'Add a method first.' });
    const result = challenges.checkCode(s.challengeId, req.user.id, req.body.code);
    if (result === 'ok') {
      db.run('UPDATE user_factors SET verified = 1 WHERE id = ? AND user_id = ?', s.factorId, req.user.id);
      req.session.factorSetup = null;
      const row = db.get('SELECT type FROM user_factors WHERE id = ?', s.factorId);
      auditLog.user('mfa.enroll', { actor: auditLog.who(req.user), detail: { method: row.type, via: 'account' } });
      return res.json(view(req));
    }
    auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(req.user), detail: { reason: result, during: 'enable' } });
    if (result === 'locked') req.session.factorSetup = null;
    res.status(result === 'gone' ? 400 : 401).json({ error: result === 'gone' ? 'That code has expired. Add the method again.' : result === 'locked' ? 'Too many incorrect codes. Add the method again.' : 'Incorrect code.' });
  });

  router.delete('/account/factors/:id', requireLogin, (req, res) => {
    const u = req.user;
    const row = db.get('SELECT * FROM user_factors WHERE id = ? AND user_id = ?', Number(req.params.id), u.id);
    if (!row) return res.status(404).json({ error: 'No such method.' });
    if (!u.directory_id && !(typeof req.body.current_password === 'string' && verifyPassword(req.body.current_password, u.password_hash))) {
      auditLog.user('mfa.failure', { outcome: 'failure', actor: auditLog.who(u), detail: { reason: 'bad_current_password', during: 'disable' } });
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    const others = factors.enrolled(u).filter((f) => f.id !== `f${row.id}`);
    if (row.verified && !others.length && (u.mfa_enabled || policies.effectivePolicy(u.id).requireMfa)) {
      return res.status(409).json({ error: 'An administrator requires a second factor for your account, so your last one cannot be removed.' });
    }
    db.run('DELETE FROM user_factors WHERE id = ?', row.id);
    auditLog.user('mfa.disable', { actor: auditLog.who(u), detail: { method: row.type, via: 'account' } });
    res.json(view(req));
  });

  return router;
};

/* -------- Twilio voice: collecting the number on the keypad (no session) -------- */

// Twilio fetches these, so they sit outside the session and CSRF layers. The token in the path is the secret: it is random,
// belongs to one challenge and works for three tries within five minutes.
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

module.exports.voiceWebhook = (() => {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '10kb' }));
  router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/xml' }); next(); });
  // When the administrator turned on signature checking (Settings > Messaging > Voice calls), a request must carry a valid
  // X-Twilio-Signature for the address it was sent to, made with the account's auth token. Without it only the token in the path protects the call.
  router.use((req, res, next) => {
    const cfg = messagingSettings.messaging().voice;
    if (!(cfg.provider === 'twilio' && cfg.twilio.verifySignature)) return next();
    const fields = req.method === 'POST' ? req.body : {};
    if (cfg.twilio.authToken && twilioSignatureOk(`${baseUrl}${req.originalUrl}`, fields, req.get('x-twilio-signature'), cfg.twilio.authToken)) return next();
    auditLog.user('factor.voice_signature_rejected', { outcome: 'failure', req, actor: { type: 'anonymous', name: 'twilio-voice' }, detail: { method: req.method } });
    return res.status(403).send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
  const say = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
  const expired = say('<Say>This sign in request has expired. Goodbye.</Say><Hangup/>');
  const gone = say('<Say>This sign in request can no longer be answered. Goodbye.</Say><Hangup/>');

  // What the call asks, from the message template for the challenge's way: a number on the keypad, or a yes or no.
  const ask = (req, token, prompt, again) => {
    const lead = again ? 'That was not right. ' : '';
    const action = xml(`${req.baseUrl}/${token}/${prompt.mode === 'yes_no' ? 'answer' : 'digits'}`);
    const gather = prompt.mode === 'yes_no'
      ? `<Gather input="dtmf speech" numDigits="1" hints="yes, no" timeout="15" action="${action}" method="POST">`
      : `<Gather input="dtmf" numDigits="${prompt.length}" timeout="15" action="${action}" method="POST">`;
    return say(`${gather}<Say>${xml(lead + prompt.text)}</Say></Gather><Say>We did not receive an answer. Goodbye.</Say><Hangup/>`);
  };

  router.all('/:token', (req, res) => {
    const prompt = challenges.voicePrompt(req.params.token);
    res.send(prompt ? ask(req, req.params.token, prompt, false) : expired);
  });

  // The number typed on the keypad (number matching and verified yes or no).
  router.post('/:token/digits', (req, res) => {
    const r = challenges.approve(req.params.token, req.body.Digits);
    if (r === 'ok') return res.send(say('<Say>Approved. Goodbye.</Say><Hangup/>'));
    if (r === 'bad') {
      const prompt = challenges.voicePrompt(req.params.token);
      return res.send(prompt ? ask(req, req.params.token, prompt, true) : gone);
    }
    return res.send(say('<Say>This sign in request can no longer be approved. Goodbye.</Say><Hangup/>'));
  });

  // The answer to "are you signing in?": a key or word for yes or no (unverified).
  router.post('/:token/answer', (req, res) => {
    const r = challenges.answerByVoice(req.params.token, req.body.Digits || req.body.SpeechResult);
    if (r === 'approved') return res.send(say('<Say>Approved. Goodbye.</Say><Hangup/>'));
    if (r === 'denied') return res.send(say('<Say>The sign in was denied. Goodbye.</Say><Hangup/>'));
    if (r === 'unclear') {
      const prompt = challenges.voicePrompt(req.params.token);
      return res.send(prompt ? ask(req, req.params.token, prompt, true) : gone);
    }
    return res.send(gone);
  });
  return router;
})();
