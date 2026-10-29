const fs = require('fs');
const db = require('./db');
const startup = require('./settings');
const forwarder = require('./audit-forward');
const { SIGNATURE_ALGORITHMS, ENCRYPTION_ALGORITHMS, KEY_TRANSPORT_ALGORITHMS } = require('./config');

// Settings an administrator edits in the console, kept in the settings table. For Duo, a saved
// configuration takes precedence over duo* in config.json / environment variables, which remain the
// fallback until one is saved.

const read = (key) => {
  const row = db.get('SELECT value FROM settings WHERE key = ?', key);
  try {
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
};
const write = (key, value) => db.run(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

/* ---------------------------------- Duo ----------------------------------- */

/** Whether the break-glass file is present. Checked on every call so that creating or removing it takes effect at once. */
const duoBypassed = () => fs.existsSync(startup.duoBypassFile);

/** Effective Duo configuration: { enabled, apiHost, integrationKey, secretKey, source, bypassed }. */
function duo() {
  const saved = read('duo');
  const cfg = saved
    ? { ...saved, enabled: Boolean(saved.enabled && saved.apiHost && saved.integrationKey && saved.secretKey), source: 'console' }
    : (() => {
      const { duoApiHost: apiHost, duoIntegrationKey: integrationKey, duoSecretKey: secretKey } = startup;
      return { enabled: Boolean(apiHost && integrationKey && secretKey), apiHost, integrationKey, secretKey, source: 'file' };
    })();
  // The break-glass file overrides the console and config files: Duo is off, but the saved settings are kept for the console.
  if (duoBypassed()) return { ...cfg, enabled: false, bypassed: true, source: 'bypass-file' };
  return { ...cfg, bypassed: false };
}

const saveDuo = (cfg) => write('duo', {
  enabled: Boolean(cfg.enabled), apiHost: cfg.apiHost, integrationKey: cfg.integrationKey, secretKey: cfg.secretKey,
});

/* -------------------------------- Grouper --------------------------------- */

// Internet2 Grouper provisions groups and memberships to /scim/v2 with a bearer token. Only a hash of the
// token is stored. attributeName is the SAML attribute that carries a user's Grouper groups.
const GROUPER_DEFAULTS = { enabled: false, attributeName: 'isMemberOf', tokenHash: '', tokenCreatedAt: '' };
const ATTRIBUTE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:\-/]*$/;

const grouper = () => ({ ...GROUPER_DEFAULTS, ...(read('grouper') || {}) });

function parseGrouper(body) {
  const errors = [];
  const attributeName = typeof body.attributeName === 'string' ? body.attributeName.trim() : '';
  if (!attributeName) errors.push('Group attribute name is required.');
  else if (attributeName.length > 200 || !ATTRIBUTE_NAME_RE.test(attributeName)) {
    errors.push('Group attribute name may contain only letters, digits and . _ : - / and must start with a letter or underscore.');
  }
  return { data: { enabled: Boolean(body.enabled), attributeName }, errors };
}

const saveGrouper = (patch) => write('grouper', { ...grouper(), ...patch });

// Last time Grouper wrote to the IdP, shown on the settings page.
const grouperActivity = () => read('grouper_activity') || { at: '', summary: '' };
const recordGrouperActivity = (summary) => write('grouper_activity', { at: new Date().toISOString(), summary });

/* -------------------------------- Branding -------------------------------- */

const BRANDING_DEFAULTS = {
  appName: 'Pons Identity',
  // On: the product name is used everywhere the product is named (messages, help, generated files). Off: only the branding uses appName.
  namePropagation: true,
  primaryColor: '#1f5fbf',
  headerColor: '',
  logo: '',
  loginMessage: '',
  // Custom sign-in page: an HTML template using the {{variables}} below ('' = built-in page) and CSS applied to either page.
  loginTemplate: '',
  loginCss: '',
};

// Variables a sign-in template may use. Keep in sync with web/src/loginTemplate.js.
const LOGIN_TEMPLATE_VARIABLES = ['username_input', 'password_input', 'submit_button', 'error_message', 'federation_link',
  'app_name', 'logo', 'login_message', 'primary_color', 'header_color'];
const LOGIN_TEMPLATE_REQUIRED = ['username_input', 'password_input', 'submit_button'];
const MAX_TEMPLATE = 20000;
const MAX_CSS = 50000;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LOGO_RE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
const MAX_LOGO = 256 * 1024;

// A blank product name means the default, so every reader gets a usable name.
const branding = () => {
  const b = { ...BRANDING_DEFAULTS, ...(read('branding') || {}) };
  return { ...b, appName: String(b.appName || '').trim() || BRANDING_DEFAULTS.appName };
};

/** The name the product goes by in messages, help and generated files. With name propagation off, that is always the default. */
const productName = () => {
  const b = branding();
  return b.namePropagation ? b.appName : BRANDING_DEFAULTS.appName;
};

/** Validate and normalize submitted branding. Colors are strictly #rrggbb because they are written into CSS. */
function parseBranding(body) {
  const errors = [];
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = {
    appName: text(body.appName),
    namePropagation: body.namePropagation !== false,
    primaryColor: text(body.primaryColor).toLowerCase(),
    headerColor: text(body.headerColor).toLowerCase(),
    logo: typeof body.logo === 'string' ? body.logo : '',
    loginMessage: text(body.loginMessage),
    loginTemplate: typeof body.loginTemplate === 'string' ? body.loginTemplate.trim() : '',
    loginCss: typeof body.loginCss === 'string' ? body.loginCss.trim() : '',
  };
  if (out.appName.length > 40) errors.push('Product name must be 40 characters or fewer.');
  if (!COLOR_RE.test(out.primaryColor)) errors.push('Primary color must look like #1f5fbf.');
  if (out.headerColor && !COLOR_RE.test(out.headerColor)) errors.push('Header color must look like #1f5fbf, or be empty to use the primary color.');
  if (out.logo && !LOGO_RE.test(out.logo)) errors.push('Logo must be a PNG, JPEG, GIF, WebP or SVG image.');
  if (out.logo.length > MAX_LOGO) errors.push('Logo must be smaller than 256 KB.');
  if (out.loginMessage.length > 300) errors.push('Sign-in message must be 300 characters or fewer.');
  if (out.loginTemplate.length > MAX_TEMPLATE) errors.push('Sign-in page template must be 20,000 characters or fewer.');
  else if (out.loginTemplate) {
    const used = [...out.loginTemplate.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
    for (const v of new Set(used)) if (!LOGIN_TEMPLATE_VARIABLES.includes(v)) errors.push(`Sign-in page template uses an unknown variable {{${v}}}.`);
    for (const v of LOGIN_TEMPLATE_REQUIRED) if (!used.includes(v)) errors.push(`Sign-in page template must include {{${v}}}.`);
    if (/<\s*script/i.test(out.loginTemplate)) errors.push('Sign-in page template cannot contain scripts.');
  }
  if (out.loginCss.length > MAX_CSS) errors.push('Sign-in page CSS must be 50,000 characters or fewer.');
  else if (/@import|<\/?style|expression\s*\(|javascript:|url\(\s*['"]?\s*(https?:)?\/\//i.test(out.loginCss)) {
    errors.push('Sign-in page CSS cannot use @import, remote url() references, scripts or <style> tags.');
  }
  return { data: out, errors };
}

const saveBranding = (b) => write('branding', b);

/** Branding for people who are not signed in: the custom sign-in template and CSS are served separately (see login-page-guard). */
function publicBranding() {
  const { loginTemplate, loginCss, ...rest } = branding();
  return { ...rest, productName: productName(), loginCustom: Boolean(loginTemplate || loginCss) };
}

/* ------------------------------- Global policy -------------------------------- */

// The sign-in and password rules that hold for every account, in the shape of a policies row (see policies.js for how they combine).
// Null when no global policy is set.
const globalPolicy = () => read('global_policy');

const saveGlobalPolicy = (row) => write('global_policy', row);

/* ------------------------------ Global password rules ------------------------------ */

// The password rules every account is held to, in the shape of a password_policies row (null = none). Before these existed only a
// minimum length was kept, under 'password_min_length'; that value is still read, as the minimum of the rules, until they are saved.
const globalPasswordRules = () => {
  const rules = read('global_password_rules');
  if (rules) return rules;
  const legacy = read('password_min_length');
  return Number.isInteger(legacy) ? { min_length: legacy } : null;
};

const saveGlobalPasswordRules = (rules) => {
  write('global_password_rules', rules);
  write('password_min_length', null);
};

/* ------------------- Sign-in page copy detection (anti-phishing) ------------------- */

const PROTECTION_DEFAULTS = { enabled: true, notifyRoleIds: [], cooldownMinutes: 60 };

const loginPageProtection = () => ({ ...PROTECTION_DEFAULTS, ...(read('login_page_protection') || {}) });

function parseLoginPageProtection(body, roleExists) {
  const errors = [];
  const ids = Array.isArray(body.notifyRoleIds) ? [...new Set(body.notifyRoleIds.map(Number))] : [];
  if (ids.some((id) => !Number.isInteger(id) || !roleExists(id))) errors.push('Choose roles that exist.');
  const cooldownMinutes = Number(body.cooldownMinutes);
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 1440) errors.push('Minutes between alerts must be a whole number from 1 to 1440.');
  return { data: { enabled: Boolean(body.enabled), notifyRoleIds: ids, cooldownMinutes }, errors };
}

const saveLoginPageProtection = (p) => write('login_page_protection', p);

/* ---------------------------- Federation identity ---------------------------- */

// The IdP that is registered in a federation such as InCommon: one entity ID, one set of keys, and a policy for what
// is released to federation SPs. Private keys live under a separate settings key so they are never part of the view.
const AFFILIATIONS = ['faculty', 'student', 'staff', 'alum', 'member', 'affiliate', 'employee', 'library-walk-in'];
const EPPN_SOURCES = ['username', 'sam_account_name', 'mail_nickname', 'upn'];
const CATEGORY_KEYS = ['rs', 'pseudonymous', 'personalized', 'anonymous', 'coco'];
const CONTACT_KEYS = ['technical', 'support', 'security'];
const FEDERATION_DEFAULTS = {
  enabled: false,
  entityId: '',
  scope: '',
  signatureAlgorithm: 'sha256',
  encryptAssertions: true,
  encryptionAlgorithm: 'aes128-gcm',
  keyTransportAlgorithm: 'rsa-oaep-mgf1p',
  eppnSource: 'username',
  defaultAffiliation: 'member',
  affiliationGroups: [],
  categories: { rs: true, pseudonymous: true, personalized: false, anonymous: true, coco: false },
  releaseRequired: true,
  organization: { name: '', displayName: '', url: '' },
  ui: { displayName: '', description: '', informationUrl: '', privacyUrl: '' },
  contacts: { technical: { name: '', email: '' }, support: { name: '', email: '' }, security: { name: '', email: '' } },
  sirtfi: false,
};

const federationIdp = () => {
  const saved = read('federation_idp') || {};
  const d = FEDERATION_DEFAULTS;
  return {
    ...d, ...saved,
    categories: { ...d.categories, ...saved.categories },
    organization: { ...d.organization, ...saved.organization },
    ui: { ...d.ui, ...saved.ui },
    contacts: Object.fromEntries(CONTACT_KEYS.map((k) => [k, { ...d.contacts[k], ...(saved.contacts || {})[k] }])),
    affiliationGroups: saved.affiliationGroups || [],
  };
};

const SCOPE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const isHttps = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };

function parseFederationIdp(body) {
  const errors = [];
  const t = (v) => (typeof v === 'string' ? v.trim() : '');
  const b = body || {};
  const out = {
    enabled: Boolean(b.enabled),
    entityId: t(b.entityId),
    scope: t(b.scope).toLowerCase(),
    signatureAlgorithm: t(b.signatureAlgorithm) || 'sha256',
    encryptAssertions: b.encryptAssertions === undefined ? true : Boolean(b.encryptAssertions),
    encryptionAlgorithm: t(b.encryptionAlgorithm) || FEDERATION_DEFAULTS.encryptionAlgorithm,
    keyTransportAlgorithm: t(b.keyTransportAlgorithm) || FEDERATION_DEFAULTS.keyTransportAlgorithm,
    eppnSource: t(b.eppnSource) || 'username',
    defaultAffiliation: b.defaultAffiliation === undefined ? FEDERATION_DEFAULTS.defaultAffiliation : t(b.defaultAffiliation),
    affiliationGroups: (Array.isArray(b.affiliationGroups) ? b.affiliationGroups : [])
      .map((r) => ({ group: t(r && r.group), affiliation: t(r && r.affiliation) })).filter((r) => r.group || r.affiliation),
    categories: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, Boolean((b.categories || {})[k])])),
    releaseRequired: Boolean(b.releaseRequired),
    organization: { name: t(b.organization?.name), displayName: t(b.organization?.displayName), url: t(b.organization?.url) },
    ui: {
      displayName: t(b.ui?.displayName), description: t(b.ui?.description),
      informationUrl: t(b.ui?.informationUrl), privacyUrl: t(b.ui?.privacyUrl),
    },
    contacts: Object.fromEntries(CONTACT_KEYS.map((k) => [k, { name: t(b.contacts?.[k]?.name), email: t(b.contacts?.[k]?.email) }])),
    sirtfi: Boolean(b.sirtfi),
  };
  if (out.entityId && !isHttps(out.entityId) && !/^urn:/.test(out.entityId)) errors.push('Entity ID must be an https URL or a URN.');
  if (out.scope && !SCOPE_RE.test(out.scope)) errors.push('Scope must be a domain name such as example.net.');
  if (!(out.signatureAlgorithm in SIGNATURE_ALGORITHMS) || out.signatureAlgorithm === 'sha1') errors.push('Choose a SHA-2 signature algorithm.');
  if (!(out.encryptionAlgorithm in ENCRYPTION_ALGORITHMS)) errors.push('Invalid assertion encryption algorithm.');
  if (!(out.keyTransportAlgorithm in KEY_TRANSPORT_ALGORITHMS)) errors.push('Invalid key transport algorithm.');
  if (!EPPN_SOURCES.includes(out.eppnSource)) errors.push('Invalid eduPersonPrincipalName source.');
  if (out.defaultAffiliation && !AFFILIATIONS.includes(out.defaultAffiliation)) errors.push('Invalid default affiliation.');
  for (const r of out.affiliationGroups) {
    if (!r.group || !AFFILIATIONS.includes(r.affiliation)) errors.push('Each affiliation mapping needs a group name and a valid affiliation.');
  }
  if (out.organization.url && !isHttps(out.organization.url) && !/^http:\/\//i.test(out.organization.url)) errors.push('Organization URL must be a web address.');
  for (const [k, u] of [['informationUrl', out.ui.informationUrl], ['privacyUrl', out.ui.privacyUrl]]) {
    if (u && !isHttps(u)) errors.push(`${k === 'privacyUrl' ? 'Privacy statement' : 'Information'} URL must be https.`);
  }
  for (const k of CONTACT_KEYS) {
    if (out.contacts[k].email && !EMAIL_RE.test(out.contacts[k].email)) errors.push(`The ${k} contact email address is not valid.`);
  }
  if (out.sirtfi && !out.contacts.security.email) errors.push('SIRTFI requires a security contact email address.');
  if (out.enabled) {
    if (!out.scope) errors.push('A scope is required before the federation identity can be enabled.');
    if (!out.organization.name || !out.organization.displayName || !out.organization.url) {
      errors.push('Organization name, display name and URL are required before the federation identity can be enabled.');
    }
    if (!out.contacts.technical.email) errors.push('A technical contact email address is required before the federation identity can be enabled.');
  }
  return { data: out, errors };
}

const saveFederationIdp = (cfg) => write('federation_idp', cfg);
const federationKeys = () => read('federation_keys');
const saveFederationKeys = (keys) => write('federation_keys', keys);

/* ------------------------- Federation service provider ------------------------ */

// The inbound half: this server as a service provider to other institutions' IdPs. 'approve' parks first-time
// sign-ins until an administrator accepts them; 'auto' creates the account straight away.
const PROVISIONING = ['approve', 'auto'];
const FEDERATION_SP_DEFAULTS = { enabled: false, entityId: '', provisioning: 'approve', idpAllowlist: [], signRequests: true };

const federationSp = () => ({ ...FEDERATION_SP_DEFAULTS, ...(read('federation_sp') || {}) });

function parseFederationSp(body, idpCfg) {
  const errors = [];
  const t = (v) => (typeof v === 'string' ? v.trim() : '');
  const b = body || {};
  const list = Array.isArray(b.idpAllowlist) ? b.idpAllowlist : String(b.idpAllowlist || '').split(/\r?\n/);
  const out = {
    enabled: Boolean(b.enabled),
    entityId: t(b.entityId),
    provisioning: t(b.provisioning) || 'approve',
    idpAllowlist: [...new Set(list.map(t).filter(Boolean))],
    signRequests: b.signRequests === undefined ? true : Boolean(b.signRequests),
  };
  if (out.entityId && !isHttps(out.entityId) && !/^urn:/.test(out.entityId)) errors.push('Entity ID must be an https URL or a URN.');
  if (!PROVISIONING.includes(out.provisioning)) errors.push('Invalid account creation policy.');
  if (out.idpAllowlist.length > 500) errors.push('The allow list is limited to 500 identity providers.');
  if (out.enabled) {
    const org = idpCfg.organization;
    if (!org.name || !org.displayName || !org.url || !idpCfg.contacts.technical.email) {
      errors.push('Fill in the organization and technical contact under Federation identity before enabling this: the federation requires them in service provider metadata.');
    }
  }
  return { data: out, errors };
}

const saveFederationSp = (cfg) => write('federation_sp', cfg);
const federationSpKeys = () => read('federation_sp_keys');
const saveFederationSpKeys = (keys) => write('federation_sp_keys', keys);

/* ------------------------- Log forwarding (SIEM, syslog) ------------------------- */

// Where audit events are sent to a syslog server or SIEM. Configured only in the console, so the settings table is
// the one source. auditStdout is not here: it is for container log shippers and stays in config.json or the environment.
const SYSLOG_URL_RE = /^(udp|tcp|tls):\/\/.+:\d+$/;
const HTTP_URL_RE = /^https?:\/\/.+/;
const HTTP_FORMATS = ['json', 'splunk-hec', 'ecs', 'cef'];

const FORWARDING_DEFAULTS = {
  syslog: { enabled: false, url: '', facility: 'authpriv', appName: 'simpleidp', caFile: '' },
  http: { enabled: false, url: '', format: 'json', authToken: '' },
};

/** Saved forwarding settings, with an enabled flag per destination. */
function forwarding() {
  const saved = read('audit_forwarding') || {};
  return {
    syslog: { ...FORWARDING_DEFAULTS.syslog, ...saved.syslog },
    http: { ...FORWARDING_DEFAULTS.http, ...saved.http },
  };
}

/** What audit-forward starts with: only the enabled destinations. */
function auditForwardingSinks() {
  const f = forwarding();
  return {
    auditSyslog: f.syslog.enabled ? { url: f.syslog.url, facility: f.syslog.facility, appName: f.syslog.appName, caFile: f.syslog.caFile } : null,
    auditHttp: f.http.enabled ? { url: f.http.url, format: f.http.format, authToken: f.http.authToken } : null,
    auditStdout: startup.auditStdout,
  };
}

// The access token never leaves the server: the view says only whether one is saved.
const auditForwardingView = () => {
  const f = forwarding();
  return { facilities: Object.keys(forwarder.FACILITIES), syslog: { ...f.syslog }, http: { enabled: f.http.enabled, url: f.http.url, format: f.http.format, tokenSet: Boolean(f.http.authToken) } };
};

/** Validate submitted forwarding settings. An empty token keeps the one in effect, as Duo's secret key does. */
function parseAuditForwarding(body, current) {
  const errors = [];
  const t = (v) => (typeof v === 'string' ? v.trim() : '');
  const sys = body.syslog || {};
  const http = body.http || {};
  const out = {
    syslog: {
      enabled: Boolean(sys.enabled),
      url: t(sys.url),
      facility: t(sys.facility) || 'authpriv',
      appName: t(sys.appName) || 'simpleidp',
      caFile: t(sys.caFile),
    },
    http: {
      enabled: Boolean(http.enabled),
      url: t(http.url),
      format: t(http.format) || 'json',
      authToken: t(http.authToken) || current.http.authToken,
    },
  };
  if (out.syslog.enabled) {
    if (!SYSLOG_URL_RE.test(out.syslog.url)) errors.push('Syslog server must look like udp://host:514, tcp://host:514 or tls://host:6514.');
    if (!(out.syslog.facility in forwarder.FACILITIES)) errors.push('Choose a valid syslog facility.');
    if (!out.syslog.appName || out.syslog.appName.length > 48) errors.push('Syslog application name must be 1 to 48 characters.');
  }
  if (out.http.enabled) {
    if (!HTTP_URL_RE.test(out.http.url)) errors.push('SIEM URL must start with http:// or https://.');
    if (!HTTP_FORMATS.includes(out.http.format)) errors.push('Choose a valid SIEM event format.');
  }
  return { data: out, errors };
}

const saveAuditForwarding = (cfg) => write('audit_forwarding', cfg);

module.exports = { read, write, duo, saveDuo, grouper, parseGrouper, saveGrouper, grouperActivity, recordGrouperActivity, branding, productName, parseBranding, saveBranding, publicBranding, loginPageProtection, parseLoginPageProtection, saveLoginPageProtection, BRANDING_DEFAULTS, LOGIN_TEMPLATE_VARIABLES,
  federationIdp, parseFederationIdp, saveFederationIdp, federationKeys, saveFederationKeys, AFFILIATIONS, EPPN_SOURCES, FEDERATION_DEFAULTS,
  federationSp, parseFederationSp, saveFederationSp, federationSpKeys, saveFederationSpKeys, PROVISIONING,
  forwarding, auditForwardingSinks, auditForwardingView, parseAuditForwarding, saveAuditForwarding, globalPasswordRules, saveGlobalPasswordRules, globalPolicy, saveGlobalPolicy };
