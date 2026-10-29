import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const EVENT = {
  id: 9, ts: 1760000000, category: 'user', action: 'login.failure', outcome: 'failure', actor_type: 'anonymous', actor_name: 'mallory',
  target_type: '', target_id: '', target_name: '', ip: '203.0.113.7', user_agent: 'curl', session_id: '', request_id: 'req-1', detail: { reason: 'bad_credentials' },
};

const requests = [];
function mock({ permissions = ['audit.view'], sinks = [] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET' });
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/users') return json([]);
    if (path === '/api/admin/audit/forwarding/test') return json({ sinks });
    if (path === '/api/admin/audit/forwarding') return json({ sinks });
    if (path.startsWith('/api/admin/audit/suggest')) {
      return json(path.includes('field=actor') ? [{ value: 'mallory', label: '', count: 4 }] : [{ value: 'login.failure', label: '', count: 4 }, { value: 'login.success', label: '', count: 9 }]);
    }
    if (path.startsWith('/api/admin/audit')) return json({ events: [EVENT], next: null, retentionDays: 365 });
    return json({});
  }));
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider>
    </MemoryRouter>,
  );
}

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('lists events, shows retention, and opens the detail of one', async () => {
  mock();
  renderAt('/admin/audit');
  expect(await screen.findByText('login.failure')).toBeInTheDocument();
  expect(screen.getByText('mallory')).toBeInTheDocument();
  expect(screen.getByText('Events are kept for 365 days.')).toBeInTheDocument();
  expect(screen.getByText(/Not configured/)).toBeInTheDocument();

  await userEvent.click(screen.getByText('login.failure'));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/bad_credentials/)).toBeInTheDocument();
  expect(within(dialog).getByText(/203\.0\.113\.7/)).toBeInTheDocument();
});

test('filters are sent to the server', async () => {
  mock();
  renderAt('/admin/audit');
  await screen.findByText('login.failure');
  // The boxes offer only values that occur in the log; typing narrows the list and a listed value is chosen.
  await userEvent.type(screen.getByLabelText('Actor'), 'mall');
  await userEvent.click(await screen.findByRole('option', { name: /mallory/ }));
  await userEvent.click(screen.getByLabelText('Action'));
  await userEvent.click(await screen.findByRole('option', { name: /login\.failure/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Search' }));
  const last = requests.filter((r) => r.path.startsWith('/api/admin/audit?')).pop();
  expect(last.path).toContain('actor=mallory');
  expect(last.path).toContain('action=login.failure');
});

test('the export link carries the applied filters', async () => {
  mock();
  renderAt('/admin/audit');
  await screen.findByText('login.failure');
  expect(screen.getByRole('link', { name: /Export CSV/ })).toHaveAttribute('href', '/api/admin/audit.csv');
});

test('shows forwarding health and can send a test event', async () => {
  mock({ sinks: [{ sink: 'http', target: 'https://siem.example/ingest', pending: 2, lastSuccess: null, lastError: { at: 'x', message: 'HTTP 503 from log server' }, consecutiveFailures: 3 }] });
  renderAt('/admin/audit');
  expect(await screen.findByText('https://siem.example/ingest')).toBeInTheDocument();
  expect(screen.getByText('Failing')).toBeInTheDocument();
  expect(screen.getByText('HTTP 503 from log server')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Send test event' }));
  expect(requests.some((r) => r.path === '/api/admin/audit/forwarding/test' && r.method === 'POST')).toBe(true);
});

test('the Audit link appears only with the audit.view permission', async () => {
  mock({ permissions: ['users.view'] });
  renderAt('/admin/users');
  await screen.findByRole('heading', { name: 'Users' });
  expect(screen.queryByRole('link', { name: 'Audit' })).not.toBeInTheDocument();
});
