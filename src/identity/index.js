const crypto = require('crypto');
const db = require('../db');
const settings = require('./settings');
const auditLog = require('../audit');
const { safeRequest } = require('../safe-fetch');

// Identity verification for self-service resets. start() opens a verification with the provider and records it; refresh() asks the
// provider for the latest status; approvedFor() is what a reset checks. A verification is approved only when the provider (or the
// script) says so: nothing the person sends from the sign-in or reset page can approve one.
//
// Scripts reach the same functions through the 'identity' scope (integrations/host.js), so an integration can start and check a
// verification in its own way and return whether it passed.

const WINDOW_SECONDS = 24 * 3600;
const same = (a, b) => String(a).length === String(b).length && crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b)));
const PERSONA_VERSION = '2023-01-05';
const now = () => Math.floor(Date.now() / 1000);

const PURPOSES = ['password_reset', 'mfa_reset'];
/** Does a reset of this kind need a verification right now? */
const required = (purpose, cfg = settings.get()) => (purpose === 'mfa_reset' ? cfg.requirement.mfa : cfg.requirement.password);

/** Is there anything that can verify someone at all? */
const available = (cfg = settings.get()) => cfg.provider !== 'none' || cfg.requirement.integrationId !== null;

const userVars = (user) => ({
  'user.username': user.username || '',
  'user.email': user.email || '',
  'user.first_name': user.first_name || '',
  'user.last_name': user.last_name || '',
  'user.display_name': user.display_name || '',
  'user.guid': user.guid || '',
  'user.employee_id': user.employee_id || '',
});

// Fills a call template. In a URL the values are encoded; in a JSON body they are escaped so they cannot break out of a string.
function fill(tpl, vars, mode) {
  const encode = { url: encodeURIComponent, json: (v) => JSON.stringify(String(v)).slice(1, -1), text: (v) => String(v) }[mode];
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (k in vars ? encode(vars[k]) : ''));
}

const headersOf = (tpl, vars) => Object.fromEntries(String(tpl || '').split(/\r?\n/).filter((l) => l.includes(':')).map((l) => {
  const i = l.indexOf(':');
  return [l.slice(0, i).trim(), fill(l.slice(i + 1).trim(), vars, 'text').replace(/[\r\n]/g, '')];
}));

// The value at a dotted path ("data.attributes.status"), or undefined.
const at = (obj, path) => (path || '').split('.').filter(Boolean).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

