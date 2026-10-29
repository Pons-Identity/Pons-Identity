import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { NotifyProvider } from '../../../components/Notify.jsx';
import GrouperCutover from './GrouperCutover.jsx';

afterEach(() => vi.unstubAllGlobals());

const group = (id, name, extra = {}) => ({ id, name, grouper_name: name, renamed: false, conflict: '', direct: 2, effective: 2, nested: 0, composite: false, delegations: 0, carries_role: false, verification: 'unverified', ...extra });

function mockApi() {
  const calls = [];
  let verified = false;
  let applied = false;
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method || 'GET', body });
    let out = null;
    if (path.endsWith('/plan')) {
      out = { options: {}, groups: applied ? [] : [group(1, 'flat', { renamed: true, grouper_name: 'simpleidp:flat', verification: verified ? 'match' : 'unverified' }),
        group(2, 'org:eng', { nested: 1, verification: verified ? 'differs' : 'unverified' }), group(3, 'clash', { conflict: 'Another group is already named "simpleidp:clash".' })] };
    }
    if (path.endsWith('/verify')) {
      verified = true;
      out = { summary: {}, rows: [{ id: 1, status: 'match', missing: [], missingCount: 0, unpushed: [], unpushedCount: 0, unknown: [], unknownCount: 0, extraCount: 0 },
        { id: 2, status: 'differs', missing: ['alice'], missingCount: 1, unpushed: [], unpushedCount: 0, unknown: [], unknownCount: 0, extraCount: 0 }] };
    }
    if (path.endsWith('/apply')) { applied = true; out = { id: 7, converted: 1, renamed: 1, pinned: 0 }; }
    if (path.endsWith('/history')) out = applied ? [{ id: 7, ts: 1700000000, actor: 'admin', reverted_at: null, groups: 1, names: ['simpleidp:flat'] }] : [];
    if (path.endsWith('/revert')) out = { reverted: 1, skipped: [{ name: 'org:eng', reason: 'The group no longer exists.' }] };
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const props = { subjectField: 'employee_id', rootStem: 'simpleidp', lookup: { lookupBy: 'subjectId', subjectSourceId: '', timeZone: 'UTC' },
  conn: { url: 'https://g.example.net/grouper-ws/servicesRest', version: 'v2_5_000', username: 'ws', password: 'pw' } };

test('check, hand over only groups confirmed identical, then revert', async () => {
  const calls = mockApi();
  render(<NotifyProvider><GrouperCutover {...props} /></NotifyProvider>);

  await userEvent.click(screen.getByRole('button', { name: 'Load groups' }));
  expect(await screen.findByText('simpleidp:flat')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Hand 0 groups/ })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Select clash' })).toBeDisabled();
  expect(screen.getByText(/already named/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Check against Grouper' }));
  const verify = await waitFor(() => calls.find((c) => c.path.endsWith('/verify')));
  expect(verify.body.connection.username).toBe('ws');
  expect(verify.body.options).toMatchObject({ subjectField: 'employee_id', rootStem: 'simpleidp', lookupBy: 'subjectId' });
  expect(await screen.findByText('Matches Grouper')).toBeInTheDocument();
  expect(screen.getByText('Differs')).toBeInTheDocument();
  // Only the confirmed group is chosen; the differing one is not, and there is nothing to override.
  expect(screen.getByRole('checkbox', { name: 'Select flat' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Select org:eng' })).not.toBeChecked();
  expect(screen.queryByText(/not confirmed identical/)).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: /Hand 1 group to Grouper/ }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/1 is renamed/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Hand over' }));
  const apply = await waitFor(() => calls.find((c) => c.path.endsWith('/apply')));
  expect(apply.body).toMatchObject({ groupIds: [1], confirm: true, force: false, pinRoleMembers: true });
  expect(await screen.findByText(/1 group handed to Grouper \(1 renamed\)/)).toBeInTheDocument();

  await userEvent.click(await screen.findByRole('button', { name: 'Revert' }));
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revert' }));
  expect(await screen.findByText(/org:eng: The group no longer exists/)).toBeInTheDocument();
  expect(calls.some((c) => c.path === '/admin/grouper/cutover/history/7/revert' && c.body.confirm === true)).toBe(true);
});
