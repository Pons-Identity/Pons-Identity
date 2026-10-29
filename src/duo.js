const crypto = require('crypto');
const appSettings = require('./app-settings');

// Duo Auth API client (v5 request signing, HMAC-SHA512). https://duo.com/docs/authapi
// Duo is an optional second factor, configured in the admin console (or config.json / environment).

const enabled = () => appSettings.duo().enabled;

class DuoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// RFC 3986 encoding as Duo expects it: only unreserved characters stay literal, upper-case hex.
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha512Hex = (s) => crypto.createHash('sha512').update(s).digest('hex');

function sortedObject(params) {
  return Object.fromEntries(Object.keys(params).sort().map((k) => [k, params[k]]));
}

/**
 * Build the signed headers for one request. Exported (with an explicit date) so the
 * signing can be checked against the test vector in the Duo documentation.
 */
function sign({ method, host, path, params = {}, date, ikey, skey }) {
  const sorted = sortedObject(params);
  const query = method === 'GET' ? Object.entries(sorted).map(([k, v]) => `${encode(k)}=${encode(String(v))}`).join('&') : '';
  const body = method === 'GET' ? '' : JSON.stringify(sorted);
  const canonical = [
    date,
    method,
    host.toLowerCase(),
    path,
    query,
    sha512Hex(body),
    sha512Hex(''), // no X-Duo-* headers are signed
  ].join('\n');
  const signature = crypto.createHmac('sha512', skey).update(canonical).digest('hex');
  return {
    query,
    body,
    headers: {
      Date: date,
      Authorization: `Basic ${Buffer.from(`${ikey}:${signature}`).toString('base64')}`,
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    },
  };
}

async function call(method, path, params = {}, cfg = appSettings.duo(), timeoutMs = 0) {
  const host = cfg.apiHost;
  const s = sign({ method, host, path, params, date: new Date().toUTCString(), ikey: cfg.integrationKey, skey: cfg.secretKey });
  const url = `https://${host}${path}${s.query ? `?${s.query}` : ''}`;
  const res = await fetch(url, { method, headers: s.headers, body: method === 'GET' ? undefined : s.body, signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined });
  const json = await res.json().catch(() => ({ stat: 'FAIL', message: `HTTP ${res.status}` }));
  if (json.stat !== 'OK') throw new DuoError(json.code, json.message_detail ? `${json.message} (${json.message_detail})` : json.message);
  return json.response;
}

/** Check that the host and integration/secret keys are accepted by Duo, without signing anyone in. */
const check = (cfg) => call('GET', '/auth/v2/check', {}, cfg, 10000);

/**
 * Ask Duo what to do for this user. result: 'auth' | 'allow' | 'deny' | 'enroll'. We say we support Verified Duo Push, so when
 * Duo requires it the answer carries txid, verification_code (the number the person matches in the Duo app) and expiration.
 */
const preauth = (username, ipaddr) => call('POST', '/auth/v2/preauth', { username, ipaddr, client_supports_verified_push: '1' });

/** Start a Duo Push without waiting for the phone. `txid` is the Verified Push transaction from preauth, when there is one. Returns { txid }. */
const startPush = (username, ipaddr, txid) => call('POST', '/auth/v2/auth', {
  username, factor: 'push', device: 'auto', async: '1', ipaddr, ...(txid ? { txid } : {}),
});

/** Check a passcode synchronously. Returns { result: 'allow' | 'deny', status }. */
const checkPasscode = (username, passcode, ipaddr) => call('POST', '/auth/v2/auth', { username, factor: 'passcode', passcode, ipaddr });

/** Long-poll an async transaction. Returns { result: 'waiting' | 'allow' | 'deny', status }. */
async function pollPush(txid) {
  try {
    return await call('GET', '/auth/v2/auth_status', { txid });
  } catch (e) {
    // 40002 is also what a long-poll timeout looks like; treat it as "still waiting".
    if (e.code === 40002) return { result: 'waiting' };
    throw e;
  }
}

module.exports = { enabled, check, preauth, startPush, checkPasscode, pollPush, sign, DuoError };