// One call to an outside service: JSON in, JSON out. Only public addresses, a timeout, and no redirects (see safe-fetch).
async function call(spec, vars) {
  const url = fill(spec.url, vars, 'url');
  const isJson = /^\s*[{[]/.test(spec.body || '');
  const headers = headersOf(spec.headers, vars);
  const body = spec.body && spec.method !== 'GET' ? fill(spec.body, vars, isJson ? 'json' : 'text') : undefined;
  if (body && isJson) { try { JSON.parse(body); } catch { throw new Error('The request body is not valid JSON.'); } }
  if (body && !headers['content-type'] && !headers['Content-Type']) headers['content-type'] = isJson ? 'application/json' : 'text/plain';
  const r = await safeRequest(url, { method: spec.method || 'GET', headers, body });
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* not JSON: the status code still counts */ }
  if (!r.ok) throw new Error(`The service answered HTTP ${r.status}.`);
  return json;
}

/* ----------------------------------- Persona ----------------------------------- */

// Persona: an inquiry is created from a template and given a hosted link. Status is read from the inquiry itself.
const personaHeaders = (cfg) => ({ authorization: `Bearer ${cfg.persona.apiKey}`, 'persona-version': PERSONA_VERSION, accept: 'application/json' });

async function personaCreate(cfg, user) {
  const r = await safeRequest(`${settings.PERSONA_API}/inquiries`, {
    headers: { ...personaHeaders(cfg), 'content-type': 'application/json' },
    body: JSON.stringify({ data: { attributes: { 'inquiry-template-id': cfg.persona.templateId, 'reference-id': user.guid } } }),
  });
  if (!r.ok) throw new Error(`Persona answered HTTP ${r.status}.`);
  const id = JSON.parse(r.text).data.id;
  return { ref: id, url: `https://withpersona.com/verify?inquiry-id=${encodeURIComponent(id)}` };
}

async function personaStatus(cfg, ref) {
  const r = await safeRequest(`${settings.PERSONA_API}/inquiries/${encodeURIComponent(ref)}`, { method: 'GET', headers: personaHeaders(cfg) });
  if (!r.ok) throw new Error(`Persona answered HTTP ${r.status}.`);
  const status = JSON.parse(r.text).data.attributes.status;
  // Persona's "completed" means the person finished the steps, not that they passed: only approved counts as passed.
  if (status === 'approved') return 'approved';
  if (['declined', 'failed'].includes(status)) return 'declined';
  if (status === 'expired') return 'expired';
  return 'pending';
}

/* ----------------------------------- REST ----------------------------------- */

// A service the administrator describes: a request to create the verification (and, optionally, one that sends the person's
// details), and a request for its status. The response fields are read by path.
async function restCreate(cfg, user) {
  const vars = { ...userVars(user), ref: '', purpose: '' };
  const created = await call(cfg.rest.create, vars);
  const ref = at(created, cfg.rest.refPath);
  if (ref === undefined || ref === null || ref === '') throw new Error(`The service did not return a reference at "${cfg.rest.refPath}".`);
  const withRef = { ...vars, ref: String(ref) };
  if (cfg.rest.send.url) await call(cfg.rest.send, withRef);
  const url = cfg.rest.urlPath ? at(created, cfg.rest.urlPath) : '';
  return { ref: String(ref), url: typeof url === 'string' ? url : '' };
}

async function restStatus(cfg, ref, user) {
  const json = await call(cfg.rest.status, { ...userVars(user || {}), ref, purpose: '' });
  const value = at(json, cfg.rest.statusPath);
  if (value === cfg.rest.approved) return 'approved';
  if (value === cfg.rest.declined) return 'declined';
  if (value === cfg.rest.expired) return 'expired';
  return 'pending';
}

/* ------------------------------ Integration script ------------------------------ */

// The gate: an integration decides. It is called with input.step 'start' (it may return { url } for the person to follow, and
// { ref }) and 'check' (it returns { approved }). Its own result is what a reset relies on.
async function scriptRun(integrationId, step, user, purpose, ref) {
  const integrations = require('../integrations');
  const row = db.get('SELECT * FROM integrations WHERE id = ?', Number(integrationId));
  if (!row || !row.enabled) return { status: 'error', error: 'The verification integration is missing or turned off.' };
  const { outcome } = await integrations.execute(row, {
    input: { step, purpose, ref: ref || '', user: { id: user.guid, username: user.username, email: user.email || '', first_name: user.first_name || '', last_name: user.last_name || '' } },
    trigger: 'manual', actor: 'identity',
  });
  if (outcome.status !== 'ok') return { status: 'error', error: outcome.error ? outcome.error.message : 'The script did not finish.' };
  // The engine keeps a run's result as JSON text.
  const r = typeof outcome.result === 'string' ? JSON.parse(outcome.result) : (outcome.result || {});
  if (step === 'check') return { status: r.approved === true ? 'approved' : r.declined === true ? 'declined' : 'pending' };
  return { status: r.approved === true ? 'approved' : 'pending', ref: r.ref ? String(r.ref) : '', url: typeof r.url === 'string' ? r.url : '' };
}

/* ------------------------------------ Records ------------------------------------ */

const view = (row) => (row ? { id: row.id, purpose: row.purpose, provider: row.provider, status: row.status, url: row.url, ref: row.ref, created_at: row.created_at } : null);

/** The verification a reset relies on: the newest one from the last day for this person and purpose. */
const latest = (userId, purpose) => db.get('SELECT * FROM identity_verifications WHERE user_id = ? AND purpose = ? AND created_at > ? ORDER BY id DESC LIMIT 1',
  userId, purpose, now() - WINDOW_SECONDS);

/** True when this person has passed a verification for this purpose in the last day (and none is still waiting, which is the newest). */
const approvedFor = (userId, purpose) => {
  const row = latest(userId, purpose);
  return Boolean(row && row.status === 'approved');
};

const setStatus = (row, status, url) => {
  const t = now();
  db.run("UPDATE identity_verifications SET status = ?, updated_at = ?, completed_at = CASE WHEN ? != 'pending' THEN ? ELSE completed_at END, url = CASE WHEN ? != '' THEN ? ELSE url END WHERE id = ?",
    status, t, status, t, url || '', url || '', row.id);
  return db.get('SELECT * FROM identity_verifications WHERE id = ?', row.id);
};

/**
 * Opens a verification for a person. Returns { verification } (the record, with the link to follow when there is one), or
 * { error } when the provider could not be reached or is not set up. The reset is not changed by this call.
 */
async function start(user, purpose = 'password_reset', { actor = null, builtinOnly = false } = {}) {
  if (!PURPOSES.includes(purpose)) return { error: 'Unknown verification.' };
  const cfg = settings.get();
  let provider; let made;
  try {
    if (cfg.requirement.integrationId !== null && !builtinOnly) {
      provider = 'script';
      made = await scriptRun(cfg.requirement.integrationId, 'start', user, purpose);
    } else if (cfg.provider === 'persona') {
      provider = 'persona';
      made = { status: 'pending', ...(await personaCreate(cfg, user)) };
    } else if (cfg.provider === 'rest') {
      provider = 'rest';
      made = { status: 'pending', ...(await restCreate(cfg, user)) };
    } else {
      return { error: 'Identity verification is not set up.' };
    }
  } catch (e) {
    auditLog.user('identity.failure', { outcome: 'failure', actor: actor || auditLog.who(user), target: auditLog.who(user), detail: { purpose, step: 'start', error: e.message } });
    return { error: 'The verification could not be started. Try again later, or contact an administrator.' };
  }
  if (made.status === 'error') return { error: made.error };
  const id = Number(db.run('INSERT INTO identity_verifications (user_id, purpose, provider, ref, url, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    user.id, purpose, provider, made.ref || '', made.url || '', made.status || 'pending', now(), now()).lastInsertRowid);
  auditLog.user('identity.start', { outcome: 'success', actor: actor || auditLog.who(user), target: auditLog.who(user), detail: { purpose, provider } });
  return { verification: view(db.get('SELECT * FROM identity_verifications WHERE id = ?', id)) };
}

/**
 * Asks the provider for the latest status of a waiting verification, and records it. Returns the record, or { error }. `builtinOnly`
 * (set by the scripts' functions) leaves a script verification as it is, so a gate script that checks itself cannot run itself again.
 */
async function refresh(row, { builtinOnly = false } = {}) {
  if (!row || row.status !== 'pending') return row;
  if (builtinOnly && row.provider === 'script') return row;
  const cfg = settings.get();
  const user = db.get('SELECT * FROM users WHERE id = ?', row.user_id);
  let status;
  try {
    if (row.provider === 'script') {
      const r = await scriptRun(cfg.requirement.integrationId, 'check', user, row.purpose, row.ref);
      if (r.status === 'error') return { error: r.error };
      status = r.status;
    } else if (row.provider === 'persona') {
      status = await personaStatus(cfg, row.ref);
    } else if (row.provider === 'rest') {
      status = await restStatus(cfg, row.ref, user);
    } else {
      return row;
    }
  } catch (e) {
    return { error: 'The verification service did not answer. Try again in a moment.' };
  }
  if (status === row.status) return row;
  const updated = setStatus(row, status);
  auditLog.user('identity.result', { outcome: status === 'approved' ? 'success' : 'failure', actor: auditLog.who(user), target: auditLog.who(user), detail: { purpose: row.purpose, provider: row.provider, status } });
  return updated;
}

/** The latest verification for a person and purpose, refreshed once if it is still waiting. Returns the view, or null. */
async function current(userId, purpose, opts = {}) {
  let row = latest(userId, purpose);
  if (row && row.status === 'pending') {
    const r = await refresh(row, opts);
    if (!r.error) row = r;
  }
  return view(row);
}

/**
 * A webhook from a provider says something changed: the verification it names is checked again with the provider, which is the
 * only thing that can say whether it passed. Persona's signature is checked first; the REST address carries a token.
 */
function personaSignatureOk(rawBody, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(now() - t) > 300 || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return same(expected, parts.v1);
}

async function webhook(provider, { rawBody = '', header = '', token = '' }) {
  const cfg = settings.get();
  let ref = '';
  if (provider === 'persona') {
    if (cfg.provider !== 'persona' || !personaSignatureOk(rawBody, header, cfg.persona.webhookSecret)) return { ok: false };
    const m = /inq_[A-Za-z0-9]+/.exec(rawBody);
    ref = m ? m[0] : '';
  } else if (provider === 'rest') {
    if (cfg.provider !== 'rest' || !cfg.rest.webhookToken || !same(token, cfg.rest.webhookToken)) return { ok: false };
    if (cfg.rest.webhookSecret && !(header && same(header, cfg.rest.webhookSecret))) return { ok: false };
    try { ref = String(at(JSON.parse(rawBody), cfg.rest.webhookRefPath) || ''); } catch { return { ok: false }; }
  }
  const row = ref ? db.get('SELECT * FROM identity_verifications WHERE ref = ? AND provider = ? ORDER BY id DESC LIMIT 1', ref, provider) : null;
  if (row) await refresh(row);
  return { ok: true, matched: Boolean(row) };
}

module.exports = { start, refresh, current, latest, approvedFor, webhook, required, available, PURPOSES, view, personaSignatureOk, fill, headersOf, at };
