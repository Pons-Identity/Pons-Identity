const db = require('../db');
const sps = require('../sps');
const auditLog = require('../audit');
const { buildLogoutRequest, buildLogoutResponse } = require('./response');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Build a hidden-iframe POST for each SP (other than `skipSpId`) that has an SLO URL and an active SSO session.
function propagation(sid, skipSpId) {
  const rows = db.all('SELECT * FROM sso_sessions WHERE sid = ?', sid);
  const targets = [];
  for (const r of rows) {
    if (r.sp_id === skipSpId) continue;
    const sp = sps.getSp(r.sp_id);
    if (!sp || !sp.slo_url) continue;
    const xml = buildLogoutRequest({ sp, nameId: r.name_id, nameIdFormat: r.name_id_format, sessionIndex: r.session_index });
    targets.push({ url: sp.slo_url, name: sp.name, samlRequest: b64(xml) });
  }
  return targets;
}

function finish(req, res, { skipSpId, final, message, kind, sp, redirectTo }) {
  const sid = req.sessionID;
  const targets = propagation(sid, skipSpId);
  // Only a signed-in session counts as a sign-out; recorded before the session is destroyed.
  if (req.session && req.session.userId) {
    auditLog.user(kind === 'sp' ? 'slo.sp_initiated' : 'logout', { req, target: sp && { type: 'service_provider', id: sp.id, name: sp.name },
      detail: { propagatedTo: targets.map((t) => t.name) } });
  }
  db.run('DELETE FROM sso_sessions WHERE sid = ?', sid);
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    // Nobody to notify: go straight back to the application that asked for the sign-out.
    if (redirectTo && !targets.length) return res.redirect(redirectTo);
    res.render('logout', { targets, final: final || null, message, redirectTo: redirectTo || null });
  });
}

function idpInitiated(req, res, { redirectTo } = {}) {
  finish(req, res, { message: 'You have been signed out.', kind: 'idp', redirectTo });
}

// SP sent us a LogoutRequest (already validated). Respond to the requesting SP once other SPs are notified.
function spInitiated(req, res, { sp, logoutRequest, relayState }) {
  const xml = buildLogoutResponse({ sp, inResponseTo: logoutRequest.id });
  const final = sp.slo_url
    ? { url: sp.slo_url, samlResponse: b64(xml), relayState: relayState || '' }
    : null;
  finish(req, res, { skipSpId: sp.id, final, message: 'You have been signed out.', kind: 'sp', sp });
}

module.exports = { idpInitiated, spInitiated };
