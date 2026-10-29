const express = require('express');
const db = require('../db');
const apps = require('../apps');
const signin = require('../app-signin');
const appPolicies = require('../app-policies');
const logout = require('../saml/logout-flow');
const appSettings = require('../app-settings');

// CAS protocol server (mounted at /cas): /login issues a single-use service ticket, /validate (CAS 1.0), /serviceValidate
// (CAS 2.0) and /p3/serviceValidate (CAS 3.0, with attributes) check it, /logout ends the session. Services are the
// URLs registered on a CAS application; tickets are for exactly the service they were issued to.

const TICKET_TTL = 300;
const FRESH_SECONDS = 120; // a sign-in this recent counts as a new login for `renew`
const router = express.Router();

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const xmlName = (n) => {
  const name = String(n).replace(/[^A-Za-z0-9_.-]/g, '_');
  return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
};
const flag = (v) => v === 'true' || v === '';
const param = (v) => (typeof v === 'string' ? v : '');

const page = (res, message, status = 400) => res.status(status).render('error', { title: 'CAS error', message });

router.get('/login', async (req, res, next) => {
  const service = param(req.query.service);
  if (!service) {
    return signin.sessionUser(req) ? res.redirect('/') : res.redirect(`/login?next=${encodeURIComponent('/')}`);
  }
  const app = apps.findCasApp(service);
  if (!app) return page(res, `This service is not authorized to use ${appSettings.productName()} for sign-in.`, 403);

  let user = signin.sessionUser(req);
  if (user && flag(req.query.renew) && signin.sessionAge(req) > FRESH_SECONDS) user = null;
  if (!user) {
    if (flag(req.query.gateway) && !flag(req.query.renew)) return res.redirect(service);
    req.session.userId = null;
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  if (user.password_change_required) return res.redirect(signin.passwordChangeUrl(req.originalUrl));

  const reason = signin.denial(app, user);
  if (reason) {
    signin.auditDenied(req, app, user, reason);
    return page(res, `Your account does not have access to ${app.name}.`, 403);
  }
  let blocked;
  try { blocked = await appPolicies.check(req, user, 'app', app.id, req.originalUrl); } catch (e) { return next(e); }
  if (blocked) {
    if (blocked.stepUp) return res.redirect('/login/mfa');
    signin.auditDenied(req, app, user, 'app_policy');
    return page(res, blocked.message, 403);
  }
  const ticket = apps.issueGrant({
    kind: 'ticket', app, userId: user.id, ttl: TICKET_TTL, prefix: 'ST-', redirectUri: service,
    authTime: signin.authTime(req), amr: req.session.amr || ['pwd'], fresh: signin.sessionAge(req) <= FRESH_SECONDS,
  });
  signin.auditIssued(req, app, user, { flow: 'cas' });
  const url = new URL(service);
  url.searchParams.set('ticket', ticket);
  res.redirect(url.toString());
});

// Spends the ticket and returns { app, user, grant } or { code, message }.
function redeem(query) {
  const service = param(query.service);
  const ticket = param(query.ticket);
  if (!service || !ticket) return { code: 'INVALID_REQUEST', message: 'Both service and ticket are required.' };
  if (!ticket.startsWith('ST-')) return { code: 'INVALID_TICKET_SPEC', message: 'Only service tickets (ST-) are accepted.' };
  const grant = apps.findGrant('ticket', ticket, { consume: true });
  if (!grant) return { code: 'INVALID_TICKET', message: `Ticket ${ticket.slice(0, 8)}… is unknown, expired or already used.` };
  if (grant.redirect_uri !== service) return { code: 'INVALID_SERVICE', message: 'The ticket was not issued for this service.' };
  if (flag(query.renew) && !grant.fresh) return { code: 'INVALID_TICKET', message: 'The ticket did not come from a new sign-in.' };
  const app = apps.getApp(grant.app_id);
  const user = app && db.get('SELECT * FROM users WHERE id = ? AND active = 1', grant.user_id);
  if (!user || signin.denial(app, user)) return { code: 'INVALID_TICKET', message: 'The account can no longer sign in to this service.' };
  return { app, user, grant };
}

const username = (app, user) => apps.subjectOf(app, user, apps.userContext(user, app));

function attributeXml(app, user, grant) {
  const rows = { ...apps.mappedClaims(app, user), authenticationDate: new Date(grant.auth_time * 1000).toISOString(),
    isFromNewLogin: String(Boolean(grant.fresh)), longTermAuthenticationRequestTokenUsed: 'false' };
  const body = Object.entries(rows).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `<cas:${xmlName(k)}>${esc(x)}</cas:${xmlName(k)}>`)).join('');
  return `<cas:attributes>${body}</cas:attributes>`;
}

function serviceValidate(withAttributes) {
  return (req, res) => {
    const r = redeem(req.query);
    const inner = r.code
      ? `<cas:authenticationFailure code="${r.code}">${esc(r.message)}</cas:authenticationFailure>`
      : `<cas:authenticationSuccess><cas:user>${esc(username(r.app, r.user))}</cas:user>${withAttributes ? attributeXml(r.app, r.user, r.grant) : ''}</cas:authenticationSuccess>`;
    res.type('application/xml').send(`<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">${inner}</cas:serviceResponse>`);
  };
}

router.get('/serviceValidate', serviceValidate(false));
router.get('/p3/serviceValidate', serviceValidate(true));

router.get('/validate', (req, res) => {
  const r = redeem(req.query);
  res.type('text/plain').send(r.code ? 'no\n\n' : `yes\n${username(r.app, r.user)}\n`);
});

// CAS 3.0 names the return address `service`; CAS 2.0 called it `url`. Either must belong to a registered application.
router.get('/logout', (req, res) => {
  const target = param(req.query.service) || param(req.query.url);
  logout.idpInitiated(req, res, { redirectTo: target && apps.findCasApp(target) ? target : undefined });
});

module.exports = router;
