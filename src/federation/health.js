const appSettings = require('../app-settings');
const { certInfo } = require('../saml/encrypt');
const metadata = require('./metadata-source');

// What an administrator needs to hear about before the federation breaks: metadata that has stopped refreshing, trust
// anchors and keys that are about to expire, and a key rollover that is half done.

const DAY = 86400000;
const HOUR = 3600000;
const when = (ms) => new Date(ms).toISOString().slice(0, 10);
const time = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t; };

function sourceAlerts(s, now) {
  const out = [];
  const add = (severity, code, detail) => out.push({ severity, code, title: s.name, detail, ref: `source:${s.id}` });
  const until = time(s.valid_until);
  const failing = Boolean(s.last_error);

  if (until !== null && until <= now) {
    add('error', 'source-expired', `The metadata expired on ${when(until)}. Its entities are no longer trusted, so sign-in through them has stopped. ${failing ? `Last refresh error: ${s.last_error}` : 'Refresh it.'}`);
  } else if (failing) {
    const soon = until !== null && until - now < DAY;
    add(soon ? 'error' : 'warning', 'source-refresh-failed',
      s.kind === 'mdq'
        ? `The last lookup failed: ${s.last_error}. Entities already cached keep being used until they expire.`
        : `The last refresh failed: ${s.last_error}. The previous copy is still in use${until !== null ? ` until ${when(until)}` : ''}.`);
  } else if (s.kind === 'mdq') {
    // Queried on demand: there is no schedule to fall behind, only lookups that fail.
  } else if (s.enabled && !s.last_success_at) {
    add('warning', 'source-never-fetched', 'This source has not been downloaded yet.');
  } else if (s.enabled && s.last_success_at) {
    const last = time(`${s.last_success_at.replace(' ', 'T')}${/Z$/.test(s.last_success_at) ? '' : 'Z'}`);
    if (last !== null && now - last > Math.max(3 * s.refresh_hours * HOUR, DAY)) {
      add('warning', 'source-stale', `It has not been refreshed since ${when(last)}, longer than its ${s.refresh_hours}-hour interval allows. Is the server running continuously?`);
    }
  }

  const certEnd = s.signing_cert ? time(s.signing_cert.notAfter) : null;
  if (certEnd !== null) {
    const left = certEnd - now;
    if (left <= 0) add('error', 'source-cert-expired', `The pinned signing certificate expired on ${when(certEnd)}. Upload the federation's current certificate.`);
    else if (left < 14 * DAY) add('error', 'source-cert-expiring', `The pinned signing certificate expires on ${when(certEnd)}. Upload the federation's new certificate before then.`);
    else if (left < 60 * DAY) add('warning', 'source-cert-expiring', `The pinned signing certificate expires on ${when(certEnd)}. Watch for the federation's replacement.`);
  }
  return out;
}

function keyAlerts(label, keys, now, ref) {
  const out = [];
  if (!keys) return out;
  for (const use of ['signing', 'encryption']) {
    const end = time(certInfo(keys[use].certPem).notAfter);
    const left = end - now;
    if (left < 30 * DAY) {
      out.push({ severity: 'error', code: 'key-expiring', title: label, ref, detail: `The ${use} certificate ${left <= 0 ? 'expired' : 'expires'} on ${when(end)}. Roll the key now: stage a new one, wait for the federation to publish it, then activate it.` });
    } else if (left < 90 * DAY) {
      out.push({ severity: 'warning', code: 'key-expiring', title: label, ref, detail: `The ${use} certificate expires on ${when(end)}. Start a key rollover soon; the federation can take days to publish a new key.` });
    }
  }
  if (keys.next) {
    out.push({ severity: 'info', code: 'key-staged', title: label, ref, detail: 'A new key is staged and published in metadata. Activate it once the federation has published your updated metadata.' });
  }
  if (keys.previous) {
    out.push({ severity: 'info', code: 'key-previous', title: label, ref, detail: 'The previous key is still published. Retire it once the federation no longer needs it.' });
  }
  return out;
}

/** All current alerts, most severe first. */
function alerts(now = Date.now()) {
  const out = metadata.list().flatMap((s) => sourceAlerts(s, now));
  if (appSettings.federationIdp().enabled) out.push(...keyAlerts('Federation identity keys', appSettings.federationKeys(), now, 'idp'));
  if (appSettings.federationSp().enabled) out.push(...keyAlerts('Federation service provider keys', appSettings.federationSpKeys(), now, 'sp'));
  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

module.exports = { alerts };
