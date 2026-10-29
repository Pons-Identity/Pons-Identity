const crypto = require('crypto');
const db = require('./db');
const attrs = require('./attributes');
const { effectiveGroupsOf } = require('./group-membership');
const { baseUrl } = require('./config');

// CAS, OpenID Connect and OAuth 2.0 applications. SAML service providers live in sps.js; these share its access rules
// (disabled / certain groups / everyone) and its attribute vocabulary, but speak their protocols from routes/cas.js and
// routes/oidc.js.

const PROTOCOLS = ['cas', 'oidc', 'oauth2'];
const ACCESS_MODES = ['none', 'groups', 'all'];
const GRANT_TYPES = {
  oidc: ['authorization_code', 'refresh_token'],
  oauth2: ['authorization_code', 'refresh_token', 'client_credentials'],
};
const OIDC_SCOPES = ['openid', 'profile', 'email', 'groups', 'offline_access'];
const MIN_TTL = 60;
const MAX_TTL = 24 * 3600;

const toArr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const unique = (list) => [...new Set(list)];

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

// Redirect URIs may also be a custom scheme (native apps, e.g. com.example.app:/callback), but never javascript: and friends.
function isRedirectUri(u) {
  try {
    const p = new URL(u);
    if (p.hash) return false;
    if (p.protocol === 'http:' || p.protocol === 'https:') return true;
    return !['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'].includes(p.protocol);
  } catch {
    return false;
  }
}

function endpoints(app) {
  if (app.protocol === 'cas') {
    return { login: `${baseUrl}/cas/login`, logout: `${baseUrl}/cas/logout`, validate: `${baseUrl}/cas/validate`,
      serviceValidate: `${baseUrl}/cas/serviceValidate`, p3ServiceValidate: `${baseUrl}/cas/p3/serviceValidate` };
  }
  const base = `${baseUrl}/${app.protocol}`;
  return {
    issuer: base,
    discovery: app.protocol === 'oidc' ? `${base}/.well-known/openid-configuration` : `${base}/.well-known/oauth-authorization-server`,
    authorization: `${base}/authorize`,
    token: `${base}/token`,
    userinfo: `${base}/userinfo`,
    introspection: `${base}/introspect`,
    revocation: `${base}/revoke`,
    ...(app.protocol === 'oidc' ? { jwks: `${base}/jwks`, endSession: `${base}/logout` } : {}),
  };
}

function hydrate(row) {
  if (!row) return null;
  const app = { ...row };
  for (const c of ['redirect_uris', 'post_logout_uris', 'grant_types', 'scopes']) app[c] = JSON.parse(row[c] || '[]');
  app.confidential = Boolean(row.client_secret_hash);
  app.maps = db.all('SELECT idp_attribute, claim_name FROM app_attribute_map WHERE app_id = ? ORDER BY id', row.id);
  app.access_groups = db.all('SELECT group_id FROM app_access_groups WHERE app_id = ?', row.id).map((g) => g.group_id);
  app.urls = endpoints(app);
  delete app.client_secret_hash;
  return app;
}

const getApp = (id) => hydrate(db.get('SELECT * FROM apps WHERE id = ?', id));
const getByClientId = (clientId, protocol) =>
  (typeof clientId === 'string' && clientId
    ? hydrate(db.get('SELECT * FROM apps WHERE client_id = ? AND protocol = ?', clientId, protocol)) : null);

function listApps() {
  return db.all('SELECT id, protocol, name, client_id, created_at FROM apps ORDER BY name');
}

// The client ID a new OAuth or OpenID Connect application will get. The form shows it before the application is saved, and sends it
// back with the form so the one shown is the one used.
const newClientId = (protocol) => `${protocol}-${random(12)}`;
const CLIENT_ID_RE = (protocol) => new RegExp(`^${protocol}-[A-Za-z0-9_-]{16}$`);

function blankApp(protocol) {
  const oauth = protocol !== 'cas';
  return {
    protocol,
    ...(oauth ? { client_id: newClientId(protocol) } : {}),
    urls: endpoints({ protocol }), name: '', description: '', access_mode: 'all', access_groups: [], maps: [],
    redirect_uris: [''], post_logout_uris: [], confidential: oauth, require_pkce: 1,
    grant_types: oauth ? ['authorization_code'] : [], scopes: protocol === 'oidc' ? ['openid', 'profile', 'email'] : [],
    subject_source: protocol === 'cas' ? 'username' : 'guid', access_token_ttl: 3600,
  };
}

