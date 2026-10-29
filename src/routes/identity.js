const express = require('express');
const identity = require('../identity');

// Webhooks from identity verification providers. Mounted before the session and CSRF layers: the provider posts without a session.
// Each one is checked before anything is done (identity/index.js): Persona by its signature, a REST service by the token in its
// address and an optional shared secret. A valid call only asks for the verification to be checked again with the provider.

const router = express.Router();
const rawBody = (req) => (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');

router.post('/webhook/persona', express.raw({ type: () => true, limit: '256kb' }), async (req, res, next) => {
  try {
    const r = await identity.webhook('persona', { rawBody: rawBody(req), header: req.get('persona-signature') || '' });
    res.sendStatus(r.ok ? 200 : 403);
  } catch (e) { next(e); }
});

router.post('/webhook/rest/:token', express.raw({ type: () => true, limit: '256kb' }), async (req, res, next) => {
  try {
    const r = await identity.webhook('rest', { rawBody: rawBody(req), header: req.get('x-identity-secret') || '', token: req.params.token });
    res.sendStatus(r.ok ? 200 : 403);
  } catch (e) { next(e); }
});

module.exports = router;
