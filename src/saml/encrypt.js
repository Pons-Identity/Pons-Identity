const crypto = require('crypto');
const { ENCRYPTION_ALGORITHMS, KEY_TRANSPORT_ALGORITHMS } = require('../config');
const { certBody } = require('../crypto');

const NS_ENC = 'http://www.w3.org/2001/04/xmlenc#';

// XML Encryption block padding: pad to the block size, with the last byte holding the pad length.
function pkcs(buf) {
  const n = 16 - (buf.length % 16);
  return Buffer.concat([buf, crypto.randomBytes(n - 1), Buffer.from([n])]);
}

function encryptData(plaintext, alg, key) {
  const iv = crypto.randomBytes(alg.ivBytes);
  const cipher = crypto.createCipheriv(alg.cipher, key, iv);
  if (alg.gcm) {
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]);
  }
  cipher.setAutoPadding(false);
  return Buffer.concat([iv, cipher.update(pkcs(Buffer.from(plaintext, 'utf8'))), cipher.final()]);
}

/**
 * Wrap a signed Assertion's XML as <saml:EncryptedAssertion>, encrypted for the SP's certificate.
 * sp: { encryption_cert_pem, encryption_algorithm, key_transport_algorithm }
 */
function encryptAssertion(assertionXml, sp) {
  const alg = ENCRYPTION_ALGORITHMS[sp.encryption_algorithm] || ENCRYPTION_ALGORITHMS['aes256-cbc'];
  const kt = KEY_TRANSPORT_ALGORITHMS[sp.key_transport_algorithm] || KEY_TRANSPORT_ALGORITHMS['rsa-oaep-mgf1p'];
  const key = crypto.randomBytes(alg.keyBytes);
  const publicKey = new crypto.X509Certificate(sp.encryption_cert_pem).publicKey;

  const wrapped = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: kt.oaepHash }, key);
  const data = encryptData(assertionXml, alg, key);

  const digest = `<ds:DigestMethod Algorithm="${kt.digestUri}"/>`;
  const mgf = kt.mgfUri ? `<xenc11:MGF xmlns:xenc11="http://www.w3.org/2009/xmlenc11#" Algorithm="${kt.mgfUri}"/>` : '';
  return `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">`
    + `<xenc:EncryptedData xmlns:xenc="${NS_ENC}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Type="${NS_ENC}Element">`
    + `<xenc:EncryptionMethod Algorithm="${alg.uri}"/>`
    + `<ds:KeyInfo><xenc:EncryptedKey>`
    + `<xenc:EncryptionMethod Algorithm="${kt.uri}">${digest}${mgf}</xenc:EncryptionMethod>`
    + `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(sp.encryption_cert_pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`
    + `<xenc:CipherData><xenc:CipherValue>${wrapped.toString('base64')}</xenc:CipherValue></xenc:CipherData>`
    + `</xenc:EncryptedKey></ds:KeyInfo>`
    + `<xenc:CipherData><xenc:CipherValue>${data.toString('base64')}</xenc:CipherValue></xenc:CipherData>`
    + `</xenc:EncryptedData></saml:EncryptedAssertion>`;
}

// Normalize an uploaded certificate (PEM, or bare base64 DER) to PEM. Throws if it is not an RSA certificate.
function normalizeCertificate(text) {
  const body = String(text || '').replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!body) throw new Error('Certificate is empty.');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  let x;
  try {
    x = new crypto.X509Certificate(pem);
  } catch {
    throw new Error('Encryption certificate is not a valid X.509 certificate (PEM or base64 DER).');
  }
  if (x.publicKey.asymmetricKeyType !== 'rsa') throw new Error('Encryption certificate must contain an RSA public key.');
  return pem;
}

function certInfo(pem) {
  if (!pem) return null;
  const x = new crypto.X509Certificate(pem);
  return { subject: x.subject.replace(/\n/g, ', '), notAfter: x.validTo, sha256: x.fingerprint256 };
}

module.exports = { encryptAssertion, normalizeCertificate, certInfo };
