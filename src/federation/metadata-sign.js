const { SignedXml } = require('xml-crypto');
const { SIGNATURE_ALGORITHMS } = require('../config');

/** Enveloped signature as the first child of the root EntityDescriptor, made with `keys.signing`. */
function signEntityDescriptor(xml, keys, algorithm) {
  const alg = SIGNATURE_ALGORITHMS[algorithm] || SIGNATURE_ALGORITHMS.sha256;
  const root = "/*[local-name(.)='EntityDescriptor']";
  const sig = new SignedXml({
    privateKey: keys.signing.keyPem, publicCert: keys.signing.certPem,
    signatureAlgorithm: alg.signature, canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: root,
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: alg.digest,
  });
  sig.computeSignature(xml, { location: { reference: root, action: 'prepend' }, prefix: 'ds' });
  return sig.getSignedXml();
}

module.exports = { signEntityDescriptor };
