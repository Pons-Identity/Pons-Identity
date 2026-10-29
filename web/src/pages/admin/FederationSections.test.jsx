import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const CONFIG = {
  enabled: false, entityId: '', scope: '', signatureAlgorithm: 'sha256', encryptAssertions: true, encryptionAlgorithm: 'aes128-gcm',
  keyTransportAlgorithm: 'rsa-oaep-mgf1p', eppnSource: 'username', defaultAffiliation: 'member', affiliationGroups: [],
  categories: { rs: true, pseudonymous: true, personalized: false, anonymous: true, coco: false }, releaseRequired: true,
  organization: { name: '', displayName: '', url: '' }, ui: { displayName: '', description: '', informationUrl: '', privacyUrl: '' },
  contacts: { technical: { name: '', email: '' }, support: { name: '', email: '' }, security: { name: '', email: '' } }, sirtfi: false,
};
const IDP = {
  config: CONFIG, entityId: 'https://idp.test/fed/idp/metadata', defaultEntityId: 'https://idp.test/fed/idp/metadata',
  urls: { metadata: 'https://idp.test/fed/idp/metadata', signedMetadata: 'https://idp.test/fed/idp/metadata?signed=true' }, keys: null,
  categories: [{ id: 'rs', label: 'REFEDS Research & Scholarship', uri: 'http://refeds.org/category/research-and-scholarship', requestedOnly: false }],
  affiliations: ['faculty', 'member'], eppnSources: ['username', 'upn'],
  algorithms: { signature: [{ value: 'sha256', label: 'RSA-SHA256' }], encryption: [{ value: 'aes128-gcm', label: 'AES-128-GCM' }], keyTransport: [{ value: 'rsa-oaep-mgf1p', label: 'RSA-OAEP' }] },
};
const SOURCE = {
  id: 3, name: 'InCommon', url: 'https://md.incommon.org/InCommon/InCommon-metadata.xml', enabled: true, refresh_hours: 6, entity_count: 0,
  last_success_at: '', last_error: '', has_cert: true, signing_cert: { subject: 'CN=InCommon Metadata Signing', notAfter: 'Jan 1 2030', sha256: 'AA:BB' },
};
const SP = {
  config: { enabled: false, entityId: '', provisioning: 'approve', idpAllowlist: [], signRequests: true },
  entityId: 'https://idp.test/fed/sp/metadata', defaultEntityId: 'https://idp.test/fed/sp/metadata', keys: null,
  urls: { metadata: 'https://idp.test/fed/sp/metadata', acs: 'https://idp.test/fed/sp/acs', signedMetadata: 'https://idp.test/fed/sp/metadata?signed=true' },
  provisioning: ['approve', 'auto'], pending: 1,
};
const PENDING = { id: 11, idp_entity_id: 'https://idp.partner.net/idp', subject_type: 'eppn', subject: 'jdoe@partner.net', status: 'pending', provisioned: false,
  display_name: 'Jane Doe', email: 'jdoe@partner.net', first_seen_at: '2026-10-24 12:00:00', last_login_at: '', user_id: null, username: null };
const MDQ_SOURCE = { ...SOURCE, id: 8, name: 'InCommon MDQ', kind: 'mdq', url: 'https://mdq.example', entity_count: 0 };
const SOURCES = { sources: [], defaults: { incommonUrl: SOURCE.url, incommonIdpOnlyUrl: 'https://md.example/idp-only.xml', incommonMdqUrl: 'https://mdq.example', refreshHours: 6 } };

const CERT = (cn) => ({ subject: `CN=${cn}`, notAfter: 'Jan 1 2035', sha256: `${cn}:FP` });
const ENTITY_ROW = { source_id: 3, entity_id: 'https://idp.partner.net/idp', is_idp: true, is_sp: false, display_name: 'Partner Weaving Guild', valid_until: '' };
const ENTITY = { entity_id: ENTITY_ROW.entity_id, display_name: 'Partner Weaving Guild', valid_until: '2026-12-01T00:00:00.000Z',
  parsed: { registrationAuthority: 'https://incommon.org', entityAttributes: {}, organization: null,
    idp: { scopes: [{ value: 'partner.net', regexp: false }], singleSignOnServices: [], keys: [{ use: 'signing', subject: 'CN=Partner IdP', notAfter: 'Jan 1 2030', sha256: 'DE:AD' }] }, sp: null } };

