const { XMLSerializer } = require('@xmldom/xmldom');

const NS = {
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  mdui: 'urn:oasis:names:tc:SAML:metadata:ui',
  mdattr: 'urn:oasis:names:tc:SAML:metadata:attribute',
  mdrpi: 'urn:oasis:names:tc:SAML:metadata:rpi',
  shibmd: 'urn:mace:shibboleth:metadata:1.0',
  saml: 'urn:oasis:names:tc:SAML:2.0:assertion',
  md: 'urn:oasis:names:tc:SAML:2.0:metadata',
};

const kids = (el, name) => {
  const out = [];
  for (let n = el && el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === name) out.push(n);
  return out;
};
const text = (el) => (el ? el.textContent.trim() : '');
const descendants = (el, ns, name) => (el ? [...el.getElementsByTagNameNS(ns, name)] : []);

// Prefer English, then an unlabelled value, then whatever comes first.
function pickLang(els) {
  const lang = (e) => (e.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang') || e.getAttribute('xml:lang') || '').toLowerCase();
  const pick = els.find((e) => lang(e).startsWith('en')) || els.find((e) => !lang(e)) || els[0];
  return text(pick);
}

function keyDescriptors(role) {
  const out = [];
  for (const kd of kids(role, 'KeyDescriptor')) {
    const cert = descendants(kd, NS.ds, 'X509Certificate')[0];
    if (!cert) continue;
    const use = kd.getAttribute('use') || 'both';
    out.push({ use, certificate: cert.textContent.replace(/\s+/g, '') });
  }
  return out;
}

const endpoints = (role, name) => kids(role, name).map((e) => ({
  binding: e.getAttribute('Binding'), location: e.getAttribute('Location'),
  ...(e.getAttribute('index') ? { index: Number(e.getAttribute('index')), isDefault: e.getAttribute('isDefault') === 'true' } : {}),
}));

function uiInfo(role) {
  const ui = descendants(role, NS.mdui, 'UIInfo')[0];
  if (!ui) return {};
  const logos = descendants(ui, NS.mdui, 'Logo').map((l) => text(l)).filter((u) => /^https:\/\//.test(u));
  return {
    displayName: pickLang(kids(ui, 'DisplayName')),
    description: pickLang(kids(ui, 'Description')),
    informationUrl: pickLang(kids(ui, 'InformationURL')),
    privacyStatementUrl: pickLang(kids(ui, 'PrivacyStatementURL')),
    logo: logos[0] || '',
  };
}

// mdattr:EntityAttributes -> { attributeName: [values] }; entity categories, assurance and SIRTFI live here.
function entityAttributes(entity) {
  const out = {};
  const ext = kids(entity, 'Extensions')[0];
  for (const ea of descendants(ext, NS.mdattr, 'EntityAttributes')) {
    for (const a of descendants(ea, NS.saml, 'Attribute')) {
      const name = a.getAttribute('Name');
      if (!name) continue;
      out[name] = [...(out[name] || []), ...descendants(a, NS.saml, 'AttributeValue').map(text).filter(Boolean)];
    }
  }
  return out;
}

function parseIdp(role) {
  const ext = kids(role, 'Extensions')[0];
  return {
    ui: uiInfo(ext),
    scopes: descendants(ext, NS.shibmd, 'Scope').map((s) => ({ value: text(s), regexp: s.getAttribute('regexp') === 'true' })),
    keys: keyDescriptors(role),
    singleSignOnServices: endpoints(role, 'SingleSignOnService'),
    singleLogoutServices: endpoints(role, 'SingleLogoutService'),
    nameIdFormats: kids(role, 'NameIDFormat').map(text),
    wantAuthnRequestsSigned: role.getAttribute('WantAuthnRequestsSigned') === 'true',
  };
}

function parseSp(role) {
  const ext = kids(role, 'Extensions')[0];
  const requested = [];
  for (const acs of kids(role, 'AttributeConsumingService')) {
    for (const ra of kids(acs, 'RequestedAttribute')) {
      requested.push({ name: ra.getAttribute('Name'), friendlyName: ra.getAttribute('FriendlyName') || '', required: ra.getAttribute('isRequired') === 'true' });
    }
  }
  return {
    ui: uiInfo(ext),
    keys: keyDescriptors(role),
    assertionConsumerServices: endpoints(role, 'AssertionConsumerService'),
    singleLogoutServices: endpoints(role, 'SingleLogoutService'),
    nameIdFormats: kids(role, 'NameIDFormat').map(text),
    authnRequestsSigned: role.getAttribute('AuthnRequestsSigned') === 'true',
    wantAssertionsSigned: role.getAttribute('WantAssertionsSigned') === 'true',
    requestedAttributes: requested.filter((r) => r.name),
  };
}

/** Reduce an EntityDescriptor element to the fields the gateway uses, plus its own serialized XML. */
function parseEntity(entity) {
  const entityId = entity.getAttribute('entityID');
  if (!entityId) throw new Error('EntityDescriptor has no entityID.');
  const idp = kids(entity, 'IDPSSODescriptor')[0];
  const sp = kids(entity, 'SPSSODescriptor')[0];
  const ext = kids(entity, 'Extensions')[0];
  const reg = descendants(ext, NS.mdrpi, 'RegistrationInfo')[0];
  const org = kids(entity, 'Organization')[0];
  const parsed = {
    registrationAuthority: reg ? reg.getAttribute('registrationAuthority') || '' : '',
    entityAttributes: entityAttributes(entity),
    organization: org ? {
      name: pickLang(kids(org, 'OrganizationName')),
      displayName: pickLang(kids(org, 'OrganizationDisplayName')),
      url: pickLang(kids(org, 'OrganizationURL')),
    } : null,
    idp: idp ? parseIdp(idp) : null,
    sp: sp ? parseSp(sp) : null,
  };
  const ui = (idp ? parsed.idp.ui : parsed.sp && parsed.sp.ui) || {};
  return {
    entityId,
    isIdp: Boolean(idp),
    isSp: Boolean(sp),
    displayName: ui.displayName || (parsed.organization && (parsed.organization.displayName || parsed.organization.name)) || entityId,
    validUntil: entity.getAttribute('validUntil') || '',
    parsed,
    xml: new XMLSerializer().serializeToString(entity),
  };
}

module.exports = { parseEntity, kids, NS };
