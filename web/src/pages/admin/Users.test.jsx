import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const KEY = 'simpleidp.users.columns';
// Alice's search matches: her username and first name are exactly what was typed.
const alice = { id: 2, username: 'alice', display_name: 'Alice Adams', email: 'alice@example.net', emails: ['alice@example.net'], first_name: 'Alice',
  department: 'Underwater Basket-Weaving', group_count: 1, active: true, mfa_enabled: false, totp_enabled: false, directory: null, matched: ['username', 'first_name'] };

function mock() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['users.view'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path.startsWith('/api/admin/users/mfa-required')) return json({});
    if (path.startsWith('/api/admin/users')) {
      // As the server does: only a text search lists the whole-value matches.
      const q = new URL(path, 'http://x').searchParams.get('q');
      return json([q ? alice : { ...alice, matched: [] }]);
    }
    return json({});
  }));
}

const renderPage = () => render(<MemoryRouter initialEntries={['/admin/users']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);
// The action column has no heading text, so it is left out.
const headers = () => screen.getAllByRole('columnheader').map((th) => th.textContent).filter(Boolean);

beforeEach(() => { mock(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

test('the admin chooses which columns the list shows, and the choice is kept', async () => {
  renderPage();
  await screen.findByText('alice');
  expect(headers()).toEqual(['Username', 'Name', 'Email', 'Groups', 'Status']);

  await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Department' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Email' }));
  await userEvent.keyboard('{Escape}');

  expect(headers()).toEqual(['Username', 'Name', 'Department', 'Groups', 'Status']);
  expect(JSON.parse(localStorage.getItem(KEY))).toEqual(['username', 'display_name', 'department', 'group_count', 'status']);
});

test('a search that matches a whole field shows that field\'s column, even when it is not chosen', async () => {
  renderPage();
  await screen.findByText('alice');
  expect(headers()).not.toContain('First name');

  await userEvent.type(screen.getByLabelText('Search people'), 'alice');
  expect(await screen.findByRole('columnheader', { name: 'First name' })).toBeInTheDocument();
  expect(within(screen.getByRole('table')).getByText('Alice')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(KEY))).toBeNull();
});

// Three people for the sort and filter tests: bob is disabled and needs MFA, carol is locked down and has the most groups.
const people = [
  { ...alice, id: 2, group_count: 1, locked_down: false },
  { ...alice, id: 3, username: 'bob', display_name: 'Bob Baker', emails: ['bob@example.net'], group_count: 3, active: false, mfa_enabled: true, locked_down: false, matched: [] },
  { ...alice, id: 4, username: 'carol', display_name: 'Carol Clark', emails: ['carol@example.net'], group_count: 2, active: true, mfa_enabled: false, locked_down: true, matched: [] },
];

// As the server does: the policy lookup answers for each id asked about, with whether a policy requires a second factor for it.
const policyAnswer = (path, policy) => Object.fromEntries(new URL(path, 'http://x').searchParams.get('ids').split(',').map((id) => [id, { required: Boolean(policy[id]) }]));

function mockPeople(list, policy = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['users.view'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path.startsWith('/api/admin/users/mfa-required')) return json(policyAnswer(path, policy));
    if (path.startsWith('/api/admin/users')) return json(list);
    return json({});
  }));
}

const names = () => within(screen.getByRole('table')).queryAllByRole('row').slice(1).map((r) => r.querySelector('td').textContent);
const pick = async (label, option) => {
  await userEvent.click(screen.getByRole('combobox', { name: label }));
  await userEvent.click(screen.getByRole('option', { name: option }));
};

test('a person locked down shows a red Locked down badge in the Status column', async () => {
  mockPeople(people);
  renderPage();
  await screen.findByText('carol');
  const badges = within(screen.getByRole('table')).getAllByText('Locked down');
  expect(badges).toHaveLength(1);
  expect(badges[0].closest('.MuiChip-colorError')).not.toBeNull();
});

test('the list sorts by any column, in either order', async () => {
  mockPeople(people);
  renderPage();
  await screen.findByText('carol');
  expect(names()).toEqual(['alice', 'bob', 'carol']);

  await pick('Sort by', 'Groups');
  expect(names()).toEqual(['alice', 'carol', 'bob']);

  await pick('Order', 'Descending');
  expect(names()).toEqual(['bob', 'carol', 'alice']);
});

