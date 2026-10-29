const db = require('./db');
const appSettings = require('./app-settings');
const roles = require('./roles');
const { CREDENTIAL_REASONS } = require('./authlog');
const gm = require('./group-membership');

// Risk-based sign-in. After the password is right, the sign-in is scored from the account's own history in the sign-in log and
// from what is known about this request. The score is the sum of the weights of the signals that fire; it falls in a level
// (low, medium, high), and each level can lead to an action: nothing, a required second factor, only phishing-resistant
// factors, only security keys, or a refusal. Administrators set the global actions; a policy can only make them stricter.
//
// Signals fire only when there is something to compare with: a person's first sign-ins never look "new". The sensitive-group
// signal is the exception: it is about who the person is, so it counts from the first sign-in. A client-supplied browser
// location can raise the score but never lowers it. Modes: 'off' does nothing, 'report' scores and logs what would have
// happened, 'enforce' acts.

const KEY = 'risk';
const SIGNALS = ['spray', 'impossible_travel', 'new_device', 'new_country', 'country_mismatch', 'new_asn', 'device_geo', 'sensitive_group'];
const MAX_GROUPS = 50;
const ACTIONS = ['allow', 'require_mfa', 'phishing_resistant', 'webauthn_only', 'block'];
const MODES = ['off', 'report', 'enforce'];

const DEFAULTS = {
  mode: 'off',
  windowMinutes: 30,
  historyDays: 180,
  medium: 30,
  high: 60,
  actions: { medium: 'allow', high: 'allow' },
  signals: {
    spray: { enabled: true, weight: 50, ipUsernames: 5, asnUsernames: 15, accountIps: 5 },
    impossible_travel: { enabled: true, weight: 60, maxSpeedKmh: 900, minDistanceKm: 100 },
    new_device: { enabled: true, weight: 20 },
    new_country: { enabled: true, weight: 25 },
    country_mismatch: { enabled: true, weight: 15 },
    new_asn: { enabled: true, weight: 15 },
    device_geo: { enabled: false, weight: 30, maxDistanceKm: 300 },
    sensitive_group: { enabled: true, weight: 30, groups: [] },
  },
};

const merge = (base, saved) => Object.fromEntries(Object.keys(base).map((k) => [k,
  base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], (saved || {})[k]) : ((saved || {})[k] ?? base[k])]));
const get = () => merge(DEFAULTS, appSettings.read(KEY));

// The groups a signal is set for: a list of group ids, each a whole number. Groups that have been deleted are dropped on use.
function groupIds(v, sig, errors) {
  if (v === undefined || v === null || v === '') return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.length > MAX_GROUPS || list.some((g) => !Number.isInteger(Number(g)) || Number(g) < 1)) {
    errors.push(`${sig}: choose up to ${MAX_GROUPS} groups.`);
    return [];
  }
  return [...new Set(list.map(Number))];
}

function parse(body) {
  const errors = [];
  const out = merge(DEFAULTS, {});
  const num = (v, label, min, max, dflt) => {
    const n = v === '' || v === undefined || v === null ? dflt : Number(v);
    if (!Number.isFinite(n) || n < min || n > max) { errors.push(`${label} must be a number from ${min} to ${max}.`); return dflt; }
    return n;
  };
  out.mode = MODES.includes(body.mode) ? body.mode : 'off';
  out.windowMinutes = num(body.windowMinutes, 'The spray window (minutes)', 1, 1440, DEFAULTS.windowMinutes);
  out.historyDays = num(body.historyDays, 'History (days)', 1, 3650, DEFAULTS.historyDays);
  out.medium = num(body.medium, 'The medium threshold', 1, 100, DEFAULTS.medium);
  out.high = num(body.high, 'The high threshold', 1, 100, DEFAULTS.high);
  if (out.high <= out.medium) errors.push('The high threshold must be above the medium threshold.');
  for (const lvl of ['medium', 'high']) out.actions[lvl] = ACTIONS.includes((body.actions || {})[lvl]) ? body.actions[lvl] : 'allow';
  for (const sig of SIGNALS) {
    const b = (body.signals || {})[sig] || {};
    const o = out.signals[sig];
    o.enabled = Boolean(b.enabled);
    o.weight = num(b.weight, `The weight of ${sig}`, 0, 100, DEFAULTS.signals[sig].weight);
    if (Array.isArray(DEFAULTS.signals[sig].groups)) o.groups = groupIds(b.groups, sig, errors);
    for (const k of Object.keys(o).filter((x) => !['enabled', 'weight', 'groups'].includes(x))) o[k] = num(b[k], `${sig}: ${k}`, 1, 100000, DEFAULTS.signals[sig][k]);
  }
  return { data: out, errors };
}
const save = (d) => appSettings.write(KEY, d);

/* ------------------------------------ Scoring ----------------------------------- */

