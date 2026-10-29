import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const NOW = Math.floor(Date.now() / 1000 / 900) * 900;
const buckets = Array.from({ length: 96 }, (_, i) => ({ ts: NOW - (95 - i) * 900, succeeded: i === 95 ? 7 : 0, failed: i === 94 ? 2 : 0 }));
const DASHBOARD = {
  users: 1284, activeUsers: 1201, groups: 42, sps: 9, roles: 5,
  signIns: { succeeded: 7, failed: 2, usersSignedIn: 4, buckets },
};

function mock(permissions) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/dashboard') return json(DASHBOARD);
    return json({});
  }));
}

function renderDashboard() {
  return render(<MemoryRouter initialEntries={['/']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);
}

afterEach(() => vi.unstubAllGlobals());

test('shows the directory counts as plain numbers and the 24-hour sign-in figures', async () => {
  mock(['users.view', 'groups.view', 'sps.view', 'roles.view', 'audit.view']);
  renderDashboard();
  expect(await screen.findByText('1,284')).toBeInTheDocument();
  expect(screen.getByText('1,201 active')).toBeInTheDocument();
  expect(screen.getAllByText('Successful sign-ins')[0].nextSibling).toHaveTextContent('7');
  expect(screen.getAllByText('Failed or denied')[0].nextSibling).toHaveTextContent('2');
  expect(screen.getByRole('img', { name: 'Sign-ins per 15 minutes over the last 24 hours' })).toBeInTheDocument();
  expect(screen.getByText('Authentications, last 24 hours')).toBeInTheDocument();
});

test('the sign-in figures and chart are left out without audit access', async () => {
  mock(['users.view']);
  renderDashboard();
  expect(await screen.findByText('1,284')).toBeInTheDocument();
  expect(screen.queryByText('Successful sign-ins')).not.toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Sign-ins per 15 minutes over the last 24 hours' })).not.toBeInTheDocument();
});

test('the chart data is also available as a table', async () => {
  mock(['audit.view']);
  renderDashboard();
  const table = await screen.findByLabelText('Sign-ins per 15 minutes'); // sits inside the collapsed "Show as table" section
  expect(table.querySelectorAll('tr')).toHaveLength(97); // header plus one row per 15 minutes
});
