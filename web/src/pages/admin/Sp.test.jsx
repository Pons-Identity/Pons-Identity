import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from '../../components/Notify.jsx';
import Sp from './Sp.jsx';

const sp = {
  id: 'abc', name: 'Portal', description: 'Wiki', metadata_mode: 'none', metadata_url: '', sp_entity_id: 'urn:portal',
  acs_urls: ['https://portal.test/acs'], slo_url: '', login_url: '', default_relay_state: '', nameid_format: 'emailAddress',
  nameid_source: 'email', signature_algorithm: 'sha256', sign_response: 1, sign_assertion: 1, groups_attribute: '',
  encrypt_assertion: 0, encryption_cert_pem: '', encryption_cert: null, signing_cert_pem: '', signing_cert: null, encryption_algorithm: 'aes256-cbc',
  key_transport_algorithm: 'rsa-oaep-mgf1p', transform_enabled: 1, transform_rules: 'mail = lower(mail)\nupn = concat(username, "@x.com")', transform_nameid_attr: 'upn', transform_temp_attrs: ['upn'],
  maps: [{ idp_attribute: 'email', saml_name: 'mail' }], statics: [{ name: 'acct', value: '42' }], roles: [],
  cert_pem: '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n',
  urls: { entityId: 'https://idp.test/saml/abc/metadata', sso: 'https://idp.test/saml/abc/sso', slo: 'https://idp.test/saml/abc/slo',
    metadata: 'https://idp.test/saml/abc/metadata', idpInitiated: 'https://idp.test/saml/abc/init' },
};
const detail = { sp, fingerprints: { sha1: 'AA:BB', sha256: 'CC:DD', notAfter: 'Jan 1 2036' }, metadata: '<md:EntityDescriptor/>' };
const options = {
  attributes: [{ key: 'email', label: 'Email address' }, { key: 'upn', label: 'User principal name (userPrincipalName)' }],
  nameIdSources: [{ key: 'email', label: 'Email address' }], groups: [],
  nameIdFormats: { unspecified: 'urn:u', emailAddress: 'urn:e', transient: 'urn:t', persistent: 'urn:p' },
  signatureAlgorithms: { sha256: { label: 'RSA-SHA256' } },
  encryptionAlgorithms: { 'aes256-cbc': { label: 'AES-256-CBC' } },
  keyTransportAlgorithms: { 'rsa-oaep-mgf1p': { label: 'RSA-OAEP (SHA-1, MGF1-SHA1)' } },
};

const calls = [];
function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method || 'GET', body });
    const out = {
      '/admin/sps/abc': init.method === 'PUT' ? detail : detail,
      '/admin/options': options,
      '/admin/users': [{ id: 7, username: 'bob', display_name: 'Bob' }],
      '/admin/sps/preview': { attributes: [{ name: 'mail', values: ['bob@x.com'] }], nameId: 'bob@x.com', errors: [] },
    }[path];
    return new Response(JSON.stringify(out ?? {}), { status: out ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

function renderPage() {
  mockApi();
  return render(
    <MemoryRouter initialEntries={['/admin/sps/abc']}>
      <NotifyProvider>
        <Routes><Route path="/admin/sps/:id" element={<Sp />} /></Routes>
      </NotifyProvider>
    </MemoryRouter>,
  );
}

test('one page lists the sections in order', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'IdP Metadata' });
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings).toEqual(['Application', 'User access', 'IdP Metadata', 'SP Metadata', 'SAML Response Attributes', 'Attribute transformations']);
  expect(screen.getByRole('textbox', { name: /^Application Name/ })).toHaveValue('Portal');
  expect(screen.getByLabelText('Application Description')).toHaveValue('Wiki');
});

test('the page has a back link to the applications list', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'IdP Metadata' });
  expect(screen.getByRole('link', { name: '← Applications' })).toHaveAttribute('href', '/admin/sps');
});

test('IdP metadata is read-only with copy, fingerprints, and view buttons', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'IdP Metadata' });
  const section = screen.getByRole('region', { name: 'IdP Metadata' });
  for (const [label, value] of [['Entity ID', 'https://idp.test/saml/abc/metadata'], ['SSO URL', 'https://idp.test/saml/abc/sso'],
    ['SLO URL', 'https://idp.test/saml/abc/slo'], ['Metadata URL', 'https://idp.test/saml/abc/metadata'],
    ['SHA-1 Fingerprint', 'AA:BB'], ['SHA-256 Fingerprint', 'CC:DD']]) {
    // The SP section has its own editable "Entity ID", so pick the read-only one.
    const field = screen.getAllByLabelText(label).find((el) => el.readOnly);
    expect(field).toHaveValue(value);
    expect(within(section).getByRole('button', { name: `Copy ${label}` })).toBeInTheDocument();
  }
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  fireEvent.click(screen.getByRole('button', { name: 'Copy SSO URL' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://idp.test/saml/abc/sso'));

  await userEvent.click(screen.getAllByRole('button', { name: 'View' })[0]);
  expect(await screen.findByRole('textbox', { name: 'IdP signing certificate' })).toHaveValue(sp.cert_pem);
});

test('SP metadata discovery offers the three modes and shows the input for the chosen one', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'SP Metadata' });
  await userEvent.click(screen.getByRole('combobox', { name: 'Metadata discovery' }));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['None (manual input)', 'Metadata XML URL', 'Metadata XML upload']);
  await userEvent.click(screen.getByRole('option', { name: 'Metadata XML URL' }));
  expect(screen.getByRole('textbox', { name: 'Metadata XML URL' })).toBeInTheDocument();
  expect(screen.getByLabelText('ACS URL')).toHaveValue('https://portal.test/acs');
});