const rad = (d) => (d * Math.PI) / 180;
function km(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const hasPlace = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat !== null && p.lon !== null;

// The profile "country" is free text. Understand a two-letter code or the country's name as the place already says it.
function profileCountryMatches(profile, geo) {
  const p = String(profile || '').trim();
  if (!p || !geo.country) return null;
  if (/^[A-Za-z]{2}$/.test(p)) return p.toUpperCase() === geo.country;
  if (geo.country_name) return p.toLowerCase() === geo.country_name.toLowerCase();
  return null;
}

/**
 * Scores a sign-in. `ctx`: { ip, geo ({country, country_name, lat, lon, asn}), deviceId, deviceGeo ({lat, lon}), now }.
 * Returns { score, level, reasons: [{ code, weight, detail }] }.
 */
function assess(user, ctx, cfg = get()) {
  const now = ctx.now || Math.floor(Date.now() / 1000);
  const geo = ctx.geo || {};
  const history = db.all(`SELECT ts, country, asn, device_id, lat, lon FROM auth_events WHERE user_id = ? AND type = 'signin' AND outcome = 'success' AND ts >= ?
                          ORDER BY ts DESC LIMIT 500`, user.id, now - cfg.historyDays * 86400);
  const seen = history.length > 0;
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, weight: cfg.signals[code].weight, detail });
  const on = (code) => cfg.signals[code].enabled;

  if (on('spray')) {
    const s = cfg.signals.spray;
    const since = now - cfg.windowMinutes * 60;
    const cred = [...CREDENTIAL_REASONS].map(() => '?').join(',');
    const base = `FROM auth_events WHERE type = 'password' AND outcome = 'failure' AND reason IN (${cred}) AND ts >= ?`;
    const creds = [...CREDENTIAL_REASONS];
    const byIp = ctx.ip ? db.get(`SELECT COUNT(DISTINCT username) AS n ${base} AND ip = ?`, ...creds, since, ctx.ip).n : 0;
    const byAsn = geo.asn ? db.get(`SELECT COUNT(DISTINCT username) AS n ${base} AND asn = ?`, ...creds, since, geo.asn).n : 0;
    const byAccount = db.get(`SELECT COUNT(DISTINCT ip) AS n ${base} AND username = ? COLLATE NOCASE`, ...creds, since, user.username).n;
    if (byIp >= s.ipUsernames) add('spray', `${byIp} different accounts failed from this address in ${cfg.windowMinutes} minutes`);
    else if (byAsn >= s.asnUsernames) add('spray', `${byAsn} different accounts failed from this network in ${cfg.windowMinutes} minutes`);
    else if (byAccount >= s.accountIps) add('spray', `this account failed from ${byAccount} different addresses in ${cfg.windowMinutes} minutes`);
  }

  if (on('impossible_travel') && hasPlace(geo)) {
    const last = history.find(hasPlace);
    if (last) {
      const dist = km(last, geo);
      const hours = Math.max((now - last.ts) / 3600, 1 / 60); // a minute at least, so two sign-ins at once do not divide by zero
      const speed = dist / hours;
      const s = cfg.signals.impossible_travel;
      if (dist >= s.minDistanceKm && speed > s.maxSpeedKmh) add('impossible_travel', `${Math.round(dist)} km from the last sign-in ${Math.round(hours * 10) / 10} hours ago (${Math.round(speed)} km/h)`);
    }
  }

  if (on('new_device') && seen && !history.some((h) => h.device_id && h.device_id === ctx.deviceId)) add('new_device', 'this browser has not signed in to this account before');
  if (on('new_country') && seen && geo.country && !history.some((h) => h.country === geo.country)) add('new_country', `first sign-in from ${geo.country_name || geo.country}`);
  if (on('new_asn') && seen && geo.asn && !history.some((h) => h.asn === geo.asn)) add('new_asn', `first sign-in from network AS${geo.asn}${geo.asn_org ? ` (${geo.asn_org})` : ''}`);
  if (on('country_mismatch') && profileCountryMatches(user.country, geo) === false) add('country_mismatch', `the profile says ${user.country} but the address is in ${geo.country_name || geo.country}`);

  if (on('device_geo') && hasPlace(ctx.deviceGeo) && hasPlace(geo)) {
    const d = km(ctx.deviceGeo, geo);
    if (d > cfg.signals.device_geo.maxDistanceKm) add('device_geo', `the device reports a location ${Math.round(d)} km from the address's`);
  }

  // Membership counts through nested groups, so putting a group inside the C-suite group is enough.
  if (on('sensitive_group') && cfg.signals.sensitive_group.groups.length) {
    const chosen = new Set(cfg.signals.sensitive_group.groups);
    const names = gm.effectiveGroupsOf(user.id, now).filter((g) => chosen.has(g.id)).map((g) => g.name);
    if (names.length) add('sensitive_group', `a member of ${names.join(', ')}`);
  }

  const score = Math.min(100, reasons.reduce((n, r) => n + r.weight, 0));
  return { score, level: score >= cfg.high ? 'high' : score >= cfg.medium ? 'medium' : 'low', reasons };
}

/* ------------------------------------ Actions ----------------------------------- */

const strictest = (...xs) => xs.filter(Boolean).reduce((a, b) => (ACTIONS.indexOf(b) > ACTIONS.indexOf(a) ? b : a), 'allow');

/** The action for a level, from the global settings and the person's policies (strictest wins). A high level also carries the medium action. */
function actionFor(level, policy, cfg = get()) {
  if (level === 'low') return 'allow';
  const fromPolicy = [policy.riskMediumAction, ...(level === 'high' ? [policy.riskHighAction] : [])];
  return strictest(cfg.actions.medium, ...(level === 'high' ? [cfg.actions.high] : []), ...fromPolicy);
}

/**
 * What an action means for the second step: { block, forceMfa, extra } where extra narrows the usable factors the way
 * factors.eligible expects. Administrators are never refused outright (a risk score must not lock out the people who fix
 * things): a block becomes "security keys only", and the sign-in code relaxes the narrowing if it would leave them nothing.
 */
function restriction(action, user) {
  const admin = roles.permissionsOf(user.id).size > 0;
  const a = action === 'block' && admin ? 'webauthn_only' : action;
  return {
    admin,
    block: a === 'block',
    forceMfa: a !== 'allow',
    extra: a === 'phishing_resistant' ? { phishingResistant: true } : a === 'webauthn_only' ? { allowed: ['webauthn'] } : {},
    narrows: a === 'phishing_resistant' || a === 'webauthn_only',
  };
}

module.exports = { get, parse, save, assess, actionFor, restriction, strictest, km, DEFAULTS, ACTIONS, MODES, SIGNALS };
