const crypto = require('crypto');
const { ENCRYPTION_ALGORITHMS } = require('../config');

// Decrypts <saml:EncryptedAssertion>: the inverse of src/saml/encrypt.js, for assertions that upstream IdPs encrypt to us.

const NS_ENC = 'http://www.w3.org/2001/04/xmlenc#';
const NS_ENC11 = 'http://www.w3.org/2009/xmlenc11#';

const child = (el, ns, name) => {
  for (let n = el && el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === name && n.namespaceURI === ns) return n;
  return null;
};
const cipherValue = (el) => {
  const cv = child(child(el, NS_ENC, 'CipherData'), NS_ENC, 'CipherValue');
  if (!cv) throw new Error('Encrypted data has no CipherValue.');
  return Buffer.from(cv.textContent.replace(/\s+/g, ''), 'base64');
};
const algorithmOf = (el) => {
  const m = child(el, NS_ENC, 'EncryptionMethod');
  return m ? m.getAttribute('Algorithm') : '';
};

const DATA = Object.fromEntries(Object.values(ENCRYPTION_ALGORITHMS).map((a) => [a.uri, a]));

// Only OAEP is accepted. PKCS#1 v1.5 key transport is vulnerable to padding-oracle attacks and is refused.
function oaepHash(method) {
  const alg = method.getAttribute('Algorithm');
  const digestEl = [...method.childNodes].find((n) => n.nodeType === 1 && n.localName === 'DigestMethod');
  const mgfEl = [...method.childNodes].find((n) => n.nodeType === 1 && n.localName === 'MGF');
  const digest = digestEl ? digestEl.getAttribute('Algorithm') : '';
  if (alg === `${NS_ENC}rsa-oaep-mgf1p`) {
    if (digest && digest !== 'http://www.w3.org/2000/09/xmldsig#sha1') throw new Error('Unsupported RSA-OAEP digest.');
    return 'sha1';
  }
  if (alg === `${NS_ENC11}rsa-oaep`) {
    const hashes = { 'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1', [`${NS_ENC}sha256`]: 'sha256', [`${NS_ENC}sha512`]: 'sha512' };
    const mgfs = { [`${NS_ENC11}mgf1sha1`]: 'sha1', [`${NS_ENC11}mgf1sha256`]: 'sha256', [`${NS_ENC11}mgf1sha512`]: 'sha512' };
    const hash = hashes[digest] || 'sha1';
    const mgf = mgfEl ? mgfs[mgfEl.getAttribute('Algorithm')] : 'sha1';
    // Node's RSA-OAEP uses one hash for both the digest and MGF1.
    if (hash !== mgf) throw new Error('Unsupported RSA-OAEP digest/MGF combination.');
    return hash;
  }
  throw new Error('Unsupported key transport algorithm.');
}

function unwrapKey(encryptedKey, privateKeyPem) {
  const method = child(encryptedKey, NS_ENC, 'EncryptionMethod');
  if (!method) throw new Error('EncryptedKey has no EncryptionMethod.');
  return crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: oaepHash(method) }, cipherValue(encryptedKey));
}

function decryptData(buf, alg, key) {
  if (key.length !== alg.keyBytes) throw new Error('Encryption key length does not match the algorithm.');
  if (alg.gcm) {
    if (buf.length < alg.ivBytes + 16) throw new Error('Encrypted data is too short.');
    const d = crypto.createDecipheriv(alg.cipher, key, buf.subarray(0, alg.ivBytes));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(alg.ivBytes, buf.length - 16)), d.final()]);
  }
  if (buf.length < 32 || buf.length % 16) throw new Error('Encrypted data is malformed.');
  const d = crypto.createDecipheriv(alg.cipher, key, buf.subarray(0, 16));
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(buf.subarray(16)), d.final()]);
  const pad = plain[plain.length - 1];
  if (!pad || pad > 16) throw new Error('Encrypted data has invalid padding.');
  return plain.subarray(0, plain.length - pad);
}

/**
 * Returns the XML text of the assertion inside `encryptedAssertion` (an EncryptedAssertion element).
 * `privateKeysPem` is one key or a list; during a key rollover the IdP may have encrypted to any of them.
 */
function decryptAssertion(encryptedAssertion, privateKeysPem) {
  const data = child(encryptedAssertion, NS_ENC, 'EncryptedData');
  if (!data) throw new Error('EncryptedAssertion has no EncryptedData.');
  const alg = DATA[algorithmOf(data)];
  if (!alg) throw new Error('Unsupported assertion encryption algorithm.');
  // The key is either inside the EncryptedData's KeyInfo or a sibling EncryptedKey (Shibboleth uses the latter).
  const ds = 'http://www.w3.org/2000/09/xmldsig#';
  const encryptedKey = child(child(data, ds, 'KeyInfo'), NS_ENC, 'EncryptedKey') || child(encryptedAssertion, NS_ENC, 'EncryptedKey');
  if (!encryptedKey) throw new Error('The assertion carries no encrypted key.');
  const cipher = cipherValue(data);
  for (const key of [].concat(privateKeysPem)) {
    try {
      return decryptData(cipher, alg, unwrapKey(encryptedKey, key)).toString('utf8');
    } catch (e) {
      if (/^(Unsupported|Encrypted|Encryption|The assertion)/.test(e.message)) throw e;
      // Wrong key for this message: try the next one.
    }
  }
  throw new Error('The assertion could not be decrypted with this service provider\'s key.');
}

module.exports = { decryptAssertion };
