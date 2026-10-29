import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import FontSettings from './FontSettings.jsx';

afterEach(() => vi.unstubAllGlobals());

// A small stand-in for the font endpoints: families are kept in `state` and the DELETE routes change it, as the server does.
function mockFonts(families) {
  const state = { families: structuredClone(families) };
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = new URL(String(url), 'http://x');
    const path = decodeURIComponent(u.pathname.replace(/^\/api/, ''));
    calls.push({ method: opts.method || 'GET', path, keep: u.searchParams.get('keep') });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/admin/settings/fonts' && (opts.method || 'GET') === 'GET') return json({ families: state.families });
    if (path === '/admin/settings/google-fonts') return json({ families: [{ family: 'Inter', category: '', variants: ['regular'], installed: true }], stale: false, error: null });
    if (path === '/admin/settings/google-fonts/unused') {
      const removed = state.families.filter((f) => f.faces.every((x) => x.source === 'google') && f.family.toLowerCase() !== (u.searchParams.get('keep') || '').toLowerCase()).map((f) => f.family);
      state.families = state.families.filter((f) => !removed.includes(f.family));
      return json({ removed, families: state.families });
    }
    const face = /^\/admin\/settings\/fonts\/(.+)\/faces\/(\w+)\/(\d+)$/.exec(path);
    if (face && opts.method === 'DELETE') {
      state.families = state.families.map((f) => (f.family === face[1]
        ? { ...f, faces: f.faces.filter((x) => !(x.style === face[2] && x.weight === Number(face[3]))) } : f)).filter((f) => f.faces.length);
      return json({ families: state.families });
    }
    const family = /^\/admin\/settings\/fonts\/(.+)$/.exec(path);
    if (family && opts.method === 'DELETE') {
      state.families = state.families.filter((f) => f.family !== family[1]);
      return json({ families: state.families });
    }
    return json({ errors: ['not mocked'] }, 404);
  }));
  return { calls, state };
}

const ACME = { family: 'Acme Sans', faces: [{ style: 'normal', weight: 400, source: 'upload' }, { style: 'italic', weight: 700, source: 'upload' }] };
const INTER = { family: 'Inter', faces: [{ style: 'normal', weight: 400, source: 'google' }, { style: 'italic', weight: 400, source: 'google' }] };

test('an uploaded family can be deleted, and clears the system font when it was the one in use', async () => {
  const { calls, state } = mockFonts([ACME]);
  const onChange = vi.fn();
  render(<FontSettings value="Acme Sans" onChange={onChange} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Delete Acme Sans' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
  expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/settings/fonts/Acme Sans')).toBe(true);
  expect(state.families).toEqual([]);
});

test('a single uploaded face (bold italic) can be deleted, and the other faces stay', async () => {
  const { calls, state } = mockFonts([ACME]);
  render(<FontSettings value="" onChange={vi.fn()} />);
  const row = await screen.findByText('Bold italic');
  await userEvent.click(within(row.parentElement).getByRole('button', { name: 'Delete Bold italic of Acme Sans' }));
  await waitFor(() => expect(calls.some((c) => c.path === '/admin/settings/fonts/Acme Sans/faces/italic/700')).toBe(true));
  expect(await screen.findByText(/Not uploaded:/)).toBeInTheDocument();
  expect(state.families[0].faces).toEqual([{ style: 'normal', weight: 400, source: 'upload' }]);
});

test('"Delete unused Google Fonts" removes downloaded Google Fonts other than the one in use, and keeps uploads', async () => {
  const { calls, state } = mockFonts([INTER, ACME]);
  const onChange = vi.fn();
  render(<FontSettings value="Acme Sans" onChange={onChange} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Delete unused Google Fonts (1)' }));
  await waitFor(() => expect(state.families.map((f) => f.family)).toEqual(['Acme Sans']));
  expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/settings/google-fonts/unused' && c.keep === 'Acme Sans')).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

test('with no unused Google Fonts the button is disabled', async () => {
  mockFonts([INTER]);
  render(<FontSettings value="Inter" onChange={vi.fn()} />);
  expect(await screen.findByRole('button', { name: 'Delete unused Google Fonts' })).toBeDisabled();
});
