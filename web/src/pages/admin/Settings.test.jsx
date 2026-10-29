import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: 'Welcome' };
const CATALOG = {
  permissions: [
    { key: 'users.view', group: 'Users', label: 'View users', description: 'See users.', implies: [] },
    { key: 'users.manage', group: 'Users', label: 'Manage users', description: 'Edit users.', implies: ['users.view'] },
    { key: 'duo.manage', group: 'Settings', label: 'Configure Duo MFA', description: 'Duo.', implies: [] },
  ],
  roles: [
    { id: 1, name: 'Administrator', description: 'Everything', builtin: true, permissions: ['users.view', 'users.manage', 'duo.manage'], member_count: 1 },
    { id: 2, name: 'Help desk', description: '', builtin: false, permissions: ['users.view'], member_count: 0 },
  ],
};

const requests = [];
function mock(permissions) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/roles' && opts.method === 'POST') return json({});
    if (path === '/api/admin/roles') return json(CATALOG);
    if (path === '/api/admin/roles/2') return json({ role: CATALOG.roles[1], members: [], candidates: [] });
    if (path === '/api/admin/roles/blank') return json({ role: { id: null, name: '', description: '', builtin: false, permissions: [] }, members: [], candidates: [{ id: 5, username: 'eve', display_name: 'Eve' }] });
    if (path === '/api/admin/policies' && opts.method === 'POST') return json({});
    if (path === '/api/admin/app-policies' && opts.method === 'POST') return json({});
    if (path === '/api/admin/app-policies') return json({
      policies: [{ id: 1, name: 'Payroll MFA', description: '', require_mfa: true, require_phishing_resistant: false, allowed_factors: ['totp'], apps: ['a1'], service_providers: [] }],
      apps: [{ id: 'a1', name: 'Payroll' }, { id: 'a2', name: 'Wiki' }], service_providers: [], factor_types: ['totp', 'webauthn', 'email', 'sms', 'voice'],
    });
    if (path === '/api/admin/policies') return json({
      policies: [{ id: 1, name: 'Staff MFA', description: '', subject_type: 'group', subject_id: 3, subject_name: 'Staff', block_sign_in: false, require_mfa: true }],
      roles: [{ id: 2, name: 'Help desk' }], groups: [{ id: 3, name: 'Staff', source: 'local' }],
    });
    if (path === '/api/admin/settings/duo') return json({ enabled: false, apiHost: '', integrationKey: '', secretSet: false, source: 'file' });
    return json({});
  }));
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotifyProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </NotifyProvider>
    </MemoryRouter>,
  );
}

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('settings shows one tab per category the admin may use', async () => {
  mock(['roles.view']);
  renderAt('/admin/settings');
  expect(await screen.findByRole('tab', { name: 'Roles & permissions' })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Duo MFA' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Branding' })).not.toBeInTheDocument();
});

test('roles tab lists roles and "manage" ticks and locks its "view"', async () => {
  mock(['roles.view', 'roles.manage', 'users.view', 'users.manage', 'duo.manage']);
  renderAt('/admin/settings/roles');
  expect(await screen.findByText('Help desk')).toBeInTheDocument();
  expect(screen.getByText('All permissions')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'New role' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText(/Name/), 'Reviewers');
  await userEvent.click(within(dialog).getByLabelText(/Manage users/));
  expect(within(dialog).getByLabelText(/View users/)).toBeChecked();
  expect(within(dialog).getByLabelText(/View users/)).toBeDisabled();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/roles');
  expect(post.body.name).toBe('Reviewers');
  expect(new Set(post.body.permissions)).toEqual(new Set(['users.manage', 'users.view']));
});

test('view-only role admins cannot edit', async () => {
  mock(['roles.view']);
  renderAt('/admin/settings/roles');
  await screen.findByText('Help desk');
  expect(screen.queryByRole('button', { name: 'New role' })).not.toBeInTheDocument();
  await userEvent.click(screen.getAllByRole('button', { name: 'View' })[1]);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

