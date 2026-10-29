const crypto = require('crypto');
const zlib = require('zlib');
const appSettings = require('../app-settings');
const { baseUrl, NAMEID_FORMATS } = require('../config');
const { certBody } = require('../crypto');
const { esc, newId, isoTime } = require('../saml/xml');
const { normalizeCertificate } = require('../saml/encrypt');
const metadata = require('./metadata-source');
const { signEntityDescriptor } = require('./metadata-sign');
const keyring = require('./keyring');
const { CATALOG } = require('./release-policy');

// This server as a service provider in the federation: one entity ID and key set used to sign in people from any
// other institution's identity provider.

const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const SIG_ALG_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SIGNED_METADATA_DAYS = 14;

const urls = () => ({ metadata: `${baseUrl}/fed/sp/metadata`, login: `${baseUrl}/fed/sp/login`, acs: `${baseUrl}/fed/sp/acs` });

const KEY_LABEL = 'Pons Identity federation SP';

function ensureKeys() {
  let keys = appSettings.federationSpKeys();
  if (!keys) {
    keys = keyring.create(KEY_LABEL);
    appSettings.saveFederationSpKeys(keys);
  }
  return keys;
}

function identity() {
  const cfg = appSettings.federationSp();
  const u = urls();
  return { cfg, entityId: cfg.entityId || u.metadata, urls: u };
}

/* ------------------------------- IdP lookup ------------------------------- */

const asPem = (b64) => {
  try {
    return normalizeCertificate(b64);
  } catch {
    return '';
  }
};

/** Whether people from this IdP may sign in: it must be in the imported metadata and, if a list is set, on it. */
function allowedIdp(entityId) {
  const { cfg } = identity();
  if (!cfg.enabled || !entityId) return null;
  if (cfg.idpAllowlist.length && !cfg.idpAllowlist.includes(entityId)) return null;
  const entity = metadata.findEntity(entityId);
  const idp = entity && entity.is_idp && entity.parsed.idp;
  if (!idp) return null;
  const sso = idp.singleSignOnServices.find((s) => s.binding === BINDING_REDIRECT && s.location);
  if (!sso) return null;
  return {
    entityId,
    name: entity.display_name || entityId,
    ssoUrl: sso.location,
    signingCerts: idp.keys.filter((k) => k.use !== 'encryption').map((k) => asPem(k.certificate)).filter(Boolean),
    scopes: idp.scopes,
  };
}

/** Identity providers a person can pick from: those in the imported metadata, limited to the allow list if one is set. */
function listIdps({ q = '', limit = 50 } = {}) {
  const { cfg } = identity();
  if (!cfg.enabled) return [];
  const found = metadata.searchEntities({ q, role: 'idp', limit, ids: cfg.idpAllowlist.length ? cfg.idpAllowlist : null });
  return found.entities.map((e) => ({ entity_id: e.entity_id, name: e.display_name }));
}

/* -------------------------------- Requests -------------------------------- */

/**
 * An AuthnRequest for `idp`, as an HTTP-Redirect URL (signed unless disabled). `requestId` doubles as RelayState,
 * which the ACS uses to find the sign-in it belongs to.
 */
