const { userFromRecord, csvRecords, jsonValue, listOf, str, arr } = require('./common');
const appSettings = require('../app-settings');

// Okta exports: the users CSV from Directory → People → More actions → Export, or the API's JSON (GET /api/v1/users,
// /api/v1/groups, /api/v1/apps). Group JSON may carry its members under members, users or _embedded.users.

function userRecord(u) {
  const p = u.profile || {};
  return {
    login: p.login, email: p.email || p.secondEmail, firstName: p.firstName, lastName: p.lastName, displayName: p.displayName || `${str(p.firstName)} ${str(p.lastName)}`.trim(),
    title: p.title, department: p.department, employeeNumber: p.employeeNumber, organization: p.organization, manager: p.manager,
    primaryPhone: p.primaryPhone, mobilePhone: p.mobilePhone, streetAddress: p.streetAddress, city: p.city, state: p.state, zipCode: p.zipCode, countryCode: p.countryCode,
    status: u.status === undefined ? undefined : u.status,
  };
}

function users(text, bundle, opts) {
  const json = jsonValue(text);
  const recs = json === undefined ? csvRecords(text) : listOf(json).map(userRecord);
  for (const r of recs) {
    const u = userFromRecord(r, opts);
    if (u) bundle.users.push(u);
  }
}

function groups(text, bundle) {
  const out = [];
  for (const g of listOf(jsonValue(text))) {
    const members = [...arr(g.members), ...arr(g.users), ...arr(g._embedded && g._embedded.users)]
      .map((m) => (typeof m === 'string' ? m : m && m.profile ? m.profile.login : m && (m.login || m.username || m.email))).filter(Boolean);
    // Okta's built-in "Everyone" and app-sourced groups are not ones an administrator made.
    if (g.type === 'BUILT_IN') { bundle.notes.push(`Okta group "${g.profile.name}" is built in and was not imported.`); continue; }
    out.push({ name: str(g.profile.name), description: str(g.profile.description), members: members.map((x) => String(x).toLowerCase()), parents: [] });
  }
  bundle.groups.push(...out);
}

// Okta expression to the Pons Identity attribute that holds the same thing.
const EXPR = {
  'user.email': 'email', 'user.login': 'username', 'user.firstname': 'first_name', 'user.lastname': 'last_name', 'user.displayname': 'display_name',
  'user.title': 'title', 'user.department': 'department', 'user.employeenumber': 'employee_id', 'user.mobilephone': 'mobile', 'user.primaryphone': 'phone',
  'user.city': 'city', 'user.state': 'state', 'user.zipcode': 'postal_code', 'user.countrycode': 'country', 'user.streetaddress': 'street_address',
  'user.organization': 'company', 'user.manager': 'manager',
};
const idpFor = (expr) => EXPR[String(expr).trim().replace(/^\$\{|\}$/g, '').toLowerCase()] || '';

function apps(text, bundle) {
  for (const a of listOf(jsonValue(text))) {
    const name = str(a.label || a.name);
    if (a.status === 'INACTIVE') bundle.notes.push(`Okta app "${name}" is inactive; it was still listed so you can decide whether to keep it, and will be created turned off.`);
    const so = (a.settings && a.settings.signOn) || {};
    if (a.signOnMode === 'SAML_2_0' || a.signOnMode === 'SAML_1_1') {
      if (a.signOnMode === 'SAML_1_1') { bundle.notes.push(`Okta app "${name}" uses SAML 1.1, which ${appSettings.productName()} does not speak. It was not imported.`); continue; }
      const maps = [];
      for (const st of arr(so.attributeStatements)) {
        const v = arr(st.values)[0];
        const idp = idpFor(v);
        if (st.name && idp) maps.push({ saml_name: st.name, idp_attribute: idp });
        else if (st.name) bundle.notes.push(`${name}: attribute "${st.name}" is built from ${v || 'an expression'}, which ${appSettings.productName()} cannot read. Map it by hand.`);
      }
      const tpl = String(so.subjectNameIdTemplate || '').toLowerCase();
      const nameidSource = /user\.email/.test(tpl) ? 'email' : /user\.(login|userName)/i.test(tpl) ? 'username' : '';
      const fmt = String(so.subjectNameIdFormat || '');
      bundle.sps.push({
        name, entityId: str(so.audience), acsUrls: [so.ssoAcsUrl, ...arr(so.ssoAcsUrlOverrides).map((o) => o && o.url)].map(str).filter(Boolean), sloUrl: '',
        nameidFormat: /emailAddress/i.test(fmt) ? 'emailAddress' : /transient/i.test(fmt) ? 'transient' : /persistent/i.test(fmt) ? 'persistent' : /unspecified/i.test(fmt) ? 'unspecified' : '',
        nameidSource, signingCert: '', encryptionCert: '', maps, signResponse: so.responseSigned !== false, signAssertion: so.assertionSigned !== false, encrypt: false,
        relayState: str(so.defaultRelayState), disabled: a.status === 'INACTIVE',
      });
    } else if (a.signOnMode === 'OPENID_CONNECT') {
      const c = (a.settings && a.settings.oauthClient) || {};
      const cred = (a.credentials && a.credentials.oauthClient) || {};
      const grants = arr(c.grant_types);
      const clientCreds = grants.includes('client_credentials');
      bundle.apps.push({
        protocol: clientCreds && !grants.includes('authorization_code') ? 'oauth2' : 'oidc', name, description: '',
        redirectUris: arr(c.redirect_uris).map(str).filter(Boolean), postLogoutUris: arr(c.post_logout_redirect_uris).map(str).filter(Boolean),
        grantTypes: grants.filter((g) => ['authorization_code', 'refresh_token', 'client_credentials'].includes(g)),
        confidential: (cred.token_endpoint_auth_method || c.token_endpoint_auth_method || 'client_secret_basic') !== 'none',
        sourceClientId: str(cred.client_id || a.credentials && a.credentials.client_id), disabled: a.status === 'INACTIVE',
      });
    } else {
      bundle.notes.push(`Okta app "${name}" uses ${a.signOnMode}, which has no ${appSettings.productName()} equivalent (it signs people in by replaying a password or opens a link). It was not imported.`);
    }
  }
}

module.exports = { users, groups, apps };
