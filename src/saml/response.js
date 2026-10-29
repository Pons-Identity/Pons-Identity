const { esc, newId, isoTime, local, signElement } = require('./xml');
const { NAMEID_FORMATS } = require('../config');
const attrs = require('../attributes');
const { parseRules, applyRules } = require('../transform');
const { encryptAssertion } = require('./encrypt');
const appSettings = require('../app-settings');

const NS = 'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"';
const ATTR_UNSPECIFIED = 'urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified';
const ATTR_URI = 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri';

// Authentication-method claims, reflecting the methods actually used at login (RFC 8176 values:
// pwd = password, otp = TOTP code, mfa = more than one factor). SPs commonly require MFA via these.
const AMR_CLAIM = 'http://schemas.microsoft.com/claims/authnmethodsreferences';
const AMR_MS = {
  pwd: 'http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password',
  mfa: 'http://schemas.microsoft.com/claims/multipleauthn',
};
const AC_PASSWORD = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
const AC_TOTP = 'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken';

const NOTBEFORE_SKEW_MS = 2 * 60 * 1000;
const VALIDITY_MS = 5 * 60 * 1000;

// `transformed` is the attribute map after the transformation rules; the rule marked as the NameID wins over nameid_source.
function nameIdFor(sp, user, ctx, transformed) {
  if (sp.nameid_format === 'transient') return newId();
  if (sp.transform_enabled && sp.transform_nameid_attr) {
    const t = transformed?.get(sp.transform_nameid_attr)?.[0];
    if (!t) throw new Error(`User "${user.username}" has no value for the transformed NameID attribute "${sp.transform_nameid_attr}".`);
    return t;
  }
  const v = attrs.resolve(user, sp.nameid_source, ctx)[0];
  if (!v) throw new Error(`User "${user.username}" has no value for the NameID attribute "${sp.nameid_source}".`);
  return v;
}

// Merge mapped, static, role and AMR attributes into [{name, values}], preserving first-seen order.
// The SP's transformation rules run after the mappings and before the AMR claims, which they cannot alter.
// Attributes marked temporary are dropped after the rules have run. Returns the attribute list; if `ruleErrors` is an
// array, rule failures are pushed onto it, and if `transformed` is a Map it receives the attributes before they are dropped.
function buildAttributes(sp, user, ctx, amr, ruleErrors = [], transformed = new Map()) {
  const out = new Map();
  const add = (name, values) => {
    if (!values.length) return;
    if (!out.has(name)) out.set(name, []);
    for (const v of values) if (!out.get(name).includes(v)) out.get(name).push(v);
  };
  for (const m of sp.maps) add(m.saml_name, attrs.resolve(user, m.idp_attribute, ctx));
  for (const s of sp.statics) add(s.name, [s.value]);
  const memberOf = new Set(ctx.groups.map((g) => g.id));
  for (const r of sp.roles) if (memberOf.has(r.group_id)) add(r.saml_name, [r.role_value]);
  if (sp.groups_attribute) add(sp.groups_attribute, ctx.groups.map((g) => g.name));
  // Groups provisioned by Grouper go out under the attribute name the administrator chose in the Grouper settings.
  if (sp.grouper_groups) {
    const g = appSettings.grouper();
    if (g.enabled && g.attributeName) add(g.attributeName, attrs.resolve(user, 'grouper_groups', ctx));
  }
  const { rules } = sp.transform_enabled ? parseRules(sp.transform_rules) : { rules: [] };
  if (rules.length) ruleErrors.push(...applyRules(rules, out, (key) => attrs.resolveKnown(user, key, ctx)));
  for (const [name, values] of out) transformed.set(name, values);
  if (sp.transform_enabled) for (const name of sp.transform_temp_attrs || []) out.delete(name);
  // Authentication-method claims are for the apps registered here; federation SPs get only what the release policy names.
  if (!sp.federated) {
    add(AMR_CLAIM, amr.map((a) => AMR_MS[a]).filter(Boolean));
    add('amr', amr);
  }
  return [...out].map(([name, values]) => ({ name, values }));
}

