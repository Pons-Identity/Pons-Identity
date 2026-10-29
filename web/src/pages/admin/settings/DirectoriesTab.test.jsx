import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from '../../../components/Notify.jsx';
import DirectoriesTab from './DirectoriesTab.jsx';

const AD = { url: '', startTls: false, rejectUnauthorized: true, caCertificate: '', bindDn: '', baseDn: '', userFilter: '(sAMAccountName={username})', attributeMap: { username: 'sAMAccountName' }, groupAttribute: 'memberOf', autoProvision: true, timeoutSeconds: 10 };
const LISTING = { directories: [], defaults: { ad: AD, ldap: { ...AD, userFilter: '(uid={username})', attributeMap: { username: 'uid' }, groupAttribute: '' } }, apiUrl: 'https://idp.test/directory/v1' };

const requests = [];
function mock() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    requests.push({ path: String(url), method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/feed')) return json({ config: { format: 'csv', mode: 'full', rules: '', leaverAction: 'deactivate', pull: {} }, runs: [], reference: { targets: [], functions: [], example: '' }, pushUrl: '' });
    if (opts.method === 'POST') return json({ id: 7, name: 'Office', type: 'ad', enabled: false, config: { ...AD, bindPasswordSet: false }, tokenSet: false, tokenCreatedAt: '', lastActivity: { at: '', summary: '' }, userCount: 0, groupCount: 0 }, 201);
    return json(LISTING);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  requests.length = 0;
});

test('a new directory shows LDAP settings only once a server URL is entered, and saves them', async () => {
  mock();
  const user = userEvent.setup();
  render(<NotifyProvider><DirectoriesTab /></NotifyProvider>);

  await user.click(await screen.findByRole('button', { name: 'Add directory' }));
  expect(screen.queryByLabelText(/Search base DN/)).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Attribute mapping' })).toBeNull();

  await user.type(screen.getByLabelText(/^Name/), 'Office');
  await user.type(screen.getByLabelText('Server URL'), 'ldaps://dc.example.com');
  await user.type(await screen.findByLabelText(/Search base DN/), 'DC=example,DC=com');
  expect(screen.getByRole('heading', { name: 'Attribute mapping' })).toBeTruthy();
  expect(screen.getByLabelText(/^Username/).value).toBe('sAMAccountName');

  await user.click(screen.getByRole('button', { name: 'Save' }));
  const post = requests.find((r) => r.method === 'POST');
  expect(post.path).toBe('/api/admin/directories');
  expect(post.body).toMatchObject({ name: 'Office', type: 'ad', config: { url: 'ldaps://dc.example.com', baseDn: 'DC=example,DC=com' } });
});

test('a directory can be deleted from the list after confirming', async () => {
  const dir = { id: 3, name: 'Old AD', type: 'ad', enabled: true, config: { ...AD, url: 'ldaps://x' }, tokenSet: false, tokenCreatedAt: '', lastActivity: { at: '', summary: '' }, userCount: 2, groupCount: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    requests.push({ path: String(url), method: opts.method || 'GET' });
    if (opts.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ...LISTING, directories: [dir] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const user = userEvent.setup();
  render(<NotifyProvider><DirectoriesTab /></NotifyProvider>);

  await user.click(await screen.findByRole('button', { name: 'Delete Old AD' }));
  expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
  await user.click(await screen.findByRole('button', { name: 'Delete' }));
  expect(requests.find((r) => r.method === 'DELETE').path).toBe('/api/admin/directories/3');
});
