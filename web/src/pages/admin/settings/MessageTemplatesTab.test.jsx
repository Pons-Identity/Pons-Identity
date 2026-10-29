import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import MessageTemplatesTab from './MessageTemplatesTab.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

afterEach(() => vi.unstubAllGlobals());

const V = (name, description, example, channels) => ({ name, description, example, channels });
const kind = {
  key: 'mfa', label: 'Sign-in verification code', description: 'Sent for a second factor.',
  variables: [V('code', 'The one-time code.', '482913', ['email', 'sms', 'voice']), V('appName', 'Application name.', 'Pons Identity', ['email', 'sms', 'voice'])],
  channels: [
    { key: 'email', label: 'Email', hasSubject: true, variables: ['code', 'appName'] },
    { key: 'sms', label: 'SMS', hasSubject: false, variables: ['code', 'appName'] },
    { key: 'voice', label: 'Voice call', hasSubject: false, variables: ['code', 'appName'] },
  ],
};
const tpl = { email: { subject: 'Code {{code}}', body: 'Your code is {{code}}' }, sms: { body: 'Code {{code}}' }, voice: { body: '{{code}}' } };
const view = { kinds: [kind], templates: { mfa: tpl }, defaults: { mfa: tpl }, limits: { subject: 200, email: 5000, sms: 1000, voice: 1000 } };

function mock() {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method || 'GET', body });
    let out = view;
    if (path.endsWith('/preview')) out = { subject: 'Code 482913', text: `Rendered: ${body.body}`, length: 5 };
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => out, text: async () => JSON.stringify(out) };
  }));
  return calls;
}

test('documents the variables and saves edited wording', async () => {
  const calls = mock();
  render(<NotifyProvider><MessageTemplatesTab /></NotifyProvider>);
  expect(await screen.findByRole('table', { name: /variables/i })).toBeInTheDocument();
  expect(screen.getByText('The one-time code.')).toBeInTheDocument();
  expect(screen.getAllByText('{{code}}').length).toBeGreaterThan(0);

  await userEvent.click(screen.getByRole('button', { name: '{{appName}}' }));
  await waitFor(() => expect(screen.getByLabelText(/Body/).value).toContain('{{appName}}'));
  await waitFor(() => expect(screen.getByText(/Rendered:/)).toBeInTheDocument());

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.body.mfa.email.body.includes('{{appName}}'))).toBe(true));
});
