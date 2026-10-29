import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { NotifyProvider } from '../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const posted = [];

function mock(reply) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: null, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/factors/approve/tok123' && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return reply; }
    if (path === '/api/factors/approve/tok123') return json({ app: 'Acme ID', expires_in: 200 });
    return json({});
  }));
}
const renderAt = () => render(<MemoryRouter initialEntries={['/approve/tok123']}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
const wrong = () => new Response(JSON.stringify({ error: 'That is not the number on the sign-in screen.' }), { status: 400, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); posted.length = 0; });

test('entering the number from the sign-in screen approves it', async () => {
  mock(ok());
  renderAt();
  await userEvent.type(await screen.findByLabelText(/Number on the sign-in screen/), '482');
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/Approved/)).toBeInTheDocument();
  expect(posted[0]).toEqual({ number: '482' });
});

test('a wrong number is reported and can be retried', async () => {
  mock(wrong());
  renderAt();
  await userEvent.type(await screen.findByLabelText(/Number on the sign-in screen/), '111');
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText('That is not the number on the sign-in screen.')).toBeInTheDocument();
  expect(screen.getByLabelText(/Number on the sign-in screen/)).toHaveValue('');
});
