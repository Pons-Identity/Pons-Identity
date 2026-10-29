const crypto = require('crypto');
const db = require('./db');
const auditLog = require('./audit');

// RS256 signing for OpenID Connect ID tokens. One key for the whole IdP, created on first use and kept in the settings table.

let cached;

function loadKey() {
  if (cached) return cached;
  let row = db.get("SELECT value FROM settings WHERE key = 'oidc_signing_key'");
  if (!row) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('oidc_signing_key', ?)", privateKey.export({ type: 'pkcs8', format: 'pem' }));
    auditLog.system('oidc.key.generate');
    row = db.get("SELECT value FROM settings WHERE key = 'oidc_signing_key'");
  }
  const privateKey = crypto.createPrivateKey(row.value);
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  // RFC 7638 thumbprint, so the kid changes only if the key does.
  const kid = crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest('base64url');
  cached = { privateKey, jwk: { ...jwk, kid, use: 'sig', alg: 'RS256' }, kid };
  return cached;
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(payload) {
  const { privateKey, kid } = loadKey();
  const input = `${b64u({ alg: 'RS256', typ: 'JWT', kid })}.${b64u(payload)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** Returns the payload of a token we signed, or null. Expiry is not checked (logout accepts an expired id_token_hint). */
function verify(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (header.alg !== 'RS256') return null;
    const { privateKey } = loadKey();
    const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey(privateKey), Buffer.from(parts[2], 'base64url'));
    return ok ? JSON.parse(Buffer.from(parts[1], 'base64url')) : null;
  } catch {
    return null;
  }
}

const jwks = () => ({ keys: [loadKey().jwk] });

// Left half of the SHA-256 of the access token (at_hash), base64url.
const halfHash = (value) => crypto.createHash('sha256').update(value).digest().subarray(0, 16).toString('base64url');

module.exports = { sign, verify, jwks, halfHash };
