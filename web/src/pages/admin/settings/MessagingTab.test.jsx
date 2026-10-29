import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../../../App.jsx';
import { AuthProvider } from '../../../auth/AuthContext.jsx';
import { NotifyProvider } from '../../../components/Notify.jsx';

const BRANDING = { appName: 'Acme ID', primaryColor: '#1f5fbf', headerColor: '', logo: '', loginMessage: '' };
const BASE = 'https://idp.example.net/messaging/inbound';

// The shape the server returns from GET /admin/settings/messaging: email, sms and voice, with the inbound addresses at the top level.
const PHONE = {
  provider: 'none', from: '', twilio: { accountSid: '', authToken: '', from: '' },
  http: { url: '', contentType: 'json', body: '', authHeader: 'Authorization', authValue: '', headers: '' }, secrets: {}, configured: false,
};
const messaging = (provider) => ({
  email: {
    provider, from: 'ops@example.net', fromName: '',
    smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
    sendgrid: { apiKey: '', apiUrl: 'https://api.sendgrid.com' },
    ses: { accessKeyId: '', secretAccessKey: '', region: 'us-east-1', configurationSet: '', snsTopicArn: '' },
    postmark: { serverToken: '', messageStream: 'outbound', inboundToken: 'token-123' },
    mailgun: { apiKey: '', domain: '', region: 'us', signingKey: '' },
    secrets: {}, configured: false,
  },
  sms: PHONE,
  voice: PHONE,
  inbound: { postmark: `${BASE}/postmark/token-123`, mailgun: `${BASE}/mailgun`, ses: `${BASE}/ses`, twilioSms: `${BASE}/twilio-sms` },
});

function mock(provider) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session') return json({ me: { id: 1, username: 'a', display_name: 'A', is_admin: true, permissions: ['messaging.manage'] }, csrf: 'c', config: {}, branding: BRANDING });
    if (path === '/api/admin/settings/messaging') return json(messaging(provider));
    return json({ error: 'Not part of this test.' }, 404);
  }));
}
const renderAt = (path) => render(<MemoryRouter initialEntries={[path]}><NotifyProvider><AuthProvider><App /></AuthProvider></NotifyProvider></MemoryRouter>);

afterEach(() => vi.unstubAllGlobals());

// Each new provider used to crash the tab: its inbound address was read from the wrong object.
test.each([
  ['ses', 'Access key ID'],
  ['postmark', 'Server API token'],
  ['mailgun', 'API key'],
])('the %s email provider opens without an error', async (provider, field) => {
  mock(provider);
  renderAt('/admin/settings/messaging');
  expect(await screen.findByLabelText(field)).toBeInTheDocument();
  expect(screen.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
});

test('the Postmark tab shows the inbound webhook address', async () => {
  mock('postmark');
  renderAt('/admin/settings/messaging');
  expect(await screen.findByLabelText('Inbound webhook address')).toHaveValue(`${BASE}/postmark/token-123`);
});

test('the SES tab names the inbound address in its help text', async () => {
  mock('ses');
  renderAt('/admin/settings/messaging');
  expect(await screen.findByText(/subscribed to https:\/\/idp\.example\.net\/messaging\/inbound\/ses/)).toBeInTheDocument();
});
