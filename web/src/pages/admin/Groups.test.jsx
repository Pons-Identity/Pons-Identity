import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';
import { buildIndex, folderChoices, resolveDrop } from './groupTree.js';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const g = (id, name, folder_id = null, position = 0) => ({ id, name, description: '', source: 'local', folder_id, position, member_count: 1, effective_count: 1 });
const f = (id, name, parent_id = null, path = name) => ({ id, parent_id, name, description: '', position: 0, path });
const TREE = {
  folders: [f(1, 'Departments'), f(2, 'Underwater Basket-Weaving', 1, 'Departments/Underwater Basket-Weaving'), f(3, 'Archive')],
  groups: [g(10, 'weavers', 2), g(11, 'staff', 2), g(12, 'everyone')],
};

test('resolveDrop: into folders, before/after siblings, and never into itself', () => {
  const ix = buildIndex(TREE);
  const open = new Set([1, 2, 3]);
  expect(resolveDrop(ix, open, { kind: 'group', id: 12 }, { kind: 'folder', id: 3 })).toEqual({ parent_id: 3, hint: 'into' });
  expect(resolveDrop(ix, open, { kind: 'group', id: 11 }, { kind: 'group', id: 10 }, 0.1)).toEqual({ parent_id: 2, hint: 'before', before_id: 10 });
  expect(resolveDrop(ix, open, { kind: 'group', id: 10 }, { kind: 'group', id: 11 }, 0.9)).toEqual({ parent_id: 2, hint: 'after' });
  expect(resolveDrop(ix, open, { kind: 'group', id: 12 }, { kind: 'group', id: 10 }, 0.9)).toEqual({ parent_id: 2, hint: 'after', before_id: 11 });
  expect(resolveDrop(ix, open, { kind: 'folder', id: 3 }, { kind: 'folder', id: 1 }, 0.1)).toEqual({ parent_id: null, hint: 'before', before_id: 1 });
  expect(resolveDrop(ix, open, { kind: 'folder', id: 1 }, { kind: 'folder', id: 2 })).toBeNull();
  expect(resolveDrop(ix, open, { kind: 'folder', id: 1 }, { kind: 'folder', id: 1 })).toBeNull();
  expect(resolveDrop(ix, open, { kind: 'folder', id: 1 }, { kind: 'group', id: 10 })).toBeNull();
  expect(resolveDrop(ix, open, { kind: 'folder', id: 2 }, 'root')).toEqual({ parent_id: null, hint: 'into' });
});

test('folderChoices excludes a folder and its subfolders', () => {
  const ix = buildIndex(TREE);
  expect(folderChoices(ix).map((c) => c.label)).toEqual(['Departments', 'Departments/Underwater Basket-Weaving', 'Archive']);
  expect(folderChoices(ix, 1).map((c) => c.label)).toEqual(['Archive']);
});

const requests = [];
function mock({ permissions = ['groups.manage'] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/group-folders/tree' || path === '/api/admin/group-folders/move') return json(TREE);
    return json({});
  }));
}
const renderGroups = () => render(
  <MemoryRouter initialEntries={['/admin/groups']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);
afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; localStorage.clear(); });

test('shows folders and their groups, and collapsing hides what is inside', async () => {
  mock();
  renderGroups();
  expect(await screen.findByText('weavers')).toBeInTheDocument();
  expect(screen.getByText('everyone')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Collapse Underwater Basket-Weaving' }));
  expect(screen.queryByText('weavers')).not.toBeInTheDocument();
});

test('dropping a group on a folder moves it there', async () => {
  mock();
  renderGroups();
  const row = (await screen.findByText('everyone')).closest('tr');
  const archive = screen.getByText('Archive').closest('tr');
  fireEvent.dragStart(row);
  fireEvent.dragOver(archive);
  fireEvent.drop(archive);
  await vi.waitFor(() => expect(requests.find((r) => r.path.endsWith('/move'))).toBeTruthy());
  expect(requests.find((r) => r.path.endsWith('/move')).body).toEqual({ type: 'group', id: 12, parent_id: 3 });
});

test('the row menu moves a group without dragging', async () => {
  mock();
  const user = userEvent.setup();
  renderGroups();
  await screen.findByText('everyone');
  await user.click(screen.getByRole('button', { name: 'Actions for everyone' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: 'Archive' }));
  await user.click(within(dialog).getByRole('button', { name: 'Move' }));
  await vi.waitFor(() => expect(requests.find((r) => r.path.endsWith('/move'))).toBeTruthy());
  expect(requests.find((r) => r.path.endsWith('/move')).body).toEqual({ type: 'group', id: 12, parent_id: 3 });
});

test('without groups.manage nothing can be dragged or edited', async () => {
  mock({ permissions: ['groups.view'] });
  renderGroups();
  const row = (await screen.findByText('everyone')).closest('tr');
  expect(row).not.toHaveAttribute('draggable');
  expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument();
});
