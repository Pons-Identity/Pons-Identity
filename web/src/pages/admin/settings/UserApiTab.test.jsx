import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const SCOPES = { 'users:read': 'Look up users', 'users:write': 'Create, change and delete ordinary users' };
const posted = [];

function mock() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const view = (tokens) => ({ apiUrl: 'https://idp.test/api/v1', docsUrl: 'https://idp.test/api/v1/docs', scopes: SCOPES, tokens });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['userapi.manage'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/user-api/tokens' && opts.method === 'POST') {
      posted.push(JSON.parse(opts.body));
      return json({ ...view([{ id: 1, name: 'HR sync', scopes: ['users:read'], expires_at: '', created_at: '2026-10-24T00:00:00Z', created_by: 'a', last_used_at: '' }]), token: 'uat_secret123' }, 201);
    }
    if (path === '/api/admin/user-api') return json(view([]));
    return json({});
  }));
}

afterEach(() => { vi.unstubAllGlobals(); posted.length = 0; });

test('creating a token sends the chosen scopes and shows the token once', async () => {
  mock();
  render(<MemoryRouter initialEntries={['/admin/settings/user-api']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);
  await userEvent.type(await screen.findByLabelText(/Token name/), 'HR sync');
  await userEvent.click(screen.getByRole('checkbox', { name: /users:write/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
  expect(await screen.findByDisplayValue('uat_secret123')).toBeInTheDocument();
  expect(posted[0]).toMatchObject({ name: 'HR sync', scopes: ['users:read'] });
  expect(within(screen.getByRole('table', { name: 'API tokens' })).getByText('users:read')).toBeInTheDocument();
});
