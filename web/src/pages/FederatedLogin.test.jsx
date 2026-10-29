import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { NotifyProvider } from '../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const IDPS = [{ entity_id: 'https://idp.partner.net/idp', name: 'Partner Weaving Guild' }, { entity_id: 'https://idp.other.net/idp', name: 'Other Guild' }];

const requests = [];
function mock({ enabled = true } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    requests.push(path);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: null, csrf: 'c', config: { federationLogin: enabled }, branding: BRANDING });
    if (path.startsWith('/api/federation/idps')) {
      const q = decodeURIComponent(path.split('q=')[1].split('&')[0]).toLowerCase();
      return json({ idps: IDPS.filter((i) => i.name.toLowerCase().includes(q)) });
    }
    return json({});
  }));
}
const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);

let assign;
beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign, pathname: '/login/federation', search: '' });
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('the sign-in page offers the institution route only when it is enabled', async () => {
  mock({ enabled: true });
  const { unmount } = renderAt('/login?next=%2Fsaml%2Fabc%2Fresume');
  const link = await screen.findByRole('link', { name: 'Sign in with your institution' });
  expect(link.getAttribute('href')).toBe('/login/federation?next=%2Fsaml%2Fabc%2Fresume');
  unmount();

  mock({ enabled: false });
  renderAt('/login');
  await screen.findByRole('button', { name: 'Sign in' });
  expect(screen.queryByRole('link', { name: 'Sign in with your institution' })).toBeNull();
});

test('searching and choosing an institution hands over to the server with the destination', async () => {
  mock();
  const user = userEvent.setup();
  renderAt('/login/federation?next=%2Fsaml%2Fabc%2Fresume');

  expect(await screen.findByText('Partner Weaving Guild')).toBeTruthy();
  expect(screen.getByText('Other Guild')).toBeTruthy();
  await user.type(screen.getByLabelText('Find your institution'), 'other');
  await waitFor(() => expect(screen.queryByText('Partner Weaving Guild')).toBeNull());
  expect(screen.getByText('Other Guild')).toBeTruthy();

  await user.click(screen.getByText('Other Guild'));
  expect(assign).toHaveBeenCalledWith('/fed/sp/login?idp=https%3A%2F%2Fidp.other.net%2Fidp&next=%2Fsaml%2Fabc%2Fresume');
});

test('the last institution used is offered first, and an unsafe next is ignored', async () => {
  localStorage.setItem('federation.lastIdp', JSON.stringify(IDPS[0]));
  mock();
  const user = userEvent.setup();
  renderAt('/login/federation?next=https%3A%2F%2Fevil.example');

  await user.click(await screen.findByRole('button', { name: 'Continue with Partner Weaving Guild' }));
  expect(assign).toHaveBeenCalledWith('/fed/sp/login?idp=https%3A%2F%2Fidp.partner.net%2Fidp&next=%2F');
});

test('when federation sign-in is off the page falls back to the normal sign-in', async () => {
  mock({ enabled: false });
  renderAt('/login/federation');
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
});
