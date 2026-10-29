import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const GROUPS = [{ id: 20, name: 'Weavers', source: 'local' }, { id: 21, name: 'Retirees', source: 'local' }];
const PEOPLE = [{ id: 5, username: 'sam', display_name: 'Sam Lee' }, { id: 6, username: 'kim', display_name: 'Kim Park' }];

const requests = [];
function mock({ permissions = ['groups.manage', 'users.view'] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/users') return json(PEOPLE);
    if (path === '/api/admin/groups' && (opts.method || 'GET') === 'GET') return json(GROUPS);
    if (path === '/api/admin/group-folders/tree') return json({ folders: [], groups: [] });
    if (path === '/api/admin/ldap-query/check') return json({ ok: true, matches: 2, attributes: [] });
    if (path === '/api/admin/groups' && opts.method === 'POST') return json({ group: { id: 9, name: 'Underwater Basket-Weaving staff' }, members: [], candidates: [], ran: { added: 2, removed: 0 } }, 201);
    if (path === '/api/admin/groups/9') return json({ group: { id: 9, name: 'Underwater Basket-Weaving staff', source: 'local', description: '' }, members: [], candidates: [] });
    if (path === '/api/admin/groups/9/effective-members') return json([]);
    if (path === '/api/admin/groups/9/structure') return json({ includes: [], included_in: [], composite: null, would_loop: [], include_exclude: null, effective_count: 0, privilege: 'admin' });
    return json({});
  }));
}
const renderNew = () => render(
  <MemoryRouter initialEntries={['/admin/groups/new']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);
afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('a new group is made with its name, the people added by hand, and its query', async () => {
  mock();
  const user = userEvent.setup();
  renderNew();
  await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Underwater Basket-Weaving staff');
  await user.type(screen.getByRole('textbox', { name: /^Description/ }), 'Test group');
  await user.click(screen.getByRole('combobox', { name: 'Added directly to' }));
  await user.click(await screen.findByRole('option', { name: /sam/ }));
  await user.type(screen.getByRole('textbox', { name: 'LDAP query' }), '(department=Underwater Basket-Weaving)');
  const create = screen.getByRole('button', { name: 'Create group' });
  await vi.waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await vi.waitFor(() => expect(requests.find((r) => r.method === 'POST' && r.path === '/api/admin/groups')).toBeTruthy());
  expect(requests.find((r) => r.method === 'POST' && r.path === '/api/admin/groups').body).toEqual({
    name: 'Underwater Basket-Weaving staff', description: 'Test group', user_ids: [5], rule: { filter: '(department=Underwater Basket-Weaving)', mode: 'ongoing' }, composite: null,
  });
});

test('a composite group is made from two groups, with no people or query of its own', async () => {
  mock();
  const user = userEvent.setup();
  renderNew();
  await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Active weavers');
  await user.type(screen.getByRole('textbox', { name: /^Description/ }), 'Test group');
  await user.click(screen.getByRole('radio', { name: /Composite/ }));
  expect(screen.queryByRole('combobox', { name: 'Added directly to' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'LDAP query' })).not.toBeInTheDocument();
  const create = screen.getByRole('button', { name: 'Create group' });
  expect(create).toBeDisabled();
  await user.click(screen.getByRole('combobox', { name: 'First group' }));
  await user.click(await screen.findByRole('option', { name: 'Weavers' }));
  await user.click(screen.getByRole('combobox', { name: 'Second group' }));
  await user.click(await screen.findByRole('option', { name: 'Retirees' }));
  await user.click(screen.getByRole('combobox', { name: 'Combine' }));
  await user.click(await screen.findByRole('option', { name: 'First, not second' }));
  await vi.waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await vi.waitFor(() => expect(requests.find((r) => r.method === 'POST' && r.path === '/api/admin/groups')).toBeTruthy());
  expect(requests.find((r) => r.method === 'POST' && r.path === '/api/admin/groups').body).toEqual({
    name: 'Active weavers', description: 'Test group', user_ids: [], rule: null, composite: { op: 'minus', left_id: 20, right_id: 21 },
  });
});

test('a composite cannot use the same group twice', async () => {
  mock();
  const user = userEvent.setup();
  renderNew();
  await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Same');
  await user.type(screen.getByRole('textbox', { name: /^Description/ }), 'Test group');
  await user.click(screen.getByRole('radio', { name: /Composite/ }));
  await user.click(screen.getByRole('combobox', { name: 'First group' }));
  await user.click(await screen.findByRole('option', { name: 'Weavers' }));
  await user.click(screen.getByRole('combobox', { name: 'Second group' }));
  await user.click(await screen.findByRole('option', { name: 'Weavers' }));
  expect(screen.getAllByText('Choose a different group.')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
});

test('a group with no query sends no rule', async () => {
  mock();
  const user = userEvent.setup();
  renderNew();
  await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Everyone');
  await user.type(screen.getByRole('textbox', { name: /^Description/ }), 'Test group');
  await user.click(screen.getByRole('button', { name: 'Create group' }));
  await vi.waitFor(() => expect(requests.find((r) => r.method === 'POST')).toBeTruthy());
  expect(requests.find((r) => r.method === 'POST').body).toEqual({ name: 'Everyone', description: 'Test group', user_ids: [], rule: null, composite: null });
});

test('a description is optional: a group can be made without one', async () => {
  mock();
  const user = userEvent.setup();
  renderNew();
  await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Everyone');
  expect(screen.getByRole('textbox', { name: /^Description/ })).not.toBeRequired();
  await user.click(screen.getByRole('button', { name: 'Create group' }));
  await vi.waitFor(() => expect(requests.find((r) => r.method === 'POST')).toBeTruthy());
  expect(requests.find((r) => r.method === 'POST').body).toEqual({ name: 'Everyone', description: '', user_ids: [], rule: null, composite: null });
});

test('without groups.manage the page says so and offers no form', async () => {
  mock({ permissions: ['groups.view'] });
  renderNew();
  expect(await screen.findByText('Creating a group needs the Manage groups permission.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create group' })).not.toBeInTheDocument();
});

test('the groups list links to the new group page', async () => {
  mock();
  render(
    <MemoryRouter initialEntries={['/admin/groups']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
  );
  const link = await screen.findByRole('link', { name: /New group/ });
  expect(link).toHaveAttribute('href', '/admin/groups/new');
});
