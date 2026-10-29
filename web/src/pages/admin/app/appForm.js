// Form model for CAS, OpenID Connect and OAuth 2.0 applications. List fields are edited as rows of objects;
// toForm / toPayload convert to and from the shape /api/admin/apps expects.

export const PROTOCOLS = {
  saml: { label: 'SAML 2.0', create: '/admin/sps/new' },
  oidc: { label: 'OpenID Connect', create: '/admin/apps/new?protocol=oidc' },
  oauth2: { label: 'OAuth 2.0', create: '/admin/apps/new?protocol=oauth2' },
  cas: { label: 'CAS', create: '/admin/apps/new?protocol=cas' },
};

export const GRANTS = {
  authorization_code: 'Authorization code',
  refresh_token: 'Refresh token',
  client_credentials: 'Client credentials (no user)',
};

export const GRANTS_FOR = {
  oidc: ['authorization_code', 'refresh_token'],
  oauth2: ['authorization_code', 'refresh_token', 'client_credentials'],
};

export const OIDC_SCOPES = [
  { value: 'openid', label: 'openid', help: 'Required. Returns the subject identifier.' },
  { value: 'profile', label: 'profile', help: 'Name and username.' },
  { value: 'email', label: 'email', help: 'Email address.' },
  { value: 'groups', label: 'groups', help: 'Names of the groups the user belongs to.' },
  { value: 'offline_access', label: 'offline_access', help: 'Refresh tokens (needs the refresh token grant).' },
];

const rows = (list) => (list && list.length ? list : ['']).map((url) => ({ url }));

export function toForm(app) {
  return {
    protocol: app.protocol,
    name: app.name || '',
    description: app.description || '',
    access_mode: app.access_mode || 'all',
    access_groups: (app.access_groups || []).map(String),
    redirect_uris: rows(app.redirect_uris),
    post_logout_uris: (app.post_logout_uris || []).map((url) => ({ url })),
    confidential: Boolean(app.confidential),
    require_pkce: Boolean(app.require_pkce),
    grant_types: app.grant_types || [],
    scopes: app.scopes || [],
    scopes_text: (app.scopes || []).join(' '),
    subject_source: app.subject_source || (app.protocol === 'cas' ? 'username' : 'guid'),
    access_token_ttl: app.access_token_ttl || 3600,
    maps: (app.maps || []).map((m) => ({ idp_attribute: m.idp_attribute, claim_name: m.claim_name })),
  };
}

export function toPayload(f) {
  const urls = (list) => list.map((r) => r.url.trim()).filter(Boolean);
  return {
    protocol: f.protocol,
    name: f.name,
    description: f.description,
    access_mode: f.access_mode,
    access_groups: f.access_groups.map(Number),
    redirect_uris: urls(f.redirect_uris),
    post_logout_uris: urls(f.post_logout_uris),
    confidential: f.confidential,
    require_pkce: f.confidential ? f.require_pkce : true,
    grant_types: f.grant_types,
    scopes: f.protocol === 'oauth2' ? f.scopes_text.split(/\s+/).filter(Boolean) : f.scopes,
    subject_source: f.subject_source,
    access_token_ttl: Number(f.access_token_ttl),
    maps: f.maps.filter((m) => m.idp_attribute && m.claim_name.trim()),
  };
}
