process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { createApp, seedAdmin } = require('../src/server');
const migrate = require('../src/migrate');
const exporter = require('../src/export');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

function client() {
  let cookie = ''; let csrf = '';
  const call = async (path, { method = 'GET', body, raw, headers: extra = {} } = {}) => {
    const headers = { cookie, ...extra };
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (raw !== undefined) headers['content-type'] = 'application/octet-stream';
    const r = await fetch(base + path, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: r.status, json, text, buf, headers: r.headers };
  };
  const login = async (u, p) => {
    csrf = (await call('/api/session')).json.csrf;
    await call('/api/login', { method: 'POST', body: { username: u, password: p } });
    csrf = (await call('/api/session')).json.csrf;
  };
  return { call, login };
}
const admin = client();
test('sign in', async () => { await admin.login('admin', 'adminpass123'); });

const upload = async (c, name, kind, content) => {
  const r = await c.call(`/api/admin/migrate/files?name=${encodeURIComponent(name)}&kind=${kind}`, { method: 'POST', raw: Buffer.isBuffer(content) ? content : Buffer.from(content) });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
};

const SP_METADATA = `<?xml version="1.0"?>
<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <md:EntityDescriptor entityID="https://wiki.example.net/shibboleth">
    <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
      <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://wiki.example.net/Shibboleth.sso/SAML2/POST" index="1"/>
      <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://wiki.example.net/Shibboleth.sso/SLO/POST"/>
    </md:SPSSODescriptor>
    <md:Organization><md:OrganizationName xml:lang="en">Wiki</md:OrganizationName><md:OrganizationDisplayName xml:lang="en">Campus Wiki</md:OrganizationDisplayName><md:OrganizationURL xml:lang="en">https://wiki.example.net</md:OrganizationURL></md:Organization>
  </md:EntityDescriptor>
  <md:EntityDescriptor entityID="https://hr.example.net/sp">
    <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://hr.example.net/acs" index="1"/>
    </md:SPSSODescriptor>
  </md:EntityDescriptor>
  <md:EntityDescriptor entityID="https://idp.old.example.net/idp/shibboleth">
    <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.old.example.net/sso"/></md:IDPSSODescriptor>
  </md:EntityDescriptor>
</md:EntitiesDescriptor>`;

const RESOLVER = `<AttributeResolver xmlns="urn:mace:shibboleth:2.0:resolver" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:enc="urn:mace:shibboleth:2.0:attribute:encoder">
  <AttributeDefinition id="mail" xsi:type="Simple" sourceAttributeID="mail"><AttributeEncoder xsi:type="enc:SAML2String" name="urn:oid:0.9.2342.19200300.100.1.3" friendlyName="mail"/></AttributeDefinition>
  <AttributeDefinition id="surname" xsi:type="Simple" sourceAttributeID="sn"><AttributeEncoder xsi:type="enc:SAML2String" name="urn:oid:2.5.4.4" friendlyName="sn"/></AttributeDefinition>
  <AttributeDefinition id="affiliation" xsi:type="Simple" sourceAttributeID="eduPersonScopedAffiliation"><AttributeEncoder xsi:type="enc:SAML2String" name="urn:oid:1.3.6.1.4.1.5923.1.1.1.9"/></AttributeDefinition>
</AttributeResolver>`;

const FILTER = `<AttributeFilterPolicyGroup xmlns="urn:mace:shibboleth:2.0:afp" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <AttributeFilterPolicy id="wiki"><PolicyRequirementRule xsi:type="Requester" value="https://wiki.example.net/shibboleth"/>
    <AttributeRule attributeID="mail"><PermitValueRule xsi:type="ANY"/></AttributeRule>
    <AttributeRule attributeID="surname"><PermitValueRule xsi:type="ANY"/></AttributeRule>
    <AttributeRule attributeID="affiliation"><PermitValueRule xsi:type="ANY"/></AttributeRule>
  </AttributeFilterPolicy>
</AttributeFilterPolicyGroup>`;

const RELYING = `<beans xmlns="http://www.springframework.org/schema/beans" xmlns:p="http://www.springframework.org/schema/p" xmlns:c="http://www.springframework.org/schema/c">
  <bean parent="RelyingPartyByName" c:relyingPartyIds="https://hr.example.net/sp">
    <property name="profileConfigurations"><list><bean parent="SAML2.SSO" p:signAssertions="false" p:signResponses="true"/></list></property>
  </bean>
</beans>`;

