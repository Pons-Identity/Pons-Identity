const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const sps = require('../sps');
const appPolicies = require('../app-policies');
const { effectivePolicy } = require('../policies');
const auditLog = require('../audit');
const { buildMetadata } = require('../saml/metadata');
const { decodeMessage, parseAuthnRequest, parseLogoutRequest, verifyRequestSignature } = require('../saml/request');
const { buildResponse, buildStatusResponse } = require('../saml/response');
const logout = require('../saml/logout-flow');

const router = express.Router();
const LOGOUT_MAX_AGE_MS = 10 * 60 * 1000;
const LOGOUT_SKEW_MS = 2 * 60 * 1000;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function loadSp(req, res, next) {
  const sp = sps.getSp(req.params.id);
  if (!sp) return res.status(404).render('error', { title: 'Unknown service provider', message: 'No such service provider.' });
  req.sp = sp;
  next();
}

const fail = (res, message, status = 400) => res.status(status).render('error', { title: 'SAML error', message });

router.get('/:id/metadata', loadSp, (req, res) => {
  res.attachment(`idp-metadata-${req.sp.id}.xml`).type('application/samlmetadata+xml').send(buildMetadata(req.sp));
});

// Resolve a message from either binding: POST body or query string.
function readMessage(req, param) {
  const isPost = req.method === 'POST';
  const src = isPost ? req.body : req.query;
  if (!src[param]) return null;
  return {
    xml: decodeMessage(src[param], isPost ? 'post' : 'redirect'),
    relayState: typeof src.RelayState === 'string' ? src.RelayState : '',
  };
}

