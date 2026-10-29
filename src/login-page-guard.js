const crypto = require('crypto');
const db = require('./db');
const { baseUrl } = require('./config');
const settings = require('./settings');
const appSettings = require('./app-settings');
const auditLog = require('./audit');
const roles = require('./roles');
const groupMembership = require('./group-membership');
const messaging = require('./messaging');

// Makes it harder to copy the custom sign-in page for a look-alike phishing site, and tells administrators when someone tries.
// A browser has to receive the CSS to draw the page, so nothing here can make copying impossible. What it does:
//  - the template and CSS are never in public settings; they come from one endpoint that only answers the page's own script
//    (same-origin fetch from a live session), and it is rate limited;
//  - requests that look like scraping (cross-site, no browser headers, no session, too frequent) are refused and reported;
//  - the CSS carries a hidden beacon image with an absolute URL on this server and a per-install watermark. A copy of the
//    CSS that is hosted elsewhere loads the beacon from there, and the browser says which site it was on (the Referer).

const ownHost = () => new URL(baseUrl).host;
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

let secret;
const watermark = () => {
  if (!secret) secret = crypto.createHmac('sha256', `${settings.sessionSecret || db.get("SELECT value FROM settings WHERE key = 'session_secret'")?.value || 'idp'}`).update('login-page-watermark').digest('hex');
  return secret.slice(0, 16);
};
const beaconUrl = () => `${baseUrl}/api/login-page/beacon.gif?t=${watermark()}`;

/** Watermark and beacon rules, written with & so the page's CSS scoping nests them under .idp-login. */
function protectionCss() {
  return `&{--idp-wm:"${watermark()}"}&::after{content:"";position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;background-image:url("${beaconUrl()}")}`;
}

// Sliding window of recent fetches per IP; more than LIMIT in WINDOW looks like a crawler, not a person reloading.
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 30;
const hits = new Map();
function tooFrequent(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  return list.length > LIMIT;
}

/** Why a request for the sign-in page's CSS looks like a copy attempt, or '' when it looks like the page itself. */
function fetchSuspicion(req) {
  const site = req.get('sec-fetch-site');
  const from = hostOf(req.get('origin') || req.get('referer') || '');
  if (site && site !== 'same-origin') return `cross_site_fetch:${site}`;
  if (!site && from !== ownHost()) return 'not_a_browser_request';
  if (from && from !== ownHost()) return `foreign_origin:${from}`;
  const sent = Buffer.from(String(req.get('x-csrf-token') || ''));
  const want = Buffer.from(String(req.session && req.session.csrf || ''));
  if (!want.length || sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) return 'no_session';
  if (tooFrequent(req.ip)) return 'too_frequent';
  return '';
}

/** Users who hold any of the role ids, assigned directly or through a mapped Grouper group. Active, with an email. */
function usersWithRoles(roleIds) {
  if (!roleIds.length) return [];
  const want = new Set(roleIds);
  return db.all("SELECT id, username, email FROM users WHERE active = 1 AND email != ''").filter((u) => roles.effectiveRoleIds(u.id).some((r) => want.has(r)));
}

/** Users who are effective members of any of the groups, nested groups included. Active, with an email. */
function usersInGroups(groupIds) {
  if (!groupIds.length) return [];
  const members = new Set(groupIds.flatMap((g) => [...groupMembership.effectiveMembers(g)]));
  return db.all("SELECT id, username, email FROM users WHERE active = 1 AND email != ''").filter((u) => members.has(u.id));
}

/** Everyone to email about a copy attempt: the holders of the chosen roles and the members of the chosen groups, once each. */
function alertRecipients(cfg) {
  const byId = new Map([...usersWithRoles(cfg.notifyRoleIds), ...usersInGroups(cfg.notifyGroupIds)].map((u) => [u.id, u]));
  return [...byId.values()];
}

const lastAlert = new Map();

/**
 * Record a suspected copy attempt (always, in the audit log) and email the people holding the chosen roles. At most one email
 * per kind and source every cooldown, so a crawler cannot flood inboxes. Never throws.
 */
async function report(kind, req, detail = {}) {
  try {
    const cfg = appSettings.loginPageProtection();
    if (!cfg.enabled) return;
    const key = `${kind}:${detail.source || req.ip}`;
    const now = Date.now();
    if (now - (lastAlert.get(key) || 0) < cfg.cooldownMinutes * 60000) return;
    lastAlert.set(key, now);
    auditLog.system(`login_page.${kind}`, { outcome: 'failure', ip: req.ip, detail: { ...detail, userAgent: String(req.get('user-agent') || '').slice(0, 200) } });
    const recipients = alertRecipients(cfg);
    const text = `${appSettings.productName()} noticed what looks like an attempt to copy your custom sign-in page, which could be used to build a look-alike phishing site.\n\n`
      + `What happened: ${kind === 'clone_detected' ? 'the sign-in page CSS was loaded from another website' : 'the sign-in page CSS was requested in a way a normal visitor would not'}\n`
      + `Details: ${Object.entries(detail).map(([k, v]) => `${k}=${v}`).join(', ')}\nFrom IP: ${req.ip}\nTime: ${new Date().toISOString()}\n\n`
      + `Check Audit log → "login_page" events. If the site is not yours, report it to its host or registrar.`;
    for (const u of recipients) {
      await messaging.send('email', u.email, { subject: 'Possible copy of your sign-in page', text }, { rateKey: `loginpage-alert:${u.id}` })
        .catch((e) => auditLog.system('login_page.alert_failed', { outcome: 'failure', detail: { user: u.username, error: e.message } }));
    }
  } catch (e) {
    console.error('login page alert failed', e);
  }
}

module.exports = { protectionCss, fetchSuspicion, report, ownHost, hostOf, watermark, usersWithRoles, usersInGroups, alertRecipients };