test('Shibboleth files: service providers, what each is released, and relying-party overrides', async () => {
  await upload(admin, 'sp-metadata.xml', 'saml-metadata', SP_METADATA);
  await upload(admin, 'attribute-resolver.xml', 'shib-attribute-resolver', RESOLVER);
  await upload(admin, 'attribute-filter.xml', 'shib-attribute-filter', FILTER);
  await upload(admin, 'relying-party.xml', 'shib-relying-party', RELYING);
  await upload(admin, 'idp.properties', 'shib-properties', 'idp.entityID = https://idp.old.example.net/idp/shibboleth\nidp.scope = example.net\n');
  const p = await admin.call('/api/admin/migrate/preview', { method: 'POST', body: { source: 'shibboleth' } });
  assert.equal(p.status, 200, p.text);
  assert.deepEqual(p.json.files.map((f) => f.kind), ['saml-metadata', 'shib-attribute-resolver', 'shib-attribute-filter', 'shib-relying-party', 'shib-properties']);
  assert.equal(p.json.counts.sps, 2);
  assert.ok(p.json.notes.some((n) => /entityID is https:\/\/idp\.old/.test(n)));
  assert.ok(p.json.notes.some((n) => /eduPersonScopedAffiliation/.test(n)), 'an unmapped attribute is reported');

  const a = await admin.call('/api/admin/migrate/apply', { method: 'POST', body: { planId: p.json.planId, options: { users: false, groups: false, apps: false } } });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.counts.sps.created, 2);
  const wiki = db.get("SELECT * FROM service_providers WHERE sp_entity_id = 'https://wiki.example.net/shibboleth'");
  assert.equal(wiki.name, 'Campus Wiki');
  assert.equal(wiki.access_mode, 'none', 'imported applications start turned off');
  assert.equal(wiki.nameid_format, 'persistent');
  assert.deepEqual(db.all('SELECT saml_name, idp_attribute FROM sp_attribute_map WHERE sp_id = ? ORDER BY saml_name', wiki.id),
    [{ saml_name: 'urn:oid:0.9.2342.19200300.100.1.3', idp_attribute: 'email' }, { saml_name: 'urn:oid:2.5.4.4', idp_attribute: 'last_name' }]);
  const hr = db.get("SELECT * FROM service_providers WHERE sp_entity_id = 'https://hr.example.net/sp'");
  assert.equal(hr.sign_assertion, 0);
  assert.equal(hr.sign_response, 1);
  assert.equal(db.all('SELECT 1 FROM sp_attribute_map WHERE sp_id = ?', hr.id).length, 0, 'the filter released nothing to this one');
});

test('applying again skips what already exists, and a used preview is gone', async () => {
  await upload(admin, 'again.xml', 'saml-metadata', SP_METADATA);
  const p = await admin.call('/api/admin/migrate/preview', { method: 'POST', body: { source: 'shibboleth' } });
  assert.equal(p.json.sps.every((s) => s.exists), true);
  const a = await admin.call('/api/admin/migrate/apply', { method: 'POST', body: { planId: p.json.planId } });
  assert.equal(a.json.counts.sps.skipped, 2);
  assert.equal((await admin.call('/api/admin/migrate/apply', { method: 'POST', body: { planId: p.json.planId } })).status, 410);
});

const OKTA_USERS = JSON.stringify([
  { id: '00u1', status: 'ACTIVE', profile: { login: 'ada@okta.example', email: 'ada@okta.example', firstName: 'Ada', lastName: 'Lovelace', department: 'Math', employeeNumber: 'E1' } },
  { id: '00u2', status: 'SUSPENDED', profile: { login: 'bob@okta.example', email: 'bob@okta.example', firstName: 'Bob', lastName: 'Barker' } },
]);
const OKTA_GROUPS = JSON.stringify([
  { id: '00g1', type: 'OKTA_GROUP', profile: { name: 'Mathematicians', description: 'People who count' }, members: ['ada@okta.example'] },
  { id: '00g2', type: 'BUILT_IN', profile: { name: 'Everyone' } },
]);
const OKTA_APPS = JSON.stringify([
  { label: 'Payroll', status: 'ACTIVE', signOnMode: 'SAML_2_0', settings: { signOn: { ssoAcsUrl: 'https://payroll.example.net/acs', audience: 'https://payroll.example.net/sp', subjectNameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', assertionSigned: true, responseSigned: true,
    attributeStatements: [{ name: 'email', type: 'EXPRESSION', values: ['user.email'] }, { name: 'tier', type: 'EXPRESSION', values: ['String.append(user.x, 1)'] }] } } },
  { label: 'Portal', status: 'ACTIVE', signOnMode: 'OPENID_CONNECT', settings: { oauthClient: { redirect_uris: ['https://portal.example.net/cb'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'client_secret_basic' } }, credentials: { oauthClient: { client_id: '0oaXYZ' } } },
  { label: 'Old tool', status: 'ACTIVE', signOnMode: 'BROWSER_PLUGIN' },
]);

test('Okta users, groups and applications', async () => {
  await upload(admin, 'users.json', 'okta-users', OKTA_USERS);
  await upload(admin, 'groups.json', 'okta-groups', OKTA_GROUPS);
  await upload(admin, 'apps.json', 'okta-apps', OKTA_APPS);
  const p = await admin.call('/api/admin/migrate/preview', { method: 'POST', body: { source: 'okta', options: { usernameFrom: 'local' } } });
  assert.deepEqual(p.json.counts, { users: 2, groups: 1, sps: 1, apps: 1 });
  assert.ok(p.json.notes.some((n) => /BROWSER_PLUGIN/.test(n)));
  assert.ok(p.json.notes.some((n) => /"tier"/.test(n)));
  const a = await admin.call('/api/admin/migrate/apply', { method: 'POST', body: { planId: p.json.planId } });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.counts.users.created, 2);
  const ada = db.get("SELECT * FROM users WHERE username = 'ada'");
  assert.equal(ada.email, 'ada@okta.example');
  assert.equal(ada.employee_id, 'E1');
  assert.equal(db.get("SELECT active FROM users WHERE username = 'bob'").active, 0);
  assert.ok(ada.password_hash, 'a password nobody knows, not an empty one');
  const g = db.get("SELECT id FROM groups WHERE name = 'Mathematicians'");
  assert.equal(db.all('SELECT 1 FROM group_members WHERE group_id = ?', g.id).length, 1);
  assert.equal(a.json.counts.apps.created, 1);
  assert.equal(a.json.secrets.length, 1, 'the new client secret is shown once');
  const app = db.get("SELECT * FROM apps WHERE name = 'Portal'");
  assert.equal(app.access_mode, 'none');
  assert.match(app.client_id, /^oidc-/);
});

