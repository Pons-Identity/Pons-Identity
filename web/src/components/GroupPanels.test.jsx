import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from './Notify.jsx';
import { AccessPanel } from './GroupPanels.jsx';

afterEach(() => vi.unstubAllGlobals());

test('self-service can be granted to everyone, and only that', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '').split('?')[0];
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const out = path.endsWith('/admins')
      ? (init.method === 'POST' ? [{ id: 1, subject_type: 'everyone', subject_id: 0, subject_name: 'Everyone', privilege: 'optin' }] : [])
      : [];
    return new Response(JSON.stringify(out), { status: init.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<NotifyProvider><AccessPanel base="/admin/groups" groupId={5} groupsPath="/admin/groups" /></NotifyProvider>);
  await screen.findByText('Nobody has been delegated access.');

  // Defaults to a person with a management privilege, which has a search box and the full privilege list.
  expect(screen.getByLabelText('Search people')).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText('Privilege'));
  expect(within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['View', 'Read', 'Update', 'Admin', 'Join themselves', 'Leave themselves']);
  await userEvent.keyboard('{Escape}');

  await userEvent.click(screen.getByLabelText('Grant to'));
  await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Everyone' }));
  expect(screen.queryByLabelText('Search people')).not.toBeInTheDocument();
  // Switching to everyone moves the privilege to a self-service one, and management privileges are no longer offered.
  expect(screen.getByLabelText('Privilege')).toHaveTextContent('Join themselves');
  await userEvent.click(screen.getByLabelText('Privilege'));
  expect(within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Join themselves', 'Leave themselves']);
  await userEvent.keyboard('{Escape}');

  await userEvent.click(screen.getByRole('button', { name: 'Grant' }));
  await waitFor(() => expect(calls).toContainEqual({ path: '/admin/groups/5/admins', method: 'POST', body: { subject_type: 'everyone', subject_id: 0, privilege: 'optin' } }));
  expect(await within(screen.getByRole('table')).findByText('Join themselves')).toBeInTheDocument();
  expect(within(screen.getByRole('table')).getByText('Everyone')).toBeInTheDocument();
});
