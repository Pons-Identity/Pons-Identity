import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { NotifyProvider } from '../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const calls = [];

function mock({ factors, enroll_options = [], challenge } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    calls.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: null, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/login/mfa') return json({ username: 'sam', enroll: null, factors, enroll_options });
    if (path === '/api/login/mfa/challenge') return json(challenge);
    if (path === '/api/login/mfa/challenge/status') return json({ result: 'waiting' });
    return json({});
  }));
}
const renderAt = (path) => render(<MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);

afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

test('with several methods the person chooses; number matching shows a number and has no code box', async () => {
  mock({
    factors: [{ id: 'totp', type: 'totp', label: 'Authenticator app', phishing_resistant: false }, { id: 'f3', type: 'sms', label: 'Text message', hint: '******1234', phishing_resistant: true }],
    challenge: { mode: 'number_match', number: '482', expires_in: 300, hint: '******1234' },
  });
  renderAt('/login/mfa');
  await userEvent.click(await screen.findByRole('button', { name: /Text message.*phishing resistant/ }));
  await userEvent.click(screen.getByRole('button', { name: /Send to \*+1234/ }));
  expect(await screen.findByText('482')).toBeInTheDocument();
  expect(screen.queryByLabelText(/Six-digit code/)).not.toBeInTheDocument();
  expect(calls.find((c) => c.path === '/api/login/mfa/challenge').body).toEqual({ factor: 'f3' });
});

test('with one authenticator app the code box is shown straight away', async () => {
  mock({ factors: [{ id: 'totp', type: 'totp', label: 'Authenticator app' }] });
  renderAt('/login/mfa');
  expect(await screen.findByLabelText(/Six-digit code/)).toBeInTheDocument();
});
