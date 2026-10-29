import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../../App.jsx';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../components/Notify.jsx';
import CalculatorDiagram, { classDefs } from '../../components/CalculatorDiagram.jsx';

// Mermaid needs a real browser to lay a diagram out, so the tests give it a stand-in that returns a small drawing in the shape it uses.
const render_ = vi.fn();
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: (...args) => render_(...args) } }));

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: 'Welcome' };
const GRAPH = {
  nodes: [{ id: 'u1', label: 'alice', kind: 'user' }, { id: 'g2', label: 'staff', kind: 'plain', details: 'Application group' }, { id: 'g3', label: 'eng', kind: 'plain' }],
  edges: [{ from: 'u1', to: 'g3', label: 'direct member' }, { from: 'g3', to: 'g2', label: 'nested in' }],
  links: { g2: '/admin/groups/2', g3: '/admin/groups/3' }, truncated: false,
};
const SVG = `<svg><g class="edgeLabels"><g class="edgeLabel" id="l0"></g><g class="edgeLabel" id="l1"></g></g>
  <path id="L_u1_g3_0" data-id="L_u1_g3_0" class="flowchart-link"></path><path id="L_g3_g2_0" data-id="L_g3_g2_0" class="flowchart-link"></path>
  <g class="node" id="flowchart-u1-0"></g><g class="node" id="flowchart-g2-1"></g><g class="node" id="flowchart-g3-2"></g></svg>`;
const USER_RESULT = {
  mode: 'membership', user: { id: 1, username: 'alice' }, group: { id: 2, name: 'staff' }, member: true,
  routes: [{ text: 'direct member of "eng" → nested in "staff"' }], text: 'GROUP CALCULATOR — alice and "staff"\n\nROUTES\n  1. direct member of "eng"', mermaid: 'flowchart LR\n  u1 --> g3', mermaid_vertical: 'flowchart TD\n  u1 --> g3', graph: GRAPH,
};
const POLICY_RESULT = {
  scenario: 'user+app', user: { id: 1, username: 'alice' }, app: { kind: 'app', id: 'a1', name: 'Payroll' },
  outcome: { status: 'step_up', reasons: ['Asked for a second factor first.'] }, text: 'POLICY CALCULATOR — alice using "Payroll"\n\nENFORCED SIGN-IN RULES', mermaid: 'flowchart LR\n  u1 --> g3', mermaid_vertical: 'flowchart TD\n  u1 --> g3', graph: GRAPH,
};

const requests = [];
function mock(permissions, answers = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    requests.push(path);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions }, csrf: 'c', config: {}, branding: BRANDING });
    if (path.startsWith('/api/admin/users')) return json([{ id: 1, username: 'alice', display_name: 'Alice A' }]);
    if (path.startsWith('/api/admin/groups?')) return json([{ id: 2, name: 'staff', description: 'All staff' }]);
    if (path.startsWith('/api/admin/applications')) return json([{ id: 'a1', protocol: 'oidc', name: 'Payroll' }, { id: 's1', protocol: 'saml', name: 'Wiki' }]);
    if (path.startsWith('/api/admin/calculators/group')) return answers.group ? json(answers.group) : json({ error: 'No such group.' }, 400);
    if (path.startsWith('/api/admin/calculators/policy')) return answers.policy ? json(answers.policy) : json({ error: 'Choose a person.' }, 400);
    return json({});
  }));
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => { render_.mockResolvedValue({ svg: SVG }); try { localStorage.clear(); } catch { /* not needed */ } });
afterEach(() => { vi.unstubAllGlobals(); requests.length = 0; render_.mockReset(); });

test('the Groups page links to the group calculator', async () => {
  mock(['groups.view']);
  renderAt('/admin/groups');
  const link = await screen.findByRole('link', { name: /Group calculator/ });
  expect(link).toHaveAttribute('href', '/admin/groups/calculator');
});

