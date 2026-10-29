const { SignedXml } = require('xml-crypto');
const { parseXml } = require('../saml/xml');
const { decryptAssertion } = require('./xml-decrypt');

// Validation of a SAML Response from an upstream IdP. Everything that is read afterwards comes from XML that a
// signature verified (the signed reference, not the original document), so a forged element cannot ride along.

const NS_P = 'urn:oasis:names:tc:SAML:2.0:protocol';
const NS_A = 'urn:oasis:names:tc:SAML:2.0:assertion';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
const SKEW_MS = 2 * 60 * 1000;

const kids = (el, ns, name) => {
  const out = [];
  for (let n = el && el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.namespaceURI === ns && n.localName === name) out.push(n);
  return out;
};
const first = (el, ns, name) => kids(el, ns, name)[0] || null;
const text = (el) => (el ? el.textContent.trim() : '');
const time = (v) => {
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Invalid timestamp "${v}".`);
  return t;
};

/**
 * Verify `el`'s own enveloped signature (a direct child) against any of `certs`. The signature must reference
 * `el` itself. Returns the XML that was actually signed.
 */
function verifySigned(docXml, el, certs) {
  const sigs = kids(el, NS_DS, 'Signature');
  if (sigs.length !== 1) throw new Error('Expected exactly one signature.');
  const id = el.getAttribute('ID');
  let lastError = new Error('No signing certificates are published for this identity provider.');
  for (const cert of certs) {
    try {
      const sig = new SignedXml({ publicCert: cert });
      sig.loadSignature(sigs[0]);
      const refs = sig.getReferences();
      if (!id || refs.length !== 1 || refs[0].uri !== `#${id}`) throw new Error('The signature does not cover the element it is in.');
      if (!sig.checkSignature(docXml)) throw new Error('Signature is invalid.');
      const signed = sig.getSignedReferences();
      if (signed.length !== 1) throw new Error('The signature does not cover the element it is in.');
      return signed[0];
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function attributesOf(assertion) {
  const out = {};
  for (const stmt of kids(assertion, NS_A, 'AttributeStatement')) {
    for (const a of kids(stmt, NS_A, 'Attribute')) {
      const name = a.getAttribute('Name');
      if (!name) continue;
      const values = kids(a, NS_A, 'AttributeValue').map((v) => {
        const nid = first(v, NS_A, 'NameID'); // eduPersonTargetedID carries a NameID element
        return text(nid || v);
      }).filter(Boolean);
      out[name] = [...(out[name] || []), ...values];
    }
  }
  return out;
}

/**
 * @param xml        the decoded SAMLResponse
 * @param expected   { requestId, idpEntityId, spEntityId, acsUrl, signingCerts: [pem], decryptionKeyPem, now }
 * @returns { assertionId, notOnOrAfter, nameId, attributes, authnInstant, authnContext, sessionIndex }
 */
function validateResponse(xml, expected) {
  const now = (expected.now || new Date()).getTime();
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (root.namespaceURI !== NS_P || root.localName !== 'Response') throw new Error('Not a SAML Response.');

  const status = first(first(root, NS_P, 'Status'), NS_P, 'StatusCode');
  const statusValue = status ? status.getAttribute('Value') : '';
  if (statusValue !== SUCCESS) {
    const inner = first(status, NS_P, 'StatusCode');
    const err = new Error(`The identity provider did not authenticate you (${(inner ? inner.getAttribute('Value') : statusValue || 'no status').split(':').pop()}).`);
    err.userFacing = true;
    throw err;
  }
  if (root.getAttribute('InResponseTo') !== expected.requestId) throw new Error('The response is not a reply to the request that was sent.');
  const destination = root.getAttribute('Destination');
  if (destination && destination !== expected.acsUrl) throw new Error('The response was addressed to a different endpoint.');
  const respIssuer = first(root, NS_A, 'Issuer');
  if (respIssuer && text(respIssuer) !== expected.idpEntityId) throw new Error('The response came from a different identity provider.');

  // 1. If the Response is signed, verify it and read only the verified copy from here on.
  let scope = root;
  let scopeXml = xml;
  let responseSigned = false;
  if (kids(root, NS_DS, 'Signature').length) {
    scopeXml = verifySigned(xml, root, expected.signingCerts);
    scope = parseXml(scopeXml).documentElement;
    responseSigned = true;
  }

  // 2. Exactly one assertion, plain or encrypted.
  const plain = kids(scope, NS_A, 'Assertion');
  const encrypted = kids(scope, NS_A, 'EncryptedAssertion');
  if (plain.length + encrypted.length !== 1) throw new Error('Expected exactly one assertion in the response.');
  let assertionXml;
  let assertionEl;
  if (encrypted.length) {
    assertionXml = decryptAssertion(encrypted[0], expected.decryptionKeysPem || expected.decryptionKeyPem);
    assertionEl = parseXml(assertionXml).documentElement;
  } else {
    assertionEl = plain[0];
    assertionXml = scopeXml;
  }
  if (assertionEl.namespaceURI !== NS_A || assertionEl.localName !== 'Assertion') throw new Error('Decrypted content is not an assertion.');

  // 3. The assertion's own signature, if it has one, must verify; one of the two signatures is required.
  let a = assertionEl;
  if (kids(assertionEl, NS_DS, 'Signature').length) {
    a = parseXml(verifySigned(assertionXml, assertionEl, expected.signingCerts)).documentElement;
  } else if (!responseSigned) {
    throw new Error('Neither the response nor the assertion is signed.');
  }

  // 4. Content checks.
  const assertionId = a.getAttribute('ID');
  if (!assertionId) throw new Error('The assertion has no ID.');
  if (a.getAttribute('Version') !== '2.0') throw new Error('Unsupported assertion version.');
  if (text(first(a, NS_A, 'Issuer')) !== expected.idpEntityId) throw new Error('The assertion was issued by a different identity provider.');

  const subject = first(a, NS_A, 'Subject');
  const nameIdEl = first(subject, NS_A, 'NameID');
  if (!nameIdEl) throw new Error('The assertion has no NameID (encrypted NameIDs are not supported).');
  const confirmation = kids(subject, NS_A, 'SubjectConfirmation').find((c) => c.getAttribute('Method') === BEARER);
  const data = confirmation && first(confirmation, NS_A, 'SubjectConfirmationData');
  if (!data) throw new Error('The assertion has no bearer confirmation.');
  if (data.getAttribute('Recipient') !== expected.acsUrl) throw new Error('The assertion was issued for a different endpoint.');
  if (data.getAttribute('InResponseTo') !== expected.requestId) throw new Error('The assertion is not a reply to the request that was sent.');
  const confirmUntil = time(data.getAttribute('NotOnOrAfter'));
  if (!(now < confirmUntil + SKEW_MS)) throw new Error('The assertion has expired.');
  if (data.getAttribute('NotBefore') && now + SKEW_MS < time(data.getAttribute('NotBefore'))) throw new Error('The assertion is not yet valid.');

  const conditions = first(a, NS_A, 'Conditions');
  if (!conditions) throw new Error('The assertion has no conditions.');
  const notBefore = conditions.getAttribute('NotBefore');
  const notOnOrAfter = conditions.getAttribute('NotOnOrAfter');
  if (notBefore && now + SKEW_MS < time(notBefore)) throw new Error('The assertion is not yet valid.');
  if (!notOnOrAfter) throw new Error('The assertion has no expiry.');
  if (!(now < time(notOnOrAfter) + SKEW_MS)) throw new Error('The assertion has expired.');
  const restrictions = kids(conditions, NS_A, 'AudienceRestriction');
  if (!restrictions.length) throw new Error('The assertion has no audience restriction.');
  for (const r of restrictions) {
    if (!kids(r, NS_A, 'Audience').some((au) => text(au) === expected.spEntityId)) throw new Error('The assertion was issued for a different service provider.');
  }

  const authn = first(a, NS_A, 'AuthnStatement');
  if (!authn) throw new Error('The assertion has no authentication statement.');
  return {
    assertionId,
    // Replay records are kept until the assertion could no longer pass the time checks above.
    notOnOrAfter: Math.max(time(notOnOrAfter), confirmUntil) + SKEW_MS,
    nameId: { value: text(nameIdEl), format: nameIdEl.getAttribute('Format') || '', nameQualifier: nameIdEl.getAttribute('NameQualifier') || '' },
    attributes: attributesOf(a),
    authnInstant: authn.getAttribute('AuthnInstant') || '',
    authnContext: text(first(first(authn, NS_A, 'AuthnContext'), NS_A, 'AuthnContextClassRef')),
    sessionIndex: authn.getAttribute('SessionIndex') || '',
  };
}

module.exports = { validateResponse, SKEW_MS };
