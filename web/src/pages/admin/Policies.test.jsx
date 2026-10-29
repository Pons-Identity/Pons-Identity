import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: 'Welcome' };
const LIMITS = {
  max_length: 128, default_min_length: 12, built_in_min_length: 12, floor_min_length: 8, max_history: 24, history_kept: 100,
  score_labels: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'],
};

const requests = [];
// What the server says a new sign-in policy would weaken against the global policy (set per test).
let weakensNow = [];
function mock(permissions) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/policies' && opts.method === 'POST') return json({});
    if (path === '/api/admin/app-policies' && opts.method === 'POST') return json({});
    if (path === '/api/admin/app-policies') return json({
      policies: [{ id: 1, name: 'Payroll MFA', description: '', require_mfa: true, require_phishing_resistant: false, allowed_factors: ['totp'], apps: ['a1'], service_providers: [] }],
      apps: [{ id: 'a1', name: 'Payroll' }, { id: 'a2', name: 'Wiki' }], service_providers: [{ id: 's1', name: 'Intranet SP' }], factor_types: ['totp', 'webauthn', 'email', 'sms', 'voice'],
    });
    if (path === '/api/admin/password-policies') return json({ password_policies: [], global: null, limits: LIMITS });
    if (path === '/api/admin/global-password-policy' && opts.method === 'PUT') return json({ min_length: 9 });
    if (path === '/api/admin/policies/preview') return json({ weakens: weakensNow });
    if (path === '/api/admin/policies') return json({
      policies: [{ id: 1, name: 'Staff MFA', description: '', subject_type: 'group', subject_id: 3, subject_name: 'Staff', block_sign_in: false, require_mfa: true }],
      roles: [{ id: 2, name: 'Help desk' }], groups: [{ id: 3, name: 'Staff', source: 'local' }, { id: 4, name: 'Contractors', source: 'local' }], global: null,
      override_rules: { password: 'Password rules' },
    });
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

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; weakensNow = []; });

