import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const HR = { id: 3, username: 'hr-feed', description: 'Nightly feed', enabled: true, has_password: true, public_keys: [], key_labels: [], grants: [{ path: '/exports/hr', access: 'read' }], created_at: '2026-10-01T10:00:00Z', created_by: 'a', updated_at: '2026-10-01T10:00:00Z' };
const NEW = { ...HR, id: 4, username: 'partner-drop', description: '', has_password: true, grants: [{ path: '/incoming', access: 'write' }] };

const requests = [];
function mock(permissions) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/service-accounts' && opts.method === 'POST') return json({ accounts: [HR, NEW], account: NEW, generated_password: 'generated-secret-123' }, 201);
    if (path === '/api/admin/service-accounts') return json({ accounts: [HR] });
    return json({});
  }));
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('the Users page has a tab for service accounts, which lists them with their directories', async () => {
  mock(['users.view', 'users.manage']);
  renderAt('/admin/users/service-accounts');
  const table = await screen.findByRole('table', { name: 'Service accounts' });
  expect(await within(table).findByText('hr-feed')).toBeInTheDocument();
  expect(within(table).getByText('/exports/hr (read)')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Service accounts' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'People' })).toBeInTheDocument();
});

test('creating a service account sends its directories and shows a generated password once', async () => {
  mock(['users.view', 'users.manage']);
  renderAt('/admin/users/service-accounts');
  await screen.findByRole('table', { name: 'Service accounts' });
  await userEvent.click(screen.getByRole('button', { name: 'New service account' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText(/^Name/), 'partner-drop');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create service account' }));
  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/service-accounts');
  expect(post.body).toMatchObject({ username: 'partner-drop', generate: true, enabled: true });
  expect(post.body.grants).toEqual([{ path: '/', access: 'read' }]);
  expect(await screen.findByText('Password for partner-drop')).toBeInTheDocument();
  expect(screen.getByDisplayValue('generated-secret-123')).toBeInTheDocument();
});
