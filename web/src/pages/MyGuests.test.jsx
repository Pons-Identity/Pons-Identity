import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from '../components/Notify.jsx';
import MyGuests from './MyGuests.jsx';

afterEach(() => vi.unstubAllGlobals());

function mockApi() {
  const posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    let out = { can_host: true, guests: [], assignable_roles: [], limit: 25, max_days: 14 };
    if (init.method === 'POST') { posts.push({ path, body: JSON.parse(init.body) }); out = { id: 1 }; }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return posts;
}
const renderPage = () => render(<MemoryRouter><NotifyProvider><MyGuests /></NotifyProvider></MemoryRouter>);

test('the initial password is generated at four words, cannot be typed, and can be regenerated', async () => {
  const posts = mockApi();
  renderPage();
  const field = await screen.findByLabelText(/Initial password/);
  await waitFor(() => expect(field.value).not.toBe(''));
  expect(field).toHaveAttribute('readonly');
  expect(field.value.split('-')).toHaveLength(4);
  const first = field.value;
  await userEvent.type(field, 'abc');
  expect(field.value).toBe(first);
  await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  await waitFor(() => expect(field.value).not.toBe(first));

  await userEvent.type(screen.getByLabelText(/^Username/), 'gus');
  const sent = field.value;
  await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].body.password).toBe(sent);
  expect(posts[0].body.expires_at).toMatch(/Z$/);
  // shown once so the host can pass it on, and a fresh one is made for the next guest
  expect(await screen.findByLabelText('Password for gus')).toHaveValue(sent);
  await waitFor(() => expect(screen.getByLabelText(/Initial password/).value).not.toBe(sent));
});