// Parse + validate the admin form. `existing` is the app being edited, whose protocol cannot change. Returns { data, errors }.
function parseForm(body, existing) {
  const errors = [];
  const protocol = existing ? existing.protocol : str(body.protocol);
  if (!PROTOCOLS.includes(protocol)) return { data: null, errors: ['Choose CAS, OpenID Connect or OAuth 2.0.'] };
  const oauth = protocol !== 'cas';

  const data = {
    protocol,
    client_id: '',
    name: str(body.name),
    description: str(body.description),
    access_mode: str(body.access_mode) || 'all',
    access_groups: unique(toArr(body.access_groups).map(Number).filter(Boolean)),
    redirect_uris: unique(toArr(body.redirect_uris).map(str).filter(Boolean)),
    post_logout_uris: protocol === 'oidc' ? unique(toArr(body.post_logout_uris).map(str).filter(Boolean)) : [],
    confidential: oauth ? Boolean(body.confidential) : false,
    require_pkce: body.require_pkce === undefined || body.require_pkce ? 1 : 0,
    grant_types: oauth ? unique(toArr(body.grant_types).map(str)) : [],
    scopes: [],
    subject_source: str(body.subject_source) || (protocol === 'cas' ? 'username' : 'guid'),
    access_token_ttl: Number(body.access_token_ttl) || 3600,
    maps: toArr(body.maps).map((m) => ({ idp_attribute: str(m && m.idp_attribute), claim_name: str(m && m.claim_name) }))
      .filter((m) => m.idp_attribute && m.claim_name),
  };

  if (!data.name) errors.push('Name is required.');
  if (!ACCESS_MODES.includes(data.access_mode)) errors.push('Invalid user access setting.');
  const known = new Set(attrs.listAttributes().map((a) => a.key));
  if (!known.has(data.subject_source)) errors.push('Unknown subject attribute.');
  for (const m of data.maps) if (!known.has(m.idp_attribute)) errors.push(`Unknown attribute: ${m.idp_attribute}`);

  if (protocol === 'cas') {
    if (!data.redirect_uris.length) errors.push('At least one service URL is required.');
    for (const u of data.redirect_uris) if (!isHttpUrl(u.replace(/\*/g, 'x'))) errors.push(`Service URL is not a valid http(s) URL: ${u}`);
    // A wildcard anywhere but the very end would let a ticket go to a site the administrator did not name (a * in the host, or a
    // pattern like https://app.example.net/*@other.example). The host and the start of the path are fixed; only what follows them may vary.
    for (const u of data.redirect_uris) if (u.includes('*') && !wildcardPatternOk(u)) errors.push(`A service URL may use * only as its last character, after a / that follows the host (for example https://app.example.net/app/*): ${u}`);
  } else {
    if (!data.redirect_uris.length) errors.push('At least one redirect URI is required.');
    for (const u of data.redirect_uris) if (!isRedirectUri(u) || u.includes('*')) errors.push(`Redirect URI is not valid (exact URIs only, no fragment): ${u}`);
    for (const u of data.post_logout_uris) if (!isRedirectUri(u)) errors.push(`Post-logout redirect URI is not valid: ${u}`);
    if (!data.grant_types.length) errors.push('Choose at least one grant type.');
    for (const g of data.grant_types) if (!GRANT_TYPES[protocol].includes(g)) errors.push(`Grant type not allowed for this application: ${g}`);
    if (data.grant_types.includes('client_credentials') && !data.confidential) errors.push('Client credentials needs a confidential client (one with a secret).');
    // A new application may take the client ID the form showed before it was saved.
    const wanted = str(body.client_id);
    if (!existing && wanted) {
      if (!CLIENT_ID_RE(protocol).test(wanted)) errors.push('The client ID is not valid. Reload the page to get a new one.');
      else if (db.get('SELECT 1 FROM apps WHERE client_id = ?', wanted)) errors.push('That client ID is already in use. Reload the page to get a new one.');
      else data.client_id = wanted;
    }
    if (!data.confidential) data.require_pkce = 1; // public clients cannot keep a secret, so PKCE is mandatory
    if (data.access_token_ttl < MIN_TTL || data.access_token_ttl > MAX_TTL) errors.push(`Access token lifetime must be between ${MIN_TTL} and ${MAX_TTL} seconds.`);
    if (protocol === 'oidc') {
      data.scopes = OIDC_SCOPES.filter((s) => toArr(body.scopes).includes(s) || s === 'openid');
      if (!data.grant_types.includes('refresh_token')) data.scopes = data.scopes.filter((s) => s !== 'offline_access');
    } else {
      data.scopes = unique(toArr(body.scopes).map(str).filter(Boolean));
      for (const s of data.scopes) if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s)) errors.push(`Scope contains characters OAuth 2.0 does not allow: ${s}`);
    }
  }
  return { data, errors };
}