test('group calculator asks about a person and a group, and shows the answer as text first', async () => {
  mock(['groups.view', 'users.view'], { group: USER_RESULT });
  renderAt('/admin/groups/calculator');
  expect(await screen.findByRole('heading', { name: 'Group calculator' })).toBeInTheDocument();
  expect(screen.getByText('Choose a person, a group, or both.')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('combobox', { name: 'Person' }));
  await userEvent.click(await screen.findByRole('option', { name: /alice/ }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Group' }));
  await userEvent.click(await screen.findByRole('option', { name: /staff/ }));

  expect(await screen.findByText(/is a member of/)).toBeInTheDocument();
  expect(screen.getByLabelText('Calculator result as text')).toHaveTextContent('GROUP CALCULATOR — alice and "staff"');
  await waitFor(() => expect(requests).toContain('/api/admin/calculators/group?user_id=1&group_id=2'));
  expect(render_).not.toHaveBeenCalled();
});

test('the diagram view draws the same answer, and remembers the choice', async () => {
  mock(['groups.view', 'users.view'], { group: USER_RESULT });
  renderAt('/admin/groups/calculator');
  await userEvent.click(await screen.findByRole('combobox', { name: 'Group' }));
  await userEvent.click(await screen.findByRole('option', { name: /staff/ }));
  await screen.findByLabelText('Calculator result as text');

  await userEvent.click(screen.getByRole('tab', { name: 'Horizontal diagram' }));
  await waitFor(() => expect(render_).toHaveBeenCalled());
  const source = render_.mock.calls[0][1];
  expect(source).toContain('flowchart LR');
  expect(source).toContain('classDef user');
  expect(await screen.findByTestId('diagram')).toBeInTheDocument();
  expect(localStorage.getItem('simpleidp.calculator.view')).toBe('horizontal');
  expect(screen.getByText('Basis group')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('tab', { name: 'Vertical diagram' }));
  await waitFor(() => expect(render_.mock.calls.at(-1)[1]).toContain('flowchart TD'));
  expect(localStorage.getItem('simpleidp.calculator.view')).toBe('vertical');

  await userEvent.click(screen.getByRole('tab', { name: 'Text' }));
  expect(screen.getByLabelText('Calculator result as text')).toBeInTheDocument();
});

test('a failed diagram says so and points to the text', async () => {
  render_.mockRejectedValue(new Error('Parse error on line 2'));
  mock(['groups.view'], { group: USER_RESULT });
  renderAt('/admin/groups/calculator');
  await userEvent.click(await screen.findByRole('combobox', { name: 'Group' }));
  await userEvent.click(await screen.findByRole('option', { name: /staff/ }));
  await userEvent.click(await screen.findByRole('tab', { name: 'Horizontal diagram' }));
  expect(await screen.findByText(/The diagram could not be drawn: Parse error on line 2/)).toBeInTheDocument();
});

test('without permission to view people, the person picker is off', async () => {
  mock(['groups.view']);
  renderAt('/admin/groups/calculator');
  expect(await screen.findByRole('combobox', { name: 'Person' })).toBeDisabled();
  expect(screen.getByText('You need permission to view people.')).toBeInTheDocument();
});

test('policy calculator is a tab of Policies, and says what would happen', async () => {
  mock(['policies.view', 'users.view', 'sps.view'], { policy: POLICY_RESULT });
  renderAt('/admin/policies/calculator');
  expect(await screen.findByRole('tab', { name: 'Policy calculator' })).toHaveAttribute('aria-selected', 'true');

  await userEvent.click(screen.getByRole('combobox', { name: 'Person' }));
  await userEvent.click(await screen.findByRole('option', { name: /alice/ }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Application' }));
  await userEvent.click(await screen.findByRole('option', { name: /Payroll/ }));

  expect(await screen.findByText('Allowed after a second factor:')).toBeInTheDocument();
  expect(screen.getByText('Asked for a second factor first.')).toBeInTheDocument();
  await waitFor(() => expect(requests).toContain('/api/admin/calculators/policy?user_id=1&kind=app&app_id=a1'));
});

test('a SAML service provider is asked about as a service provider', async () => {
  mock(['policies.view', 'sps.view'], { policy: { ...POLICY_RESULT, outcome: null } });
  renderAt('/admin/policies/calculator');
  await userEvent.click(await screen.findByRole('combobox', { name: 'Application' }));
  await userEvent.click(await screen.findByRole('option', { name: /Wiki/ }));
  await waitFor(() => expect(requests).toContain('/api/admin/calculators/policy?kind=sp&app_id=s1'));
});

/* ------------------------------ The diagram itself ------------------------------ */

function Where() { return <div data-testid="where">{useLocation().pathname}</div>; }

function drawn() {
  return render(
    <MemoryRouter initialEntries={['/start']}>
      <Routes><Route path="*" element={<><CalculatorDiagram mermaid="flowchart LR" graph={GRAPH} /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
}

test('clicking a box opens what it stands for', async () => {
  drawn();
  const host = await screen.findByTestId('diagram');
  await waitFor(() => expect(host.querySelector('g.node')).not.toBeNull());
  const box = host.querySelector('#flowchart-g2-1');
  expect(box).toHaveAttribute('role', 'link');
  expect(box).toHaveAttribute('aria-label', 'staff. Application group');
  await userEvent.click(box);
  expect(screen.getByTestId('where')).toHaveTextContent('/admin/groups/2');
});

test('pointing at a box dims what is not connected to it', async () => {
  drawn();
  const host = await screen.findByTestId('diagram');
  await waitFor(() => expect(host.querySelector('g.node')).not.toBeNull());
  await userEvent.hover(host.querySelector('#flowchart-g2-1'));
  expect(host.querySelector('#flowchart-g3-2').style.opacity).toBe('');
  expect(host.querySelector('#flowchart-u1-0').style.opacity).toBe('0.25');
  expect(host.querySelector('#L_u1_g3_0').style.opacity).toBe('0.15');
  expect(host.querySelector('#L_g3_g2_0').style.strokeWidth).toBe('3px');
  expect(host.querySelector('#l0').style.opacity).toBe('0.15');
  await userEvent.unhover(host.querySelector('#flowchart-g2-1'));
  expect(host.querySelector('#flowchart-u1-0').style.opacity).toBe('');
});

test('pointing at a box shows its details in a tooltip after a short wait', async () => {
  drawn();
  const host = await screen.findByTestId('diagram');
  await waitFor(() => expect(host.querySelector('g.node')).not.toBeNull());
  const box = host.querySelector('#flowchart-g2-1');
  const started = Date.now();
  await userEvent.hover(box);
  expect(screen.queryByRole('tooltip')).toBeNull();
  const tip = await screen.findByRole('tooltip', {}, { timeout: 2000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  expect(tip).toHaveTextContent('Application group');
  await userEvent.unhover(box);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
});

test('boxes can be opened from the keyboard', async () => {
  drawn();
  const host = await screen.findByTestId('diagram');
  await waitFor(() => expect(host.querySelector('g.node')).not.toBeNull());
  host.querySelector('#flowchart-g3-2').focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByTestId('where')).toHaveTextContent('/admin/groups/3');
});

test('zoom buttons change the scale within limits', async () => {
  drawn();
  await screen.findByTestId('diagram');
  await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(screen.getByText('120%')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Actual size' }));
  expect(screen.getByText('100%')).toBeInTheDocument();
  for (let i = 0; i < 3; i += 1) await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  expect(screen.getByText('40%')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
});

test('class definitions follow light and dark mode', () => {
  expect(classDefs('light')).toContain('classDef user fill:#e3f2fd');
  expect(classDefs('dark')).toContain('classDef user fill:#0d3a66');
});
