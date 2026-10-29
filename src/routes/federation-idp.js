const express = require('express');
const idp = require('../federation/idp');
const mdq = require('../federation/mdq');
const { decodeMessage, parseAuthnRequest, parseLogoutRequest } = require('../saml/request');
const saml = require('./saml').shared;

// The IdP's federation endpoints: /fed/idp/*. One URL set serves every federation SP; the SP is found from the
// request's Issuer in the federation metadata. Like /saml, these are exempt from CSRF and are called cross-site.

const router = express.Router();

// Federation endpoints do not exist until an administrator enables the federation identity.
router.use((req, res, next) => (idp.identity().cfg.enabled
  ? next()
  : res.status(404).render('error', { title: 'Not found', message: 'Federation is not enabled.' })));

router.get('/metadata', (req, res) => {
  res.type('application/samlmetadata+xml').send(idp.buildMetadata({ signed: req.query.signed === 'true' }));
});

// Find the SP a SAML message came from and hand over to the shared handlers.
function bySender(parse) {
  return (handler) => async (req, res) => {
    let issuer;
    try {
      const src = req.method === 'POST' ? req.body : req.query;
      if (!src.SAMLRequest) return saml.fail(res, 'Missing SAMLRequest. Start sign-in from the service provider.');
      issuer = parse(decodeMessage(src.SAMLRequest, req.method === 'POST' ? 'post' : 'redirect')).issuer;
    } catch (e) {
      return saml.fail(res, `Invalid SAML message: ${e.message}`);
    }
    await mdq.ensureEntity(issuer); // fetches it from an MDQ source if it is not already known
    const sp = idp.forEntity(issuer);
    if (!sp) return saml.fail(res, `"${issuer}" is not a service provider this identity provider serves.`, 403);
    req.sp = sp;
    return handler(req, res);
  };
}

router.get('/sso', bySender(parseAuthnRequest)(saml.sso));
router.post('/sso', bySender(parseAuthnRequest)(saml.sso));
router.get('/slo', bySender(parseLogoutRequest)(saml.slo));
router.post('/slo', bySender(parseLogoutRequest)(saml.slo));

// IdP-initiated sign-in: /fed/idp/init?providerId=<SP entity ID>[&target=<relay state>]
router.get('/init', async (req, res) => {
  const providerId = String(req.query.providerId || '');
  await mdq.ensureEntity(providerId);
  const sp = idp.forEntity(providerId);
  if (!sp) return saml.fail(res, 'Unknown service provider.', 403);
  const pending = saml.idpInitiatedPending(sp);
  if (typeof req.query.target === 'string' && Buffer.byteLength(req.query.target) <= 80) pending.relayState = req.query.target;
  return saml.proceed(req, res, sp, pending);
});

router.get('/resume', (req, res) => {
  const pending = req.session.pending;
  const sp = pending && idp.forEntity(pending.spEntityId);
  if (!pending || !sp || pending.spId !== sp.id || !req.session.userId) return res.redirect('/');
  return saml.issue(req, res, sp, pending);
});

module.exports = router;
