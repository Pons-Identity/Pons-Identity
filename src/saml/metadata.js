const { esc } = require('./xml');
const { NAMEID_FORMATS } = require('../config');
const { certBody } = require('../crypto');

function buildMetadata(sp) {
  const u = sp.urls;
  const formats = Object.values(NAMEID_FORMATS).map((f) => `      <md:NameIDFormat>${f}</md:NameIDFormat>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${esc(u.entityId)}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${certBody(sp.cert_pem)}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(u.slo)}"/>
${formats}
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${esc(u.sso)}"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(u.sso)}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>
`;
}

module.exports = { buildMetadata };
