import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from '../components/Notify.jsx';
import MyGroups from './MyGroups.jsx';

afterEach(() => vi.unstubAllGlobals());

function mockApi({ managed = [], available }) {
  const calls = [];
  let list = available;
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    calls.push({ path, method: init.method || 'GET' });
    let out = null;
    if (path === '/my/groups') out = managed;
    if (path === '/my/groups/available') out = list;
    if (path.endsWith('/join')) { list = list.map((g) => (g.id === 1 ? { ...g, member: true, direct: true, can_join: false, can_leave: true } : g)); out = list[0]; }
    if (path.endsWith('/leave')) { list = list.map((g) => ({ ...g, member: false, direct: false, can_join: true, can_leave: false })); out = list[0]; }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
const club = { id: 1, name: 'club', description: 'Book club', member: false, direct: false, can_join: true, can_leave: false };
const renderPage = () => render(<MemoryRouter><NotifyProvider><MyGroups /></NotifyProvider></MemoryRouter>);

test('groups can be joined and left from the list', async () => {
  const calls = mockApi({ available: [club, { id: 2, name: 'inherited', description: '', member: true, direct: false, can_join: true, can_leave: false }] });
  renderPage();
  await screen.findByText('Groups you can join or leave');
  expect(screen.getByText('through another group')).toBeInTheDocument();
  expect(screen.queryByText('Groups you manage')).not.toBeInTheDocument();

  const join = screen.getAllByRole('button', { name: 'Join' })[0];
  await userEvent.click(join);
  await waitFor(() => expect(calls).toContainEqual({ path: '/my/groups/1/join', method: 'POST' }));
  const leave = await screen.findByRole('button', { name: 'Leave' });
  await userEvent.click(leave);
  await waitFor(() => expect(calls).toContainEqual({ path: '/my/groups/1/leave', method: 'POST' }));
  expect((await screen.findAllByText('Not a member')).length).toBeGreaterThan(0);
});

test('shows only the sections that apply, and a message when there is nothing', async () => {
  mockApi({ managed: [{ id: 9, name: 'hr', description: '', source: 'local', privilege: 'update' }], available: [] });
  const { unmount } = renderPage();
  await screen.findByText('Groups you manage');
  expect(screen.queryByText('Groups you can join or leave')).not.toBeInTheDocument();
  unmount();

  mockApi({ available: [] });
  renderPage();
  expect(await screen.findByText('You have not been given access to any groups.')).toBeInTheDocument();
});
