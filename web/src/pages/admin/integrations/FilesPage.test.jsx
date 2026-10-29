import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const LIST = {
  stat: { path: '/exports', name: 'exports', kind: 'dir', size: 0, updated_at: '', updated_by: '' },
  entries: [
    { path: '/exports/hr', name: 'hr', kind: 'dir', size: 0, updated_at: '2026-10-01T10:00:00Z', updated_by: '' },
    { path: '/exports/people.csv', name: 'people.csv', kind: 'file', size: 42, updated_at: '2026-10-01T10:00:00Z', updated_by: 'integration:HR sync' },
    { path: '/exports/photo.png', name: 'photo.png', kind: 'file', size: 42, updated_at: '2026-10-01T10:00:00Z', updated_by: 'integration:HR sync' },
  ],
  viewBytes: 256 * 1024,
};
const SFTP = { enabled: false, port: 2222, bindAddress: '0.0.0.0', running: false, error: '', fingerprint: 'SHA256:abc' };

const requests = [];
function mock(permissions) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET' });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path.startsWith('/api/admin/files/list')) return json(LIST);
    if (path.startsWith('/api/admin/files/view')) return json({ text: 'name,email\nsam,sam@example.net' });
    if (path === '/api/admin/files/sftp') return json(SFTP);
    return json({});
  }));
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('the Files tab lists a folder, opens a folder from its name, and shows the SFTP server as off', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/files?path=%2Fexports');
  const table = await screen.findByRole('table', { name: 'Files and folders' });
  expect(await within(table).findByText('people.csv')).toBeInTheDocument();
  expect(within(table).getByRole('button', { name: 'hr' })).toBeInTheDocument();
  expect(within(within(table).getByRole('row', { name: /people\.csv/ })).getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/admin/files/download?path=%2Fexports%2Fpeople.csv');
  expect(screen.getByText('Off')).toBeInTheDocument();
  expect(screen.getByDisplayValue('SHA256:abc')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New folder' })).toBeInTheDocument();
  expect(requests.some((r) => r.path === '/api/admin/files/list?path=%2Fexports')).toBe(true);
});

test('viewers see the files and the SFTP settings, but cannot change them', async () => {
  mock(['integrations.view']);
  renderAt('/admin/integrations/files');
  const table = await screen.findByRole('table', { name: 'Files and folders' });
  expect(await within(table).findByText('people.csv')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument();
  expect(within(table).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  expect(within(table).queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save SFTP settings' })).not.toBeInTheDocument();
});

test('a small plain-text file opens in a viewer, and other files do not offer one', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/files?path=%2Fexports');
  const table = await screen.findByRole('table', { name: 'Files and folders' });
  expect(await within(table).findByText('people.csv')).toBeInTheDocument();
  expect(within(table).getAllByRole('button', { name: 'View' })).toHaveLength(1);
  await userEvent.click(within(table).getByRole('button', { name: 'View' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('textbox', { name: 'people.csv' })).toHaveValue('name,email\nsam,sam@example.net');
  expect(requests.some((r) => r.path === '/api/admin/files/view?path=%2Fexports%2Fpeople.csv')).toBe(true);
});
