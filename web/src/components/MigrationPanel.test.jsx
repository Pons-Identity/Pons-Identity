import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import MigrationPanel from './MigrationPanel.jsx';

const SOURCES = [
  { id: 'okta', label: 'Okta', docs: 'migrate-from-okta', slots: [
    { kind: 'okta-users', label: 'Users', needed: true, many: false, help: 'Every user.', where: 'Admin console: Directory, then People.' },
    { kind: 'okta-apps', label: 'Applications', needed: false, many: false, help: 'Your applications.', where: 'GET /api/v1/apps.' },
  ] },
  { id: 'shibboleth', label: 'Shibboleth IdP', docs: 'migrate-from-shibboleth', slots: [
    { kind: 'saml-metadata', label: 'Service provider metadata', needed: true, many: true, help: 'Each service provider.', where: 'conf/metadata-providers.xml.' },
  ] },
];

// A tiny stand-in for the migrate routes: it keeps staged files the way the server does.
function mock() {
  let files = [];
  let n = 0;
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    calls.push({ path, method: opts.method || 'GET' });
    const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
    if (path === '/api/admin/migrate' && (opts.method || 'GET') === 'GET') return json({ sources: SOURCES, files, maxFileMb: 25 });
    if (path.startsWith('/api/admin/migrate/files?')) {
      const q = new URL(path, 'http://x').searchParams;
      const kind = q.get('kind');
      const source = SOURCES.find((s) => s.slots.some((x) => x.kind === kind))?.id;
      files = [...files.filter((f) => f.kind !== kind), { id: `f${++n}`, name: q.get('name'), bytes: 2048, kind, source }];
      return json({ id: `f${n}`, files }, 201);
    }
    if (path === '/api/admin/migrate/preview') return json({ errors: ['Upload at least one file first.'] }, 400);
    return json({ files });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

test('a source shows one upload for each file it needs, with where to find it and a guide', async () => {
  mock();
  render(<MigrationPanel base="/admin/migrate" />);
  await userEvent.click(await screen.findByLabelText(/Coming from/));
  await userEvent.click(await screen.findByRole('option', { name: 'Okta' }));
  const users = screen.getByLabelText('Users');
  expect(within(users).getByText('Admin console: Directory, then People.')).toBeInTheDocument();
  expect(within(users).getByText('Needed')).toBeInTheDocument();
  expect(within(screen.getByLabelText('Applications')).getByText('Optional')).toBeInTheDocument();
  expect(screen.queryByText('Service provider metadata')).not.toBeInTheDocument();
  expect(within(users).getByRole('link', { name: /Read the guide/ })).toHaveAttribute('href', '/help/migrate-from-okta');
  expect(screen.getByRole('button', { name: 'Preview what will be imported' })).toBeDisabled();
});

test('each file goes to its own slot, and a one-file slot is replaced', async () => {
  const calls = mock();
  render(<MigrationPanel base="/admin/migrate" />);
  await userEvent.click(await screen.findByLabelText(/Coming from/));
  await userEvent.click(await screen.findByRole('option', { name: 'Okta' }));
  const input = screen.getByTestId('migration-file-okta-users');
  await userEvent.upload(input, new File(['a,b'], 'users.csv', { type: 'text/csv' }));
  expect(await screen.findByRole('list', { name: 'Uploaded Users' })).toHaveTextContent('users.csv');
  await userEvent.upload(screen.getByTestId('migration-file-okta-users'), new File(['[]'], 'again.json'));
  await waitFor(() => expect(screen.queryByText('users.csv')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: /Replace file/ })).toBeInTheDocument();
  expect(calls.some((c) => c.path.includes('kind=okta-users'))).toBe(true);
  expect(screen.getByRole('button', { name: 'Preview what will be imported' })).toBeEnabled();
});

test('a slot that takes several files says so', async () => {
  mock();
  render(<MigrationPanel base="/admin/migrate" />);
  await userEvent.click(await screen.findByLabelText(/Coming from/));
  await userEvent.click(await screen.findByRole('option', { name: 'Shibboleth IdP' }));
  expect(screen.getByTestId('migration-file-saml-metadata')).toHaveAttribute('multiple');
  expect(screen.getByRole('button', { name: 'Add files' })).toBeInTheDocument();
});
