const { baseUrl } = require('./settings');

const NAMEID_FORMATS = {
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  emailAddress: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
};

const SIGNATURE_ALGORITHMS = {
  sha1: {
    label: 'RSA-SHA1 (legacy)',
    signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
  },
  sha256: {
    label: 'RSA-SHA256',
    signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
  },
  sha384: {
    label: 'RSA-SHA384',
    signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
    digest: 'http://www.w3.org/2001/04/xmldsig-more#sha384',
  },
  sha512: {
    label: 'RSA-SHA512',
    signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
    digest: 'http://www.w3.org/2001/04/xmlenc#sha512',
  },
};

const XENC = 'http://www.w3.org/2001/04/xmlenc#';

// Block ciphers for the assertion (xenc:EncryptedData). CBC uses a random IV prefix; GCM appends the tag.
const ENCRYPTION_ALGORITHMS = {
  'aes128-cbc': { label: 'AES-128-CBC', uri: `${XENC}aes128-cbc`, cipher: 'aes-128-cbc', keyBytes: 16, ivBytes: 16 },
  'aes192-cbc': { label: 'AES-192-CBC', uri: `${XENC}aes192-cbc`, cipher: 'aes-192-cbc', keyBytes: 24, ivBytes: 16 },
  'aes256-cbc': { label: 'AES-256-CBC', uri: `${XENC}aes256-cbc`, cipher: 'aes-256-cbc', keyBytes: 32, ivBytes: 16 },
  'aes128-gcm': { label: 'AES-128-GCM', uri: 'http://www.w3.org/2009/xmlenc11#aes128-gcm', cipher: 'aes-128-gcm', keyBytes: 16, ivBytes: 12, gcm: true },
  'aes192-gcm': { label: 'AES-192-GCM', uri: 'http://www.w3.org/2009/xmlenc11#aes192-gcm', cipher: 'aes-192-gcm', keyBytes: 24, ivBytes: 12, gcm: true },
  'aes256-gcm': { label: 'AES-256-GCM', uri: 'http://www.w3.org/2009/xmlenc11#aes256-gcm', cipher: 'aes-256-gcm', keyBytes: 32, ivBytes: 12, gcm: true },
};

// How the symmetric key is wrapped for the SP's public key (xenc:EncryptedKey).
const KEY_TRANSPORT_ALGORITHMS = {
  'rsa-oaep-mgf1p': {
    label: 'RSA-OAEP (SHA-1, MGF1-SHA1)',
    uri: `${XENC}rsa-oaep-mgf1p`,
    oaepHash: 'sha1',
    digestUri: 'http://www.w3.org/2000/09/xmldsig#sha1',
  },
  'rsa-oaep-sha256': {
    label: 'RSA-OAEP (SHA-256, MGF1-SHA256)',
    uri: 'http://www.w3.org/2009/xmlenc11#rsa-oaep',
    oaepHash: 'sha256',
    digestUri: `${XENC}sha256`,
    mgfUri: 'http://www.w3.org/2009/xmlenc11#mgf1sha256',
  },
};

function spUrls(id) {
  const metadata = `${baseUrl}/saml/${id}/metadata`;
  return {
    metadata,
    entityId: metadata,
    sso: `${baseUrl}/saml/${id}/sso`,
    slo: `${baseUrl}/saml/${id}/slo`,
    idpInitiated: `${baseUrl}/saml/${id}/init`,
  };
}

module.exports = { baseUrl, NAMEID_FORMATS, SIGNATURE_ALGORITHMS, ENCRYPTION_ALGORITHMS, KEY_TRANSPORT_ALGORITHMS, spUrls };
