const crypto = require('crypto');
const forge = require('node-forge');

function generateKeyAndCert(commonName, { altNames = [], days = 3650 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(pubPem);
  cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: commonName }, { name: 'organizationName', value: 'Pons Identity' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    ...(altNames.length ? [
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: altNames.map((v) => (/^[\d.]+$|:/.test(v) ? { type: 7, ip: v } : { type: 2, value: v })),
      },
    ] : []),
  ]);
  cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  return { keyPem, certPem: forge.pki.certificateToPem(cert) };
}

function fingerprints(certPem) {
  const x = new crypto.X509Certificate(certPem);
  return { sha1: x.fingerprint, sha256: x.fingerprint256, notAfter: x.validTo };
}

// Base64 DER body, as embedded in <ds:X509Certificate>
function certBody(certPem) {
  return certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Same format as hashPassword, but scrypt runs on the thread pool so hashing many passwords (bulk imports) does not
// stall every other request.
async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (e, k) => (e ? reject(e) : resolve(k))));
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// scrypt on the thread pool, a few at a time. The synchronous verifyPassword holds up every other request while it runs, so
// anything an unauthenticated visitor can trigger uses this instead. Hashes past the queue limit are refused, not queued without end.
const MAX_CONCURRENT_HASHES = 3;
const MAX_QUEUED_HASHES = 100;
let hashing = 0;
const waiting = [];

class BusyError extends Error {}

function slot() {
  if (hashing < MAX_CONCURRENT_HASHES) { hashing++; return Promise.resolve(); }
  if (waiting.length >= MAX_QUEUED_HASHES) return Promise.reject(new BusyError('Too many password checks are waiting.'));
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next(); else hashing--;
}

/** verifyPassword without blocking the event loop. Resolves false for a missing or malformed stored hash. */
async function verifyPasswordAsync(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  await slot();
  try {
    const actual = await new Promise((resolve, reject) => crypto.scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, (e, k) => (e ? reject(e) : resolve(k))));
    return crypto.timingSafeEqual(actual, expected);
  } finally {
    release();
  }
}

// A real hash of a random password nobody has. Checking a password against it takes as long as checking against a real account,
// so a sign-in for a name that does not exist (or is switched off) cannot be told apart by how long the answer takes.
let dummyHash;
const dummyPasswordHash = () => { dummyHash = dummyHash || hashPassword(crypto.randomBytes(24).toString('base64url')); return dummyHash; };

module.exports = { generateKeyAndCert, fingerprints, certBody, hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync, dummyPasswordHash, BusyError };
