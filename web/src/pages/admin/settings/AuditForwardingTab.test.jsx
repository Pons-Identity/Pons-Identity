import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const FACILITIES = ['kern', 'user', 'authpriv', 'local4'];
const NONE = {
  facilities: FACILITIES,
  syslog: { enabled: false, url: '', facility: 'authpriv', appName: 'simpleidp', caFile: '' },
  http: { enabled: false, url: '', format: 'json', tokenSet: false },
};
const sent = [];

function mock(saved = NONE) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['audit.manage'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/settings/audit-forwarding' && opts.method === 'PUT') {
      sent.push(JSON.parse(opts.body));
      return json({ ...saved, http: { ...saved.http, enabled: true, tokenSet: true } });
    }
    if (path === '/api/admin/settings/audit-forwarding') return json(saved);
    return json({});
  }));
}
afterEach(() => { vi.unstubAllGlobals(); sent.length = 0; });

const renderTab = () => render(<MemoryRouter initialEntries={['/admin/settings/log-forwarding']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);

test('a saved access token is never shown, only that one is saved', async () => {
  mock({ ...NONE, http: { enabled: true, url: 'https://siem.example/ingest', format: 'splunk-hec', tokenSet: true } });
  renderTab();
  expect(await screen.findByDisplayValue('https://siem.example/ingest')).toBeInTheDocument();
  expect(screen.getByLabelText('Access token')).toHaveValue('');
  expect(screen.getByText(/A token is saved/)).toBeInTheDocument();
});

test('saving sends the destinations, with a blank token to keep the saved one', async () => {
  mock();
  renderTab();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Send to a syslog server' }));
  await userEvent.type(screen.getByLabelText('Syslog server'), 'tls://logs.example.net:6514');
  await userEvent.click(screen.getByRole('checkbox', { name: 'Send to a SIEM over HTTP' }));
  await userEvent.type(screen.getByLabelText('SIEM URL'), 'https://siem.example/ingest');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Log forwarding saved')).toBeInTheDocument();
  expect(sent).toHaveLength(1);
  expect(sent[0].syslog).toMatchObject({ enabled: true, url: 'tls://logs.example.net:6514', facility: 'authpriv' });
  expect(sent[0].http).toMatchObject({ enabled: true, url: 'https://siem.example/ingest', format: 'json', authToken: '' });
});
