import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const calls = [];

function mock() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['users.manage', 'users.view'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/users/bulk' && opts.method === 'POST') {
      calls.push(JSON.parse(opts.body));
      return json({ dry_run: true, summary: { total: 2, valid: 1, failed: 1, created: 0 }, generated: [],
        rows: [{ row: 2, username: 'ann', status: 'valid', errors: [] }, { row: 3, username: 'bob', status: 'error', errors: ['Password is required.'] }] });
    }
    if (path === '/api/admin/users/bulk') return json([]);
    return json({});
  }));
}

afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

test('checking a CSV shows each row and what is wrong with it, without creating anything', async () => {
  mock();
  render(<MemoryRouter initialEntries={['/admin/users/import']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);
  const box = await screen.findByLabelText('CSV');
  await userEvent.click(box);
  await userEvent.paste('username,password\nann,annpass123\nbob,');
  await userEvent.click(screen.getByRole('button', { name: 'Check' }));
  expect(await screen.findByText('Password is required.')).toBeInTheDocument();
  expect(screen.getByText('1 ready', { exact: false })).toBeInTheDocument();
  expect(calls[0].dry_run).toBe(true);
  expect(calls[0].csv).toContain('ann,annpass123');
});