test('policies is its own module with a tab per policy type', async () => {
  mock(['policies.view']);
  renderAt('/admin/policies/sign-in');
  expect(await screen.findByRole('heading', { name: 'Policies' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Sign-in policies' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Application policies' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Password policies' })).toBeInTheDocument();
});

test('old policy links under Settings open the Policies module', async () => {
  mock(['policies.view']);
  renderAt('/admin/settings/app-policies');
  expect(await screen.findByText('Payroll MFA')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Application policies' })).toHaveAttribute('aria-selected', 'true');
});

test('sign-in policies lists policies and creates one for a role', async () => {
  mock(['policies.view', 'policies.manage']);
  renderAt('/admin/policies/sign-in');
  expect(await screen.findByText('Staff MFA')).toBeInTheDocument();
  expect(screen.getByText('Group: Staff')).toBeInTheDocument();
  expect(screen.getByText('MFA required')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'New policy' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Help desk MFA');
  await userEvent.click(within(dialog).getByRole('combobox', { name: /Role/ }));
  await userEvent.click(await screen.findByRole('option', { name: 'Help desk' }));
  await userEvent.click(within(dialog).getByLabelText(/Require an authenticator/));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/policies');
  expect(post.body).toMatchObject({ name: 'Help desk MFA', subject_type: 'role', subject_id: 2, require_mfa: true, block_sign_in: false });
});

test('application policies lists them and creates one for an application', async () => {
  mock(['policies.view', 'policies.manage']);
  renderAt('/admin/policies/applications');
  expect(await screen.findByText('Payroll MFA')).toBeInTheDocument();
  expect(screen.getByText('Only: Authenticator app')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'New application policy' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Wiki webauthn');
  await userEvent.click(within(dialog).getByRole('combobox', { name: /^Applications/ }));
  await userEvent.click(await screen.findByRole('option', { name: /Wiki/ }));
  await userEvent.click(within(dialog).getByRole('combobox', { name: /^Applications/ }));
  await userEvent.click(await screen.findByRole('option', { name: /Intranet SP/ }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/app-policies');
  expect(post.body).toMatchObject({ name: 'Wiki webauthn', apps: ['a2'], service_providers: ['s1'], require_mfa: true });
});

test('global password rules can lower the minimum length only after a warning', async () => {
  mock(['policies.view', 'policies.manage']);
  renderAt('/admin/policies/passwords');
  expect(await screen.findByText('Global password rules')).toBeInTheDocument();
  const length = screen.getByRole('spinbutton', { name: 'Minimum length' });
  await userEvent.clear(length);
  await userEvent.type(length, '9');
  expect(screen.getByText(/The built-in minimum is 12 characters/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Save global rules' }));
  const dialog = await screen.findByRole('dialog');
  expect(requests.some((r) => r.method === 'PUT' && r.path === '/api/admin/global-password-policy')).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Lower it' }));
  await waitFor(() => expect(requests.find((r) => r.method === 'PUT' && r.path === '/api/admin/global-password-policy')).toBeTruthy());
  expect(requests.find((r) => r.path === '/api/admin/global-password-policy').body).toMatchObject({ min_length: '9' });
});

test('a sign-in policy that weakens password rules needs acceptance even when the global policy has no sign-in rules', async () => {
  mock(['policies.view', 'policies.manage']);
  weakensNow = ['password'];
  renderAt('/admin/policies/sign-in');
  expect(await screen.findByText('Staff MFA')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'New policy' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Short passwords');
  await userEvent.click(within(dialog).getByRole('combobox', { name: /Role/ }));
  await userEvent.click(await screen.findByRole('option', { name: 'Help desk' }));

  expect(await within(dialog).findByText(/less secure than the global policy: Password rules/)).toBeInTheDocument();
  const save = within(dialog).getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled();
  await userEvent.click(within(dialog).getByLabelText(/I accept that this policy reduces security/));
  expect(save).toBeEnabled();
  await userEvent.click(save);

  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/policies');
  expect(post.body).toMatchObject({ name: 'Short passwords', accept_global_override: true });
});

test('a password policy with a minimum below the minimum for every password needs acceptance', async () => {
  mock(['policies.view', 'policies.manage']);
  renderAt('/admin/policies/passwords');
  await userEvent.click(await screen.findByRole('button', { name: 'New password policy' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Short passwords');
  await userEvent.type(within(dialog).getByLabelText('Minimum length'), '8');

  expect(await within(dialog).findByText(/minimum length for every password is 12 characters/)).toBeInTheDocument();
  const save = within(dialog).getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled();
  await userEvent.click(within(dialog).getByLabelText(/I accept that this password policy reduces security below the minimum for every password/));
  expect(save).toBeEnabled();
  await userEvent.click(save);

  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/password-policies');
  expect(post.body).toMatchObject({ name: 'Short passwords', min_length: '8', accept_global_override: true });
});

test('view-only policy admins cannot edit', async () => {
  mock(['policies.view']);
  renderAt('/admin/policies/sign-in');
  await screen.findByText('Staff MFA');
  expect(screen.queryByRole('button', { name: 'New policy' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('Staff MFA'));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

test('a sign-in policy can be applied to several groups', async () => {
  mock(['policies.view', 'policies.manage']);
  renderAt('/admin/policies/sign-in');
  await userEvent.click(await screen.findByRole('button', { name: 'New policy' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Outsiders');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Groups' }));
  await userEvent.click(within(dialog).getByRole('combobox', { name: /Groups/ }));
  await userEvent.click(await screen.findByRole('option', { name: 'Staff' }));
  await userEvent.click(within(dialog).getByRole('combobox', { name: /Groups/ }));
  await userEvent.click(await screen.findByRole('option', { name: 'Contractors' }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  const post = requests.filter((r) => r.method === 'POST' && r.path === '/api/admin/policies').pop();
  expect(post.body).toMatchObject({ name: 'Outsiders', subject_type: 'group', group_ids: [3, 4] });
});