test('Entra / Active Directory CSV, Graph groups with nesting, and AD FS trusts', async () => {
  const csv = 'userPrincipalName,displayName,givenName,surname,mail,department,accountEnabled,onPremisesSamAccountName\r\n'
    + 'carol@corp.example,Carol Cole,Carol,Cole,carol@corp.example,Law,true,ccole\r\ndave@corp.example,Dave Dale,Dave,Dale,dave@corp.example,Law,false,ddale\r\n';
  const groups = JSON.stringify({ value: [
    { displayName: 'Legal', description: 'Lawyers', securityEnabled: true, members: [{ '@odata.type': '#microsoft.graph.user', userPrincipalName: 'carol@corp.example' }, { '@odata.type': '#microsoft.graph.group', displayName: 'Paralegals' }] },
    { displayName: 'Paralegals', securityEnabled: true, members: [{ '@odata.type': '#microsoft.graph.user', userPrincipalName: 'dave@corp.example' }] },
  ] });
  const adfs = JSON.stringify([{ Name: 'Intranet', Identifier: ['https://intranet.corp.example/'], Enabled: true, SamlResponseSignature: 'MessageAndAssertion', NameIdentifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    SamlEndpoints: [{ Location: 'https://intranet.corp.example/saml', Binding: 'POST', Protocol: 'SAMLAssertionConsumer' }],
    IssuanceTransformRules: 'c:[Type == "x"] => issue(store = "Active Directory", types = ("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"), query = ";mail,sn;{0}", param = c.Value);' }]);
  // PowerShell's Out-File writes UTF-16 with a byte order mark.
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(adfs, 'utf16le')]);
  await upload(admin, 'EntraUsers.csv', 'ms-users', csv);
  await upload(admin, 'groups.json', 'ms-groups', groups);
  await upload(admin, 'adfs.json', 'adfs-trusts', utf16);
  const p = await admin.call('/api/admin/migrate/preview', { method: 'POST', body: { source: 'microsoft' } });
  assert.deepEqual(p.json.files.map((f) => f.kind), ['ms-users', 'ms-groups', 'adfs-trusts']);
  assert.equal(p.json.counts.users, 2);
  const a = await admin.call('/api/admin/migrate/apply', { method: 'POST', body: { planId: p.json.planId } });
  assert.equal(a.status, 200, a.text);
  assert.equal(db.get("SELECT username FROM users WHERE username = 'ccole'").username, 'ccole');
  assert.equal(db.get("SELECT upn FROM users WHERE username = 'ccole'").upn, 'carol@corp.example');
  const legal = db.get("SELECT id FROM groups WHERE name = 'Legal'");
  const para = db.get("SELECT id FROM groups WHERE name = 'Paralegals'");
  assert.ok(db.get('SELECT 1 FROM group_includes WHERE group_id = ? AND member_group_id = ?', legal.id, para.id), 'Paralegals is nested in Legal');
  const sp = db.get("SELECT * FROM service_providers WHERE name = 'Intranet'");
  assert.equal(sp.sp_entity_id, 'https://intranet.corp.example/');
  assert.deepEqual(db.all('SELECT idp_attribute FROM sp_attribute_map WHERE sp_id = ? ORDER BY id', sp.id).map((r) => r.idp_attribute), ['email', 'last_name']);
});

