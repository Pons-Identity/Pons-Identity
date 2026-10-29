const db = require('../db');
const sps = require('../sps');
const appSettings = require('../app-settings');
const { baseUrl, NAMEID_FORMATS } = require('../config');
const { certBody } = require('../crypto');
const { esc, newId, isoTime } = require('../saml/xml');
const { normalizeCertificate } = require('../saml/encrypt');
const metadata = require('./metadata-source');
const { signEntityDescriptor } = require('./metadata-sign');
const keyring = require('./keyring');
const { releaseFor, supportedCategories } = require('./release-policy');

// The IdP as the federation sees it: one entity ID and one set of keys for every federation SP, independent of the
// per-application identities used for apps registered by hand.

const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const SIGNED_METADATA_DAYS = 14;

const urls = () => ({
  metadata: `${baseUrl}/fed/idp/metadata`,
  sso: `${baseUrl}/fed/idp/sso`,
  slo: `${baseUrl}/fed/idp/slo`,
  idpInitiated: `${baseUrl}/fed/idp/init`,
});
const defaultEntityId = () => `${baseUrl}/fed/idp/metadata`;

const KEY_LABEL = 'Pons Identity federation';

/** The key set, generated on first use. */
function ensureKeys() {
  let keys = appSettings.federationKeys();
  if (!keys) {
    keys = keyring.create(KEY_LABEL);
    appSettings.saveFederationKeys(keys);
  }
  return keys;
}

function identity() {
  const cfg = appSettings.federationIdp();
  return { cfg, entityId: cfg.entityId || defaultEntityId(), urls: urls() };
}

const asPem = (b64) => {
  try {
    return normalizeCertificate(b64);
  } catch {
    return '';
  }
};