const requests = [];
function mock({ alerts = [], idpKeys = null, sources = SOURCES, permissions = ['federation.view', 'federation.manage', 'users.view', 'users.manage'], refresh } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', is_admin: true, permissions }, csrf: 'c', config: {}, branding: { appName: 'X' } });
    if (path === '/api/admin/federation/sources' && opts.method === 'POST') return json(SOURCE, 201);
    if (path === '/api/admin/federation/sources') return json(sources);
    if (path.endsWith('/lookup')) return opts.method === 'POST' && JSON.parse(opts.body).entityId.includes('unknown')
      ? json({ errors: ['The service does not know that entity.'], source: MDQ_SOURCE }, 502)
      : json({ entityId: 'https://idp.partner.net/idp', name: 'Partner Weaving Guild', isIdp: true, isSp: false, source: { ...MDQ_SOURCE, entity_count: 1 } });
    if (path.endsWith('/refresh')) return refresh ? refresh(json) : json({ count: 5, source: { ...SOURCE, entity_count: 5 } });
    if (path === '/api/admin/federation/health') return json({ alerts });
    if (/\/(idp|sp)\/keys\//.test(path)) {
      const action = path.split('/').pop();
      const keys = { signing: CERT('old'), encryption: CERT('old-enc'), next: action === 'stage' ? { signing: CERT('new'), encryption: CERT('new-enc') } : null, previous: null };
      return json({ ...IDP, keys });
    }
    if (path.startsWith('/api/admin/federation/entity?')) return json(ENTITY);
    if (path.startsWith('/api/admin/federation/entities')) return json({ total: 1, entities: [ENTITY_ROW] });
    if (path === '/api/admin/federation/idp' && opts.method === 'PUT') return json({ ...IDP, config: JSON.parse(opts.body) });
    if (path === '/api/admin/federation/idp') return json({ ...IDP, keys: idpKeys });
    if (path === '/api/admin/federation/sp' && opts.method === 'PUT') return json({ ...SP, config: JSON.parse(opts.body) });
    if (path === '/api/admin/federation/sp') return json(SP);
    if (path.endsWith('/approve')) return json({ identities: [{ ...PENDING, status: 'active', user_id: 5, username: 'jdoe@partner.net', provisioned: true }] });
    if (path.startsWith('/api/admin/federation/identities')) return json({ identities: [PENDING] });
    if (path === '/api/admin/users') return json([{ id: 5, username: 'sam', display_name: 'Sam', active: 1 }]);
    return json([]);
  }));
}
// Renders the module at one of its tabs, through the app so the sidebar and routes are the real ones.
const renderTab = (tab = 'settings') => render(
  <MemoryRouter initialEntries={[`/admin/federation/${tab}`]}>
    <NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider>
  </MemoryRouter>,
);

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('the Federation module has a sidebar with one tab per section', async () => {
  mock();
  renderTab();
  const sidebar = await screen.findByRole('tablist', { name: 'Federation sections' });
  const tabs = within(sidebar).getAllByRole('tab').map((t) => t.textContent);
  expect(tabs).toEqual(['Federation settings', 'Signing and encryption', 'Attribute release', 'Other institutions']);
});

