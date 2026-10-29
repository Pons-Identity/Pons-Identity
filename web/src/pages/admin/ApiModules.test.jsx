import { render, screen } from '@testing-library/react';
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

test('the API module lists the Group API and User API tabs', async () => {
  mock(['groupapi.manage', 'userapi.manage']);
  renderAt('/admin/api');
  expect(await screen.findByRole('tab', { name: 'Group API' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'User API' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'API' })).toBeInTheDocument();
});

test('the External systems module lists Grouper, Directories and RADIUS', async () => {
  mock(['grouper.manage', 'directories.manage', 'radius.manage']);
  renderAt('/admin/external-systems');
  expect(await screen.findByRole('tab', { name: 'Grouper' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Directories' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'RADIUS' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'External systems' })).toBeInTheDocument();
});

test('the old settings links open the moved pages', async () => {
  mock(['radius.manage']);
  renderAt('/admin/settings/radius');
  expect(await screen.findByRole('tab', { name: 'RADIUS' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'External systems' })).toBeInTheDocument();
});

test('the External systems module lists Duo MFA', async () => {
  mock(['duo.manage']);
  renderAt('/admin/external-systems');
  expect(await screen.findByRole('tab', { name: 'Duo MFA' })).toBeInTheDocument();
});

test('the Settings module no longer lists the moved tabs', async () => {
  mock(['duo.manage', 'radius.manage']);
  renderAt('/admin/settings');
  expect(await screen.findByText('You do not have permission to change any settings.')).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Duo MFA' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'RADIUS' })).not.toBeInTheDocument();
});