test('flags narrow the list to people with or without them, and can be cleared', async () => {
  mockPeople(people);
  renderPage();
  await screen.findByText('carol');

  await pick('Locked down', 'Yes');
  expect(names()).toEqual(['carol']);

  await pick('Locked down', 'Any');
  await pick('Disabled', 'Yes');
  expect(names()).toEqual(['bob']);

  await pick('Disabled', 'No');
  await pick('MFA required', 'No');
  expect(names()).toEqual(['alice', 'carol']);

  await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(names()).toEqual(['alice', 'bob', 'carol']);
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
});

test('a person whom a sign-in policy requires a second factor for shows MFA required, and the flag filter counts it', async () => {
  mockPeople(people, { 4: true });
  renderPage();
  await screen.findByText('carol');
  await waitFor(() => expect(within(screen.getByRole('table')).getAllByText('MFA required')).toHaveLength(2));

  await pick('MFA required', 'Yes');
  expect(names()).toEqual(['bob', 'carol']);
});

test('administrator-defined attributes are columns the admin can show, and a search that matches one shows its column', async () => {
  const room = { ...alice, attributes: { room: 'r-204' }, matched: ['attr:room'] };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['users.view'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/attribute-defs') return json([{ name: 'room', label: 'Room', type: 'text' }]);
    if (path.startsWith('/api/admin/users')) return json([new URL(path, 'http://x').searchParams.get('q') ? room : { ...room, matched: [] }]);
    return json({});
  }));
  renderPage();
  await screen.findByText('alice');
  expect(headers()).not.toContain('Room');

  await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Room' }));
  await userEvent.keyboard('{Escape}');
  expect(headers()).toEqual(['Username', 'Name', 'Email', 'Groups', 'Status', 'Room']);
  expect(within(screen.getByRole('table')).getByText('r-204')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(KEY))).toEqual(['username', 'display_name', 'emails', 'group_count', 'status', 'attr:room']);
});

// The full record the view dialog and the edit page load for one person.
const detail = { ...alice, guid: 'g-0002', personal_email: 'alice.home@example.net', custom: 'x=1\ny=2', attributes: {}, memberships: [{ id: 9, name: 'Staff', source: 'local', via: [] }], locked_down: false, factors: [], role_ids: [], group_ids: [] };

function mockDetail() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['users.view'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path.startsWith('/api/admin/users/mfa-required')) return json({});
    if (path === '/api/admin/users/2') return json(detail);
    if (path === '/api/admin/users/2/password-rules') return json({});
    if (path === '/api/admin/options') return json({ groups: [], roles: [] });
    if (path === '/api/admin/attribute-defs') return json([]);
    if (path.startsWith('/api/admin/users')) return json([alice]);
    return json({});
  }));
}

test('View opens the person in a dialog with a copy button for each field, and Close returns to the list', async () => {
  mockDetail();
  renderPage();
  await screen.findByText('alice');

  await userEvent.click(screen.getByRole('button', { name: 'View alice' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('textbox', { name: 'Username' })).toHaveValue('alice');
  expect(within(dialog).getByRole('textbox', { name: 'Personal recovery email' })).toHaveValue('alice.home@example.net');
  expect(within(dialog).getByRole('textbox', { name: 'Groups' })).toHaveValue('Staff');
  expect(within(dialog).getByRole('button', { name: 'Copy Username' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Copy GUID' })).toBeInTheDocument();
  // Still on the list: the dialog did not navigate to the edit page.
  expect(screen.queryByRole('heading', { name: 'Edit alice' })).toBeNull();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('table')).toBeInTheDocument();
});

test('Edit in the view dialog goes to the edit page for that person', async () => {
  mockDetail();
  renderPage();
  await screen.findByText('alice');

  await userEvent.click(screen.getByRole('button', { name: 'View alice' }));
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Edit' }));
  expect(await screen.findByRole('heading', { name: 'Edit alice' })).toBeInTheDocument();
});

test('clicking a row outside the View button still goes to the edit page', async () => {
  mockDetail();
  renderPage();
  await screen.findByText('alice');

  await userEvent.click(screen.getByText('Alice Adams'));
  expect(await screen.findByRole('heading', { name: 'Edit alice' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).toBeNull();
});
