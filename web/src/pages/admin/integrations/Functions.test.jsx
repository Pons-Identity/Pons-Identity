import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const FUNCTIONS = [
  { name: 'normalizeEmail', description: 'Trims and lower-cases an email address.', inputs: [{ name: 'email', variable: 'email' }], script: 'return email;', created_by: 'starter', updated_at: '2026-10-01T10:00:00Z' },
];

const INPUTS = [{ name: 'days', description: 'x' }, { name: 'email', description: 'The primary address.' }, { name: 'first_name', description: 'The user\'s first name.' }];

const requests = [];
function mock(permissions) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/integrations/functions') return json({ functions: FUNCTIONS, inputs: INPUTS });
    if (path.startsWith('/api/admin/integrations/functions/')) return json({ functions: [...FUNCTIONS, { name: 'chunk', description: 'Splits a list.', inputs: [], script: 'return 1;', updated_at: '' }] });
    return json({});
  }));
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('the functions tab lists the functions an integration can call', async () => {
  mock(['integrations.view']);
  renderAt('/admin/integrations/functions');
  const table = await screen.findByRole('table', { name: 'Functions' });
  expect(await within(table).findByText('fn.normalizeEmail')).toBeInTheDocument();
  expect(within(table).getByText('Trims and lower-cases an email address.')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'New function' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
});

test('an input name is chosen from the alphabetical list, or typed', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/functions/normalizeEmail?tab=inputs');
  await userEvent.click(await screen.findByRole('button', { name: 'Add input' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Input 1 name' }));
  const options = await screen.findAllByRole('option');
  expect(options.map((o) => o.querySelector('code').textContent)).toEqual(['days', 'email', 'first_name']);
  await userEvent.click(screen.getByRole('option', { name: /email/ }));
  expect(screen.getByRole('combobox', { name: 'Input 1 name' })).toHaveValue('email');
});

test('a new function is added from its details; its other tabs open once it exists', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/functions/new');
  await userEvent.type(await screen.findByLabelText(/^Name/), 'dateInDays');
  await userEvent.type(screen.getByLabelText(/^Description/), 'A date N days from now.');
  expect(screen.getByRole('tab', { name: 'Inputs' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Add function' }));
  const put = requests.find((r) => r.method === 'PUT');
  expect(put.path).toBe('/api/admin/integrations/functions/dateInDays');
  expect(put.body).toEqual({ description: 'A date N days from now.', inputs: [], script: '' });
});

test('editing a function keeps its name fixed and saves its description', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/functions/normalizeEmail');
  expect(await screen.findByLabelText(/^Name/)).toBeDisabled();
  expect(screen.getByLabelText(/^Name/)).toHaveValue('normalizeEmail');
  expect(screen.getByRole('button', { name: 'Save function' })).toBeDisabled();
  await userEvent.type(screen.getByLabelText(/^Description/), '!');
  await userEvent.click(screen.getByRole('button', { name: 'Save function' }));
  const put = requests.find((r) => r.method === 'PUT');
  expect(put.path).toBe('/api/admin/integrations/functions/normalizeEmail');
  expect(put.body).toMatchObject({ description: 'Trims and lower-cases an email address.!', script: 'return email;' });
});

test('the function body is saved from its own tab', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/functions/normalizeEmail?tab=body');
  expect(await screen.findByRole('textbox', { name: 'Function body' })).toHaveTextContent('return email;');
  await userEvent.click(screen.getByRole('textbox', { name: 'Function body' }));
  await userEvent.paste('return 2;');
  await userEvent.click(screen.getByRole('button', { name: 'Save function' }));
  const put = requests.find((r) => r.method === 'PUT');
  expect(put.body.script).toContain('return 2;');
});

test('a tab with unsaved changes stays open until they are saved or discarded', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/functions/normalizeEmail?tab=body');
  await userEvent.click(await screen.findByRole('textbox', { name: 'Function body' }));
  await userEvent.paste('return 2;');
  await userEvent.click(screen.getByRole('tab', { name: 'Details' }));
  expect(screen.getByRole('tab', { name: 'Function body' })).toHaveAttribute('aria-selected', 'true');
  await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  await userEvent.click(screen.getByRole('tab', { name: 'Details' }));
  expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
});

test('deleting asks first, then removes the function', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/functions');
  const table = await screen.findByRole('table', { name: 'Functions' });
  await userEvent.click(within(table).getByRole('button', { name: 'Delete' }));
  expect(screen.getByText(/fn\.normalizeEmail will fail/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Delete function' }));
  expect(requests.some((r) => r.method === 'DELETE' && r.path === '/api/admin/integrations/functions/normalizeEmail')).toBe(true);
});