// eduPersonTargetedID is the one common attribute whose value is a <saml:NameID> element rather than a string.
const EPTID_NAME = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.10';
const FRIENDLY_NAMES = {
  'urn:oid:1.3.6.1.4.1.5923.1.1.1.6': 'eduPersonPrincipalName', 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9': 'eduPersonScopedAffiliation',
  'urn:oid:1.3.6.1.4.1.5923.1.1.1.1': 'eduPersonAffiliation', [EPTID_NAME]: 'eduPersonTargetedID',
  'urn:oid:1.3.6.1.4.1.25178.1.2.9': 'schacHomeOrganization', 'urn:oid:0.9.2342.19200300.100.1.3': 'mail',
  'urn:oid:2.16.840.1.113730.3.1.241': 'displayName', 'urn:oid:2.5.4.42': 'givenName', 'urn:oid:2.5.4.4': 'sn',
};

function attributeXml({ name, values }, sp) {
  const fmt = /^(urn:|https?:\/\/)/.test(name) ? ATTR_URI : ATTR_UNSPECIFIED;
  const friendly = sp.federated && FRIENDLY_NAMES[name] ? ` FriendlyName="${FRIENDLY_NAMES[name]}"` : '';
  if (sp.federated && name === EPTID_NAME) {
    const nameIds = values.map((v) => `<saml:AttributeValue><saml:NameID Format="${NAMEID_FORMATS.persistent}" NameQualifier="${esc(sp.urls.entityId)}" SPNameQualifier="${esc(sp.sp_entity_id)}">${esc(v)}</saml:NameID></saml:AttributeValue>`).join('');
    return `<saml:Attribute Name="${esc(name)}"${friendly} NameFormat="${fmt}">${nameIds}</saml:Attribute>`;
  }
  const vs = values.map((v) => `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${esc(v)}</saml:AttributeValue>`).join('');
  return `<saml:Attribute Name="${esc(name)}"${friendly} NameFormat="${fmt}">${vs}</saml:Attribute>`;
}

/**
 * Build the (signed per SP settings) SAML Response.
 * pending: { acsUrl, inResponseTo? }  login: { amr: [...], authnInstant: Date, sessionIndex }
 */
