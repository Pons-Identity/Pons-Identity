import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const META = {
  integrations: [{ id: 4, name: 'HR sync', description: 'Nightly feed', enabled: true, inputs: [], scopes: ['users:write'], timeout_seconds: 10, webhook: { enabled: true, path: '/hooks/integrations/4' }, schedules: [{ id: 7, type: 'daily', at: '02:00', label: 'Daily at 02:00 UTC', next_run_at: '2026-10-02T02:00:00Z' }], events: ['user.created'], last_run: { id: 1, status: 'ok', started_at: '2026-10-01T10:00:00Z' } }],
  scopes: { 'users:read': 'Look up users', 'users:write': 'Create users', http: 'Call web services' },
  reference: {
    variables: [{ name: 'input', description: 'The data the run was started with.', example: '{ "employee_id": "10442" }' }],
    attributes: {
      defined: [{ name: 'badge_expires', label: 'Badge expires', type: 'date', required: false, options: [], example: '2027-06-30' }],
      read: 'const expires = u.attributes.badge_expires;', write: 'await idp.users.update("sam", { attributes: { badge_expires: "2027-06-30" } });',
    },
    recipes: [{ title: 'Turn off an account when someone leaves', description: 'Run by a webhook.', code: 'const u = await idp.users.find({ employee_id: input.employee_id });' }],
    functions: [{ group: 'Users', scope: 'users:write', items: [{ signature: 'await idp.users.create(NewUser)', description: 'Creates a local user.', returns: 'User.', throws: 'With every problem found.', example: 'await idp.users.create({ username: "sam" });' }] }],
    types: [{ name: 'User', description: 'A local account.', fields: [{ name: 'username', type: 'string', required: true, description: 'Sign-in name.' }, { name: 'groups', type: 'string[]', description: 'Group names.' }], example: { username: 'sam', groups: [] } }],
    events: [{ name: 'user.created', label: 'A user was created', extra: ['user: the User affected'], example: { event: 'user.created' } }],
    triggers: [{ name: 'Schedule', description: 'Every N minutes, daily or weekly, in UTC.' }],
    inputs: [{ name: 'email', description: 'The user\'s email.' }],
    limits: [['Time', '1–60 seconds per run.']],
  },
  events: [{ name: 'user.created', label: 'A user was created', fields: ['event', 'user.email'] }, { name: 'user.deleted', label: 'A user was deleted', fields: ['event'] }],
  scheduleLimits: { minMinutes: 5, maxMinutes: 10080, maxPerIntegration: 10, customUnits: { minute: 59, hour: 23, day: 365, week: 52 }, days: [] },
  webhookBase: 'https://idp.example.net',
  starter: 'return 1;',
  starter_inputs: [],
};
const DETAIL = { ...META.integrations[0], script: 'return input;', runs: [] };

// A finished run, as the run page reads it.
const RUN = { id: 2, trigger: 'manual', status: 'ok', started_at: '2026-10-01T10:00:00Z', finished_at: '2026-10-01T10:00:01Z', duration_ms: 12, actor: 'a', node: 'idp-node-1', input: { n: 1 }, result: { got: 1 }, logs: [{ level: 'normal', text: 'hello', color: 'default', time: '2026-10-01T10:00:00Z' }], output: [{ text: 'printed', color: 'green', time: '2026-10-01T10:00:00.500Z' }], error: null };

const requests = [];
function mock(permissions, { variables = [{ name: 'CRM_URL', secret: false, value: 'https://crm', set: true, description: '' }, { name: 'CRM_KEY', secret: true, value: '', set: true, description: '' }] } = {}, { rerunError = '' } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url);
    requests.push({ path, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/integrations' && opts.method === 'POST') return json({ ...DETAIL, id: 9 }, 201);
    if (path === '/api/admin/integrations') return json(META);
    if (path === '/api/admin/integrations/4' || path === '/api/admin/integrations/9') return json(DETAIL);
    if (path === '/api/admin/integrations/4/run') return json({ run: { ...RUN, status: 'running', finished_at: null, output: [], logs: [], result: null, duration_ms: 0 } }, 202);
    if (path === '/api/admin/integrations/4/runs/2') return json({ integration: { id: 4, name: 'HR sync' }, run: RUN });
    if (path === '/api/admin/integrations/4/runs/2/rerun') return rerunError ? json({ errors: [rerunError] }, 409) : json({ run: { ...RUN, id: 3, status: 'running', finished_at: null, output: [], logs: [], result: null, duration_ms: 0 } }, 202);
    if (path === '/api/admin/integrations/4/runs/3') return json({ integration: { id: 4, name: 'HR sync' }, run: { ...RUN, id: 3 } });
    if (path === '/api/admin/integrations/variables') return json({ variables });
    if (path.startsWith('/api/admin/integrations/variables/')) return json({ variables });
    return json({});
  }));
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>,
);

afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; });

test('the nav link and page appear for administrators with the permission', async () => {
  mock(['integrations.view']);
  renderAt('/admin/integrations');
  expect(await screen.findByText('HR sync')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Integrations' }));
  expect(screen.getByRole('menuitem', { name: /^Integrations/ })).toBeInTheDocument();
  expect(screen.getByText('Console, webhook, daily at 02:00 utc, 1 event')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'New integration' })).not.toBeInTheDocument();
});

test('creating an integration sends its name and limit, and its other tabs open once it exists', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/new');
  await userEvent.type(await screen.findByLabelText(/^Name/), 'Badge sync');
  expect(screen.getByRole('tab', { name: 'Script' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Create integration' }));
  const post = requests.find((r) => r.method === 'POST' && r.path === '/api/admin/integrations');
  expect(post.body).toMatchObject({ name: 'Badge sync', script: 'return 1;', timeout_seconds: 10, enabled: true, schedules: [], events: [] });
  expect(post.body.scopes).toEqual(['users:read', 'users:write']);
});

test('a tab with unsaved changes stays open until they are saved or discarded', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/4');
  await userEvent.type(await screen.findByLabelText(/^Description/), '!');
  await userEvent.click(screen.getByRole('tab', { name: 'Permissions' }));
  expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/You have unsaved changes on this tab/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(screen.queryByText(/You have unsaved changes on this tab/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Permissions' }));
  expect(screen.getByRole('tab', { name: 'Permissions' })).toHaveAttribute('aria-selected', 'true');
});

test('saving a tab saves the integration, and only a changed tab can be saved', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/4?tab=logging');
  expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: /Use the logging settings/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  const put = requests.find((r) => r.method === 'PUT' && r.path === '/api/admin/integrations/4');
  expect(put.body.logging).toEqual({ inherit: false });
  expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
});

test('the script is read-only without permission to change integrations', async () => {
  mock(['integrations.view']);
  renderAt('/admin/integrations/4?tab=script');
  expect(await screen.findByLabelText('Script')).toHaveAttribute('contenteditable', 'false');
});

test('running opens the run in a new page, and the run page shows its output, log, result and times', async () => {
  mock(['integrations.view', 'integrations.manage']);
  const page = { location: { href: '' } };
  const open = vi.fn(() => page);
  vi.stubGlobal('open', open);
  renderAt('/admin/integrations/4?tab=run');
  await screen.findByRole('button', { name: 'Run now' });
  await userEvent.click(screen.getByRole('button', { name: 'Add a custom input' }));
  await userEvent.type(screen.getByLabelText('Input 1 name'), 'n');
  await userEvent.type(screen.getByLabelText('Input 1 value'), '1');
  await userEvent.click(screen.getByRole('combobox', { name: 'Input 1 type' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Number' }));
  await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
  // The tab is opened on the click, then pointed at the run once the server has started it.
  expect(open).toHaveBeenCalledWith('about:blank', '_blank');
  await waitFor(() => expect(page.location.href).toMatch(/\/admin\/integrations\/4\/runs\/2$/));
  expect(requests.find((r) => r.path.endsWith('/run')).body).toEqual({ values: [{ name: 'n', type: 'number', value: '1' }] });
  vi.unstubAllGlobals();
});

test('a run page is plain text: the node, the script, the log and output in order, how it ended, and the times', async () => {
  mock(['integrations.view']);
  renderAt('/admin/integrations/4/runs/2');
  expect(await screen.findByRole('heading', { name: 'HR sync (run #2)', level: 1 })).toBeInTheDocument();
  expect(screen.getByLabelText('Run page')).toHaveStyle({ backgroundColor: 'rgb(255, 255, 255)' });
  expect(screen.queryByRole('heading', { name: 'Integrations' })).not.toBeInTheDocument();
  const lines = [...screen.getByLabelText('Run page').querySelectorAll('pre span')].map((s) => s.textContent);
  expect(lines.slice(0, 2)).toEqual(['Node: idp-node-1', 'Running HR sync']);
  expect(lines[3]).toMatch(/^\d{4}\/10\/01 \d{2}:\d{2}:\d{2}\.000: INFO hello$/);
  expect(lines[4]).toBe('printed');
  expect(lines[6]).toBe('Completed.');
  expect(lines[7]).toBe('Result:\n{\n  "got": 1\n}');
  expect(lines[9]).toMatch(/^Start time: \d{4}\/10\/01 /);
  expect(lines[10]).toMatch(/^End time: \d{4}\/10\/01 /);
  expect(lines[11]).toBe('Run time: 00:00:00.012');
  expect(requests.some((r) => r.path.endsWith('/rerun'))).toBe(false);
});

test('reloading a run page runs the integration again and shows the new run', async () => {
  mock(['integrations.view', 'integrations.manage']);
  const navigation = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' }]);
  renderAt('/admin/integrations/4/runs/2');
  expect(await screen.findByRole('heading', { name: 'HR sync (run #3)', level: 1 })).toBeInTheDocument();
  expect(requests.filter((r) => r.path.endsWith('/rerun')).map((r) => [r.method, r.path])).toEqual([['POST', '/api/admin/integrations/4/runs/2/rerun']]);
  // Only the first load after a reload starts a run.
  expect(requests.filter((r) => r.path.endsWith('/rerun'))).toHaveLength(1);
  navigation.mockRestore();
});

test('a reload that cannot run the integration again says why, and still shows the run', async () => {
  const navigation = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' }]);
  mock(['integrations.view', 'integrations.manage'], undefined, { rerunError: 'This run had a secret value in its input, which is not kept, so it cannot run again from here. Run it from the editor.' });
  renderAt('/admin/integrations/4/runs/2');
  expect(await screen.findByRole('alert')).toHaveTextContent('secret value in its input');
  expect(screen.getByRole('heading', { name: 'HR sync (run #2)', level: 1 })).toBeInTheDocument();
  navigation.mockRestore();
});

test('triggers: a schedule and events are saved with the integration', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/4?tab=triggers');
  expect(await screen.findByText(/Daily at 02:00 UTC\. Next run:/)).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /user\.created/ })).toBeChecked();

  await userEvent.click(screen.getByRole('combobox', { name: 'Schedule' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Every so often' }));
  const minutes = screen.getByLabelText(/Minutes between runs/);
  await userEvent.clear(minutes);
  await userEvent.type(minutes, '15');
  await userEvent.click(screen.getByRole('checkbox', { name: /user\.deleted/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  const put = requests.find((r) => r.method === 'PUT' && r.path === '/api/admin/integrations/4');
  expect(put.body.schedules).toEqual([{ type: 'interval', minutes: 15 }]);
  expect(new Set(put.body.events)).toEqual(new Set(['user.created', 'user.deleted']));
});

test('a schedule is started with input values, and an event gives an input a field of the event', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/4?tab=triggers');
  expect(await screen.findByText(/Daily at 02:00 UTC\. Next run:/)).toBeInTheDocument();

  await userEvent.click(screen.getAllByRole('button', { name: 'Add an input value' })[0]);
  await userEvent.type(screen.getAllByLabelText('Input 1 name')[0], 'days');
  await userEvent.type(screen.getAllByLabelText('Input 1 value')[0], '90');
  await userEvent.click(screen.getAllByRole('combobox', { name: 'Input 1 type' })[0]);
  await userEvent.click(await screen.findByRole('option', { name: 'Number' }));

  // user.created is already chosen; its inputs table comes after the schedules' tables.
  await userEvent.click(screen.getByRole('button', { name: 'Add an input' }));
  await userEvent.type(screen.getAllByLabelText('Input 1 name')[1], 'email');
  await userEvent.click(screen.getByRole('combobox', { name: 'Input 1 from' }));
  await userEvent.click(await screen.findByRole('option', { name: /user\.email/ }));

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  const put = requests.find((r) => r.method === 'PUT' && r.path === '/api/admin/integrations/4');
  expect(put.body.schedules).toEqual([{ type: 'daily', at: '02:00', inputs: [{ name: 'days', type: 'number', value: '90' }] }]);
  expect(put.body.event_inputs).toEqual([{ name: 'email', type: 'text', value: '', from: 'user.email' }]);
});

test('an integration can have several schedules', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/4?tab=triggers');
  expect(await screen.findByText(/Daily at 02:00 UTC\. Next run:/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Add a schedule' }));
  const [, added] = screen.getAllByRole('combobox', { name: 'Schedule' });
  await userEvent.click(added);
  await userEvent.click(await screen.findByRole('option', { name: 'Every weekday (Mon–Fri)' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  const put = requests.find((r) => r.method === 'PUT' && r.path === '/api/admin/integrations/4');
  expect(put.body.schedules).toEqual([{ type: 'daily', at: '02:00' }, { type: 'weekdays', at: '02:00' }]);
});

test('the reference tab shows every object field, its notes and an example', async () => {
  mock(['integrations.view']);
  renderAt('/admin/integrations/reference');
  const table = await screen.findByRole('table', { name: 'User fields' });
  expect(within(table).getByText('Sign-in name.')).toBeInTheDocument();
  expect(within(table).getByText('string[]')).toBeInTheDocument();
  expect(screen.getByLabelText('User example')).toHaveTextContent('"username": "sam"');
  expect(screen.getByLabelText('user.created example')).toBeInTheDocument();
  expect(screen.getByText('With every problem found.')).toBeInTheDocument();
  expect(screen.getByText('Every N minutes, daily or weekly, in UTC.')).toBeInTheDocument();
});

test('the reference shows a variable example, defined attributes with example values, and recipes', async () => {
  mock(['integrations.view']);
  renderAt('/admin/integrations/reference');
  const attributes = await screen.findByRole('table', { name: 'Defined attributes' });
  expect(within(attributes).getByText('badge_expires')).toBeInTheDocument();
  expect(within(attributes).getByText('"2027-06-30"')).toBeInTheDocument();
  expect(screen.getByLabelText('input example')).toHaveTextContent('"employee_id": "10442"');
  expect(screen.getByLabelText('Turn off an account when someone leaves script')).toHaveTextContent('find({ employee_id: input.employee_id })');
});

test('the reference can be copied as plain text', async () => {
  mock(['integrations.view']);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  renderAt('/admin/integrations/reference');
  await screen.findByRole('table', { name: 'User fields' });
  await userEvent.click(screen.getByRole('button', { name: 'Copy as text' }));
  const text = writeText.mock.calls[0][0];
  expect(text).toContain('FUNCTIONS');
  expect(text).toContain('await idp.users.create(NewUser)');
  expect(text).toContain('scope users:write: Create users');
  expect(text).toContain('  groups: string[]. Group names.');
  expect(text).toContain('ATTRIBUTES');
  expect(text).toContain('badge_expires — date. Example: "2027-06-30"');
  expect(text).toContain('RECIPES');
  expect(text).not.toMatch(/[*`<>]/);
});

test('the reference can be downloaded as a text file', async () => {
  mock(['integrations.view']);
  const createObjectURL = vi.fn(() => 'blob:reference');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  renderAt('/admin/integrations/reference');
  await screen.findByRole('table', { name: 'User fields' });
  await userEvent.click(screen.getByRole('button', { name: 'Download as text' }));
  const blob = createObjectURL.mock.calls[0][0];
  expect(blob.type).toBe('text/plain;charset=utf-8');
  expect(await blob.text()).toContain('FUNCTIONS');
  expect(click).toHaveBeenCalledTimes(1);
  expect(click.mock.contexts[0].download).toBe('integration-script-reference.txt');
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:reference');
  click.mockRestore();
});

test('the webhook URL is shown for an integration that has one', async () => {
  mock(['integrations.view']);
  renderAt('/admin/integrations/4?tab=webhook');
  expect(await screen.findByDisplayValue('https://idp.example.net/hooks/integrations/4')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Replace token' })).not.toBeInTheDocument();
});

test('variables hide secret values and save without sending a blank secret as plain', async () => {
  mock(['integrations.view', 'integrations.manage']);
  renderAt('/admin/integrations/variables');
  expect(await screen.findByText('https://crm')).toBeInTheDocument();
  expect(screen.getByText('•••••••• (secret)')).toBeInTheDocument();

  await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
  expect(screen.getByLabelText(/^Name/)).toBeDisabled();
  expect(screen.getByLabelText(/^Secret/)).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Save variable' }));
  const put = requests.find((r) => r.method === 'PUT');
  expect(put.path).toBe('/api/admin/integrations/variables/CRM_KEY');
  expect(put.body).toMatchObject({ value: '', secret: true });
});

test('the run section can choose the log level its run saves, for that run only', async () => {
  mock(['integrations.view', 'integrations.manage']);
  vi.stubGlobal('open', vi.fn(() => ({ location: { href: '' } })));
  renderAt('/admin/integrations/4?tab=run');
  await screen.findByRole('button', { name: 'Run now' });
  await userEvent.click(screen.getByRole('combobox', { name: 'Save log lines at or above' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Debug' }));
  await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
  await waitFor(() => expect(requests.find((r) => r.path.endsWith('/run')).body).toMatchObject({ save_level: 'debug' }));
});
