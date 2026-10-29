import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const BUILDER = {
  sources: [
    { key: 'users', label: 'Users', permission: 'users.view', options: ['active'], fields: [
      { key: 'department', type: 'text', label: 'Department' }, { key: 'active', type: 'boolean', label: 'Active' }, { key: 'created_at', type: 'date', label: 'Created' },
    ] },
  ],
  operators: {
    text: [{ key: 'eq', label: 'is', takesValue: true }, { key: 'empty', label: 'is empty', takesValue: false }],
    boolean: [{ key: 'is', label: 'is', takesValue: true }],
    date: [{ key: 'gte', label: 'on or after', takesValue: true }],
  },
  measures: [{ key: 'count', label: 'Count', needsNumber: false, needsField: false }],
  charts: ['table', 'bar', 'line', 'pie'],
  limits: { limit: { min: 1, max: 1000, default: 100 }, days: { min: 1, max: 365, default: 7 }, filters: 10, columns: 12, measures: 4, groups: 500 },
};
const META = {
  builtin: [], reports: [], reference: { functions: [], userFields: [] }, starter: 'return [];', builder: BUILDER,
  limits: { minSeconds: 1, maxSeconds: 60, defaultSeconds: 20, maxScript: 100000 },
};
const RESULT = {
  status: 'ok',
  result: { kind: 'builder', columns: [{ key: 'group', label: 'Department', type: 'text' }, { key: 'm0', label: 'Count', type: 'number' }],
    rows: [{ group: 'Sailing', m0: 2 }, { group: 'History', m0: 1 }], chart: { type: 'bar', labels: ['Sailing', 'History'], values: [2, 1], label: 'Count' },
    total: 3, truncated: false },
  logs: [], error: null, duration_ms: 3,
};

const previews = [];
function mock() {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['reports.view', 'reports.manage', 'users.view'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/reports') return json(META);
    if (path === '/api/admin/reports/builder/preview') { previews.push(JSON.parse(opts.body)); return json(RESULT); }
    return json({});
  }));
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);

afterEach(() => { vi.unstubAllGlobals(); previews.length = 0; });

test('the builder previews a summary as a table and a bar chart, from a definition with no code', async () => {
  mock();
  renderAt('/admin/reports/new/builder');
  const form = await screen.findByRole('form', { name: 'Report builder' });
  await userEvent.click(within(form).getByRole('radio', { name: /A summary, grouped by a field/ }));
  await userEvent.click(within(form).getByRole('combobox', { name: 'Group by' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Department' }));
  await userEvent.click(within(form).getByRole('button', { name: 'Add a measure' }));
  await userEvent.click(within(form).getByRole('combobox', { name: 'Shown as' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Bar chart' }));
  await userEvent.click(within(form).getByRole('button', { name: 'Preview' }));
  expect(await screen.findByRole('img', { name: 'Bar chart' })).toBeInTheDocument();
  const table = screen.getByRole('table', { name: 'Report results' });
  expect(within(table).getByText('Sailing')).toBeInTheDocument();
  expect(screen.getByText(/3 rows matched/)).toBeInTheDocument();
  expect(previews[0].definition).toMatchObject({ source: 'users', group_by: 'department', measures: [{ op: 'count' }], view: 'bar' });
});

test('a report that failed to parse shows the reason from the server', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['reports.view', 'reports.manage'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/reports') return json(META);
    if (path === '/api/admin/reports/builder/preview') return json({ errors: ['A bar chart needs a field to group by and at least one measure.'] }, 400);
    return json({});
  }));
  renderAt('/admin/reports/new/builder');
  const form = await screen.findByRole('form', { name: 'Report builder' });
  await userEvent.click(within(form).getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('A bar chart needs a field to group by and at least one measure.')).toBeInTheDocument();
});
