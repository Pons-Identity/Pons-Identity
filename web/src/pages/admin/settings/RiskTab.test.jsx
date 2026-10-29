import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const SIG = (w) => ({ enabled: true, weight: w });
const SETTINGS = {
  mode: 'report', windowMinutes: 30, historyDays: 180, medium: 30, high: 60, actions: { medium: 'require_mfa', high: 'block' },
  signals: { spray: { ...SIG(50), ipUsernames: 5, asnUsernames: 15, accountIps: 5 }, impossible_travel: { ...SIG(60), maxSpeedKmh: 900, minDistanceKm: 100 }, new_device: SIG(20), new_country: SIG(25),
    country_mismatch: SIG(15), new_asn: SIG(15), device_geo: { enabled: false, weight: 30, maxDistanceKm: 300 }, sensitive_group: { enabled: true, weight: 30, groups: [] } },
  geoip: { cityPath: '', asnPath: '', city: null, asn: null },
};
const sent = [];
const uploads = [];

function mock() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['risk.manage'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/settings/risk' && opts.method === 'PUT') { sent.push(JSON.parse(opts.body)); return json({ ...SETTINGS, ...JSON.parse(opts.body), geoip_status: { city: 'file not found', asn: 'not configured' } }); }
    if (path === '/api/admin/settings/risk/simulate') { sent.push(JSON.parse(opts.body)); return json({ score: 75, level: 'high', action: 'block', mode: 'report', reasons: [{ code: 'impossible_travel', weight: 60, detail: '5570 km in 1 hours' }] }); }
    if (path === '/api/admin/settings/risk/geoip/city' && opts.method === 'PUT') {
      uploads.push({ path, type: opts.headers['content-type'], body: opts.body });
      return json({ ...SETTINGS, geoip: { ...SETTINGS.geoip, cityPath: '/data/geoip/GeoLite2-City.mmdb', city: { type: 'GeoLite2-City', built: '2026-10-01' } }, geoip_status: { city: 'loaded', asn: 'not configured' } });
    }
    if (path === '/api/admin/settings/risk') return json(SETTINGS);
    if (path === '/api/admin/groups') return json([{ id: 7, name: 'C-suite', description: 'Chief officers' }, { id: 8, name: 'Frequently phished', description: '' }]);
    return json({});
  }));
}
afterEach(() => { vi.unstubAllGlobals(); sent.length = 0; uploads.length = 0; });
const renderTab = () => render(<MemoryRouter initialEntries={['/admin/settings/risk']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);

test('turning a signal off and enforcing are saved with the rest of the settings', async () => {
  mock();
  renderTab();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Use Unrecognized device' }, { timeout: 5000 }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Mode' }));
  await userEvent.click(screen.getByRole('option', { name: /Enforce/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('file not found')).toBeInTheDocument();
  expect(sent[0].mode).toBe('enforce');
  expect(sent[0].signals.new_device.enabled).toBe(false);
  expect(sent[0].signals.spray.enabled).toBe(true);
});

test('a MaxMind database is uploaded from the page and then in use', async () => {
  mock();
  renderTab();
  const file = new File(['mmdb bytes'], 'GeoLite2-City.mmdb', { type: 'application/octet-stream' });
  await userEvent.upload(await screen.findByLabelText('City database file', {}, { timeout: 5000 }), file);
  expect(await screen.findByText('loaded')).toBeInTheDocument();
  expect(screen.getByLabelText('City database path')).toHaveValue('/data/geoip/GeoLite2-City.mmdb');
  expect(uploads).toHaveLength(1);
  expect(uploads[0].type).toBe('application/octet-stream');
  expect(uploads[0].body).toBe(file);
});

test('the simulator shows the score, the action and why', async () => {
  mock();
  renderTab();
  await userEvent.type(await screen.findByLabelText(/^Username/, {}, { timeout: 5000 }), 'tom');
  await userEvent.type(screen.getByLabelText('From address'), '203.0.113.2');
  await userEvent.click(screen.getByRole('button', { name: 'Score it' }));
  expect(await screen.findByText('high (75)')).toBeInTheDocument();
  expect(screen.getByText(/Action: Block \(not applied: mode is report\)/)).toBeInTheDocument();
  expect(screen.getByText(/5570 km in 1 hours/)).toBeInTheDocument();
  expect(sent[0]).toMatchObject({ username: 'tom', ip: '203.0.113.2', new_device: true });
});

test('an example fills the sign-in details and scores them with the username entered', async () => {
  mock();
  renderTab();
  await userEvent.type(await screen.findByLabelText(/^Username/, {}, { timeout: 5000 }), 'tom');
  await userEvent.click(screen.getByRole('button', { name: 'Abroad, new browser' }));
  expect(await screen.findByText('high (75)')).toBeInTheDocument();
  expect(screen.getByLabelText('Country code')).toHaveValue('GB');
  expect(screen.getByLabelText(/^Username/)).toHaveValue('tom');
  expect(sent[0]).toMatchObject({ username: 'tom', ip: '198.51.100.9', geo: { country: 'GB', lat: '51.5', lon: '-0.12', asn: '2856' }, new_device: true });
});

test('sensitive groups are chosen from the list and saved with the signal', async () => {
  mock();
  renderTab();
  await userEvent.click(await screen.findByRole('combobox', { name: 'Groups' }, { timeout: 5000 }));
  await userEvent.click(await screen.findByRole('option', { name: /^C-suite/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('file not found');
  expect(sent[0].signals.sensitive_group).toMatchObject({ enabled: true, groups: [7] });
});

test('the AS number is typed without the AS prefix, which is shown beside it', async () => {
  mock();
  renderTab();
  await userEvent.type(await screen.findByLabelText(/^Username/, {}, { timeout: 5000 }), 'tom');
  expect(screen.getByText('AS')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('AS number'), '7922');
  await userEvent.click(screen.getByRole('button', { name: 'Score it' }));
  await screen.findByText('high (75)');
  expect(sent[0].geo).toMatchObject({ asn: '7922' });
});

test('an example without a username only fills the details', async () => {
  mock();
  renderTab();
  await userEvent.click(await screen.findByRole('button', { name: 'Usual sign-in' }, { timeout: 5000 }));
  expect(screen.getByLabelText('From address')).toHaveValue('203.0.113.1');
  expect(screen.getByLabelText('Latitude')).toHaveValue('40.71');
  expect(sent).toHaveLength(0);
});
