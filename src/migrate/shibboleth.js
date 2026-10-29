const { parseXml } = require('../saml/xml');
const { fromEntity, guessIdpAttribute, kids } = require('../saml/sp-metadata');
const { str } = require('./common');
const appSettings = require('../app-settings');

// Shibboleth Identity Provider files. A Shibboleth IdP keeps no users of its own (it signs people in against LDAP or another
// directory), so what moves is its relationships: the service providers it trusts (metadata), what it releases to each
// (attribute-filter.xml, with the names from attribute-resolver.xml), per-relying-party signing and encryption choices
// (relying-party.xml), and a few facts from idp.properties that the administrator needs for the cut-over.

const descendants = (el, name, out = []) => {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    if (n.localName === name) out.push(n);
    descendants(n, name, out);
  }
  return out;
};
const attrOf = (el, local) => {
  for (let i = 0; i < el.attributes.length; i++) if (el.attributes[i].localName === local) return el.attributes[i].value;
  return '';
};

/** Every SPSSODescriptor entity in a metadata file (one entity or a whole federation's worth). */
function metadata(text, bundle, file) {
  const doc = parseXml(text);
  const entities = descendants(doc.documentElement, 'EntityDescriptor');
  if (doc.documentElement.localName === 'EntityDescriptor') entities.unshift(doc.documentElement);
  let idp = 0;
  const before = bundle.sps.length;
  const seen = new Set();
  for (const e of entities) {
    const id = e.getAttribute('entityID');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!kids(e, 'SPSSODescriptor').length) { if (kids(e, 'IDPSSODescriptor').length) idp++; continue; }
    try {
      const m = fromEntity(e);
      const org = kids(e, 'Organization')[0];
      const orgName = org && (descendants(org, 'OrganizationDisplayName')[0] || descendants(org, 'OrganizationName')[0]);
      const svc = descendants(e, 'ServiceName')[0];
      bundle.sps.push({
        name: str((svc && svc.textContent) || (orgName && orgName.textContent)) || id, entityId: m.sp_entity_id, acsUrls: m.acs_urls, sloUrl: m.slo_url,
        nameidFormat: m.nameid_format, signingCert: m.signing_cert_pem, encryptionCert: m.encryption_cert_pem, maps: m.maps, requested: m.maps,
        signResponse: true, signAssertion: true, encrypt: false, file,
      });
    } catch (err) {
      bundle.notes.push(`${file}: ${id}: ${err.message}`);
    }
  }
  if (idp && bundle.sps.length === before) bundle.notes.push(`${file} describes an identity provider, not service providers. Its signing key cannot be imported: each ${appSettings.productName()} application has its own certificate, so give every service provider the new metadata.`);
  else if (idp) bundle.notes.push(`${file}: ${idp} identity provider entr${idp === 1 ? 'y was' : 'ies were'} skipped.`);
}

/** attribute-resolver.xml: for each attribute the IdP can release, its source attribute and the SAML names it is sent under. */
function resolver(text, ctx) {
  const doc = parseXml(text);
  for (const d of descendants(doc.documentElement, 'AttributeDefinition')) {
    const id = d.getAttribute('id');
    if (!id) continue;
    const names = [];
    for (const enc of kids(d, 'AttributeEncoder')) {
      const n = enc.getAttribute('name');
      if (n) names.push({ saml_name: n, friendly: enc.getAttribute('friendlyName') || '' });
    }
    ctx.definitions.set(id, { id, source: attrOf(d, 'sourceAttributeID') || id, names });
  }
}

/** attribute-filter.xml: which attributes each requester (or everyone) may receive. */
function filter(text, ctx) {
  const doc = parseXml(text);
  for (const p of descendants(doc.documentElement, 'AttributeFilterPolicy')) {
    const rule = kids(p, 'PolicyRequirementRule')[0];
    const requesters = [];
    let all = false;
    if (rule) {
      const walk = (r) => {
        const t = attrOf(r, 'type');
        if (t === 'ANY') all = true;
        else if (t === 'Requester' || t === 'RequesterRegex') requesters.push({ regex: t === 'RequesterRegex', value: r.getAttribute('value') || r.getAttribute('regex') || '' });
        else if (t === 'OR') for (const c of kids(r, 'Rule')) walk(c);
        else if (t === 'AND' || t === 'NOT') ctx.complex = true;
      };
      walk(rule);
    }
    const released = [];
    for (const ar of kids(p, 'AttributeRule')) {
      const id = ar.getAttribute('attributeID');
      const permit = kids(ar, 'PermitValueRule')[0];
      const denyAll = kids(ar, 'DenyValueRule').length > 0 && !permit;
      if (id && !denyAll) {
        const t = permit ? attrOf(permit, 'type') : '';
        if (t && t !== 'ANY') ctx.valueRules = true;
        released.push(id);
      }
    }
    ctx.policies.push({ all, requesters, released });
  }
}

