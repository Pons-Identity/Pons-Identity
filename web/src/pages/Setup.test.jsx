import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { NotifyProvider } from '../components/Notify.jsx';

const calls = [];
function mock({ session, status, verify = 200 }) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    calls.push({ path, method: opts.method || 'GET', headers: opts.headers, body: opts.body && JSON.parse(opts.body) });
    const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ csrf: 'c', config: {}, branding: { appName: 'Pons Identity', primaryColor: '#1f5fbf' }, ...session });
    if (path === '/api/setup/status') return json(status);
    if (path === '/api/setup/verify') return verify === 200 ? json({ ok: true, mode: 'initial' }) : json({ errors: ['That setup token is not right.'] }, verify);
    if (path === '/api/setup/defaults') return json({ branding: { appName: 'Pons Identity', primaryColor: '#1f5fbf' }, session: { sessionHours: 8, idleMinutes: 30 }, baseUrl: window.location.origin, mode: 'initial' });
    if (path === '/api/setup/migrate') return json({ sources: [{ id: 'okta', label: 'Okta', docs: 'migrate-from-okta', slots: [] }], files: [], maxFileMb: 25 });
    if (path === '/api/setup/complete') return json({ ok: true, mode: 'initial', imported: null });
    return json({});
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const open = (path) => render(<MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);

test('while nobody can sign in, every address leads to the wizard, which asks for the token first', async () => {
  mock({ session: { me: null, setupRequired: true }, status: { required: true, canRerun: false } });
  open('/admin/users');
  expect(await screen.findByRole('heading', { name: 'Welcome to Pons Identity' })).toBeInTheDocument();
  expect(screen.getByLabelText('Setup token')).toBeInTheDocument();
});

test('a wrong token is shown in the wizard instead of sending the person to sign in', async () => {
  mock({ session: { me: null, setupRequired: true }, status: { required: true, canRerun: false }, verify: 401 });
  open('/setup');
  await userEvent.type(await screen.findByLabelText('Setup token'), 'nope');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('That setup token is not right.')).toBeInTheDocument();
  expect(screen.getByLabelText('Setup token')).toBeInTheDocument();
});

test('the steps lead from token to administrator to finishing, and the token travels as a header', async () => {
  mock({ session: { me: null, setupRequired: true }, status: { required: true, canRerun: false } });
  open('/setup');
  await userEvent.type(await screen.findByLabelText('Setup token'), 'abcd-1234');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('Username');
  // A mismatch is caught before anything is sent.
  await userEvent.type(screen.getByLabelText('Email'), 'a@example.net');
  await userEvent.type(screen.getByLabelText('Password'), 'long enough passphrase 1!');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'something else');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText('Confirm password'));
  await userEvent.type(screen.getByLabelText('Confirm password'), 'long enough passphrase 1!');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByLabelText('Product name');
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText(/Coming from another identity provider/);
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));
  await waitFor(() => expect(calls.some((c) => c.path === '/api/setup/complete')).toBe(true));
  const done = calls.find((c) => c.path === '/api/setup/complete');
  expect(done.headers['x-setup-token']).toBe('abcd-1234');
  expect(done.body.admin.username).toBe('admin');
  expect(done.body.branding.appName).toBe('Pons Identity');
  expect(await screen.findByText(/The wizard is now switched off/)).toBeInTheDocument();
});

test('a closed wizard is not shown to people who cannot reopen it', async () => {
  mock({ session: { me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['users.view'] }, setupRequired: false }, status: { required: false, canRerun: false } });
  open('/setup');
  await waitFor(() => expect(screen.queryByRole('heading', { name: /Welcome to Pons Identity|Setup wizard/ })).not.toBeInTheDocument());
});

test('a person who may re-run it gets the wizard without the token and administrator steps', async () => {
  mock({ session: { me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['setup.run'] }, setupRequired: false }, status: { required: false, canRerun: true } });
  open('/setup');
  expect(await screen.findByRole('heading', { name: 'Setup wizard' })).toBeInTheDocument();
  expect(await screen.findByLabelText('Product name')).toBeInTheDocument();
  expect(screen.queryByLabelText('Setup token')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
});