function buildResponse({ sp, user, pending, login }) {
  const ctx = { groups: attrs.userGroups(user.id), custom: attrs.userCustom(user.id), sp };
  const now = new Date();
  const transformed = new Map();
  const attributeList = buildAttributes(sp, user, ctx, login.amr, [], transformed);
  const nameId = nameIdFor(sp, user, ctx, transformed);
  const nameIdFormat = NAMEID_FORMATS[sp.nameid_format];
  const audience = sp.sp_entity_id || pending.acsUrl;
  const irt = pending.inResponseTo ? ` InResponseTo="${esc(pending.inResponseTo)}"` : '';
  const assertionId = newId();
  const responseId = newId();
  const issuer = `<saml:Issuer>${esc(sp.urls.entityId)}</saml:Issuer>`;

  let assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${isoTime(now)}" Version="2.0">`
    + issuer
    + `<saml:Subject><saml:NameID Format="${nameIdFormat}"${sp.federated && sp.nameid_format === 'persistent' ? ` NameQualifier="${esc(sp.urls.entityId)}"` : ''}${sp.sp_entity_id ? ` SPNameQualifier="${esc(sp.sp_entity_id)}"` : ''}>${esc(nameId)}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">`
    + `<saml:SubjectConfirmationData${irt} NotOnOrAfter="${isoTime(new Date(now.getTime() + VALIDITY_MS))}" Recipient="${esc(pending.acsUrl)}"/>`
    + `</saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${isoTime(new Date(now.getTime() - NOTBEFORE_SKEW_MS))}" NotOnOrAfter="${isoTime(new Date(now.getTime() + VALIDITY_MS))}">`
    + `<saml:AudienceRestriction><saml:Audience>${esc(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${isoTime(login.authnInstant)}" SessionIndex="${login.sessionIndex}">`
    + `<saml:AuthnContext><saml:AuthnContextClassRef>${login.amr.includes('otp') ? AC_TOTP : AC_PASSWORD}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attributeList.map((a) => attributeXml(a, sp)).join('')}</saml:AttributeStatement>`
    + `</saml:Assertion>`;

  if (sp.sign_assertion) {
    assertion = signElement(assertion, {
      rootXpath: `/${local('Assertion')}`,
      issuerXpath: `/${local('Assertion')}/${local('Issuer')}`,
      sp,
    });
  }
  if (sp.encrypt_assertion && sp.encryption_cert_pem) assertion = encryptAssertion(assertion, sp);

  let response = `<samlp:Response ${NS} ID="${responseId}"${irt} Version="2.0" IssueInstant="${isoTime(now)}" Destination="${esc(pending.acsUrl)}">`
    + issuer
    + `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
    + assertion
    + `</samlp:Response>`;

  if (sp.sign_response) response = signResponseRoot(response, sp);
  return { xml: response, nameId, nameIdFormat, attributes: attributeList };
}

function signResponseRoot(xml, sp) {
  return signElement(xml, {
    rootXpath: `/${local('Response')}`,
    issuerXpath: `/${local('Response')}/${local('Issuer')}`,
    sp,
  });
}

// Error status response (e.g. NoPassive for IsPassive requests when no session exists). Always signed.
function buildStatusResponse({ sp, pending, status }) {
  const irt = pending.inResponseTo ? ` InResponseTo="${esc(pending.inResponseTo)}"` : '';
  const xml = `<samlp:Response ${NS} ID="${newId()}"${irt} Version="2.0" IssueInstant="${isoTime()}" Destination="${esc(pending.acsUrl)}">`
    + `<saml:Issuer>${esc(sp.urls.entityId)}</saml:Issuer>`
    + `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"><samlp:StatusCode Value="${esc(status)}"/></samlp:StatusCode></samlp:Status>`
    + `</samlp:Response>`;
  return signResponseRoot(xml, sp);
}

function buildLogoutRequest({ sp, nameId, nameIdFormat, sessionIndex }) {
  const xml = `<samlp:LogoutRequest ${NS} ID="${newId()}" Version="2.0" IssueInstant="${isoTime()}" Destination="${esc(sp.slo_url)}" NotOnOrAfter="${isoTime(new Date(Date.now() + VALIDITY_MS))}">`
    + `<saml:Issuer>${esc(sp.urls.entityId)}</saml:Issuer>`
    + `<saml:NameID Format="${esc(nameIdFormat)}">${esc(nameId)}</saml:NameID>`
    + `<samlp:SessionIndex>${esc(sessionIndex)}</samlp:SessionIndex>`
    + `</samlp:LogoutRequest>`;
  return signElement(xml, {
    rootXpath: `/${local('LogoutRequest')}`,
    issuerXpath: `/${local('LogoutRequest')}/${local('Issuer')}`,
    sp,
  });
}

function buildLogoutResponse({ sp, inResponseTo, success = true }) {
  const code = success ? 'urn:oasis:names:tc:SAML:2.0:status:Success' : 'urn:oasis:names:tc:SAML:2.0:status:Responder';
  const xml = `<samlp:LogoutResponse ${NS} ID="${newId()}" InResponseTo="${esc(inResponseTo)}" Version="2.0" IssueInstant="${isoTime()}" Destination="${esc(sp.slo_url)}">`
    + `<saml:Issuer>${esc(sp.urls.entityId)}</saml:Issuer>`
    + `<samlp:Status><samlp:StatusCode Value="${code}"/></samlp:Status>`
    + `</samlp:LogoutResponse>`;
  return signElement(xml, {
    rootXpath: `/${local('LogoutResponse')}`,
    issuerXpath: `/${local('LogoutResponse')}/${local('Issuer')}`,
    sp,
  });
}

module.exports = { buildAttributes, nameIdFor, buildResponse, buildStatusResponse, buildLogoutRequest, buildLogoutResponse, AMR_CLAIM };