// An SP may publish several signing certificates (key rollover); the request is acceptable if any one verifies it.
function verifyAgainstAny(req, xml, certs) {
  let last;
  for (const certPem of certs) {
    try {
      return verifyRequestSignature({
        binding: req.method === 'POST' ? 'post' : 'redirect', xml, rawQuery: req.originalUrl.split('?')[1], certPem,
      });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// Where the browser returns after signing in. Federation SPs resume at the federation endpoint.
const resumeUrl = (sp) => sp.resume_path || `/saml/${sp.id}/resume`;

function sso(req, res) {
  const sp = req.sp;
  let pending;
  try {
    const msg = readMessage(req, 'SAMLRequest');
    if (msg) {
      const ar = parseAuthnRequest(msg.xml);
      if (sp.sp_entity_id && ar.issuer !== sp.sp_entity_id) {
        return fail(res, `Request issuer "${ar.issuer}" does not match this service provider's entity ID.`);
      }
      // When the SP has a registered signing certificate, its requests must be signed with it.
      const certs = sp.signing_cert_pems && sp.signing_cert_pems.length ? sp.signing_cert_pems : [sp.signing_cert_pem].filter(Boolean);
      if (certs.length) verifyAgainstAny(req, msg.xml, certs);
      // The request's ACS URL is honoured only if registered; otherwise it is an error (never an open redirect).
      if (ar.acsUrl && !sp.acs_urls.includes(ar.acsUrl)) {
        return fail(res, `ACS URL "${ar.acsUrl}" is not registered for this service provider.`);
      }
      pending = {
        spId: sp.id, spEntityId: sp.sp_entity_id, inResponseTo: ar.id, acsUrl: ar.acsUrl || sp.acs_urls[0], relayState: msg.relayState,
        forceAuthn: ar.forceAuthn, isPassive: ar.isPassive,
      };
    }
  } catch (e) {
    return fail(res, `Invalid SAMLRequest: ${e.message}`);
  }
  // A bare visit to the SSO URL is treated as IdP-initiated.
  proceed(req, res, sp, pending || idpInitiatedPending(sp));
}

const idpInitiatedPending = (sp) => ({
  spId: sp.id, spEntityId: sp.sp_entity_id, inResponseTo: null, acsUrl: sp.acs_urls[0],
  relayState: sp.default_relay_state || '', forceAuthn: false, isPassive: false,
});

function proceed(req, res, sp, pending) {
  const s = req.session;
  if (!s.userId || pending.forceAuthn) {
    if (pending.isPassive) {
      const xml = buildStatusResponse({ sp, pending, status: 'urn:oasis:names:tc:SAML:2.0:status:NoPassive' });
      return postToSp(res, pending, xml);
    }
    s.pending = pending;
    s.userId = null; // ForceAuthn: require a fresh login
    return res.redirect(`/login?next=${encodeURIComponent(resumeUrl(sp))}`);
  }
  issue(req, res, sp, pending);
}

function postToSp(res, pending, xml) {
  res.render('post', { action: pending.acsUrl, samlResponse: b64(xml), relayState: pending.relayState });
}

async function issue(req, res, sp, pending) {
  const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', req.session.userId);
  if (!user || require('../guests').expired(user)) {
    req.session.userId = null;
    return res.redirect(`/login?next=${encodeURIComponent(resumeUrl(sp))}`);
  }
  if (user.password_change_required) return res.redirect(`/account/profile?next=${encodeURIComponent(resumeUrl(sp))}`);
  // Kept in the session while a second factor may be asked for, so the request survives the step-up and resumes afterwards.
  req.session.pending = pending;
  const spTarget = { type: 'service_provider', id: sp.id, name: sp.name || sp.entity_id };
  if (effectivePolicy(user.id).blockSignIn) {
    auditLog.user('sso.denied', { outcome: 'failure', req, actor: auditLog.who(user), target: spTarget, detail: { reason: 'blocked_by_policy' } });
    return fail(res, 'Sign-in is not permitted for this account.', 403);
  }
  if (!sps.userHasAccess(sp, user.id)) {
    auditLog.user('sso.denied', { outcome: 'failure', req, actor: auditLog.who(user), target: spTarget, detail: { reason: 'no_access' } });
    return fail(res, `Your account does not have access to ${sp.name}.`, 403);
  }
  let blocked;
  try { blocked = await appPolicies.check(req, user, 'sp', sp.id, resumeUrl(sp)); } catch (e) { return fail(res, e.message, 500); }
  if (blocked) {
    if (blocked.stepUp) return res.redirect('/login/mfa');
    req.session.pending = null;
    auditLog.user('sso.denied', { outcome: 'failure', req, actor: auditLog.who(user), target: spTarget, detail: { reason: 'app_policy' } });
    return fail(res, blocked.message, 403);
  }
  req.session.pending = null;
  const sessionIndex = `_${crypto.randomBytes(16).toString('hex')}`;
  try {
    const out = buildResponse({
      sp, user, pending,
      login: { amr: req.session.amr || ['pwd'], authnInstant: new Date(req.session.authnInstant), sessionIndex },
    });
    // Federation SPs that exist only in metadata have no row to attach a session to, so no logout fan-out for them.
    if (!sp.synthetic) {
      db.run('INSERT INTO sso_sessions (sid, sp_id, name_id, name_id_format, session_index) VALUES (?,?,?,?,?)',
        req.sessionID, sp.id, out.nameId, out.nameIdFormat, sessionIndex);
    }
    auditLog.user('sso.assertion_issued', { req, actor: auditLog.who(user), target: spTarget, detail: { amr: req.session.amr, nameIdFormat: out.nameIdFormat } });
    postToSp(res, pending, out.xml);
  } catch (e) {
    auditLog.user('sso.denied', { outcome: 'failure', req, actor: auditLog.who(user), target: spTarget, detail: { reason: 'error', error: e.message } });
    fail(res, e.message, 500);
  }
}

router.get('/:id/sso', loadSp, sso);
router.post('/:id/sso', loadSp, sso);

router.get('/:id/init', loadSp, (req, res) => proceed(req, res, req.sp, idpInitiatedPending(req.sp)));

router.get('/:id/resume', loadSp, (req, res) => {
  const pending = req.session.pending;
  if (!pending || pending.spId !== req.sp.id || !req.session.userId) {
    return res.redirect(`/saml/${req.sp.id}/init`);
  }
  issue(req, res, req.sp, pending);
});

function slo(req, res) {
  const sp = req.sp;
  try {
    const msg = readMessage(req, 'SAMLRequest');
    if (msg) {
      const lr = parseLogoutRequest(msg.xml);
      if (sp.sp_entity_id && lr.issuer !== sp.sp_entity_id) return fail(res, 'LogoutRequest issuer mismatch.');
      // A LogoutRequest ends the person's session and tells every other application, so it is accepted only over the HTTP-POST
      // binding, carrying an enveloped XML signature made with the SP's registered signing certificate, and fresh, so a captured
      // one cannot be sent again later. It is never a GET (a link or image tag could trigger that), and an SP with no certificate
      // registered cannot send one at all, because there would be nothing to check it against.
      if (req.method !== 'POST') throw new Error('A LogoutRequest must be sent with the HTTP-POST binding.');
      const certs = sp.signing_cert_pems && sp.signing_cert_pems.length ? sp.signing_cert_pems : [sp.signing_cert_pem].filter(Boolean);
      if (!certs.length) throw new Error('This service provider has no signing certificate registered, so its LogoutRequests cannot be verified.');
      verifyAgainstAny(req, msg.xml, certs);
      const issued = Date.parse(lr.issueInstant);
      if (Number.isNaN(issued) || issued < Date.now() - LOGOUT_MAX_AGE_MS || issued > Date.now() + LOGOUT_SKEW_MS) throw new Error('The LogoutRequest is not current.');
      return logout.spInitiated(req, res, { sp, logoutRequest: lr, relayState: msg.relayState });
    }
    // A LogoutResponse from an SP (reply to our LogoutRequest) or a bare visit: just end the local session.
    return logout.idpInitiated(req, res);
  } catch (e) {
    return fail(res, `Invalid logout message: ${e.message}`);
  }
}

router.get('/:id/slo', loadSp, slo);
router.post('/:id/slo', loadSp, slo);

module.exports = router;
// The same handlers serve the federation endpoints, which pick the SP from the message rather than from the URL.
module.exports.shared = { readMessage, sso, proceed, issue, slo, fail, idpInitiatedPending };