function writeChildren(id, d) {
  db.run('DELETE FROM app_attribute_map WHERE app_id = ?', id);
  db.run('DELETE FROM app_access_groups WHERE app_id = ?', id);
  for (const m of d.maps) db.run('INSERT INTO app_attribute_map (app_id, idp_attribute, claim_name) VALUES (?,?,?)', id, m.idp_attribute, m.claim_name);
  for (const g of d.access_groups) db.run('INSERT OR IGNORE INTO app_access_groups (app_id, group_id) SELECT ?, id FROM groups WHERE id = ?', id, g);
}

const COLS = ['name', 'description', 'access_mode', 'require_pkce', 'subject_source', 'access_token_ttl'];
const jsonCols = (d) => [d.redirect_uris, d.post_logout_uris, d.grant_types, d.scopes].map((v) => JSON.stringify(v));

/** Creates the app. Returns { id, secret }; the secret (confidential clients only) is shown once and never stored. */
function createApp(d) {
  const id = crypto.randomBytes(8).toString('hex');
  const secret = d.confidential ? random() : '';
  const clientId = d.protocol === 'cas' ? null : d.client_id || newClientId(d.protocol);
  db.tx(() => {
    db.run(
      `INSERT INTO apps (id, protocol, client_id, client_secret_hash, redirect_uris, post_logout_uris, grant_types, scopes, ${COLS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${COLS.map(() => '?').join(', ')})`,
      id, d.protocol, clientId, secret ? sha256(secret) : '', ...jsonCols(d), ...COLS.map((c) => d[c]));
    writeChildren(id, d);
  });
  return { id, secret };
}

