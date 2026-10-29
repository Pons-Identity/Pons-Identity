import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from './Notify.jsx';
import { AddMembersPanel, MemberGroupsPanel } from './GroupPanels.jsx';

const GROUPS = [{ id: 3, name: 'campus' }, { id: 2, name: 'staff' }, { id: 7, name: 'labs' }];
const PEOPLE = [{ id: 5, username: 'sam', display_name: 'Sam Lee' }, { id: 6, username: 'kim', display_name: 'Kim Park' }];

afterEach(() => { vi.unstubAllGlobals(); });

function mock(structure) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    calls.push({ path, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    let out = {};
    if (path.endsWith('/structure')) out = structure;
    else if (path === '/admin/groups') out = GROUPS;
    else if (path.startsWith('/admin/groups/3/candidates')) {
      const q = (new URL(path, 'http://idp.test').searchParams.get('q') || '').toLowerCase();
      out = PEOPLE.filter((u) => `${u.username} ${u.display_name}`.toLowerCase().includes(q));
    }
    return new Response(JSON.stringify(out), { status: init.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const renderAdd = (privilege = 'admin') => render(
  <NotifyProvider><AddMembersPanel base="/admin/groups" groupId={3} groupsPath="/admin/groups" privilege={privilege} /></NotifyProvider>,
);
const renderList = (privilege = 'admin') => render(
  <NotifyProvider><MemberGroupsPanel base="/admin/groups" groupId={3} privilege={privilege} /></NotifyProvider>,
);

test('one box searches people and groups, and one submit adds both', async () => {
  const calls = mock({ includes: [{ id: 2, name: 'staff' }], composite: null, would_loop: [] });
  const user = userEvent.setup();
  renderAdd();
  const box = await screen.findByRole('combobox', { name: 'People and groups' });
  await user.click(box);
  expect(await screen.findByRole('option', { name: 'labs' })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: /sam/ })).toBeInTheDocument();
  await user.click(screen.getByRole('option', { name: 'labs' }));
  await user.click(screen.getByRole('option', { name: /sam/ }));
  await user.click(screen.getByRole('button', { name: 'Add selected' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: '/admin/groups/3/members', method: 'POST', body: { user_ids: [5] } })));
  expect(calls).toContainEqual(expect.objectContaining({ path: '/admin/groups/3/includes', method: 'POST', body: { group_id: 7 } }));
});

test('a group already a member, and the group itself, are not offered', async () => {
  mock({ includes: [{ id: 2, name: 'staff' }], composite: null, would_loop: [] });
  const user = userEvent.setup();
  renderAdd();
  await user.click(await screen.findByRole('combobox', { name: 'People and groups' }));
  expect(await screen.findByRole('option', { name: 'labs' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'staff' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'campus' })).not.toBeInTheDocument();
});

test('typing searches: people come from the server and groups are narrowed to the matches', async () => {
  const calls = mock({ includes: [], composite: null, would_loop: [] });
  const user = userEvent.setup();
  renderAdd();
  const box = await screen.findByRole('combobox', { name: 'People and groups' });
  await user.click(box);
  await user.keyboard('kim');
  expect(box).toHaveValue('kim');
  expect(await screen.findByRole('option', { name: /kim/ })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('option', { name: /sam/ })).not.toBeInTheDocument());
  expect(screen.queryByRole('option', { name: 'labs' })).not.toBeInTheDocument();
  expect(calls.some((c) => c.path.includes('candidates?q=kim'))).toBe(true);
  await user.clear(box);
  await user.keyboard('lab');
  expect(await screen.findByRole('option', { name: 'labs' })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('option', { name: /kim/ })).not.toBeInTheDocument());
});

test('a reader is offered no add box', async () => {
  mock({ includes: [], composite: null, would_loop: [] });
  renderAdd('read');
  await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
});

test('member groups are listed, and an admin can remove one', async () => {
  const calls = mock({ includes: [{ id: 2, name: 'staff' }], composite: null, would_loop: [] });
  const user = userEvent.setup();
  renderList();
  expect(await screen.findByText('staff')).toBeInTheDocument();
  await user.click(screen.getByTestId('CancelIcon'));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: '/admin/groups/3/includes/2', method: 'DELETE' })));
});

test('a reader sees member groups but cannot remove them', async () => {
  mock({ includes: [{ id: 2, name: 'staff' }], composite: null, would_loop: [] });
  renderList('read');
  expect(await screen.findByText('staff')).toBeInTheDocument();
  expect(screen.queryByTestId('CancelIcon')).not.toBeInTheDocument();
});

test('a composite group has no member groups to show', async () => {
  mock({ includes: [], composite: { op: 'union', left: { id: 2, name: 'staff' }, right: { id: 7, name: 'labs' } } });
  renderList();
  await waitFor(() => expect(screen.queryByText('Member groups')).not.toBeInTheDocument());
});
