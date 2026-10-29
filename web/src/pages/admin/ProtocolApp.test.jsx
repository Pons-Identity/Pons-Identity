import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from '../../components/Notify.jsx';
import ProtocolApp from './ProtocolApp.jsx';

const oidc = {
  id: 'a1', protocol: 'oidc', name: 'Wiki', description: '', client_id: 'oidc-xyz', confidential: true, require_pkce: 1,
  redirect_uris: ['https://wiki.test/cb'], post_logout_uris: [], grant_types: ['authorization_code'], scopes: ['openid', 'email'],
  subject_source: 'guid', access_token_ttl: 3600, access_mode: 'all', access_groups: [], maps: [{ idp_attribute: 'department', claim_name: 'dept' }],
  urls: { issuer: 'https://idp.test/oidc', token: 'https://idp.test/oidc/token' },
};
const options = {
  attributes: [{ key: 'guid', label: 'GUID' }, { key: 'department', label: 'Department' }],
  nameIdSources: [{ key: 'guid', label: 'GUID' }, { key: 'username', label: 'Username' }], groups: [],
};

const calls = [];
function mockApi(routes) {
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const out = routes[`${init.method || 'GET'} ${path}`] ?? routes[path];
    return new Response(JSON.stringify(out ?? {}), { status: out ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotifyProvider>
        <Routes>
          <Route path="/admin/apps/new" element={<ProtocolApp />} />
          <Route path="/admin/apps/:id" element={<ProtocolApp />} />
        </Routes>
      </NotifyProvider>
    </MemoryRouter>,
  );
}

test('an OpenID Connect app shows its endpoints and client settings', async () => {
  mockApi({ '/admin/apps/a1': { app: oidc }, '/admin/options': options });
  renderAt('/admin/apps/a1');
  await screen.findByRole('heading', { name: 'Connection details' });
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent))
    .toEqual(['Application', 'User access', 'Connection details', 'Client', 'Redirect URIs', 'Subject and claims']);
  expect(screen.getByLabelText('Client ID')).toHaveValue('oidc-xyz');
  expect(screen.getByLabelText('Token endpoint')).toHaveValue('https://idp.test/oidc/token');
  expect(screen.getByRole('checkbox', { name: /^openid/ })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /^email/ })).toBeChecked();
});

test('the back link to the applications list shows for existing and new applications', async () => {
  mockApi({ '/admin/apps/a1': { app: oidc }, '/admin/options': options, '/admin/apps/blank?protocol=oidc': { ...oidc, id: undefined, name: '', client_id: 'x', redirect_uris: [''], confidential: true, urls: {} } });
  renderAt('/admin/apps/a1');
  await screen.findByRole('heading', { name: 'Connection details' });
  expect(screen.getByRole('link', { name: '← Applications' })).toHaveAttribute('href', '/admin/sps');
  cleanup();
  renderAt('/admin/apps/new?protocol=oidc');
  await screen.findByRole('heading', { name: 'Connection details' });
  expect(screen.getByRole('link', { name: '← Applications' })).toHaveAttribute('href', '/admin/sps');
});

test('a new CAS application has services and no client section, and saves in the API shape', async () => {
  const blank = { protocol: 'cas', name: '', description: '', access_mode: 'all', access_groups: [], maps: [], redirect_uris: [''], post_logout_uris: [],
    confidential: false, require_pkce: 1, grant_types: [], scopes: [], subject_source: 'username', access_token_ttl: 3600 };
  mockApi({ '/admin/apps/blank?protocol=cas': blank, '/admin/options': options, 'POST /admin/apps': { app: { ...blank, id: 'c1', name: 'Legacy', urls: {} } },
    '/admin/apps/c1': { app: { ...blank, id: 'c1', name: 'Legacy', urls: {} } } });
  renderAt('/admin/apps/new?protocol=cas');
  await screen.findByRole('heading', { name: 'New CAS application' });
  expect(screen.queryByRole('heading', { name: 'Client' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: /^Application Name/ }), { target: { value: 'Legacy' } });
  fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'https://legacy.test/*' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST').body).toMatchObject({
    protocol: 'cas', name: 'Legacy', redirect_uris: ['https://legacy.test/*'], subject_source: 'username',
  });
});

test('a new client secret is shown once after creation', async () => {
  const blank = { ...oidc, id: undefined, name: '', client_id: undefined, urls: {}, redirect_uris: [''], confidential: true };
  const created = { ...oidc, id: 'n1', name: 'New', urls: {} };
  mockApi({ '/admin/apps/blank?protocol=oidc': blank, '/admin/options': options, 'POST /admin/apps': { app: created, secret: 's3cret-value' },
    '/admin/apps/n1': { app: created } });
  renderAt('/admin/apps/new?protocol=oidc');
  await screen.findByRole('heading', { name: 'New OpenID Connect application' });
  fireEvent.change(screen.getByRole('textbox', { name: /^Application Name/ }), { target: { value: 'New' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByLabelText('Client secret')).toHaveValue('s3cret-value');
});

test('a new OpenID Connect application shows its client ID and endpoints before it is saved, and sends that client ID', async () => {
  const blank = { ...oidc, id: undefined, name: '', client_id: 'oidc-reserved123456', redirect_uris: [''], confidential: true,
    urls: { issuer: 'https://idp.test/oidc', discovery: 'https://idp.test/oidc/.well-known/openid-configuration', token: 'https://idp.test/oidc/token' } };
  const created = { ...oidc, id: 'n2', name: 'Early', client_id: 'oidc-reserved123456', urls: {} };
  mockApi({ '/admin/apps/blank?protocol=oidc': blank, '/admin/options': options, 'POST /admin/apps': { app: created, secret: 'x' }, '/admin/apps/n2': { app: created } });
  renderAt('/admin/apps/new?protocol=oidc');
  await screen.findByRole('heading', { name: 'New OpenID Connect application' });
  expect(screen.getByLabelText('Client ID')).toHaveValue('oidc-reserved123456');
  expect(screen.getByLabelText('Discovery URL')).toHaveValue('https://idp.test/oidc/.well-known/openid-configuration');
  fireEvent.change(screen.getByRole('textbox', { name: /^Application Name/ }), { target: { value: 'Early' } });
  fireEvent.change(screen.getByLabelText('Redirect URI'), { target: { value: 'https://early.test/cb' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST').body.client_id).toBe('oidc-reserved123456');
});
