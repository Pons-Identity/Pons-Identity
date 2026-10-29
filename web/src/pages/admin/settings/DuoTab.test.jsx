import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const UNCONFIGURED = { enabled: false, apiHost: '', integrationKey: '', secretSet: false, source: 'file' };
const sent = [];
let duoAccepts = true;

function mock(saved = UNCONFIGURED) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['duo.manage'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/settings/duo/test') {
      sent.push(JSON.parse(opts.body));
      return duoAccepts ? json({ ok: true }) : json({ error: 'Duo rejected these settings: Invalid integration key', errors: ['Duo rejected these settings: Invalid integration key'] }, 400);
    }
    if (path === '/api/admin/settings/duo' && opts.method === 'PUT') { sent.push(JSON.parse(opts.body)); return json({ ...saved, enabled: JSON.parse(opts.body).enabled, secretSet: true }); }
    if (path === '/api/admin/settings/duo') return json(saved);
    return json({});
  }));
}
afterEach(() => { vi.unstubAllGlobals(); sent.length = 0; duoAccepts = true; });
const renderTab = () => render(<MemoryRouter initialEntries={['/admin/external-systems/duo']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);
const toggle = () => screen.findByRole('checkbox', { name: 'Require Duo after the password' }, { timeout: 5000 });

test('the Duo toggle stays off until the connection test passes', async () => {
  mock();
  renderTab();
  expect(await toggle()).toBeDisabled();
  await userEvent.type(screen.getByLabelText('API hostname'), 'api-test.duosecurity.com');
  await userEvent.type(screen.getByLabelText('Integration key'), 'DI1');
  await userEvent.type(screen.getByLabelText('Secret key'), 'sekrit');
  expect(await toggle()).toBeDisabled();
  await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
  expect(await toggle()).toBeEnabled();
  await userEvent.click(await toggle());
  expect(await toggle()).toBeChecked();
});

test('a failed test keeps the toggle locked', async () => {
  duoAccepts = false;
  mock();
  renderTab();
  await userEvent.type(await screen.findByLabelText('API hostname'), 'api-test.duosecurity.com');
  await userEvent.type(screen.getByLabelText('Integration key'), 'DI1');
  await userEvent.type(screen.getByLabelText('Secret key'), 'sekrit');
  await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
  expect(await screen.findByText(/Invalid integration key/)).toBeInTheDocument();
  expect(await toggle()).toBeDisabled();
});

test('editing a verified detail requires testing again', async () => {
  mock();
  renderTab();
  await userEvent.type(await screen.findByLabelText('API hostname'), 'api-test.duosecurity.com');
  await userEvent.type(screen.getByLabelText('Integration key'), 'DI1');
  await userEvent.type(screen.getByLabelText('Secret key'), 'sekrit');
  await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
  expect(await toggle()).toBeEnabled();
  await userEvent.type(screen.getByLabelText('Integration key'), '2');
  expect(await toggle()).toBeDisabled();
});

test('an already enabled Duo can be turned off without a new test', async () => {
  mock({ enabled: true, apiHost: 'api-test.duosecurity.com', integrationKey: 'DI1', secretSet: true, source: 'console' });
  renderTab();
  const enabled = await toggle();
  expect(enabled).toBeChecked();
  expect(enabled).toBeEnabled();
  await userEvent.click(enabled);
  expect(await toggle()).not.toBeChecked();
});
