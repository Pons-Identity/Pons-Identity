const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const apps = require('../apps');
const appPolicies = require('../app-policies');
const jwt = require('../jwt');
const signin = require('../app-signin');
const logout = require('../saml/logout-flow');
const auditLog = require('../audit');
const { baseUrl } = require('../config');

// OpenID Connect (mounted at /oidc) and plain OAuth 2.0 (mounted at /oauth2) share these endpoints: authorization code with
// PKCE, refresh tokens, client credentials, userinfo, introspection and revocation. OIDC adds discovery, ID tokens, the key
// set and RP-initiated logout. Access and refresh tokens are opaque and stored hashed; there is no consent screen because
// every client is registered by an administrator.

const CODE_TTL = 60;
const REFRESH_TTL = 30 * 24 * 3600;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const SCOPE_LIST = (s) => (typeof s === 'string' ? s.split(' ').filter(Boolean) : []);

function build(protocol) {
  const router = express.Router();
  const base = `${baseUrl}/${protocol}`;
  const isOidc = protocol === 'oidc';

  // Browsers call these from other origins; none of them rely on cookies, so any origin may.
  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
  const noStore = (res) => res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  const oauthError = (res, status, error, description) => {
    noStore(res);
    return res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
  };
  const page = (res, message, status = 400) => res.status(status).render('error', { title: 'Sign-in error', message });

  /* ----------------------------- Discovery & keys ---------------------------- */

  router.get(isOidc ? '/.well-known/openid-configuration' : '/.well-known/oauth-authorization-server', cors, (req, res) => {
    const grants = apps.GRANT_TYPES[protocol];
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      userinfo_endpoint: `${base}/userinfo`,
      introspection_endpoint: `${base}/introspect`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: grants,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      ...(isOidc ? {
        jwks_uri: `${base}/jwks`,
        end_session_endpoint: `${base}/logout`,
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: apps.OIDC_SCOPES,
        claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'amr', 'at_hash', 'name', 'given_name', 'family_name', 'preferred_username', 'email', 'groups'],
      } : {}),
    });
  });

  if (isOidc) router.get('/jwks', cors, (req, res) => res.json(jwt.jwks()));

  /* ------------------------------- Authorization ------------------------------ */

  router.get('/authorize', async (req, res, next) => {
    const q = req.query;
    const app = apps.getByClientId(q.client_id, protocol);
    if (!app) return page(res, 'Unknown client.');
    // Until the redirect URI is known to be registered, errors are shown here and never sent to it.
    if (typeof q.redirect_uri !== 'string' || !apps.redirectAllowed(app, q.redirect_uri)) return page(res, 'The redirect URI is not registered for this application.');

    const back = (params) => {
      const url = new URL(q.redirect_uri);
      for (const [k, v] of Object.entries({ ...params, ...(q.state ? { state: String(q.state) } : {}), ...(isOidc ? { iss: base } : {}) })) url.searchParams.set(k, v);
      return res.redirect(url.toString());
    };
    const fail = (error, description) => back({ error, error_description: description });

    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only the authorization code flow is supported.');
    if (!app.grant_types.includes('authorization_code')) return fail('unauthorized_client', 'This client may not use the authorization code flow.');

    const scopes = SCOPE_LIST(q.scope);
    if (isOidc && !scopes.includes('openid')) return fail('invalid_scope', 'The openid scope is required.');
    const unknown = scopes.find((s) => !app.scopes.includes(s));
    if (unknown) return fail('invalid_scope', `Scope not allowed for this client: ${unknown}`);

    const challenge = typeof q.code_challenge === 'string' ? q.code_challenge : '';
    if (challenge && (q.code_challenge_method !== 'S256' || !PKCE_CHALLENGE.test(challenge))) return fail('invalid_request', 'PKCE needs a valid S256 code_challenge.');
    if (!challenge && (app.require_pkce || !app.confidential)) return fail('invalid_request', 'This client must use PKCE.');

    const prompts = SCOPE_LIST(q.prompt);
    const maxAge = Number.parseInt(q.max_age, 10);
    let user = signin.sessionUser(req);
    const stale = user && Number.isFinite(maxAge) && maxAge >= 0 && signin.sessionAge(req) > maxAge;
    if (user && (prompts.includes('login') || stale)) user = null;

    if (!user) {
      if (prompts.includes('none')) return fail('login_required', 'Sign-in is required.');
      // Come back without prompt=login, or the person would be asked to sign in again forever.
      const resume = new URL(req.originalUrl, baseUrl);
      const rest = prompts.filter((p) => p !== 'login');
      if (rest.length) resume.searchParams.set('prompt', rest.join(' ')); else resume.searchParams.delete('prompt');
      req.session.userId = null;
      return res.redirect(`/login?next=${encodeURIComponent(resume.pathname + resume.search)}`);
    }

    if (user.password_change_required) return res.redirect(signin.passwordChangeUrl(req.originalUrl));

    const reason = signin.denial(app, user);
    if (reason) {
      signin.auditDenied(req, app, user, reason);
      return fail('access_denied', 'Your account does not have access to this application.');
    }
    let blocked;
    try { blocked = await appPolicies.check(req, user, 'app', app.id, req.originalUrl); } catch (e) { return next(e); }
    if (blocked) {
      if (blocked.stepUp) return res.redirect('/login/mfa');
      signin.auditDenied(req, app, user, 'app_policy');
      return fail('access_denied', blocked.message);
    }
    const code = apps.issueGrant({
      kind: 'code', app, userId: user.id, ttl: CODE_TTL, scope: scopes.join(' '), redirectUri: q.redirect_uri,
      nonce: typeof q.nonce === 'string' ? q.nonce.slice(0, 500) : '', codeChallenge: challenge,
      authTime: signin.authTime(req), amr: req.session.amr || ['pwd'],
    });
    signin.auditIssued(req, app, user, { flow: 'authorization_code', scope: scopes });
    return back({ code });
  });

  /* ---------------------------------- Tokens --------------------------------- */

  // Client authentication: HTTP Basic or credentials in the body. Public clients identify themselves by client_id alone.
  function authenticateClient(req) {
    let id = req.body.client_id;
    let secret = req.body.client_secret;
    const m = /^Basic (.+)$/i.exec(req.get('authorization') || '');
    if (m) {
      const [u, ...p] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
      try {
        id = decodeURIComponent(u.replace(/\+/g, ' '));
        secret = decodeURIComponent(p.join(':').replace(/\+/g, ' '));
      } catch {
        return null;
      }
    }
    const app = apps.getByClientId(id, protocol);
    if (!app) return null;
    if (app.confidential && !apps.checkSecret(app, secret)) return null;
    return app;
  }

  const badClient = (res) => {
    res.set('WWW-Authenticate', 'Basic realm="PonsIdentity"');
    return oauthError(res, 401, 'invalid_client', 'Client authentication failed.');
  };

  function activeUser(app, userId) {
    const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', userId);
    return user && !require('../guests').expired(user) && !signin.denial(app, user) ? user : null;
  }

  function tokenResponse(req, res, app, { user, scope, authTime, amr, nonce, refresh }) {
    const ttl = app.access_token_ttl;
    const scopes = SCOPE_LIST(scope);
    const accessToken = apps.issueGrant({ kind: 'access', app, userId: user ? user.id : null, ttl, scope, authTime, amr });
    const out = { access_token: accessToken, token_type: 'Bearer', expires_in: ttl, ...(scope ? { scope } : {}) };
    const wantsRefresh = user && app.grant_types.includes('refresh_token') && (isOidc ? scopes.includes('offline_access') : true);
    if (wantsRefresh) {
      out.refresh_token = apps.issueGrant({ kind: 'refresh', app, userId: user.id, ttl: REFRESH_TTL, scope, authTime, amr });
    }
    if (isOidc && user && scopes.includes('openid')) {
      const now = Math.floor(Date.now() / 1000);
      out.id_token = jwt.sign({
        ...apps.claimsFor(app, user, scopes),
        iss: base, aud: app.client_id, iat: now, exp: now + ttl, auth_time: authTime, amr,
        ...(nonce ? { nonce } : {}), at_hash: jwt.halfHash(accessToken),
      });
    }
    noStore(res);
    auditLog.user('token.issue', { req, actor: user ? auditLog.who(user) : { type: 'integration', name: app.name }, target: signin.target(app),
      detail: { protocol, grant: req.body.grant_type, scope: scopes, refresh: Boolean(out.refresh_token) } });
    res.json(out);
  }

  router.options(['/token', '/userinfo', '/introspect', '/revoke'], cors);

  router.post('/token', cors, (req, res) => {
    const app = authenticateClient(req);
    if (!app) return badClient(res);
    const grantType = req.body.grant_type;
    if (!app.grant_types.includes(grantType)) {
      return oauthError(res, 400, grantType ? 'unauthorized_client' : 'invalid_request', 'This client may not use that grant type.');
    }

    if (grantType === 'authorization_code') {
      // Consumed up front so a code works once even when the checks below fail.
      const grant = apps.findGrant('code', req.body.code, { consume: true });
      if (!grant || grant.app_id !== app.id) return oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid or expired.');
      if (grant.redirect_uri !== req.body.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
      if (grant.code_challenge) {
        const verifier = String(req.body.code_verifier || '');
        const ok = PKCE_VERIFIER.test(verifier)
          && crypto.createHash('sha256').update(verifier).digest('base64url') === grant.code_challenge;
        if (!ok) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
      }
      const user = activeUser(app, grant.user_id);
      if (!user) return oauthError(res, 400, 'invalid_grant', 'The account can no longer sign in to this application.');
      return tokenResponse(req, res, app, { user, scope: grant.scope, authTime: grant.auth_time, amr: grant.amr, nonce: grant.nonce });
    }

    if (grantType === 'refresh_token') {
      // Rotated: the presented token is spent and a new one issued with the new access token.
      const grant = apps.findGrant('refresh', req.body.refresh_token, { consume: true });
      if (!grant || grant.app_id !== app.id) return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or expired.');
      let scope = grant.scope;
      if (req.body.scope) {
        const wanted = SCOPE_LIST(req.body.scope);
        const have = new Set(SCOPE_LIST(grant.scope));
        if (wanted.some((s) => !have.has(s))) return oauthError(res, 400, 'invalid_scope', 'Requested scope exceeds the original grant.');
        scope = wanted.join(' ');
      }
      const user = activeUser(app, grant.user_id);
      if (!user) return oauthError(res, 400, 'invalid_grant', 'The account can no longer sign in to this application.');
      return tokenResponse(req, res, app, { user, scope, authTime: grant.auth_time, amr: grant.amr });
    }

    if (grantType === 'client_credentials') {
      const wanted = req.body.scope === undefined ? app.scopes : SCOPE_LIST(req.body.scope);
      const bad = wanted.find((s) => !app.scopes.includes(s));
      if (bad) return oauthError(res, 400, 'invalid_scope', `Scope not allowed for this client: ${bad}`);
      return tokenResponse(req, res, app, { user: null, scope: wanted.join(' '), authTime: 0, amr: [] });
    }

    return oauthError(res, 400, 'unsupported_grant_type');
  });

  /* ---------------------- UserInfo, introspection, revocation ---------------------- */

  function bearer(req) {
    const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
    return m ? m[1] : (req.method === 'POST' && typeof req.body.access_token === 'string' ? req.body.access_token : '');
  }

  const userinfo = (req, res) => {
    const grant = apps.findGrant('access', bearer(req));
    const app = grant && apps.getApp(grant.app_id);
    if (!app || app.protocol !== protocol || !grant.user_id) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return res.status(401).json({ error: 'invalid_token' });
    }
    const scopes = SCOPE_LIST(grant.scope);
    if (isOidc && !scopes.includes('openid')) {
      res.set('WWW-Authenticate', 'Bearer error="insufficient_scope", scope="openid"');
      return res.status(403).json({ error: 'insufficient_scope' });
    }
    const user = activeUser(app, grant.user_id);
    if (!user) return res.status(401).json({ error: 'invalid_token' });
    noStore(res);
    res.json(apps.claimsFor(app, user, scopes));
  };
  router.get('/userinfo', cors, userinfo);
  router.post('/userinfo', cors, userinfo);

  router.post('/introspect', cors, (req, res) => {
    const app = authenticateClient(req);
    if (!app || !app.confidential) return badClient(res);
    const token = req.body.token;
    const grant = apps.findGrant('access', token) || apps.findGrant('refresh', token);
    noStore(res);
    if (!grant || grant.app_id !== app.id) return res.json({ active: false });
    const user = grant.user_id && db.get('SELECT * FROM users WHERE id = ? AND active = 1', grant.user_id);
    if (grant.user_id && !user) return res.json({ active: false });
    res.json({
      active: true, scope: grant.scope, client_id: app.client_id, token_type: 'Bearer', exp: grant.expires_at, iss: base,
      ...(user ? { sub: apps.subjectOf(app, user, apps.userContext(user, app)), username: user.username } : { sub: app.client_id }),
    });
  });

  router.post('/revoke', cors, (req, res) => {
    const app = authenticateClient(req);
    if (!app) return badClient(res);
    const grant = apps.findGrant('access', req.body.token) || apps.findGrant('refresh', req.body.token);
    if (grant && grant.app_id === app.id) apps.revokeGrant(req.body.token);
    res.sendStatus(200);
  });

  /* ------------------------------- RP-initiated logout ------------------------------ */

  if (isOidc) {
    router.get('/logout', (req, res) => {
      const hint = jwt.verify(req.query.id_token_hint);
      const aud = hint && (Array.isArray(hint.aud) ? hint.aud[0] : hint.aud);
      const app = apps.getByClientId(aud || req.query.client_id, protocol);
      const uri = req.query.post_logout_redirect_uri;
      let redirectTo;
      // Only a registered address is honoured, and only for a client we can identify.
      if (app && typeof uri === 'string' && app.post_logout_uris.includes(uri)) {
        const url = new URL(uri);
        if (req.query.state) url.searchParams.set('state', String(req.query.state));
        redirectTo = url.toString();
      }
      logout.idpInitiated(req, res, { redirectTo });
    });
  }

  return router;
}

module.exports = { oidc: build('oidc'), oauth2: build('oauth2') };
