const crypto = require('crypto');
const appSettings = require('../app-settings');
const { baseUrl } = require('../config');

// Identity verification for self-service resets: a person proves who they are with an outside platform before a password or
// second-factor reset goes through. The provider is Persona, a REST service the administrator describes, or an integration script
// (identity/index.js does the work). Secrets (the Persona API key and webhook secret, the headers that carry credentials) are
// stored like the Duo secret key: the console never gets them back, and a blank value keeps the stored one.
const KEY = 'identity';
const PROVIDERS = ['none', 'persona', 'rest'];
const PERSONA_API = 'https://withpersona.com/api/v1';

// Each call: what to send. `headers` is one "Name: value" per line; `body` is a template (JSON or text).
const CALL = { method: 'GET', url: '', headers: '', body: '' };
const DEFAULTS = {
  provider: 'none',
  persona: { apiKey: '', templateId: '', webhookSecret: '' },
  rest: {
    create: { ...CALL, method: 'POST' },
    send: { ...CALL, method: 'POST' },
    status: { ...CALL },
    refPath: 'id', urlPath: '', statusPath: 'status',
    approved: 'approved', declined: 'declined', expired: 'expired',
    webhookRefPath: 'id', webhookToken: '', webhookSecret: '',
  },
  // Which resets require a verification. `integrationId` (when set) replaces the provider with an integration script.
  requirement: { password: false, mfa: false, integrationId: null },
};

// The fields that must never be sent back to the console. Headers are included because they usually carry a token.
const SECRETS = [['persona', 'apiKey'], ['persona', 'webhookSecret'], ['rest', 'webhookSecret'], ['rest', 'create', 'headers'], ['rest', 'send', 'headers'], ['rest', 'status', 'headers']];

const clone = (v) => JSON.parse(JSON.stringify(v));
const merge = (base, saved) => {
  const out = clone(base);
  for (const k of Object.keys(base)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], (saved || {})[k]);
    else if (saved && saved[k] !== undefined) out[k] = saved[k];
  }
  return out;
};

/** The saved configuration, with defaults for what is not set. */
function get() {
  return merge(DEFAULTS, appSettings.read(KEY) || {});
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const httpUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
const HEADER_RE = /^[A-Za-z0-9-]+\s*:/;

function checkCall(label, call, errors, { required = false } = {}) {
  if (!call.url && !required) return;
  if (!call.url) { errors.push(`${label}: the address is required.`); return; }
  if (!httpUrl(call.url)) errors.push(`${label}: the address must be an http or https address.`);
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(call.method)) errors.push(`${label}: the method must be GET, POST, PUT, PATCH or DELETE.`);
  for (const line of call.headers.split(/\r?\n/).filter((l) => l.trim())) {
    if (!HEADER_RE.test(line)) errors.push(`${label}: header "${line.slice(0, 30)}" must look like Name: value.`);
  }
}

/** Validates submitted settings and keeps stored secrets where a blank was submitted. Returns { data, errors }. */
function parse(body = {}, current = get()) {
  const errors = [];
  const src = body || {};
  const out = merge(DEFAULTS, {});
  out.provider = PROVIDERS.includes(src.provider) ? src.provider : 'none';

  const p = src.persona || {};
  out.persona = { apiKey: text(p.apiKey), templateId: text(p.templateId), webhookSecret: text(p.webhookSecret) };
  const r = src.rest || {};
  const call = (c, fallback) => ({
    method: text(c && c.method).toUpperCase() || fallback.method,
    url: text(c && c.url),
    headers: typeof (c && c.headers) === 'string' ? c.headers : '',
    body: typeof (c && c.body) === 'string' ? c.body : '',
  });
  out.rest = {
    create: call(r.create, DEFAULTS.rest.create),
    send: call(r.send, DEFAULTS.rest.send),
    status: call(r.status, DEFAULTS.rest.status),
    refPath: text(r.refPath) || 'id',
    urlPath: text(r.urlPath),
    statusPath: text(r.statusPath) || 'status',
    approved: text(r.approved) || 'approved',
    declined: text(r.declined) || 'declined',
    expired: text(r.expired) || 'expired',
    webhookRefPath: text(r.webhookRefPath) || text(r.refPath) || 'id',
    // A token in the webhook address (not secret: the address is what the provider is given), made once.
    webhookToken: text(r.webhookToken) || crypto.randomBytes(18).toString('base64url'),
    webhookSecret: text(r.webhookSecret),
  };
  const req = src.requirement || {};
  const integrationId = req.integrationId === null || req.integrationId === '' || req.integrationId === undefined ? null : Number(req.integrationId);
  out.requirement = { password: Boolean(req.password), mfa: Boolean(req.mfa), integrationId: Number.isInteger(integrationId) ? integrationId : null };

  if (out.provider === 'persona') {
    if (!out.persona.apiKey && !current.persona.apiKey) errors.push('Persona: the API key is required.');
    if (!out.persona.templateId) errors.push('Persona: the inquiry template ID is required (it starts with itmpl_).');
  }
  if (out.provider === 'rest') {
    checkCall('Create the request', out.rest.create, errors, { required: true });
    checkCall('Send user information', out.rest.send, errors);
    checkCall('Get the status', out.rest.status, errors, { required: true });
    if (!out.rest.statusPath || !out.rest.approved) errors.push('REST: say which field holds the status and which value means approved.');
  }
  const wanted = out.requirement.password || out.requirement.mfa;
  if (wanted && out.provider === 'none' && out.requirement.integrationId === null) {
    errors.push('Choose a provider, or an integration script, before requiring a verification.');
  }

  // Blank secrets keep what is stored.
  for (const path of SECRETS) {
    const value = path.reduce((o, k) => o[k], out);
    if (value) continue;
    const old = path.reduce((o, k) => (o ? o[k] : undefined), current);
    if (old) path.slice(0, -1).reduce((o, k) => o[k], out)[path[path.length - 1]] = old;
  }
  return { data: out, errors };
}

const save = (data) => appSettings.write(KEY, data);

/** What the console sees: secrets replaced by whether each is set, and the address the provider calls back. */
function view(cfg = get()) {
  const out = clone(cfg);
  out.secrets = {};
  for (const path of SECRETS) {
    const key = path.join('.');
    const value = path.reduce((o, k) => o[k], out);
    out.secrets[key] = Boolean(value);
    path.slice(0, -1).reduce((o, k) => o[k], out)[path[path.length - 1]] = '';
  }
  out.callbacks = {
    persona: `${baseUrl}/identity/webhook/persona`,
    rest: `${baseUrl}/identity/webhook/rest/${cfg.rest.webhookToken}`,
  };
  return out;
}

module.exports = { get, parse, save, view, PROVIDERS, PERSONA_API, DEFAULTS, SECRETS };
