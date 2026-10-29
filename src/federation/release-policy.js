// What a federation SP is sent, decided from its published metadata (entity categories, requested attributes) and the
// administrator's federation settings. Nothing is released unless a category bundle or a required request calls for it.

const OID = (n) => `urn:oid:${n}`;

// Each releasable attribute: the IdP-side key that resolves it, its canonical SAML name, and other names SPs ask for it by.
const CATALOG = {
  eppn: { key: 'eduperson_principal_name', name: OID('1.3.6.1.4.1.5923.1.1.1.6'), friendly: 'eduPersonPrincipalName', aliases: ['urn:mace:dir:attribute-def:eduPersonPrincipalName', 'eduPersonPrincipalName'] },
  mail: { key: 'email', name: OID('0.9.2342.19200300.100.1.3'), friendly: 'mail', aliases: ['urn:mace:dir:attribute-def:mail', 'mail'] },
  displayName: { key: 'display_name', name: OID('2.16.840.1.113730.3.1.241'), friendly: 'displayName', aliases: ['urn:mace:dir:attribute-def:displayName', 'displayName'] },
  givenName: { key: 'first_name', name: OID('2.5.4.42'), friendly: 'givenName', aliases: ['urn:mace:dir:attribute-def:givenName', 'givenName'] },
  sn: { key: 'last_name', name: OID('2.5.4.4'), friendly: 'sn', aliases: ['urn:mace:dir:attribute-def:sn', 'sn'] },
  epa: { key: 'eduperson_affiliation', name: OID('1.3.6.1.4.1.5923.1.1.1.1'), friendly: 'eduPersonAffiliation', aliases: ['urn:mace:dir:attribute-def:eduPersonAffiliation', 'eduPersonAffiliation'] },
  epsa: { key: 'eduperson_scoped_affiliation', name: OID('1.3.6.1.4.1.5923.1.1.1.9'), friendly: 'eduPersonScopedAffiliation', aliases: ['urn:mace:dir:attribute-def:eduPersonScopedAffiliation', 'eduPersonScopedAffiliation'] },
  eptid: { key: 'eduperson_targeted_id', name: OID('1.3.6.1.4.1.5923.1.1.1.10'), friendly: 'eduPersonTargetedID', aliases: ['urn:mace:dir:attribute-def:eduPersonTargetedID', 'eduPersonTargetedID'] },
  schacHome: { key: 'schac_home_organization', name: OID('1.3.6.1.4.1.25178.1.2.9'), friendly: 'schacHomeOrganization', aliases: ['urn:mace:terena.org:attribute-def:schacHomeOrganization', 'schacHomeOrganization'] },
  subjectId: { key: 'subject_id', name: 'urn:oasis:names:tc:SAML:attribute:subject-id', friendly: 'subject-id', aliases: ['subject-id'] },
  pairwiseId: { key: 'pairwise_id', name: 'urn:oasis:names:tc:SAML:attribute:pairwise-id', friendly: 'pairwise-id', aliases: ['pairwise-id'] },
  uid: { key: 'username', name: OID('0.9.2342.19200300.100.1.1'), friendly: 'uid', aliases: ['urn:mace:dir:attribute-def:uid', 'uid'] },
};

const ENTITY_CATEGORY = 'http://macedir.org/entity-category';

// Category bundles. Check these against the REFEDS and InCommon specifications before relying on them;
// eduPersonAssurance is part of some bundles upstream but is not something this IdP can assert.
const CATEGORIES = {
  rs: {
    label: 'REFEDS Research & Scholarship',
    uri: 'http://refeds.org/category/research-and-scholarship',
    attributes: ['eppn', 'mail', 'displayName', 'givenName', 'sn', 'epsa', 'eptid'],
  },
  pseudonymous: {
    label: 'REFEDS Pseudonymous Access',
    uri: 'https://refeds.org/category/pseudonymous',
    attributes: ['pairwiseId', 'epsa', 'schacHome'],
  },
  personalized: {
    label: 'REFEDS Personalized Access',
    uri: 'https://refeds.org/category/personalized',
    attributes: ['subjectId', 'mail', 'displayName', 'givenName', 'sn', 'epsa', 'schacHome'],
  },
  anonymous: {
    label: 'REFEDS Anonymous Access',
    uri: 'https://refeds.org/category/anonymous',
    attributes: ['epsa', 'schacHome'],
  },
  // Code of Conduct: whatever the SP requests (required or optional) that this IdP can supply.
  coco: {
    label: 'GÉANT Data Protection Code of Conduct',
    uri: 'https://refeds.org/category/code-of-conduct/v2',
    requested: true,
  },
};

const byName = new Map();
for (const [id, a] of Object.entries(CATALOG)) for (const n of [a.name, ...a.aliases]) byName.set(n, id);

/**
 * Work out the attribute mappings for one SP. `parsed` is the entity's parsed metadata (see entity-parser).
 * Returns { maps: [{ idp_attribute, saml_name }], reasons: [{ name, friendly, via }] }.
 * Bundle attributes go out under their canonical name; requested ones under the name the SP asked for.
 */
function releaseFor(parsed, cfg) {
  const maps = [];
  const reasons = [];
  const seen = new Set();
  const add = (id, samlName, via) => {
    const a = CATALOG[id];
    if (seen.has(samlName)) return;
    seen.add(samlName);
    maps.push({ idp_attribute: a.key, saml_name: samlName });
    reasons.push({ name: samlName, friendly: a.friendly, via });
  };

  const categories = (parsed.entityAttributes && parsed.entityAttributes[ENTITY_CATEGORY]) || [];
  const requested = (parsed.sp && parsed.sp.requestedAttributes) || [];

  for (const [id, cat] of Object.entries(CATEGORIES)) {
    if (!cfg.categories[id] || !categories.includes(cat.uri)) continue;
    if (cat.requested) {
      for (const r of requested) if (byName.has(r.name)) add(byName.get(r.name), r.name, cat.label);
    } else {
      for (const attr of cat.attributes) add(attr, CATALOG[attr].name, cat.label);
    }
  }
  if (cfg.releaseRequired) {
    for (const r of requested) if (r.required && byName.has(r.name)) add(byName.get(r.name), r.name, 'Required by the service provider');
  }
  return { maps, reasons };
}

/** Entity category URIs this IdP announces support for in its metadata. */
const supportedCategories = (cfg) => Object.entries(CATEGORIES).filter(([id]) => cfg.categories[id]).map(([, c]) => c.uri);

module.exports = { CATALOG, CATEGORIES, releaseFor, supportedCategories };