test('encryption controls are disabled until encryption is enabled', async () => {
  renderPage();
  const algo = await screen.findByRole('combobox', { name: 'Assertion encryption algorithm' });
  expect(algo).toHaveAttribute('aria-disabled', 'true');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Encrypt assertions' }));
  expect(screen.getByRole('combobox', { name: 'Assertion encryption algorithm' })).not.toHaveAttribute('aria-disabled', 'true');
});

test('mapping table merges IdP and static rows, and saves them in the API shape', async () => {
  renderPage();
  const table = await screen.findByRole('table', { name: 'Attribute mapping' });
  expect(within(table).getByLabelText('SAML attribute name 1')).toHaveValue('mail');
  expect(within(table).getByLabelText('Static value 2')).toHaveValue('42');

  fireEvent.change(screen.getByRole('textbox', { name: /^Application Name/ }), { target: { value: 'Portal 2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  const put = calls.find((c) => c.method === 'PUT').body;
  expect(put).toMatchObject({
    name: 'Portal 2', description: 'Wiki', map_idp: ['email'], map_saml: ['mail'], static_name: ['acct'], static_value: ['42'],
    transform_rules: 'mail = lower(mail)\nupn = concat(username, "@x.com")', transform_nameid_attr: 'upn', transform_temp_attrs: ['upn'],
    acs_url: ['https://portal.test/acs'],
  });
});

test('attribute transformations start collapsed and fetch no preview until opened', async () => {
  renderPage();
  const summary = await screen.findByRole('button', { name: 'Attribute transformations' });
  expect(summary).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('textbox', { name: 'Transformation rule 1' })).not.toBeInTheDocument();
  expect(calls.some((c) => c.path === '/admin/sps/preview')).toBe(false);
});

test('transformation preview shows the attributes for the chosen user', async () => {
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: 'Attribute transformations' }));
  const preview = await screen.findByRole('table', { name: 'Attribute preview' });
  expect(within(preview).getAllByText('bob@x.com')).toHaveLength(2); // the NameID row and the mail attribute
  const req = calls.find((c) => c.path === '/admin/sps/preview');
  expect(req.body).toMatchObject({ user_id: '7', transform_rules: 'mail = lower(mail)\nupn = concat(username, "@x.com")' });
});

test('the enable checkbox gates the rules and is saved', async () => {
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: 'Attribute transformations' }));
  const box = screen.getByRole('checkbox', { name: 'Enable attribute transformations' });
  expect(box).toBeChecked();
  await userEvent.click(box);
  expect(screen.getByRole('textbox', { name: 'Transformation rule 1' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  expect(calls.find((c) => c.method === 'PUT').body).toMatchObject({ transform_enabled: false, transform_rules: 'mail = lower(mail)\nupn = concat(username, "@x.com")' });
});

test('transformation rows edit the rule, the attribute and the NameID/temporary flags', async () => {
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: 'Attribute transformations' }));
  expect(screen.getByRole('textbox', { name: 'Transformation rule 1' })).toHaveValue('lower(mail)');
  expect(screen.getByRole('textbox', { name: 'Transformed SAML attribute 2' })).toHaveValue('upn');

  // Row 2 is the NameID attribute, so row 1's NameID checkbox is greyed out until row 2 releases it.
  const nameId1 = screen.getByRole('checkbox', { name: 'Set transformation 1 as my NameID attribute' });
  const nameId2 = screen.getByRole('checkbox', { name: 'Set transformation 2 as my NameID attribute' });
  expect(nameId2).toBeChecked();
  expect(nameId1).toBeDisabled();
  await userEvent.click(nameId2);
  expect(nameId1).toBeEnabled();
  await userEvent.click(nameId1);
  expect(nameId2).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  expect(calls.find((c) => c.method === 'PUT').body).toMatchObject({ transform_nameid_attr: 'mail', transform_temp_attrs: ['upn'] });
});
