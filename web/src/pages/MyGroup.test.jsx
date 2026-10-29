import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from '../components/Notify.jsx';
import MyGroup from './MyGroup.jsx';

const calls = [];
function mockApi(privilege) {
  const structure = { includes: [], included_in: [], composite: null, would_loop: [], effective_count: 1, privilege };
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '').split('?')[0];
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const out = {
      '/my/groups': [{ id: 5, name: 'hr', description: '', source: 'local', privilege }],
      '/my/groups/5/members': [{ id: 1, username: 'erin', display_name: 'Erin' }],
      '/my/groups/5/candidates': [{ id: 2, username: 'frank', display_name: 'Frank' }],
      '/my/groups/5/structure': structure,
      '/my/groups/5/effective-members': [{ id: 1, username: 'erin', display_name: 'Erin', direct: true, start_at: null, end_at: null }],
      '/my/groups/5/audit': [{ id: 1, ts: 1700000000, actor: 'dana', action: 'member.add', detail: 'erin' }],
      '/my/groups/5/admins': [],
    }[path];
    return new Response(JSON.stringify(out ?? {}), { status: out ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

function renderPage(privilege) {
  mockApi(privilege);
  return render(
    <MemoryRouter initialEntries={['/groups/5']}>
      <NotifyProvider><Routes><Route path="/groups/:id" element={<MyGroup />} /></Routes></NotifyProvider>
    </MemoryRouter>,
  );
}

test('an update grant can add and remove members but not manage access', async () => {
  renderPage('update');
  await screen.findByText('Your access: Update');
  expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'People' })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Delegated access' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: '/my/groups/5/members/1', method: 'DELETE' })));
});

test('a read grant sees members but gets no editing controls', async () => {
  renderPage('read');
  await screen.findByText('Your access: Read');
  await screen.findByText('Effective members (1)');
  expect(screen.queryByRole('combobox', { name: /People/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add selected' })).not.toBeInTheDocument();
});

test('a view grant is told to ask for read access and loads nothing more', async () => {
  renderPage('view');
  await screen.findByText(/Ask a group administrator for read access/);
  expect(calls.some((c) => c.path.endsWith('/structure'))).toBe(false);
});

test('an admin grant gets the delegated access tab', async () => {
  renderPage('admin');
  await userEvent.click(await screen.findByRole('tab', { name: 'Delegated access' }));
  expect(await screen.findByText('Nobody has been delegated access.')).toBeInTheDocument();
});
