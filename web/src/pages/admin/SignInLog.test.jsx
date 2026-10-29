import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const EVENT = {
  id: 7, ts: 1760000000, type: 'signin', outcome: 'success', reason: '', user_id: 3, username: 'mallory', factor: '', amr: ['pwd'], ip: '203.0.113.2',
  country: 'GB', country_name: 'United Kingdom', region: '', city: 'London', lat: 51.5, lon: -0.12, asn: 2856, asn_org: 'BT', device_id: 'abc123def456', device_known: false,
  user_agent: 'Mozilla/5.0 Chrome/120', browser: 'Chrome 120', os: 'macOS', device_type: 'desktop', device_lat: null, device_lon: null,
  risk_score: 75, risk_level: 'high', risk_action: 'block', risk_reasons: [{ code: 'impossible_travel', weight: 60, detail: '5570 km from the last sign-in 1 hours ago' }, { code: 'new_device', weight: 15, detail: 'this browser has not signed in to this account before' }],
  session_id: 'sess1', request_id: 'req-9',
};
const urls = [];

function mock() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    urls.push(path);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['audit.view'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path.startsWith('/api/admin/auth-log/suggest')) return json([{ value: 'mallory', label: '', count: 3 }]);
    if (path.startsWith('/api/admin/auth-log')) return json({ events: [EVENT], next: null });
    return json({});
  }));
}
afterEach(() => { vi.unstubAllGlobals(); urls.length = 0; });

test('rows show person, place, network, device and risk; a row opens everything an investigator needs', async () => {
  mock();
  render(<MemoryRouter initialEntries={['/admin/sign-ins']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);
  const table = await screen.findByRole('table', { name: 'Sign-in log' }, { timeout: 5000 });
  expect(within(table).getByText('mallory')).toBeInTheDocument();
  expect(within(table).getByText(/London, United Kingdom · AS2856 BT/)).toBeInTheDocument();
  expect(within(table).getByText('Chrome 120 on macOS')).toBeInTheDocument();
  expect(within(table).getByText('high 75')).toBeInTheDocument();
  await userEvent.click(within(table).getByText('mallory'));
  expect(await screen.findByText(/5570 km from the last sign-in/)).toBeInTheDocument();
  expect(screen.getByText('req-9')).toBeInTheDocument();
  expect(screen.getByText(/new to this account/)).toBeInTheDocument();
});

test('searching and following an address send the filters', async () => {
  mock();
  render(<MemoryRouter initialEntries={['/admin/sign-ins']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);
  await userEvent.type(await screen.findByLabelText('Person', {}, { timeout: 5000 }), 'mal');
  await userEvent.click(await screen.findByRole('option', { name: /mallory/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
  expect(urls.some((u) => u.includes('username=mallory'))).toBe(true);
  await userEvent.click(await screen.findByRole('button', { name: '203.0.113.2' }));
  expect(urls.some((u) => u.includes('ip=203.0.113.2') && !u.includes('username='))).toBe(true);
});
