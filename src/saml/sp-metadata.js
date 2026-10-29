const { parseXml } = require('./xml');
const { NAMEID_FORMATS } = require('../config');

const kids = (el, name) => {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === name) out.push(n);
  return out;
};

// Guess an IdP attribute for an SP-requested attribute name.
function guessIdpAttribute(name) {
  const n = name.toLowerCase();
  if (/(mail)/.test(n)) return 'email';
  if (/(givenname|firstname|first_name)/.test(n)) return 'first_name';
  if (/(surname|lastname|last_name|familyname)/.test(n)) return 'last_name';
  if (/(displayname|fullname|\/name$|^name$)/.test(n)) return 'display_name';
  if (/(employee)/.test(n)) return 'employee_id';
  if (/(upn|userprincipal)/.test(n)) return 'upn';
  if (/(samaccount)/.test(n)) return 'sam_account_name';
  if (/(username|uid)/.test(n)) return 'username';
  if (/(company)/.test(n)) return 'company';
  if (/(manager)/.test(n)) return 'manager';
  if (/(mobile)/.test(n)) return 'mobile';
  if (/(postal|zip)/.test(n)) return 'postal_code';
  if (/(street)/.test(n)) return 'street_address';
  if (/(country)/.test(n)) return 'country';
  if (/(office)/.test(n)) return 'office';
  if (/(department)/.test(n)) return 'department';
  if (/(title)/.test(n)) return 'title';
  if (/(phone|telephone)/.test(n)) return 'phone';
  if (/(group|role|memberof)/.test(n)) return 'groups';
  return '';
}

// Extract the settings the SP form can use from SP metadata XML.
function parseSpMetadata(xml) {
  const doc = parseXml(xml);
  let root = doc.documentElement;
  if (root.localName === 'EntitiesDescriptor') root = kids(root, 'EntityDescriptor')[0];
  return fromEntity(root);
}

// The settings in one EntityDescriptor element.
function fromEntity(root) {
  if (!root || root.localName !== 'EntityDescriptor') throw new Error('Not SAML metadata (no EntityDescriptor).');
  const sp = kids(root, 'SPSSODescriptor')[0];
  if (!sp) throw new Error('Metadata has no SPSSODescriptor (is this IdP metadata?).');

  const acs = kids(sp, 'AssertionConsumerService')
    .sort((a, b) => (a.getAttribute('isDefault') === 'true' ? -1 : 0) - (b.getAttribute('isDefault') === 'true' ? -1 : 0))
    .map((e) => e.getAttribute('Location')).filter(Boolean);
  const slos = kids(sp, 'SingleLogoutService');
  const slo = (slos.find((e) => /HTTP-POST$/.test(e.getAttribute('Binding'))) || slos[0]);

  const idFormat = kids(sp, 'NameIDFormat').map((e) => e.textContent.trim())
    .map((u) => Object.keys(NAMEID_FORMATS).find((k) => NAMEID_FORMATS[k] === u)).find(Boolean);

  const maps = [];
  for (const acd of kids(sp, 'AttributeConsumingService')) {
    for (const ra of kids(acd, 'RequestedAttribute')) {
      const name = ra.getAttribute('Name');
      if (name) maps.push({ saml_name: name, idp_attribute: guessIdpAttribute(name) });
    }
  }

  // Encryption certificate: a KeyDescriptor marked for encryption (or unmarked, meaning both uses).
  let encryptionCert = '';
  for (const kd of kids(sp, 'KeyDescriptor')) {
    if (kd.getAttribute('use') === 'signing') continue;
    const cert = kd.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate')[0];
    if (cert) { encryptionCert = cert.textContent.replace(/\s+/g, ''); break; }
  }

  // Signing certificate: a KeyDescriptor marked for signing (or unmarked), used to verify the SP's AuthnRequests.
  let signingCert = '';
  for (const kd of kids(sp, 'KeyDescriptor')) {
    if (kd.getAttribute('use') === 'encryption') continue;
    const cert = kd.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate')[0];
    if (cert) { signingCert = cert.textContent.replace(/\s+/g, ''); break; }
  }

  return {
    name: '',
    encryption_cert_pem: encryptionCert,
    signing_cert_pem: signingCert,
    sp_entity_id: root.getAttribute('entityID') || '',
    acs_urls: acs,
    slo_url: slo ? slo.getAttribute('Location') : '',
    nameid_format: idFormat || '',
    maps,
  };
}

module.exports = { parseSpMetadata, fromEntity, guessIdpAttribute, kids };
