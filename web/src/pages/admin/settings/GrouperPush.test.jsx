import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import GrouperPush from './GrouperPush.jsx';
import GrouperConnection, { DEFAULT_LOOKUP, EMPTY_CONNECTION } from './GrouperConnection.jsx';

// The parent owns the connection, as GrouperExport does.
function Harness() {
  const [conn, setConn] = useState(EMPTY_CONNECTION);
  const [lookup, setLookup] = useState(DEFAULT_LOOKUP);
  return (
    <>
      <GrouperConnection conn={conn} onConn={setConn} lookup={lookup} onLookup={setLookup} />
      <GrouperPush subjectField="employee_id" rootStem="simpleidp" conn={conn} onConn={setConn} lookup={lookup} pollMs={10} />
    </>
  );
}

afterEach(() => vi.unstubAllGlobals());

const check = { counts: { groups: 3, memberships: 5, nested: 1, privileges: 2, composites: 1 }, notPushed: { composites: 1 }, checked: 4, found: 3, notFound: [{ subject: 'ghost-3', code: 'SUBJECT_NOT_FOUND' }], notFoundCount: 1 };
const running = { id: 'a', state: 'running', actor: 'admin', started_at: '2026-01-01T00:00:00Z', target: 'https://g/x', progress: { phase: 'members', done: 2, total: 5 } };
const done = {
  ...running, state: 'done',
  report: { phases: { groups: { ok: 3, failed: 0 }, members: { ok: 4, failed: 1 }, nested: { ok: 1, failed: 0 }, privileges: { ok: 2, failed: 0 } },
    failures: [{ phase: 'members', target: 'org:eng: ghost', code: 'SUBJECT_NOT_FOUND' }], failureCount: 1, notPushed: { composites: [{ group: 'org:both' }] } },
};

function mockApi() {
  const calls = [];
  let polls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method || 'GET', body });
    let out = null;
    if (path.endsWith('/push/status')) { out = polls === 0 ? null : polls < 3 ? running : done; polls += 1; }
    if (path.endsWith('/push/preflight')) out = check;
    if (path.endsWith('/push') && init.method === 'POST') { polls = 1; out = running; }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

test('check, confirm, push, then follow progress to a report; the password is cleared and sent only in the body', async () => {
  const calls = mockApi();
  render(<Harness />);
  const checkBtn = screen.getByRole('button', { name: 'Check connection and people' });
  const pushBtn = screen.getByRole('button', { name: 'Push to Grouper…' });
  expect(checkBtn).toBeDisabled();
  expect(pushBtn).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Web services URL'), 'https://grouper.example.net/grouper-ws/servicesRest');
  await userEvent.type(screen.getByLabelText('Username'), 'wsuser');
  await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
  await userEvent.click(checkBtn);
  expect(await screen.findByText(/Grouper found 3 of 4 people/)).toBeInTheDocument();
  expect(screen.getByText(/ghost-3/)).toBeInTheDocument();
  expect(screen.getByText(/1 composite group will not be pushed/)).toBeInTheDocument();
  const pre = calls.find((c) => c.path.endsWith('/preflight'));
  expect(pre.body.connection).toMatchObject({ username: 'wsuser', password: 'hunter2', version: 'v2_5_000' });
  expect(pre.body.options).toMatchObject({ subjectField: 'employee_id', rootStem: 'simpleidp', lookupBy: 'subjectId', timeZone: 'UTC' });

  await userEvent.click(pushBtn);
  expect(await screen.findByText(/creates or updates 3 groups, and adds 5 members/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Push' }));

  const start = await waitFor(() => calls.find((c) => c.path === '/admin/grouper/export/push' && c.method === 'POST'));
  expect(start.body.confirm).toBe(true);
  expect(await screen.findByText('Members: 4 done, 1 failed')).toBeInTheDocument();
  expect(screen.getByText(/org:eng: ghost \(SUBJECT_NOT_FOUND\)/)).toBeInTheDocument();
  expect(screen.getByText(/Not pushed .*org:both/)).toBeInTheDocument();
  expect(screen.getByLabelText('Password')).toHaveValue('');
});
