import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';
import Group from './Group.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

test('a group has a back link to the groups list', async () => {
  const group = { id: 'g1', name: 'Staff', description: '', source: 'local' };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: [] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path.endsWith('/effective-members')) return json([]);
    return json({ group, members: [], candidates: [] });
  }));
  render(
    <MemoryRouter initialEntries={['/admin/groups/g1']}>
      <NotifyProvider>
        <AuthProvider>
          <Routes><Route path="/admin/groups/:id" element={<Group />} /></Routes>
        </AuthProvider>
      </NotifyProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Staff' });
  expect(screen.getByRole('link', { name: '← Groups' })).toHaveAttribute('href', '/admin/groups');
});

test('after a person is added there is still one Add section, and it can add another person', async () => {
  const PEOPLE = [{ id: 5, username: 'sam', display_name: 'Sam Lee' }, { id: 6, username: 'kim', display_name: 'Kim Park' }];
  let direct = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['groups.manage'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/admin/groups/g1/members' && init.method === 'POST') {
      direct = [...direct, ...JSON.parse(init.body).user_ids.map((uid) => PEOPLE.find((p) => p.id === uid))];
      return json({});
    }
    if (path === '/admin/groups/g1/effective-members') return json(direct.map((p) => ({ ...p, direct: true, how: 'Direct' })));
    if (path === '/admin/groups/g1/structure') return json({ includes: [], included_in: [], composite: null, would_loop: [], effective_count: direct.length, privilege: 'admin' });
    if (path === '/admin/groups') return json([]);
    if (path.startsWith('/admin/groups/g1/candidates')) {
      const q = (new URL(path, 'http://idp.test').searchParams.get('q') || '').toLowerCase();
      return json(PEOPLE.filter((p) => !direct.some((d) => d.id === p.id) && `${p.username} ${p.display_name}`.toLowerCase().includes(q)));
    }
    if (path === '/admin/groups/g1') return json({ group: { id: 'g1', name: 'Staff', description: '', source: 'local' }, members: direct, candidates: [], role: 'application' });
    return json({});
  }));
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/admin/groups/g1']}>
      <NotifyProvider><AuthProvider><Routes><Route path="/admin/groups/:id" element={<Group />} /></Routes></AuthProvider></NotifyProvider>
    </MemoryRouter>,
  );
  const box = await screen.findByRole('combobox', { name: 'People and groups' });
  await user.click(box);
  await user.click(await screen.findByRole('option', { name: /sam/ }));
  await user.click(screen.getByRole('button', { name: 'Add selected' }));
  await screen.findByText('Sam Lee');
  expect(screen.getAllByRole('heading', { name: 'Add' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Add selected' })).toBeDisabled();

  await user.click(screen.getByRole('combobox', { name: 'People and groups' }));
  await user.keyboard('kim');
  await user.click(await screen.findByRole('option', { name: /kim/ }));
  await user.click(screen.getByRole('button', { name: 'Add selected' }));
  await screen.findByText('Kim Park');
  expect(direct.map((d) => d.username)).toEqual(['sam', 'kim']);
});
