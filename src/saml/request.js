const zlib = require('zlib');
const crypto = require('crypto');
const { SignedXml } = require('xml-crypto');
const { parseXml } = require('./xml');

const MAX = 1024 * 1024;

// Decode a SAMLRequest/SAMLResponse from HTTP-Redirect (deflate) or HTTP-POST (plain base64).
function decodeMessage(raw, binding) {
  if (typeof raw !== 'string' || !raw) throw new Error('Missing SAML message.');
  const buf = Buffer.from(raw, 'base64');
  if (binding === 'redirect') return zlib.inflateRawSync(buf, { maxOutputLength: MAX }).toString('utf8');
  if (buf.length > MAX) throw new Error('SAML message too large.');
  return buf.toString('utf8');
}

function firstChild(el, name) {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === name) return n;
  return null;
}

function parseAuthnRequest(xml) {
  const root = parseXml(xml).documentElement;
  if (root.localName !== 'AuthnRequest') throw new Error('Expected an AuthnRequest.');
  const issuer = firstChild(root, 'Issuer');
  return {
    id: root.getAttribute('ID'),
    issuer: issuer ? issuer.textContent.trim() : '',
    acsUrl: root.getAttribute('AssertionConsumerServiceURL') || '',
    forceAuthn: root.getAttribute('ForceAuthn') === 'true' || root.getAttribute('ForceAuthn') === '1',
    isPassive: root.getAttribute('IsPassive') === 'true' || root.getAttribute('IsPassive') === '1',
  };
}

function parseLogoutRequest(xml) {
  const root = parseXml(xml).documentElement;
  if (root.localName !== 'LogoutRequest') throw new Error('Expected a LogoutRequest.');
  const issuer = firstChild(root, 'Issuer');
  const nameId = firstChild(root, 'NameID');
  const si = firstChild(root, 'SessionIndex');
  return {
    id: root.getAttribute('ID'),
    issuer: issuer ? issuer.textContent.trim() : '',
    nameId: nameId ? nameId.textContent.trim() : '',
    sessionIndex: si ? si.textContent.trim() : '',
    issueInstant: root.getAttribute('IssueInstant') || '',
  };
}

const REDIRECT_SIG_ALGS = {
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384': 'sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'sha512',
};

// HTTP-Redirect: the signature covers the raw, still-encoded query parameters in a fixed order (SAML bindings 3.4.4.1).
function verifyRedirectSignature(rawQuery, param, certPem) {
  const parts = Object.fromEntries(String(rawQuery || '').split('&').map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
  }));
  if (!parts.Signature || !parts.SigAlg) throw new Error('The request is not signed.');
  const alg = REDIRECT_SIG_ALGS[decodeURIComponent(parts.SigAlg)];
  if (!alg) throw new Error('Unsupported request signature algorithm.');
  const signed = [`${param}=${parts[param]}`];
  if (parts.RelayState !== undefined) signed.push(`RelayState=${parts.RelayState}`);
  signed.push(`SigAlg=${parts.SigAlg}`);
  const sig = Buffer.from(decodeURIComponent(parts.Signature), 'base64');
  if (!crypto.verify(alg, Buffer.from(signed.join('&')), new crypto.X509Certificate(certPem).publicKey, sig)) {
    throw new Error('Request signature is invalid.');
  }
}

// HTTP-POST: an enveloped XML signature that must reference the request element itself.
function verifyPostSignature(xml, certPem) {
  const root = parseXml(xml).documentElement;
  const sigs = [];
  for (let n = root.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === 'Signature') sigs.push(n);
  if (sigs.length !== 1) throw new Error('The request is not signed.');
  const sig = new SignedXml({ publicCert: certPem });
  sig.loadSignature(sigs[0]);
  const refs = sig.getReferences();
  if (refs.length !== 1 || refs[0].uri !== `#${root.getAttribute('ID')}`) {
    throw new Error('The request signature does not cover the request.');
  }
  if (!sig.checkSignature(xml)) throw new Error('Request signature is invalid.');
}

/**
 * Verify a signed request against the SP's registered signing certificate. Throws if it is unsigned or invalid.
 * `binding` is 'redirect' or 'post'; for redirect pass the raw query string and the parameter name.
 */
function verifyRequestSignature({ binding, xml, rawQuery, param = 'SAMLRequest', certPem }) {
  if (binding === 'redirect') return verifyRedirectSignature(rawQuery, param, certPem);
  return verifyPostSignature(xml, certPem);
}

module.exports = { decodeMessage, parseAuthnRequest, parseLogoutRequest, verifyRequestSignature };
