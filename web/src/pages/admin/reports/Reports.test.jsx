import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';
import { toCsv } from './ResultTable.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const META = {
  builtin: [
    { key: 'users-without-mfa', name: 'Active users without MFA', description: 'Accounts with no second factor.', requires: ['users.view'], input: {}, runnable: true, builtin: true },
    { key: 'failed-sign-ins', name: 'Failed sign-ins by user', description: 'Who failed most.', requires: ['audit.view'], input: { days: 7 }, runnable: false, builtin: true },
  ],
  reports: [{ id: 3, name: 'Headcount', description: 'By department', timeout_seconds: 20, builtin: false }],
  reference: { functions: [{ signature: 'await report.users({ active?, limit? })', requires: 'users.view', returns: 'ReportUser[]', description: 'Every user.', example: 'return await report.users();' }], userFields: [{ name: 'username', type: 'string', description: '' }] },
  starter: 'return [];',
  limits: { minSeconds: 1, maxSeconds: 60, defaultSeconds: 20, maxScript: 100000 },
};
const RESULT = { status: 'ok', result: [{ username: 'sam', department: 'Math' }, { username: 'bob', department: '=cmd()' }], logs: [], error: null, duration_ms: 5 };

const requests = [];
function mock(permissions) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/reports') return json(META);
    if (path === '/api/admin/reports/builtin/users-without-mfa') return json({ ...META.builtin[0], script: 'return [];' });
    if (path === '/api/admin/reports/builtin/users-without-mfa/run') return json(RESULT);
    if (path === '/api/admin/reports/3') return json({ ...META.reports[0], script: 'return 1;' });
    if (path === '/api/admin/reports/3/run') return json(RESULT);
    return json({});
  }));
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('the nav link and both lists show, with the new-report button only for writers', async () => {
  mock(['reports.view', 'users.view']);
  renderAt('/admin/reports');
  expect(await screen.findByRole('link', { name: 'Active users without MFA' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Headcount' })).toBeInTheDocument();
  expect(screen.getByText('Needs audit.view')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'New report' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Reports' }));
  expect(screen.getByRole('menuitem', { name: /^Reports/ })).toBeInTheDocument();
});

test('a writer sees the new-report button', async () => {
  mock(['reports.view', 'reports.manage']);
  renderAt('/admin/reports');
  expect(await screen.findByRole('link', { name: 'New report' })).toBeInTheDocument();
});

test('running a pre-built report shows a table', async () => {
  mock(['reports.view', 'users.view']);
  renderAt('/admin/reports/builtin/users-without-mfa');
  await userEvent.click(await screen.findByRole('button', { name: 'Run report' }));
  expect(await screen.findByRole('table', { name: 'Report result' })).toBeInTheDocument();
  expect(screen.getByText('sam')).toBeInTheDocument();
  expect(screen.getByText('2 rows')).toBeInTheDocument();
  expect(requests.find((r) => r.path.endsWith('/run')).body).toEqual({ input: {} });
});

test('someone who can only run reports cannot edit a custom report', async () => {
  mock(['reports.view']);
  renderAt('/admin/reports/3');
  expect(await screen.findByLabelText('Script')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Run report' }));
  expect(await screen.findByText('bob')).toBeInTheDocument();
});

test('CSV cells that a spreadsheet would run as formulas are made text and quoting is correct', () => {
  expect(toCsv([{ a: '=cmd()', b: 'x,"y"', c: null, d: { k: 1 } }])).toBe('a,b,c,d\r\n\'=cmd(),"x,""y""",,"{""k"":1}"\r\n');
});
