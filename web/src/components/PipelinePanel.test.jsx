import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from './Notify.jsx';
import { PipelinePanel } from './GroupPanels.jsx';

const pipeline = {
  role: 'application',
  steps: [
    { id: 1, name: 'staff:include', role: 'basis', count: 2, op: null, inputs: [{ relation: 'direct' }] },
    { id: 2, name: 'staff', role: 'reference', count: 3, op: null, inputs: [{ relation: 'direct' }, { relation: 'include', group: { id: 1, name: 'staff:include' } }] },
    { id: 3, name: 'campus', role: 'application', count: 3, op: null, inputs: [{ relation: 'nested', group: { id: 2, name: 'staff' } }] },
  ],
};

afterEach(() => { vi.unstubAllGlobals(); });

function mock(structure) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    calls.push({ path, method: init.method || 'GET' });
    const out = path.endsWith('/pipeline') ? pipeline : path.endsWith('/structure') ? structure : {};
    return new Response(JSON.stringify(out), { status: init.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
const render_ = (privilege = 'admin') => render(
  <NotifyProvider><PipelinePanel base="/admin/groups" groupId={3} privilege={privilege} /></NotifyProvider>,
);

test('the steps run basis first and the group last, each with its badge and what feeds it', async () => {
  mock({ include_exclude: { include: { id: 1, name: 'staff:include' }, exclude: { id: 9, name: 'staff:exclude' } } });
  render_();
  const items = await screen.findAllByRole('listitem');
  expect(items.map((li) => li.textContent)).toEqual([
    expect.stringContaining('staff:include'),
    expect.stringContaining('staff'),
    expect.stringContaining('campus'),
  ]);
  expect(items[0]).toHaveTextContent('Basis');
  expect(items[1]).toHaveTextContent('Reference');
  expect(items[1]).toHaveTextContent('plus staff:include');
  expect(items[2]).toHaveTextContent('Application');
  expect(screen.queryByRole('button', { name: 'Create include and exclude groups' })).not.toBeInTheDocument();
});

test('a group whose include and exclude groups are missing offers to make them, for an administrator', async () => {
  const calls = mock({ include_exclude: null });
  const user = userEvent.setup();
  render_();
  await user.click(await screen.findByRole('button', { name: 'Create include and exclude groups' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/admin/groups/3/include-exclude')).toBe(true));
});

test('a reader is not offered the create button', async () => {
  mock({ include_exclude: null });
  render_('read');
  await screen.findAllByRole('listitem');
  expect(screen.queryByRole('button', { name: 'Create include and exclude groups' })).not.toBeInTheDocument();
});

test('an include or exclude group is not warned about a missing pair; it says which group it serves', async () => {
  mock({ include_exclude: null });
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url).replace(/^\/api/, '');
    const out = path.endsWith('/pipeline') ? { ...pipeline, part_of: { id: 2, name: 'staff', kind: 'include' } } : { include_exclude: null };
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  render_();
  expect(await screen.findByText('This is the include group of staff.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create include and exclude groups' })).not.toBeInTheDocument();
});