/** Updates the app. Switching a client between public and confidential issues or removes its secret; returns the new secret, if any. */
function updateApp(id, d) {
  const cur = db.get('SELECT client_secret_hash FROM apps WHERE id = ?', id);
  let secret = '';
  let hash = cur.client_secret_hash;
  if (d.confidential && !hash) {
    secret = random();
    hash = sha256(secret);
  } else if (!d.confidential) {
    hash = '';
  }
  db.tx(() => {
    db.run(
      `UPDATE apps SET client_secret_hash = ?, redirect_uris = ?, post_logout_uris = ?, grant_types = ?, scopes = ?, ${COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      hash, ...jsonCols(d), ...COLS.map((c) => d[c]), id);
    writeChildren(id, d);
  });
  return secret;
}

function rotateSecret(id) {
  const secret = random();
  db.tx(() => {
    db.run('UPDATE apps SET client_secret_hash = ? WHERE id = ?', sha256(secret), id);
    db.run("DELETE FROM app_grants WHERE app_id = ? AND kind IN ('refresh', 'access') AND user_id IS NULL", id);
  });
  return secret;
}

function deleteApp(id) {
  db.run('DELETE FROM apps WHERE id = ?', id);
}

function checkSecret(app, presented) {
  const row = db.get('SELECT client_secret_hash AS h FROM apps WHERE id = ?', app.id);
  if (!row || !row.h || typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(sha256(presented));
  const b = Buffer.from(row.h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// May this user sign in to the app? Disabled for all, enabled for members of chosen groups, or enabled for all.
function userHasAccess(app, userId) {
  if (app.access_mode === 'none') return false;
  if (app.access_mode !== 'groups') return true;
  const allowed = new Set(app.access_groups);
  return effectiveGroupsOf(userId).some((g) => allowed.has(g.id));
}

/* Redirect and service matching */

const redirectAllowed = (app, uri) => app.redirect_uris.includes(uri);

// A pattern has one * and it is the last character, directly after a / that comes after the host: https://app.example.net/app/*.
function wildcardPatternOk(pattern) {
  if (pattern.indexOf('*') !== pattern.length - 1 || !pattern.endsWith('/*')) return false;
  const prefix = pattern.slice(0, -1);
  return /^https?:\/\/[^/?#@\\*]+\/[^?#\\]*$/i.test(prefix) && isHttpUrl(prefix);
}

// CAS service URLs match exactly, or by pattern when they end in /*. The service must be on the pattern's own host and under its path;
// a pattern that is not of that form (one saved before this rule) matches nothing.
function serviceAllowed(app, service) {
  return app.redirect_uris.some((p) => {
    if (!p.includes('*')) return p === service;
    if (!wildcardPatternOk(p)) return false;
    const prefix = p.slice(0, -1);
    try {
      return service.startsWith(prefix) && new URL(service).origin === new URL(prefix).origin;
    } catch {
      return false;
    }
  });
}

function findCasApp(service) {
  if (!isHttpUrl(service)) return null;
  for (const row of db.all("SELECT id FROM apps WHERE protocol = 'cas' ORDER BY name")) {
    const app = getApp(row.id);
    if (serviceAllowed(app, service)) return app;
  }
  return null;
}

/* Claims */

function subjectOf(app, user, ctx) {
  const [v] = attrs.resolve(user, app.subject_source, ctx);
  return v || String(user.guid || user.username);
}

function userContext(user, app) {
  return { groups: attrs.userGroups(user.id), custom: attrs.userCustom(user.id), sp: { sp_entity_id: app.client_id || app.id } };
}

const fullName = (u) => u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ');

// Claims released for the granted scopes, plus the attributes mapped on the application.
function claimsFor(app, user, scopes) {
  const ctx = userContext(user, app);
  const claims = { sub: subjectOf(app, user, ctx) };
  const set = (k, v) => { if (v) claims[k] = v; };
  if (scopes.includes('profile')) {
    set('name', fullName(user));
    set('given_name', user.first_name);
    set('family_name', user.last_name);
    set('preferred_username', user.username);
  }
  if (scopes.includes('email')) set('email', user.email);
  if (scopes.includes('groups')) claims.groups = ctx.groups.map((g) => g.name);
  Object.assign(claims, mappedClaims(app, user, ctx));
  return claims;
}

function mappedClaims(app, user, ctx = userContext(user, app)) {
  const out = {};
  for (const m of app.maps) {
    const values = attrs.resolve(user, m.idp_attribute, ctx);
    if (!values.length) continue;
    out[m.claim_name] = attrs.MULTI_VALUED.has(m.idp_attribute) ? values : values[0];
  }
  return out;
}

/* Grants: codes, tokens and tickets. Only hashes are stored. */

function purgeExpired() {
  db.run('DELETE FROM app_grants WHERE expires_at < ?', Math.floor(Date.now() / 1000));
}

/** Stores a grant and returns the value to hand out. */
function issueGrant({ kind, app, userId = null, ttl, prefix = '', ...rest }) {
  purgeExpired();
  const value = `${prefix}${random()}`;
  db.run(
    `INSERT INTO app_grants (token_hash, kind, app_id, user_id, scope, redirect_uri, nonce, code_challenge, auth_time, amr, fresh, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    sha256(value), kind, app.id, userId, rest.scope || '', rest.redirectUri || '', rest.nonce || '', rest.codeChallenge || '',
    rest.authTime || 0, JSON.stringify(rest.amr || []), rest.fresh ? 1 : 0, Math.floor(Date.now() / 1000) + ttl);
  return value;
}

/** Looks up an unexpired grant of the given kind. With `consume`, it is deleted in the same step so it can be used once. */
function findGrant(kind, value, { consume = false } = {}) {
  if (typeof value !== 'string' || !value) return null;
  const hash = sha256(value);
  const row = db.get('SELECT * FROM app_grants WHERE token_hash = ? AND kind = ? AND expires_at >= ?', hash, kind, Math.floor(Date.now() / 1000));
  if (!row) return null;
  if (consume) db.run('DELETE FROM app_grants WHERE token_hash = ?', hash);
  return { ...row, amr: JSON.parse(row.amr) };
}

function revokeGrant(value) {
  if (typeof value === 'string' && value) db.run('DELETE FROM app_grants WHERE token_hash = ?', sha256(value));
}

module.exports = {
  PROTOCOLS, GRANT_TYPES, OIDC_SCOPES, getApp, getByClientId, listApps, blankApp, parseForm, createApp, updateApp, rotateSecret, deleteApp,
  checkSecret, userHasAccess, redirectAllowed, serviceAllowed, findCasApp, claimsFor, mappedClaims, subjectOf, userContext,
  issueGrant, findGrant, revokeGrant, sha256, random,
};
