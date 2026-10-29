const { userFromRecord, csvRecords, jsonValue, listOf, str, arr, flat } = require('./common');
const { guessIdpAttribute } = require('../saml/sp-metadata');
const appSettings = require('../app-settings');

// Microsoft: Entra ID (Azure AD) portal downloads and Microsoft Graph JSON, Active Directory exports (Get-ADUser, Get-ADGroup
// piped to Export-Csv or ConvertTo-Json), and AD FS relying party trusts (Get-AdfsRelyingPartyTrust | ConvertTo-Json).

function userRecord(u) {
  const get = (...k) => { for (const x of k) if (u[x] !== undefined && u[x] !== null && u[x] !== '') return u[x]; return undefined; };
  const rec = {
    userPrincipalName: get('userPrincipalName', 'UserPrincipalName'), sAMAccountName: get('onPremisesSamAccountName', 'SamAccountName', 'sAMAccountName'),
    givenName: get('givenName', 'GivenName'), surname: get('surname', 'Surname'), displayName: get('displayName', 'DisplayName', 'Name'),
    mail: get('mail', 'EmailAddress', 'Mail'), employeeId: get('employeeId', 'EmployeeID', 'EmployeeNumber'), department: get('department', 'Department'),
    jobTitle: get('jobTitle', 'Title'), businessPhones: arr(u.businessPhones)[0] || get('OfficePhone', 'telephoneNumber'), mobilePhone: get('mobilePhone', 'MobilePhone'),
    mailNickname: get('mailNickname'), companyName: get('companyName', 'Company'), manager: u.manager && u.manager.userPrincipalName || get('Manager'),
    officeLocation: get('officeLocation', 'Office'), streetAddress: get('streetAddress', 'StreetAddress'), city: get('city', 'City'), state: get('state', 'State'),
    postalCode: get('postalCode', 'PostalCode'), country: get('country', 'Country'), description: get('description', 'Description'),
    distinguishedName: get('onPremisesDistinguishedName', 'DistinguishedName'), accountEnabled: get('accountEnabled', 'Enabled'),
  };
  return rec;
}

function users(text, bundle, opts) {
  const json = jsonValue(text);
  const recs = json === undefined ? csvRecords(text) : listOf(json).map(userRecord);
  for (const r of recs) {
    const u = userFromRecord(r, opts);
    if (u) bundle.users.push(u);
  }
}

const memberKey = (m) => (typeof m === 'string' ? m : m && (m.userPrincipalName || m.UserPrincipalName || m.SamAccountName || m.mail || m.displayName || m.distinguishedName));

function groups(text, bundle) {
  const json = jsonValue(text);
  const list = json === undefined ? csvRecords(text) : listOf(json);
  for (const g of list) {
    const name = str(g.displayName || g.DisplayName || g.Name || g.name);
    if (!name) continue;
    const members = [];
    const parents = [];
    for (const m of arr(g.members || g.Members)) {
      const isGroup = m && typeof m === 'object' && /group/i.test(m['@odata.type'] || m.objectClass || '');
      const key = memberKey(m);
      if (!key) continue;
      if (isGroup) bundle.groups.push({ name: str(m.displayName || m.Name || key), description: '', members: [], parents: [name], placeholder: true });
      else members.push(String(key).toLowerCase());
    }
    // AD's Get-ADGroup -Properties MemberOf: the groups this one sits inside.
    for (const p of arr(g.memberOf || g.MemberOf)) { const k = memberKey(p); if (k) parents.push(String(k)); }
    // A CSV cell of several members.
    const csvMembers = typeof g.members === 'string' ? g.members.split(/[;|]/).map((x) => x.trim().toLowerCase()).filter(Boolean) : [];
    bundle.groups.push({ name, description: str(g.description || g.Description), members: [...members, ...csvMembers], parents, dn: str(g.distinguishedName || g.DistinguishedName) });
  }
}

const first = (list, test) => arr(list).map(str).find(test) || '';

