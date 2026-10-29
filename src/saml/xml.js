const crypto = require('crypto');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { SIGNATURE_ALGORITHMS } = require('../config');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const newId = () => `_${crypto.randomBytes(16).toString('hex')}`;
const isoTime = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');

const local = (name) => `*[local-name(.)='${name}']`;

// Enveloped signature over `rootName` (Response, Assertion, LogoutRequest, ...), placed right after its Issuer.
function signElement(xml, { rootXpath, issuerXpath, sp }) {
  const alg = SIGNATURE_ALGORITHMS[sp.signature_algorithm] || SIGNATURE_ALGORITHMS.sha256;
  const sig = new SignedXml({
    privateKey: sp.private_key_pem,
    publicCert: sp.cert_pem,
    signatureAlgorithm: alg.signature,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: rootXpath,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: alg.digest,
  });
  sig.computeSignature(xml, { location: { reference: issuerXpath, action: 'after' }, prefix: 'ds' });
  return sig.getSignedXml();
}

function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTDs are not allowed in SAML messages.');
  const errors = [];
  const doc = new DOMParser({ onError: (lvl, msg) => { if (lvl !== 'warning') errors.push(msg); } })
    .parseFromString(xml, 'text/xml');
  if (errors.length || !doc.documentElement) throw new Error('Malformed XML.');
  return doc;
}

module.exports = { esc, newId, isoTime, local, signElement, parseXml };