const byDefaultThenIndex = (a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || (a.index ?? 1e9) - (b.index ?? 1e9);

/**
 * The service-provider record to serve `entityId`, or null if federation is off or the entity is not a known SP.
 * A service provider registered by hand under the same entity ID keeps its own settings (attribute mapping, rules,
 * access); only the identity — issuer, keys and endpoints — is the federation's. Otherwise one is synthesised from
 * metadata and the release policy.
 */
function forEntity(entityId, { preview = false } = {}) {
  const { cfg, entityId: issuer, urls: u } = identity();
  if ((!cfg.enabled && !preview) || !entityId) return null;
  const entity = metadata.findEntity(entityId);
  const spMeta = entity && entity.is_sp && entity.parsed.sp;
  if (!spMeta) return null;
  const acs = spMeta.assertionConsumerServices.filter((e) => e.binding === BINDING_POST && e.location).sort(byDefaultThenIndex);
  if (!acs.length) return null;

  const keys = ensureKeys();
  const identityFields = {
    federated: true,
    resume_path: '/fed/idp/resume',
    private_key_pem: keys.signing.keyPem,
    cert_pem: keys.signing.certPem,
    signature_algorithm: cfg.signatureAlgorithm,
    urls: { metadata: u.metadata, entityId: issuer, sso: u.sso, slo: u.slo, idpInitiated: u.idpInitiated },
  };

  const registered = db.get("SELECT id FROM service_providers WHERE sp_entity_id = ? AND sp_entity_id != ''", entityId);
  if (registered) return { ...sps.getSp(registered.id), ...identityFields, synthetic: false };

  const slo = spMeta.singleLogoutServices.find((e) => e.binding === BINDING_POST);
  const encKey = spMeta.keys.find((k) => k.use !== 'signing');
  const encryptionCert = cfg.encryptAssertions && encKey ? asPem(encKey.certificate) : '';
  const formats = spMeta.nameIdFormats;
  const nameidFormat = formats.length && !formats.includes(NAMEID_FORMATS.persistent) && formats.includes(NAMEID_FORMATS.transient)
    ? 'transient' : 'persistent';
  const signingCerts = spMeta.authnRequestsSigned
    ? spMeta.keys.filter((k) => k.use !== 'encryption').map((k) => asPem(k.certificate)).filter(Boolean) : [];

  return {
    ...identityFields,
    id: 'federation',
    synthetic: true,
    name: entity.display_name || entityId,
    sp_entity_id: entityId,
    acs_urls: acs.map((e) => e.location),
    slo_url: slo ? slo.location : '',
    login_url: '',
    default_relay_state: '',
    nameid_format: nameidFormat,
    nameid_source: 'persistent_id',
    sign_response: 1,
    sign_assertion: 1,
    encrypt_assertion: encryptionCert ? 1 : 0,
    encryption_cert_pem: encryptionCert,
    encryption_algorithm: cfg.encryptionAlgorithm,
    key_transport_algorithm: cfg.keyTransportAlgorithm,
    signing_cert_pem: signingCerts[0] || '',
    signing_cert_pems: signingCerts,
    groups_attribute: '',
    grouper_groups: 0,
    transform_enabled: 0,
    transform_rules: '',
    transform_nameid_attr: '',
    transform_temp_attrs: [],
    access_mode: 'all',
    access_groups: [],
    maps: releaseFor(entity.parsed, cfg).maps,
    statics: [],
    roles: [],
  };
}

/* -------------------------------- Metadata -------------------------------- */

const NS_ATTR_FORMAT = 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri';
const SIRTFI = 'https://refeds.org/sirtfi';

const entityAttr = (name, values) => `<saml:Attribute Name="${esc(name)}" NameFormat="${NS_ATTR_FORMAT}">${
  values.map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`;

function contactXml(type, c, extraAttrs = '') {
  if (!c.email) return '';
  return `\n  <md:ContactPerson contactType="${type}"${extraAttrs}>`
    + (c.name ? `<md:GivenName>${esc(c.name)}</md:GivenName>` : '')
    + `<md:EmailAddress>mailto:${esc(c.email)}</md:EmailAddress></md:ContactPerson>`;
}

function unsignedMetadata({ signed }) {
  const { cfg, entityId, urls: u } = identity();
  const keys = ensureKeys();
  const keyXml = (use, pem) => `
    <md:KeyDescriptor use="${use}"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`;
  const attrs = [];
  const cats = supportedCategories(cfg);
  if (cats.length) attrs.push(entityAttr('http://macedir.org/entity-category-support', cats));
  if (cfg.sirtfi) attrs.push(entityAttr('urn:oasis:names:tc:SAML:attribute:assurance-certification', [SIRTFI]));
  const ui = cfg.ui;
  const lang = 'xml:lang="en"';
  const uiXml = [
    ui.displayName && `<mdui:DisplayName ${lang}>${esc(ui.displayName)}</mdui:DisplayName>`,
    ui.description && `<mdui:Description ${lang}>${esc(ui.description)}</mdui:Description>`,
    ui.informationUrl && `<mdui:InformationURL ${lang}>${esc(ui.informationUrl)}</mdui:InformationURL>`,
    ui.privacyUrl && `<mdui:PrivacyStatementURL ${lang}>${esc(ui.privacyUrl)}</mdui:PrivacyStatementURL>`,
  ].filter(Boolean).join('');
  const now = new Date();
  const root = signed
    ? ` ID="${newId()}" validUntil="${isoTime(new Date(now.getTime() + SIGNED_METADATA_DAYS * 86400000))}" cacheDuration="PT6H"` : '';
  const o = cfg.organization;

  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui" xmlns:shibmd="urn:mace:shibboleth:metadata:1.0" xmlns:mdattr="urn:oasis:names:tc:SAML:metadata:attribute" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:remd="http://refeds.org/metadata" entityID="${esc(entityId)}"${root}>`
    + (attrs.length ? `\n  <md:Extensions><mdattr:EntityAttributes>${attrs.join('')}</mdattr:EntityAttributes></md:Extensions>` : '')
    + `\n  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`
    + `\n    <md:Extensions>${cfg.scope ? `<shibmd:Scope regexp="false">${esc(cfg.scope)}</shibmd:Scope>` : ''}${uiXml ? `<mdui:UIInfo>${uiXml}</mdui:UIInfo>` : ''}</md:Extensions>`
    + keyring.published(keys, 'signing').map((k) => keyXml('signing', k.certPem)).join('')
    + keyring.published(keys, 'encryption').map((k) => keyXml('encryption', k.certPem)).join('')
    + `\n    <md:SingleLogoutService Binding="${BINDING_POST}" Location="${esc(u.slo)}"/>`
    + `\n    <md:NameIDFormat>${NAMEID_FORMATS.persistent}</md:NameIDFormat>`
    + `\n    <md:NameIDFormat>${NAMEID_FORMATS.transient}</md:NameIDFormat>`
    + `\n    <md:SingleSignOnService Binding="${BINDING_REDIRECT}" Location="${esc(u.sso)}"/>`
    + `\n    <md:SingleSignOnService Binding="${BINDING_POST}" Location="${esc(u.sso)}"/>`
    + `\n  </md:IDPSSODescriptor>`
    + (o.name ? `\n  <md:Organization><md:OrganizationName ${lang}>${esc(o.name)}</md:OrganizationName><md:OrganizationDisplayName ${lang}>${esc(o.displayName || o.name)}</md:OrganizationDisplayName><md:OrganizationURL ${lang}>${esc(o.url)}</md:OrganizationURL></md:Organization>` : '')
    + contactXml('technical', cfg.contacts.technical)
    + contactXml('support', cfg.contacts.support)
    + (cfg.sirtfi ? contactXml('other', cfg.contacts.security, ' remd:contactType="http://refeds.org/metadata/contact/security"') : '')
    + '\n</md:EntityDescriptor>\n';
}

/**
 * The IdP's metadata. Unsigned is what is submitted to the federation's registration tool; signed adds validUntil
 * and cacheDuration and an enveloped signature by the federation signing key, for consumers that fetch it directly.
 */
function buildMetadata({ signed = false } = {}) {
  const xml = unsignedMetadata({ signed });
  if (!signed) return xml;
  return signEntityDescriptor(xml, ensureKeys(), identity().cfg.signatureAlgorithm);
}

module.exports = { identity, forEntity, buildMetadata, ensureKeys, defaultEntityId, KEY_LABEL };