test('uploading the InCommon signing certificate creates the source with that certificate', async () => {
  mock();
  const user = userEvent.setup();
  renderTab();

  await user.click(await screen.findByRole('button', { name: 'Add InCommon IdP list' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText(/^Name/).value).toBe('InCommon identity providers');
  expect(within(dialog).getByLabelText(/^Metadata URL/).value).toBe('https://md.example/idp-only.xml');
  expect(within(dialog).getByRole('button', { name: 'Save' }).disabled).toBe(true);

  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  await user.upload(within(dialog).getByLabelText('Signing certificate file'), new File([pem], 'incommon-metadata.crt'));
  expect(await within(dialog).findByText(/incommon-metadata\.crt selected/)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  const post = requests.find((r) => r.method === 'POST');
  expect(post.path).toBe('/api/admin/federation/sources');
  expect(post.body).toMatchObject({ name: 'InCommon identity providers', kind: 'aggregate', roles: 'idp', url: 'https://md.example/idp-only.xml', refresh_hours: 6, enabled: true, signing_cert_pem: pem });
});

test('an existing source shows its pinned certificate and a failed refresh keeps the reason visible', async () => {
  mock({
    sources: { ...SOURCES, sources: [SOURCE] },
    refresh: (json) => json({ errors: ['Metadata signature is invalid.'], source: { ...SOURCE, last_error: 'Metadata signature is invalid.' } }, 502),
  });
  const user = userEvent.setup();
  renderTab();

  expect(await screen.findByText('CN=InCommon Metadata Signing')).toBeTruthy();
  expect(screen.getByText(/SHA-256 AA:BB/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Refresh InCommon' }));
  expect((await screen.findAllByText('Metadata signature is invalid.')).length).toBeGreaterThan(0);
  expect(screen.getByText('Refresh failed')).toBeTruthy();
});

test('saving the federation identity sends the whole configuration', async () => {
  mock();
  const user = userEvent.setup();
  renderTab();

  await user.type(await screen.findByLabelText('Scope'), 'example.net');
  await user.type(screen.getByLabelText('Organization name'), 'Example Weaving Guild');
  await user.click(screen.getByLabelText('Enable federation sign-in'));
  await user.click(screen.getByRole('button', { name: 'Save federation settings' }));

  const put = requests.find((r) => r.method === 'PUT');
  expect(put.path).toBe('/api/admin/federation/idp');
  expect(put.body).toMatchObject({ enabled: true, scope: 'example.net', organization: { name: 'Example Weaving Guild' }, categories: { rs: true } });
});

test('unsaved identity changes survive a trip to another tab and are saved from there', async () => {
  mock();
  const user = userEvent.setup();
  renderTab();

  await user.type(await screen.findByLabelText('Scope'), 'example.net');
  await user.click(screen.getByRole('tab', { name: 'Attribute release' }));
  await user.click(await screen.findByLabelText('Release attributes a service provider marks as required'));
  await user.click(screen.getByRole('tab', { name: 'Federation settings' }));
  expect((await screen.findByLabelText('Scope')).value).toBe('example.net');

  await user.click(screen.getByRole('button', { name: 'Save federation settings' }));
  const put = requests.find((r) => r.method === 'PUT');
  expect(put.body).toMatchObject({ scope: 'example.net', releaseRequired: false });
});

test('a viewer sees the settings but cannot change them', async () => {
  mock({ sources: { ...SOURCES, sources: [SOURCE] }, permissions: ['federation.view'] });
  renderTab();

  expect(await screen.findByText('CN=InCommon Metadata Signing')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add InCommon MDQ' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save federation settings' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh InCommon' })).toBeNull();
  expect((await screen.findByLabelText('Scope')).disabled).toBe(true);
  expect(screen.queryByRole('heading', { name: 'Preview attribute release' })).toBeNull();
});

test('the attribute release tab offers the release preview to people who can manage it', async () => {
  mock();
  renderTab('release');
  expect(await screen.findByRole('heading', { name: 'Preview attribute release' })).toBeTruthy();
});

test('enabling sign-in from other institutions saves the policy and allow list', async () => {
  mock();
  const user = userEvent.setup();
  renderTab('institutions');

  const form = await screen.findByRole('form', { name: 'Sign in from other institutions' });
  await user.click(within(form).getByLabelText(/Offer/));
  await user.type(within(form).getByLabelText(/Allowed institutions/), 'https://idp.partner.net/idp');
  await user.click(within(form).getByRole('button', { name: 'Save' }));

  const put = requests.find((r) => r.method === 'PUT' && r.path === '/api/admin/federation/sp');
  expect(put.body).toMatchObject({ enabled: true, provisioning: 'approve', idpAllowlist: 'https://idp.partner.net/idp' });
});

test('automatic account creation without an allow list is called out', async () => {
  mock();
  const user = userEvent.setup();
  renderTab('institutions');

  const form = await screen.findByRole('form', { name: 'Sign in from other institutions' });
  await user.click(within(form).getByLabelText('New people'));
  await user.click(await screen.findByRole('option', { name: /Create an account automatically/ }));
  expect(within(form).getByText(/anyone at any institution in the federation can create an account/)).toBeTruthy();
});

test('a first-time sign-in can be approved from the queue', async () => {
  mock();
  const user = userEvent.setup();
  renderTab('institutions');

  expect(await screen.findByText('1 waiting')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Approve Jane Doe' }));
  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/federation/identities/11/approve');
  expect(post).toBeTruthy();
  expect(await screen.findByText('active')).toBeTruthy();
});

test('linking a first-time sign-in to an existing user sends that user', async () => {
  mock();
  const user = userEvent.setup();
  renderTab('institutions');

  await user.click(await screen.findByRole('button', { name: 'Link Jane Doe' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Link' }).disabled).toBe(true);
  await user.click(within(dialog).getByLabelText('Local user'));
  await user.click(await screen.findByRole('option', { name: /sam/ }));
  await user.click(within(dialog).getByRole('button', { name: 'Link' }));
  const post = requests.find((r) => r.path.endsWith('/identities/11/approve'));
  expect(post.body).toEqual({ user_id: 5 });
});

test('without the right to manage users, approval buttons are not offered', async () => {
  mock({ permissions: ['federation.view', 'federation.manage'] });
  renderTab('institutions');
  expect(await screen.findByText('Jane Doe')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve Jane Doe' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Link Jane Doe' })).toBeNull();
});

test('alerts about failing metadata and expiring keys are shown above the sections', async () => {
  mock({ alerts: [
    { severity: 'error', code: 'source-expired', title: 'InCommon', detail: 'The metadata expired on 2026-10-01.', ref: 'source:3' },
    { severity: 'warning', code: 'key-expiring', title: 'Federation identity keys', detail: 'The signing certificate expires on 2027-01-01.', ref: 'idp' },
  ] });
  renderTab('signing');
  const region = await screen.findByRole('region', { name: 'Federation alerts' });
  expect(within(region).getByText('The metadata expired on 2026-10-01.')).toBeTruthy();
  expect(within(region).getByText('The signing certificate expires on 2027-01-01.')).toBeTruthy();
});

test('a key rollover is staged first and activation asks for confirmation', async () => {
  mock({ idpKeys: { signing: CERT('old'), encryption: CERT('old-enc'), next: null, previous: null } });
  const user = userEvent.setup();
  renderTab('signing');

  const group = await screen.findByRole('group', { name: 'Keys' });
  expect(within(group).getByText('Active')).toBeTruthy();
  expect(within(group).queryByRole('button', { name: 'Activate staged key' })).toBeNull();
  await user.click(within(group).getByRole('button', { name: 'Stage a new key' }));
  expect(requests.some((r) => r.method === 'POST' && r.path === '/api/admin/federation/idp/keys/stage')).toBe(true);

  expect(await within(group).findByText('Staged')).toBeTruthy();
  await user.click(within(group).getByRole('button', { name: 'Activate staged key' }));
  expect(requests.some((r) => r.path.endsWith('/keys/activate'))).toBe(false);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/Do this only after the federation is publishing/)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Activate' }));
  expect(requests.some((r) => r.method === 'POST' && r.path === '/api/admin/federation/idp/keys/activate')).toBe(true);
});

test('the entity browser searches and shows what an institution published, with key fingerprints', async () => {
  mock();
  const user = userEvent.setup();
  renderTab();

  const table = await screen.findByRole('table', { name: 'Imported entities' });
  await user.type(screen.getByLabelText('Search entities'), 'partner');
  await user.click(await within(table).findByText('Partner Weaving Guild'));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('partner.net')).toBeTruthy();
  expect(within(dialog).getByText('https://incommon.org')).toBeTruthy();
  expect(within(dialog).getByText(/SHA-256 DE:AD/)).toBeTruthy();
  expect(requests.some((r) => r.path.startsWith('/api/admin/federation/entities') && r.path.includes('q=partner'))).toBe(true);
});

test('viewers cannot roll keys', async () => {
  mock({ permissions: ['federation.view'], idpKeys: { signing: CERT('old'), encryption: CERT('old-enc'), next: null, previous: null } });
  renderTab('signing');
  const group = await screen.findByRole('group', { name: 'Keys' });
  expect(within(group).queryByRole('button', { name: 'Stage a new key' })).toBeNull();
});

test('an MDQ source is added with its own certificate and can be tested with a real lookup', async () => {
  mock({ sources: { ...SOURCES, sources: [MDQ_SOURCE] } });
  const user = userEvent.setup();
  renderTab();

  // Listed as on demand: nothing to refresh by hand.
  expect(await screen.findByText('Queried on demand')).toBeTruthy();
  expect(screen.getByText('0 cached')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Refresh InCommon MDQ' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Edit InCommon MDQ' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText(/^MDQ service URL/).value).toBe('https://mdq.example');
  expect(within(dialog).queryByLabelText('Refresh every (hours)')).toBeNull();
  expect(within(dialog).queryByLabelText('Keep')).toBeNull();

  await user.type(within(dialog).getByLabelText('Entity ID to look up'), 'https://idp.unknown.net/idp');
  await user.click(within(dialog).getByRole('button', { name: 'Look up' }));
  expect(await within(dialog).findByText('The service does not know that entity.')).toBeTruthy();

  await user.clear(within(dialog).getByLabelText('Entity ID to look up'));
  await user.type(within(dialog).getByLabelText('Entity ID to look up'), 'https://idp.partner.net/idp');
  await user.click(within(dialog).getByRole('button', { name: 'Look up' }));
  expect(await within(dialog).findByText(/Found Partner Weaving Guild \(identity provider\)\. Signature verified\./)).toBeTruthy();
  expect(requests.find((r) => r.path === '/api/admin/federation/sources/8/lookup' && r.body.entityId === 'https://idp.partner.net/idp')).toBeTruthy();
});

test('adding the InCommon MDQ preset creates an MDQ source without role or refresh settings', async () => {
  mock();
  const user = userEvent.setup();
  renderTab();

  await user.click(await screen.findByRole('button', { name: 'Add InCommon MDQ' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText(/^MDQ service URL/).value).toBe('https://mdq.example');
  expect(within(dialog).queryByLabelText('Test lookup')).toBeNull();
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  await user.upload(within(dialog).getByLabelText('Signing certificate file'), new File([pem], 'inc-md-cert-mdq.pem'));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/federation/sources');
  expect(post.body).toMatchObject({ name: 'InCommon MDQ', kind: 'mdq', url: 'https://mdq.example', signing_cert_pem: pem });
});
