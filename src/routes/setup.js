const express = require('express');
const db = require('../db');
const roles = require('../roles');
const setup = require('../setup');
const migrate = require('../migrate');
const migrateRoutes = require('./migrate');
const appSettings = require('../app-settings');
const fonts = require('../fonts');

// The setup wizard's API, at /api/setup. It answers only while the wizard is open (the database has no users) to a person who
// knows the one-time token printed on the server's console, or afterwards to a signed-in person holding `setup.run`, who
// re-runs it without the administrator step. For anybody else it is a plain 404, so a finished server shows nothing here.
const router = express.Router();
const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });

function privilegedUser(req) {
  const user = req.session && req.session.userId ? db.get('SELECT * FROM users WHERE id = ? AND active = 1', req.session.userId) : null;
  return user && roles.permissionsOf(user.id).has('setup.run') ? user : null;
}

// Sets req.setup = { mode, owner, actor }, or answers.
function gate(req, res, next) {
  if (setup.required()) {
    setup.sync();
    const r = setup.checkToken(req.get('x-setup-token'), req.ip);
    if (r.closed) return res.status(404).json({ error: 'Not found.' });
    if (r.retryAfter) { res.set('Retry-After', String(r.retryAfter)); return fail(res, 'Too many wrong tokens. Wait a few minutes and try again.', 429); }
    if (!r.ok) return fail(res, `That setup token is not right. It is printed on the server console when ${appSettings.productName()} starts.`, 401);
    req.setup = { mode: 'initial', owner: 'setup', actor: null };
    return next();
  }
  const user = privilegedUser(req);
  if (!user) return res.status(404).json({ error: 'Not found.' });
  req.setup = { mode: 'rerun', owner: `setup:${user.id}`, actor: user };
  next();
}

// Public: is the wizard open, and could this person open it.
router.get('/status', (req, res) => {
  const required = setup.required();
  if (required) setup.sync();
  res.json({ required, canRerun: !required && Boolean(privilegedUser(req)), state: !required && privilegedUser(req) ? setup.state() : undefined });
});

router.post('/verify', gate, (req, res) => res.json({ ok: true, mode: req.setup.mode }));

router.get('/defaults', gate, (req, res) => res.json({ ...setup.defaults(), mode: req.setup.mode }));

router.use('/migrate', gate, migrateRoutes({ ctx: (req) => req.setup, canApply: false }));

// The system font: the common Google Fonts, and downloading one of them. Uploading a font is left to the branding page.
router.get('/google-fonts', gate, async (req, res) => {
  try {
    res.json(await fonts.googleCatalog());
  } catch (e) { fail(res, e.message, e.status || 500); }
});

router.post('/google-fonts/:family', gate, async (req, res) => {
  try {
    res.json({ installed: await fonts.installGoogle(req.params.family) });
  } catch (e) { fail(res, e.message, e.status || 500); }
});

router.post('/complete', gate, async (req, res, next) => {
  try {
    const { mode, actor, owner } = req.setup;
    const body = req.body || {};
    const v = await setup.validate(body, { needAdmin: mode === 'initial' });
    if (v.errors.length) return fail(res, v.errors);
    const plan = body.import && body.import.planId ? body.import : null;
    let result;
    try {
      result = setup.apply(v, { mode, actor, imports: plan ? () => {
        const r = migrate.apply(owner, String(plan.planId), plan.options || {}, actor);
        if (r.errors) { const e = new Error(r.errors[0]); e.status = 410; throw e; }
        return r;
      } : null });
    } catch (e) {
      if (e.status) return fail(res, e.message, e.status);
      throw e;
    }
    // Google Fonts downloaded earlier in the wizard and then passed over are not kept.
    if (v.branding) fonts.pruneGoogle(v.branding.fontFamily);
    if (mode === 'initial') setup.finish();
    res.json({ ok: true, mode, imported: result.imported ? { counts: result.imported.counts, secrets: result.imported.secrets, notes: result.imported.notes } : null });
  } catch (e) { next(e); }
});

module.exports = router;
