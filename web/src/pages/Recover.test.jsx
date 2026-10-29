import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { NotifyProvider } from '../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const posted = [];

function mock({ recovery = true, tokenOk = true, resetStatus = 200 } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: null, csrf: 'c', config: { passwordRecovery: recovery }, branding: BRANDING });
    if (path === '/api/recover' && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return json({ ok: true, message: 'If we found an account, we sent a link.' }); }
    if (path === '/api/recover/tok1' && (!opts.method || opts.method === 'GET')) return tokenOk ? json({ username: 'sam', min_length: 12 }) : json({ error: 'This link has expired or was already used.' }, 404);
    if (path === '/api/recover/reset') { posted.push(JSON.parse(opts.body)); return resetStatus === 200 ? json({ ok: true }) : json({ error: 'Password must be at least 12 characters.' }, resetStatus); }
    return json({});
  }));
}
const renderAt = (path) => render(<MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);

afterEach(() => { vi.unstubAllGlobals(); posted.length = 0; });

test('the sign-in page links to recovery only when it is on', async () => {
  mock({ recovery: true });
  renderAt('/login');
  expect(await screen.findByRole('link', { name: 'Forgot your password?' })).toHaveAttribute('href', '/recover');
});

test('no link, and the page redirects, when recovery is off', async () => {
  mock({ recovery: false });
  renderAt('/login');
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  expect(screen.queryByText('Forgot your password?')).not.toBeInTheDocument();
});

test('asking for a link shows the same message whatever was typed', async () => {
  mock();
  renderAt('/recover');
  await userEvent.type(await screen.findByLabelText(/Username or email/), 'someone');
  await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(await screen.findByText('If we found an account, we sent a link.')).toBeInTheDocument();
  expect(posted[0]).toEqual({ identifier: 'someone' });
});

test('the emailed link lets the person choose a password, checking the two match', async () => {
  mock();
  renderAt('/recover/tok1');
  await userEvent.type(await screen.findByLabelText(/^New password/), 'a-long-new-password');
  await userEvent.type(screen.getByLabelText(/Confirm new password/), 'different-password');
  await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
  expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
  expect(posted).toHaveLength(0);
  await userEvent.clear(screen.getByLabelText(/Confirm new password/));
  await userEvent.type(screen.getByLabelText(/Confirm new password/), 'a-long-new-password');
  await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
  expect(await screen.findByText(/Your password has been changed/)).toBeInTheDocument();
  expect(posted[0]).toEqual({ token: 'tok1', new_password: 'a-long-new-password' });
});

test('an expired link says so and offers a new one', async () => {
  mock({ tokenOk: false });
  renderAt('/recover/tok1');
  expect(await screen.findByText('This link has expired or was already used.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Send a new link' })).toBeInTheDocument();
});

test('when identity verification is required, the person verifies before choosing a password', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    calls.push(path);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: null, csrf: 'c', config: { passwordRecovery: true }, branding: BRANDING });
    if (path === '/api/recover/tok2') return json({ username: 'sam', min_length: 12, purpose: 'password', identity: { required: true, status: 'missing', available: true } });
    if (path === '/api/recover/identity') return json({ purpose: 'password', identity: { required: true, status: 'pending', url: 'https://withpersona.com/verify?inquiry-id=inq_1', available: true } });
    if (path === '/api/recover/identity/check') return json({ purpose: 'password', identity: { required: true, status: 'approved', available: true } });
    return json({});
  }));
  renderAt('/recover/tok2');
  await userEvent.click(await screen.findByRole('button', { name: 'Verify my identity' }));
  expect(await screen.findByRole('link', { name: 'Open the verification' })).toHaveAttribute('href', 'https://withpersona.com/verify?inquiry-id=inq_1');
  await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByLabelText(/^New password/)).toBeInTheDocument();
  expect(calls).toContain('/api/recover/identity/check');
});

test('a second-factor link removes the factors once identity is verified, and asks for no password', async () => {
  const posted = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: null, csrf: 'c', config: { passwordRecovery: true, mfaReset: true }, branding: BRANDING });
    if (path === '/api/recover/tok3') return json({ username: 'sam', min_length: 12, purpose: 'mfa', identity: { required: true, status: 'approved', available: true } });
    if (path === '/api/recover/mfa/reset') { posted.push(JSON.parse(opts.body)); return json({ ok: true }); }
    return json({});
  }));
  renderAt('/recover/tok3');
  expect(screen.queryByLabelText(/^New password/)).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: 'Remove my second factors' }));
  expect(await screen.findByText(/Your second factors were removed/)).toBeInTheDocument();
  expect(posted).toEqual([{ token: 'tok3' }]);
});
