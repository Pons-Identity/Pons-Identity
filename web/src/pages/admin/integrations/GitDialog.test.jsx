import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import GitDialog from './GitDialog.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const calls = [];
function mock({ permissions = ['integrations.view', 'integrations.manage'], status }) {
  let current = status;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    calls.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: {} });
    if (path === '/api/admin/integrations/git') return json(current);
    if (path === '/api/admin/integrations/git/commit') { current = { ...current, initialized: true, changes: [], last: { short: 'abc1234', subject: 'First' } }; return json({ created: true, status: current }, 201); }
    if (path === '/api/admin/integrations/git/push') return json({ status: current });
    return json({});
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const show = () => render(
  <MemoryRouter><NotifyProvider><AuthProvider><GitDialog open onClose={() => {}} /></AuthProvider></NotifyProvider></MemoryRouter>,
);
const FRESH = { available: true, initialized: false, branch: 'main', remoteUrl: '', changes: [{ status: 'A', path: 'integrations/x/script.js' }], last: null, unpushed: 0 };

test('with no repository it says committing will create one, and commit needs a message', async () => {
  mock({ status: FRESH });
  show();
  expect(await screen.findByText('Not a Git repository yet (committing will initialize one).')).toBeInTheDocument();
  const commit = screen.getByRole('button', { name: 'Commit all changes' });
  const push = screen.getByRole('button', { name: 'Push' });
  expect(commit).toBeDisabled();
  expect(push).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Commit message'), 'First snapshot');
  expect(commit).toBeEnabled();
  await userEvent.click(commit);
  await waitFor(() => expect(calls.find((c) => c.path.endsWith('/commit'))?.body).toEqual({ message: 'First snapshot', branch: 'main' }));
  expect(await screen.findByText(/Last commit abc1234: First/)).toBeInTheDocument();
});

test('push sends the remote, branch and token, and the token field is cleared afterwards', async () => {
  mock({ status: { ...FRESH, initialized: true, changes: [], last: { short: 'abc1234', subject: 'First' }, unpushed: 1 } });
  show();
  await screen.findByText(/1 commit not pushed/);
  const token = screen.getByLabelText('Access token (not stored)');
  expect(token).toHaveAttribute('type', 'password');
  await userEvent.type(screen.getByLabelText('Remote URL (https)'), 'https://git.example.net/team/idp.git');
  await userEvent.type(token, 'ghp_abc');
  await userEvent.click(screen.getByRole('button', { name: 'Push' }));
  await waitFor(() => expect(calls.find((c) => c.path.endsWith('/push'))?.body).toEqual({ remoteUrl: 'https://git.example.net/team/idp.git', branch: 'main', token: 'ghp_abc' }));
  await waitFor(() => expect(token).toHaveValue(''));
});

test('a viewer sees the state but cannot commit or push', async () => {
  mock({ permissions: ['integrations.view'], status: { ...FRESH, remoteUrl: 'https://git.example.net/a.git' } });
  show();
  await screen.findByText(/Not a Git repository yet/);
  expect(screen.getByLabelText('Commit message')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Commit all changes' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Push' })).toBeDisabled();
});

test('without git installed it says so', async () => {
  mock({ status: { available: false, message: 'Git is not installed on the server, so integrations cannot be committed. Install git and try again.' } });
  show();
  expect(await screen.findByText(/Git is not installed on the server/)).toBeInTheDocument();
});
