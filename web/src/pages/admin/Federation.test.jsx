import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };

// The tabs' own data is not what these tests check, so every other call answers with an error, as the tabs expect when a service is down.
function mock(permissions) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    return json({ error: 'Not part of this test.' }, 404);
  }));
}
const renderAt = (path) => render(<MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);

afterEach(() => vi.unstubAllGlobals());

test('the Federation module opens with its page heading', async () => {
  mock(['federation.view']);
  renderAt('/admin/federation');
  expect(await screen.findByRole('heading', { name: 'Federation' })).toBeInTheDocument();
  expect(screen.queryByText('You do not have permission to view federation.')).not.toBeInTheDocument();
});

test('the Federation module is refused without federation.view', async () => {
  mock(['roles.view']);
  renderAt('/admin/federation');
  expect(await screen.findByText('You do not have permission to view federation.')).toBeInTheDocument();
});

test('the old settings link opens the Federation module', async () => {
  mock(['federation.view']);
  renderAt('/admin/settings/federation');
  expect(await screen.findByRole('heading', { name: 'Federation' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Federation/ })).toBeInTheDocument();
});

test('the Settings module no longer lists Federation', async () => {
  mock(['roles.view', 'federation.view']);
  renderAt('/admin/settings');
  expect(await screen.findByRole('tab', { name: 'Roles & permissions' })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Federation' })).not.toBeInTheDocument();
});

test('the Modules menu lists Federation between Policies and API', async () => {
  mock(['policies.view', 'federation.view', 'groupapi.manage']);
  renderAt('/admin/api');
  await userEvent.click(await screen.findByRole('button', { name: 'API' }));
  const labels = screen.getAllByRole('menuitem').map((item) => item.querySelector('.MuiListItemText-primary').textContent);
  const at = (label) => labels.indexOf(label);
  expect(at('Federation')).toBe(at('Policies') + 1);
  expect(at('API')).toBe(at('Federation') + 1);
});

test('the Federation menu item is hidden without federation.view', async () => {
  mock(['policies.view', 'groupapi.manage']);
  renderAt('/admin/api');
  await userEvent.click(await screen.findByRole('button', { name: 'API' }));
  expect(screen.queryByRole('menuitem', { name: /Federation/ })).not.toBeInTheDocument();
});