function buildLoginRedirect(idp, { forceAuthn = false } = {}) {
  const { cfg, entityId, urls: u } = identity();
  const id = newId();
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`
    + ` ID="${id}" Version="2.0" IssueInstant="${isoTime()}" Destination="${esc(idp.ssoUrl)}"`
    + ` ProtocolBinding="${BINDING_POST}" AssertionConsumerServiceURL="${esc(u.acs)}"${forceAuthn ? ' ForceAuthn="true"' : ''}>`
    + `<saml:Issuer>${esc(entityId)}</saml:Issuer><samlp:NameIDPolicy AllowCreate="true"/></samlp:AuthnRequest>`;
  const params = [`SAMLRequest=${encodeURIComponent(zlib.deflateRawSync(xml).toString('base64'))}`, `RelayState=${encodeURIComponent(id)}`];
  if (cfg.signRequests) {
    params.push(`SigAlg=${encodeURIComponent(SIG_ALG_RSA_SHA256)}`);
    const sig = crypto.sign('sha256', Buffer.from(params.join('&')), ensureKeys().signing.keyPem).toString('base64');
    params.push(`Signature=${encodeURIComponent(sig)}`);
  }
  return { id, url: `${idp.ssoUrl}${idp.ssoUrl.includes('?') ? '&' : '?'}${params.join('&')}` };
}

/* -------------------------------- Metadata -------------------------------- */

// Attributes asked for, as the R&S-style set. Optional: whether they arrive depends on the IdP's own release policy.
const REQUESTED = ['eppn', 'mail', 'displayName', 'givenName', 'sn', 'epsa', 'schacHome', 'pairwiseId', 'subjectId'];

function buildMetadata({ signed = false } = {}) {
  const { entityId, urls: u } = identity();
  const keys = ensureKeys();
  const idpCfg = appSettings.federationIdp();
  const o = idpCfg.organization;
  const lang = 'xml:lang="en"';
  const keyXml = (use, pem) => `
    <md:KeyDescriptor use="${use}"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`;
  const contact = (type, c) => (c.email ? `\n  <md:ContactPerson contactType="${type}">${c.name ? `<md:GivenName>${esc(c.name)}</md:GivenName>` : ''}<md:EmailAddress>mailto:${esc(c.email)}</md:EmailAddress></md:ContactPerson>` : '');
  const name = idpCfg.ui.displayName || o.displayName || o.name || appSettings.productName();
  const root = signed
    ? ` ID="${newId()}" validUntil="${isoTime(new Date(Date.now() + SIGNED_METADATA_DAYS * 86400000))}" cacheDuration="PT6H"` : '';
  const requested = REQUESTED.map((k) => `<md:RequestedAttribute Name="${esc(CATALOG[k].name)}" FriendlyName="${esc(CATALOG[k].friendly)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri" isRequired="false"/>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui" entityID="${esc(entityId)}"${root}>`
    + `\n  <md:SPSSODescriptor AuthnRequestsSigned="${identity().cfg.signRequests}" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`
    + `\n    <md:Extensions><mdui:UIInfo><mdui:DisplayName ${lang}>${esc(name)}</mdui:DisplayName></mdui:UIInfo></md:Extensions>`
    + keyring.published(keys, 'signing').map((k) => keyXml('signing', k.certPem)).join('')
    + keyring.published(keys, 'encryption').map((k) => keyXml('encryption', k.certPem)).join('')
    + `\n    <md:NameIDFormat>${NAMEID_FORMATS.persistent}</md:NameIDFormat>`
    + `\n    <md:NameIDFormat>${NAMEID_FORMATS.transient}</md:NameIDFormat>`
    + `\n    <md:AssertionConsumerService Binding="${BINDING_POST}" Location="${esc(u.acs)}" index="0" isDefault="true"/>`
    + `\n    <md:AttributeConsumingService index="1"><md:ServiceName ${lang}>${esc(name)}</md:ServiceName>${requested}</md:AttributeConsumingService>`
    + `\n  </md:SPSSODescriptor>`
    + (o.name ? `\n  <md:Organization><md:OrganizationName ${lang}>${esc(o.name)}</md:OrganizationName><md:OrganizationDisplayName ${lang}>${esc(o.displayName || o.name)}</md:OrganizationDisplayName><md:OrganizationURL ${lang}>${esc(o.url)}</md:OrganizationURL></md:Organization>` : '')
    + contact('technical', idpCfg.contacts.technical) + contact('support', idpCfg.contacts.support)
    + '\n</md:EntityDescriptor>\n';
  return signed ? signEntityDescriptor(xml, keys, idpCfg.signatureAlgorithm) : xml;
}

module.exports = { KEY_LABEL, identity, ensureKeys, allowedIdp, listIdps, buildLoginRedirect, buildMetadata, urls };
