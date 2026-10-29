import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import GlobalSearch from './GlobalSearch.jsx';

// The signed-in administrator, who may open every area the tests search.
vi.mock('../auth/AuthContext.jsx', () => ({
  DEFAULT_PRODUCT_NAME: 'Pons Identity',
  useAuth: () => ({ session: { me: { id: 1, username: 'admin', is_admin: true, permissions: ['users.view', 'groups.view', 'audit.view'] } } }),
  useProductName: () => 'Pons Identity',
}));

// jsdom has no layout, so the highlighted result cannot be scrolled into view; the component asks for it anyway.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => vi.unstubAllGlobals());

// Shows where the router has taken the page, so a test can check where a result leads.
function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function mockSearch(body) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderSearch = (onClose = () => {}) => render(
  <MemoryRouter initialEntries={['/']}>
    <GlobalSearch open onClose={onClose} />
    <Where />
  </MemoryRouter>,
);

test('results are grouped by area, and the arrow keys and Enter open one', async () => {
  const fetchMock = mockSearch({
    people: { results: [{ id: 4, username: 'alice', display_name: 'Alice Adams', email: 'alice@example.net', department: 'Underwater Basket-Weaving' }], total: 1 },
    groups: { results: [{ id: 2, name: 'underwater-basket-weaving-staff', description: 'Everyone in underwater basket-weaving', member_count: 3 }], total: 1 },
  });
  const onClose = vi.fn();
  renderSearch(onClose);

  await userEvent.type(screen.getByRole('textbox', { name: 'Search the console' }), 'phys');
  expect(await screen.findByText('Alice Adams')).toBeInTheDocument();
  expect(screen.getByText('People · 1')).toBeInTheDocument();
  expect(screen.getByText('Groups · 1')).toBeInTheDocument();
  expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/admin/search?q=phys');

  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(screen.getByTestId('where')).toHaveTextContent('/admin/groups/2');
  expect(onClose).toHaveBeenCalled();
});

test('a bad LDAP filter is reported in the people section, with no matches elsewhere', async () => {
  mockSearch({ people: { results: [], total: 0, error: 'Expected ")" at position 6.' } });
  renderSearch();

  await userEvent.type(screen.getByRole('textbox', { name: 'Search the console' }), '(cn=al');
  expect(await screen.findByText('Expected ")" at position 6.')).toBeInTheDocument();
  expect(screen.getByText(/No matches for/)).toBeInTheDocument();
});

test('"See all" opens the list page searched with the same text', async () => {
  mockSearch({ audit: { results: [{ id: 9, ts: 1700000000, action: 'login.failure', outcome: 'failure', actor_name: 'mallory', target_name: '' }], total: 1 } });
  renderSearch();

  await userEvent.type(screen.getByRole('textbox', { name: 'Search the console' }), 'mallory');
  await userEvent.click(await screen.findByRole('button', { name: 'See all' }));
  expect(screen.getByTestId('where')).toHaveTextContent('/admin/audit?q=mallory');
});

test('documentation matches are listed, and Enter opens the article', async () => {
  mockSearch({});
  const onClose = vi.fn();
  renderSearch(onClose);

  await userEvent.type(screen.getByRole('textbox', { name: 'Search the console' }), 'passkey');
  expect(await screen.findByText('Add a security key or passkey')).toBeInTheDocument();
  expect(screen.getByText(/^Documentation · \d+$/)).toBeInTheDocument();

  await userEvent.keyboard('{Enter}');
  expect(screen.getByTestId('where')).toHaveTextContent('/help/add-security-key');
  expect(onClose).toHaveBeenCalled();
});

test('"See all" on documentation opens the help page searched with the same text', async () => {
  mockSearch({});
  renderSearch();

  await userEvent.type(screen.getByRole('textbox', { name: 'Search the console' }), 'passkey');
  await userEvent.click(await screen.findByRole('button', { name: 'See all' }));
  expect(screen.getByTestId('where')).toHaveTextContent('/help?q=passkey');
});
