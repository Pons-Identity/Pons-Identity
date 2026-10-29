import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi, afterEach } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { NotifyProvider } from '../components/Notify.jsx';
import { ARTICLES, SECTIONS, visibleArticles } from '../help/articles.js';

afterEach(() => vi.unstubAllGlobals());

// Serve /api/session for the given user, with the given permissions.
function mockSignedInAs(me, branding = { appName: 'Pons Identity', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' }) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ me, csrf: 'c', config: {}, branding }),
    { status: 200, headers: { 'content-type': 'application/json' } })));
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotifyProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </NotifyProvider>
    </MemoryRouter>,
  );
}

const person = { id: 2, username: 'bob', display_name: 'Bob', is_admin: false, permissions: [], manages_groups: false, self_service: false };

test('the navbar links to help from a button beside the profile menu', async () => {
  mockSignedInAs(person);
  renderAt('/help');
  const help = await screen.findByRole('link', { name: 'Help' });
  expect(help).toHaveAttribute('href', '/help');
  expect(screen.getByRole('button', { name: 'Bob' })).toBeInTheDocument();
});

test('a person with no permissions sees only the everyday articles', async () => {
  mockSignedInAs(person);
  renderAt('/help');
  expect(await screen.findByRole('link', { name: /Change your password/ })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Create a user/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Find events in the audit/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Join or leave a group/ })).not.toBeInTheDocument();
});

test('an administrator with a permission sees the articles for it', async () => {
  mockSignedInAs({ ...person, is_admin: true, permissions: ['users.manage', 'users.view'] });
  renderAt('/help');
  expect(await screen.findByRole('link', { name: /Create a user/ })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Run a report/ })).not.toBeInTheDocument();
});

test('an article opens and shows its steps', async () => {
  mockSignedInAs(person);
  renderAt('/help/change-password');
  expect(await screen.findByRole('heading', { name: 'Change your password', level: 1 })).toBeInTheDocument();
  const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
  expect(steps[0]).toMatch(/^Select your name in the top bar, then select Profile\./);
});

test('an article is written with the product name the administrator chose, under name propagation', async () => {
  const article = ARTICLES.find((a) => JSON.stringify(a.body).includes('Pons Identity') && a.visible({ me: person, can: () => false }));
  mockSignedInAs(person, { appName: 'Acme ID', productName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' });
  renderAt(`/help/${article.slug}`);
  expect(await screen.findByRole('heading', { name: article.title, level: 1 })).toBeInTheDocument();
  expect(document.body.textContent).toContain('Acme ID');
  expect(document.body.textContent).not.toContain('Pons Identity');
});

test('an article the person may not read is reported as not found', async () => {
  mockSignedInAs(person);
  renderAt('/help/create-user');
  expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
});

test('every article has a title, summary and a known section', () => {
  for (const a of ARTICLES) {
    expect(a.title, a.slug).toBeTruthy();
    expect(a.summary, a.slug).toBeTruthy();
    expect(SECTIONS, a.slug).toContain(a.section);
    expect(typeof a.visible, a.slug).toBe('function');
  }
  const slugs = ARTICLES.map((a) => a.slug);
  expect(new Set(slugs).size).toBe(slugs.length);
});

// Every /help/<slug> link inside an article must name a real article.
function linksIn(value, out = []) {
  if (typeof value === 'string') for (const m of value.matchAll(/\]\((\/help\/[^)]+)\)/g)) out.push(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => linksIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => linksIn(v, out));
  return out;
}

test('every help link points at an article that exists', () => {
  const slugs = new Set(ARTICLES.map((a) => `/help/${a.slug}`));
  for (const a of ARTICLES) {
    for (const link of linksIn(a.body)) expect(slugs.has(link), `${a.slug} links to ${link}`).toBe(true);
  }
});

test('integration developers see the reference, and only administrators see the write-up of scripts', () => {
  const viewer = { me: person, can: (p) => p === 'integrations.view' };
  const titles = visibleArticles(viewer).map((a) => a.title);
  expect(titles).toContain('Reference: integration functions');
  expect(titles).not.toContain('Write an integration script');
  expect(titles).not.toContain('Write a custom report');
  expect(titles).not.toContain('Add a SAML 2.0 application');
});

test('protocol reference needs sps.view, and configuration needs sps.manage', () => {
  const reader = { me: person, can: (p) => p === 'sps.view' };
  const titles = visibleArticles(reader).map((a) => a.title);
  expect(titles).toContain('Reference: OpenID Connect');
  expect(titles).not.toContain('Add an OpenID Connect application');
});

test('a reference article renders its tables and code', async () => {
  mockSignedInAs({ ...person, is_admin: true, permissions: ['integrations.view'] });
  renderAt('/help/reference-integration-limits');
  expect(await screen.findByRole('heading', { name: 'Reference: limits, scopes and security', level: 1 })).toBeInTheDocument();
  expect(screen.getAllByRole('table').length).toBeGreaterThan(1);
  expect(screen.getByText('users:read')).toBeInTheDocument();
});

test('the help search filters the articles, and an empty result says so', async () => {
  mockSignedInAs(person);
  renderAt('/help?q=passkey');
  expect(await screen.findByRole('link', { name: /Add a security key or passkey/ })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Change your password/ })).not.toBeInTheDocument();
  expect(screen.getByRole('searchbox', { name: 'Search help' })).toHaveValue('passkey');
});

test('a help search with no matches says so', async () => {
  mockSignedInAs(person);
  renderAt('/help?q=zzz-no-such-thing');
  expect(await screen.findByText('No help matches “zzz-no-such-thing”.')).toBeInTheDocument();
});

test('the index groups articles under their section headings', async () => {
  mockSignedInAs({ ...person, is_admin: true, permissions: ['users.manage'] });
  renderAt('/help');
  const users = (await screen.findByRole('heading', { name: 'Users', level: 2 })).parentElement;
  expect(within(users).getByRole('link', { name: /Create a user/ })).toBeInTheDocument();
});
