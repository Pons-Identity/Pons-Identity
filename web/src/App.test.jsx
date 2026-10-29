import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import App from './App.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import { NotifyProvider } from './components/Notify.jsx';

// Serve /api/session for the given user (or no user) and nothing else.
function mockSignedInAs(me) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ me, csrf: 'c', config: {}, branding: { appName: 'Pons Identity', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' } }),
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

test('anonymous visitors to the admin console are sent to sign-in', async () => {
  mockSignedInAs(null);
  renderAt('/admin/users');
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  vi.unstubAllGlobals();
});

test('non-admins get a forbidden page on admin routes', async () => {
  mockSignedInAs({ id: 2, username: 'bob', display_name: 'Bob', is_admin: false });
  renderAt('/admin/users');
  expect(await screen.findByText('Administrator access is required.')).toBeInTheDocument();
  vi.unstubAllGlobals();
});
