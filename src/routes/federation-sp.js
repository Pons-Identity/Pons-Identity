const express = require('express');
const sp = require('../federation/sp');
const identities = require('../federation/identities');
const { validateResponse } = require('../federation/response-validator');
const { decodeMessage } = require('../saml/request');
const policies = require('../policies');
const keyring = require('../federation/keyring');
const mdq = require('../federation/mdq');

// The service-provider half of the federation gateway: /fed/sp/*. People from other institutions are sent to their own
// IdP from here and return to the ACS. Exempt from CSRF (the IdP posts cross-site); the one-time RelayState bound to the
// session, and InResponseTo, do that job instead.

const auditLog = require('../audit');
const router = express.Router();
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_OPEN_LOGINS = 5;
// The REFEDS multi-factor authentication profile: how an upstream IdP says the person used more than one factor.
const REFEDS_MFA = 'https://refeds.org/profile/mfa';
const GENERIC = 'Sign-in with your institution could not be completed. Try again, or contact an administrator.';

const { safeNext } = require('../safe-redirect');
const fail = (res, message, status = 400) => res.status(status).render('error', { title: 'Sign-in problem', message });

router.use((req, res, next) => (sp.identity().cfg.enabled
  ? next()
  : res.status(404).render('error', { title: 'Not found', message: 'Sign-in through other institutions is not enabled.' })));

router.get('/metadata', (req, res) => {
  res.type('application/samlmetadata+xml').send(sp.buildMetadata({ signed: req.query.signed === 'true' }));
});

router.get('/login', async (req, res) => {
  await mdq.ensureEntity(String(req.query.idp || ''));
  const idp = sp.allowedIdp(String(req.query.idp || ''));
  if (!idp) return fail(res, 'That institution is not available for sign-in here.', 403);
  const pending = req.session.pending;
  const { id, url } = sp.buildLoginRedirect(idp, { forceAuthn: Boolean(pending && pending.forceAuthn) });

  // Remember what this request was for. Entries are single-use, expire, and are capped so a session cannot grow without bound.
  const now = Date.now();
  const open = Object.entries(req.session.fedLogins || {}).filter(([, l]) => now - l.at < LOGIN_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at).slice(0, MAX_OPEN_LOGINS - 1);
  req.session.fedLogins = Object.fromEntries(open);
  req.session.fedLogins[id] = { idp: idp.entityId, next: safeNext(req.query.next), at: now };
  res.redirect(url);
});

router.post('/acs', async (req, res) => {
  const { cfg, entityId, urls } = sp.identity();
  const relay = typeof req.body.RelayState === 'string' ? req.body.RelayState : '';
  const logins = req.session.fedLogins || {};
  const login = logins[relay];
  if (!login || Date.now() - login.at > LOGIN_TTL_MS) {
    return fail(res, 'Your sign-in expired or was not started from this site. Start again.');
  }
  delete logins[relay]; // one use
  req.session.fedLogins = logins;

  let user;
  let mfa = false;
  try {
    await mdq.ensureEntity(login.idp); // normally cached from the start of this sign-in
    const idp = sp.allowedIdp(login.idp);
    if (!idp) throw Object.assign(new Error('That institution is no longer available for sign-in here.'), { userFacing: true });
    const xml = decodeMessage(req.body.SAMLResponse, 'post');
    const assertion = validateResponse(xml, {
      requestId: relay, idpEntityId: idp.entityId, spEntityId: entityId, acsUrl: urls.acs,
      signingCerts: idp.signingCerts, decryptionKeysPem: keyring.decryptionKeys(sp.ensureKeys()),
    });
    if (!identities.consumeAssertion(assertion.assertionId, assertion.notOnOrAfter)) throw new Error('This assertion was already used.');
    const result = identities.resolve({ idp, assertion, provisioning: cfg.provisioning });
    if (result.pending) {
      auditLog.user('federated_login.pending', { outcome: 'failure', actor: { type: 'anonymous', name: '' }, target: { type: 'idp', name: idp.entityId }, detail: { reason: 'awaiting_approval' } });
      return res.status(202).render('error', {
        title: 'Waiting for approval',
        message: 'Your institution confirmed who you are. An administrator needs to approve your access before you can sign in; try again once they have.',
      });
    }
    user = result.user;

    // The same sign-in rules apply as for a password: a blocked person stays blocked, and a policy that demands
    // multi-factor sign-in is met only if the institution says it used it.
    const policy = policies.effectivePolicy(user.id);
    if (policy.blockSignIn) throw Object.assign(new Error('Sign-in is not permitted for this account.'), { userFacing: true });
    mfa = assertion.authnContext === REFEDS_MFA;
    if (policy.requireMfa && !mfa) {
      throw Object.assign(new Error('Your account requires multi-factor sign-in, and your institution did not report using it.'), { userFacing: true });
    }
  } catch (e) {
    console.warn(`Federation sign-in rejected (${login.idp}): ${e.message}`);
    auditLog.user('federated_login.failure', { outcome: 'failure', actor: user ? auditLog.who(user) : undefined, target: { type: 'idp', name: login.idp }, detail: { reason: e.message } });
    return fail(res, e.userFacing ? e.message : GENERIC);
  }

  const pending = req.session.pending;
  req.session.regenerate((err) => {
    if (err) return fail(res, GENERIC, 500);
    req.session.userId = user.id;
    req.session.amr = mfa ? ['federated', 'mfa'] : ['federated'];
    req.session.authnInstant = new Date().toISOString();
    if (pending) req.session.pending = pending;
    auditLog.user('federated_login.success', { req, actor: auditLog.who(user), target: { type: 'idp', name: login.idp }, detail: { amr: req.session.amr } });
    res.redirect(safeNext(login.next));
  });
});

module.exports = router;
