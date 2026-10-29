import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from '../../../components/Notify.jsx';
import GuestPoliciesTab from './GuestPoliciesTab.jsx';

afterEach(() => vi.unstubAllGlobals());

test('shows each chosen group with its guest limit, and saves the limits and the longest lifespan', async () => {
  const puts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    if (init.method === 'PUT') puts.push({ path: String(url), body: JSON.parse(init.body) });
    const body = { hostGroups: [{ id: 3, maxGuests: 10 }], maxDays: 14, groups: [{ id: 3, name: 'Staff' }, { id: 4, name: 'Faculty' }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render(<NotifyProvider><GuestPoliciesTab /></NotifyProvider>);
  const limit = await screen.findByLabelText('Most guests for members of Staff');
  expect(limit).toHaveValue(10);
  expect(screen.getByLabelText(/Longest a guest account may last/)).toHaveValue(14);
  expect(screen.queryByLabelText('Most guests for members of Faculty')).not.toBeInTheDocument();
  await userEvent.clear(limit);
  await userEvent.type(limit, '4');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0].path).toBe('/api/admin/guest-policy');
  expect(puts[0].body).toEqual({ hostGroups: [{ id: 3, maxGuests: 4 }], maxDays: 14 });
});