/** relying-party.xml (IdP 3 and later): signing and encryption overrides for named relying parties. */
function relyingParty(text, ctx) {
  const doc = parseXml(text);
  const beans = descendants(doc.documentElement, 'bean');
  for (const b of beans) {
    const parent = b.getAttribute('parent') || '';
    if (!/^RelyingParty(ByName|ByTag)?$/.test(parent) && !b.getAttribute('c:relyingPartyIds')) continue;
    const ids = [];
    const direct = b.getAttribute('c:relyingPartyIds') || '';
    if (direct) ids.push(...direct.replace(/^\{|\}$/g, '').split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean));
    for (const v of descendants(b, 'value')) { const t = v.textContent.trim(); if (/^https?:|^urn:/.test(t)) ids.push(t); }
    const prof = descendants(b, 'bean').find((x) => /SAML2\.SSO|SAML2\.Logout/.test(x.getAttribute('parent') || '')) || b;
    const flag = (name) => {
      const v = attrOf(prof, name) || (descendants(prof, 'property').find((p) => p.getAttribute('name') === name) || { getAttribute: () => '' }).getAttribute('value');
      return v === '' || v === undefined ? undefined : String(v).trim().toLowerCase() === 'true';
    };
    const o = { signAssertion: flag('signAssertions'), signResponse: flag('signResponses'), encrypt: flag('encryptAssertions') };
    for (const id of ids) ctx.overrides.set(id, o);
  }
}

/** idp.properties and ldap.properties: facts for the cut-over, not settings. */
function properties(text, bundle, file) {
  const get = (k) => { const m = text.match(new RegExp(`^\\s*${k.replace(/\./g, '\\.')}\\s*[=:]\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
  const entity = get('idp.entityID');
  if (entity) bundle.notes.push(`This Shibboleth IdP's entityID is ${entity}${get('idp.scope') ? ` (scope ${get('idp.scope')})` : ''}. ${appSettings.productName()} gives each application its own entityID and endpoints, so every service provider needs the new metadata (Applications → the application → IdP metadata) before you switch it over.`);
  const ldap = get('idp.authn.LDAP.ldapURL');
  if (ldap) bundle.notes.push(`${file}: people sign in against ${ldap}${get('idp.authn.LDAP.baseDN') ? ` (base ${get('idp.authn.LDAP.baseDN')})` : ''}. Add the same directory under External systems → Directories so those people can keep signing in; Shibboleth has no user list to import.`);
}

const forEntity = (ctx, entityId) => {
  let released = null;
  for (const p of ctx.policies) {
    const hit = p.all || p.requesters.some((r) => (r.regex ? safeRegex(r.value).test(entityId) : r.value === entityId));
    if (hit) released = [...(released || []), ...p.released];
  }
  return released;
};
function safeRegex(v) { try { return new RegExp(v); } catch { return /$^/; } }

/** Joins what was read: each service provider gets the attributes released to it and its relying-party overrides. */
function finish(bundle, ctx) {
  for (const sp of bundle.sps) {
    const o = ctx.overrides.get(sp.entityId);
    if (o) {
      if (o.signAssertion !== undefined) sp.signAssertion = o.signAssertion;
      if (o.signResponse !== undefined) sp.signResponse = o.signResponse;
      if (o.encrypt !== undefined) sp.encrypt = o.encrypt && Boolean(sp.encryptionCert);
    }
    if (!sp.signAssertion && !sp.signResponse) sp.signAssertion = true;
    const released = ctx.policies.length ? forEntity(ctx, sp.entityId) : null;
    if (released) {
      const maps = [];
      for (const id of new Set(released)) {
        const def = ctx.definitions.get(id);
        const idp = guessIdpAttribute(def ? def.source : id) || guessIdpAttribute(id);
        const names = def && def.names.length ? def.names.map((n) => n.saml_name) : [id];
        for (const n of names) {
          if (idp) maps.push({ saml_name: n, idp_attribute: idp });
          else bundle.notes.push(`${sp.name}: attribute "${id}"${def ? ` (from ${def.source})` : ''} has no matching ${appSettings.productName()} attribute and was not mapped. Add it as a custom attribute and map it by hand.`);
        }
      }
      sp.maps = maps;
    } else if (ctx.policies.length) {
      sp.maps = [];
    }
    sp.maps = dedupe(sp.maps);
  }
  if (ctx.complex) bundle.notes.push('attribute-filter.xml uses AND/NOT rules, which were not translated: check what each application receives.');
  if (ctx.valueRules) bundle.notes.push(`attribute-filter.xml limits some attributes to particular values. ${appSettings.productName()} releases the whole attribute; use a transformation rule on the application if you need to narrow it.`);
}
const dedupe = (maps) => { const seen = new Set(); return maps.filter((m) => { const k = `${m.saml_name}|${m.idp_attribute}`; if (seen.has(k)) return false; seen.add(k); return true; }); };

module.exports = { metadata, resolver, filter, relyingParty, properties, finish, newContext: () => ({ definitions: new Map(), policies: [], overrides: new Map(), complex: false, valueRules: false }) };