test('uploads need a known slot, a one-file slot keeps the latest upload, and a file that matches nothing is noted', async () => {
  assert.equal((await admin.call('/api/admin/migrate/files?name=x.json&kind=nope', { method: 'POST', raw: Buffer.from('[]') })).status, 400);
  assert.equal((await admin.call('/api/admin/migrate/preview', { method: 'POST', body: { source: 'nope' } })).status, 400);
  await upload(admin, 'first.json', 'okta-apps', OKTA_APPS);
  await upload(admin, 'second.json', 'okta-apps', OKTA_APPS);
  const listed = (await admin.call('/api/admin/migrate')).json.files.filter((f) => f.kind === 'okta-apps');
  assert.deepEqual(listed.map((f) => f.name), ['second.json']);
  await upload(admin, 'mystery.csv', 'okta-users', 'nothing to see');
  const p = await admin.call('/api/admin/migrate/preview', { method: 'POST', body: { source: 'okta' } });
  assert.equal(p.status, 200, p.text);
  assert.ok(p.json.notes.some((n) => /mystery\.csv: nothing in it matched users/.test(n)));
});

test('people with a different permission cannot use the tools', async () => {
  const { hashPassword } = require('../src/crypto');
  const { newGuid } = require('../src/guid');
  const u = db.run("INSERT INTO users (guid, username, password_hash, display_name, email) VALUES (?, 'viewer', ?, 'V', 'v@example.net')", newGuid(), hashPassword('Viewer long passphrase 9!'));
  const helpdesk = db.get("SELECT id FROM roles WHERE key = 'helpdesk'");
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', Number(u.lastInsertRowid), helpdesk.id);
  const low = client();
  await low.login('viewer', 'Viewer long passphrase 9!');
  assert.equal((await low.call('/api/admin/migrate')).status, 403);
  assert.equal((await low.call('/api/admin/export')).status, 403);
});

test('export: parts follow the permissions, secrets never leave, and zip carries users.csv', async () => {
  const json = await admin.call('/api/admin/export/download?include=config,users,groups,integrations');
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-disposition'), /simpleidp-export-.*\.json/);
  const doc = json.json;
  assert.equal(doc.format, 'simpleidp-export');
  assert.deepEqual(doc.parts, ['config', 'users', 'groups', 'integrations']);
  const text = json.text;
  assert.ok(!/password_hash|totp_secret|private_key_pem|client_secret_hash|session_secret/.test(text), 'no secrets in the document');
  assert.ok(doc.users.find((u) => u.username === 'ccole' && u.groups.some((g) => g.name === 'Legal')));
  assert.ok(doc.groups.groups.find((g) => g.name === 'Legal').includes.includes('Paralegals'));
  assert.ok(doc.config.service_providers.find((s) => s.name === 'Intranet').attribute_map.length === 2);
  assert.ok(doc.integrations.functions.length > 0, 'starter functions are exported');
  // A secret variable's value is left out.
  db.run("INSERT INTO integration_variables (name, value, secret) VALUES ('API_KEY', 'hunter2', 1)");
  assert.ok(!(await admin.call('/api/admin/export/download?include=integrations')).text.includes('hunter2'));

  const zip = await admin.call('/api/admin/export/download?include=users&format=zip');
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.ok(zip.buf.includes(Buffer.from('users.csv')));
  assert.equal((await admin.call('/api/admin/export/download')).status, 400);
});

test('CSV cells that would run as spreadsheet formulas are neutralised', () => {
  const csv = exporter.usersCsv([{ username: '=cmd|x', groups: [], roles: [], active: true }]);
  assert.ok(csv.split('\r\n')[1].startsWith("'=cmd|x"));
});

test('exporting a part needs that part\'s view permission', async () => {
  const { hashPassword } = require('../src/crypto');
  const { newGuid } = require('../src/guid');
  const rid = Number(db.run("INSERT INTO roles (key, name) VALUES ('exporter', 'Exporter')").lastInsertRowid);
  db.run("INSERT INTO role_permissions (role_id, permission) VALUES (?, 'export.manage')", rid);
  const u = db.run("INSERT INTO users (guid, username, password_hash, display_name, email) VALUES (?, 'exp', ?, 'E', 'e@example.net')", newGuid(), hashPassword('Exporter long passphrase 9!'));
  db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', Number(u.lastInsertRowid), rid);
  const c = client();
  await c.login('exp', 'Exporter long passphrase 9!');
  assert.equal((await c.call('/api/admin/export/download?include=config')).status, 200);
  assert.equal((await c.call('/api/admin/export/download?include=users')).status, 403);
});