function servicePrincipals(text, bundle) {
  for (const sp of listOf(jsonValue(text))) {
    const name = str(sp.displayName);
    if (sp.preferredSingleSignOnMode === 'saml' || (arr(sp.replyUrls).length && sp.preferredSingleSignOnMode !== 'oidc' && sp.preferredSingleSignOnMode !== 'password')) {
      const entity = first(sp.servicePrincipalNames, (n) => n && n !== sp.appId && /^(https?:|urn:)/.test(n)) || first(sp.identifierUris, Boolean);
      bundle.sps.push({
        name, entityId: entity, acsUrls: arr(sp.replyUrls).map(str).filter(Boolean), sloUrl: str(sp.logoutUrl), nameidFormat: '', signingCert: '', encryptionCert: '',
        maps: [], signResponse: true, signAssertion: true, encrypt: false, relayState: str(sp.samlSingleSignOnSettings && sp.samlSingleSignOnSettings.relayState),
        disabled: sp.accountEnabled === false,
      });
      bundle.notes.push(`${name}: Entra does not export the attributes it sends. Map them on the new application (it starts with the usual email and name set).`);
    } else {
      bundle.notes.push(`Entra enterprise application "${name}" uses ${sp.preferredSingleSignOnMode || 'no single sign-on method'}, which has no ${appSettings.productName()} equivalent. It was not imported.`);
    }
  }
}

function applications(text, bundle) {
  for (const a of listOf(jsonValue(text))) {
    const name = str(a.displayName);
    const web = arr(a.web && a.web.redirectUris);
    const spa = arr(a.spa && a.spa.redirectUris);
    const pub = arr(a.publicClient && a.publicClient.redirectUris);
    const uris = [...new Set([...web, ...spa, ...pub].map(str).filter(Boolean))];
    if (!uris.length) { bundle.notes.push(`Entra app registration "${name}" has no redirect URIs, so it was not imported.`); continue; }
    bundle.apps.push({
      protocol: 'oidc', name, description: '', redirectUris: uris, postLogoutUris: [str(a.web && a.web.logoutUrl)].filter(Boolean),
      grantTypes: ['authorization_code', 'refresh_token'], confidential: web.length > 0 && !spa.length && !pub.length, sourceClientId: str(a.appId),
    });
  }
}

// AD FS issuance rules: pairs of claim type and LDAP attribute out of `types = ("t1","t2"), query = ";a1,a2;{0},{1}"`.
function claimMaps(rules) {
  const maps = [];
  for (const m of String(rules || '').matchAll(/types\s*=\s*\(([^)]*)\)\s*,\s*query\s*=\s*"([^"]*)"/gi)) {
    const types = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    const attrs = (m[2].split(';')[1] || '').split(',').map((x) => x.trim());
    types.forEach((t, i) => {
      const idp = guessIdpAttribute(attrs[i] || '') || guessIdpAttribute(t);
      if (idp && t) maps.push({ saml_name: t, idp_attribute: idp });
    });
  }
  return maps;
}

function adfsTrusts(text, bundle) {
  for (const t of listOf(jsonValue(text))) {
    const name = str(t.Name);
    const post = arr(t.SamlEndpoints).filter((e) => /consumer|assertion/i.test(String(e.Protocol || 'SAMLAssertionConsumer')) || e.Protocol === undefined);
    const acs = post.map((e) => str(e.Location)).filter(Boolean);
    const slo = arr(t.SamlEndpoints).find((e) => /logout/i.test(String(e.Protocol || '')));
    const sig = String(t.SamlResponseSignature || '');
    const fmt = String(t.NameIdentifierFormat || '');
    const entity = first(t.Identifier, (x) => /^(https?:|urn:)/.test(x));
    if (!entity) { bundle.notes.push(`AD FS trust "${name}" has no identifier, so it was not imported.`); continue; }
    if (arr(t.Identifier).length > 1) bundle.notes.push(`AD FS trust "${name}" has several identifiers; ${entity} was used.`);
    if (/WS-?Federation|WSFed/i.test(String(t.WSFedEndpoint || '')) && !acs.length) bundle.notes.push(`AD FS trust "${name}" is WS-Federation only, which ${appSettings.productName()} does not speak. It was not imported.`);
    bundle.sps.push({
      name, entityId: entity, acsUrls: acs, sloUrl: slo ? str(slo.Location) : '', nameidFormat: /emailAddress/i.test(fmt) ? 'emailAddress' : /transient/i.test(fmt) ? 'transient' : /persistent/i.test(fmt) ? 'persistent' : '',
      signingCert: '', encryptionCert: '', maps: claimMaps(t.IssuanceTransformRules), signResponse: !/AssertionOnly/i.test(sig), signAssertion: !/MessageOnly/i.test(sig),
      encrypt: false, disabled: t.Enabled === false,
    });
    if (t.IssuanceTransformRules) bundle.notes.push(`${name}: AD FS claim rules were read for attribute names only. Rules that compute values (regex, conditions, group claims) were not translated; check the application's transformations.`);
  }
}

module.exports = { users, groups, servicePrincipals, applications, adfsTrusts, flat };
