process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
process.env.ALLOW_PRIVATE_FETCH = 'true';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const messaging = require('../src/messaging');
const settings = require('../src/messaging/settings');
const { createApp, seedAdmin } = require('../src/server');

seedAdmin();
const requests = [];
let status = 200;
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { requests.push({ url: req.url, headers: req.headers, body }); res.statusCode = status; res.end('{}'); });
});
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
test.before(() => new Promise((r) => provider.listen(0, r)));
test.after(() => { server.close(); provider.close(); });
const pbase = () => `http://localhost:${provider.address().port}`;
test.beforeEach(() => { requests.length = 0; status = 200; messaging.resetRateLimits(); });

const cfg = (over) => {
  const { data } = settings.parse({}, settings.messaging());
  return { ...data, ...over };
};

test('SendGrid posts the message with a bearer key', async () => {
  const c = cfg({ email: { ...settings.messaging().email, provider: 'sendgrid', from: 'idp@x.net', sendgrid: { apiKey: 'SG.key', apiUrl: pbase() } } });
  await messaging.send('email', 'a@y.net', { subject: 'Hi', text: 'Body' }, { config: c });
  assert.equal(requests[0].url, '/v3/mail/send');
  assert.equal(requests[0].headers.authorization, 'Bearer SG.key');
  assert.equal(JSON.parse(requests[0].body).personalizations[0].to[0].email, 'a@y.net');
  status = 401;
  await assert.rejects(messaging.send('email', 'b@y.net', { subject: 'Hi', text: 'Body' }, { config: c }), (e) => e instanceof messaging.MessagingError && !/SG\.key/.test(e.message));
});

test('SMTP goes through the configured transport', async () => {
  const mails = [];
  const original = messaging.deps.createTransport;
  let opts;
  messaging.deps.createTransport = (o) => { opts = o; return { sendMail: async (m) => { mails.push(m); } }; };
  try {
    const c = cfg({ email: { ...settings.messaging().email, provider: 'smtp', from: 'idp@x.net', smtp: { host: 'smtp.x.net', port: 465, secure: true, user: 'u', pass: 'p' } } });
    await messaging.send('email', 'a@y.net', { subject: 'Hi', text: 'Body' }, { config: c });
    assert.equal(opts.host, 'smtp.x.net');
    assert.equal(mails[0].to, 'a@y.net');
    messaging.deps.createTransport = () => ({ sendMail: async () => { throw new Error('535 password p rejected'); } });
    await assert.rejects(messaging.send('email', 'c@y.net', { subject: 'Hi', text: 'Body' }, { config: c }), (e) => !/password/.test(e.message));
  } finally { messaging.deps.createTransport = original; }
});

test('generic HTTP SMS escapes the message into the JSON template and adds the auth header', async () => {
  const base0 = settings.messaging().sms;
  const c = cfg({ sms: { ...base0, provider: 'http', from: '+15550000000', http: { ...base0.http, url: `${pbase()}/send?to={{to}}`, authHeader: 'X-Key', authValue: 'secret' } } });
  await messaging.send('sms', '+15551234567', { text: 'code "42"\nline' }, { config: c });
  assert.equal(requests[0].url, '/send?to=%2B15551234567');
  assert.equal(requests[0].headers['x-key'], 'secret');
  assert.deepEqual(JSON.parse(requests[0].body), { to: '+15551234567', from: '+15550000000', text: 'code "42"\nline' });
});

test('Twilio SMS and voice use the Messages and Calls endpoints', async () => {
  messaging.deps.twilioBase = pbase();
  const mk = (ch) => ({ ...settings.messaging()[ch], provider: 'twilio', twilio: { accountSid: 'AC1', authToken: 'tok', from: '+15550000000' } });
  const c = cfg({ sms: mk('sms'), voice: mk('voice') });
  await messaging.send('sms', '+15551234567', { text: 'hello' }, { config: c });
  await messaging.send('voice', '+15551234567', { text: 'a <b> & c' }, { config: c });
  assert.equal(requests[0].url, '/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(new URLSearchParams(requests[0].body).get('Body'), 'hello');
  assert.equal(requests[0].headers.authorization, `Basic ${Buffer.from('AC1:tok').toString('base64')}`);
  assert.equal(requests[1].url, '/2010-04-01/Accounts/AC1/Calls.json');
  assert.match(new URLSearchParams(requests[1].body).get('Twiml'), /a &lt;b&gt; &amp; c/);
});

test('bad destinations, unconfigured channels and floods are refused', async () => {
  await assert.rejects(messaging.send('sms', '+15551234567', { text: 'x' }, { config: cfg({}) }), (e) => e.status === 503);
  const base0 = settings.messaging().sms;
  const c = cfg({ sms: { ...base0, provider: 'http', http: { ...base0.http, url: `${pbase()}/s` } } });
  await assert.rejects(messaging.send('sms', '5551234567', { text: 'x' }, { config: c }), (e) => e.status === 400);
  for (let i = 0; i < 5; i++) await messaging.send('sms', '+15551234567', { text: 'x' }, { config: c });
  await assert.rejects(messaging.send('sms', '+15551234567', { text: 'x' }, { config: c }), (e) => e.status === 429);
});

test('settings validate and keep stored secrets when a blank is submitted', () => {
  assert.ok(settings.parse({ email: { provider: 'smtp', from: 'bad' } }).errors.length);
  const first = settings.parse({ email: { provider: 'smtp', from: 'a@x.net', smtp: { host: 'h', pass: 's3cret' } } });
  assert.deepEqual(first.errors, []);
  const stored = first.data;
  const second = settings.parse({ email: { provider: 'smtp', from: 'a@x.net', smtp: { host: 'h2', pass: '' } } }, stored);
  assert.equal(second.data.email.smtp.pass, 's3cret');
  assert.equal(JSON.stringify(settings.view(second.data)).includes('s3cret'), false);
  assert.ok(settings.parse({ sms: { provider: 'http', http: { url: 'ftp://x', body: 'no placeholders' } } }).errors.length >= 2);
});

test('the console API saves settings, hides secrets and sends a test message', async () => {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return { status: r.status, json: await r.json() };
  };
  await call('/api/session');
  await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  const put = await call('/api/admin/settings/messaging', { method: 'PUT', body: { email: { provider: 'sendgrid', from: 'idp@x.net', sendgrid: { apiKey: 'SG.abc', apiUrl: pbase() } } } });
  assert.equal(put.status, 200);
  assert.equal(put.json.email.configured, true);
  assert.equal(put.json.email.secrets['sendgrid.apiKey'], true);
  assert.equal(JSON.stringify(put.json).includes('SG.abc'), false);
  const t = await call('/api/admin/settings/messaging/test', { method: 'POST', body: { channel: 'email', to: 'me@x.net' } });
  assert.equal(t.status, 200);
  assert.equal(requests.length, 1);
  assert.equal((await call('/api/admin/settings/messaging/test', { method: 'POST', body: { channel: 'sms', to: '+15551234567' } })).status, 400);
});

const templates = require('../src/messaging/templates');

test('built-in templates are valid and render each variable', () => {
  for (const kind of Object.keys(templates.KINDS)) {
    for (const ch of Object.keys(templates.DEFAULTS[kind])) assert.deepEqual(templates.check(kind, ch, templates.DEFAULTS[kind][ch]), [], `${kind}.${ch}`);
  }
  const mail = templates.render('mfa', 'email', { username: 'srivera', code: '482913', expiresInMinutes: 5 });
  assert.match(mail.subject, /482913/);
  assert.match(mail.text, /Hello srivera,/);
  assert.match(mail.text, /expires in 5 minutes/);
  assert.match(templates.render('mfa', 'voice', { username: 'srivera', code: '482913' }).text, /4, 8, 2, 9, 1, 3/);
  assert.equal(templates.render('passwordReset', 'sms', { username: 'u', link: 'https://x/r/1' }).subject, undefined);
});

test('templates reject unknown, misplaced and missing variables', () => {
  const bad = (kind, ch, tpl) => templates.check(kind, ch, tpl).join(' | ');
  assert.match(bad('mfa', 'sms', { body: 'Code {{code}} for {{nope}}' }), /\{\{nope\}\} is not a known variable/);
  assert.match(bad('mfa', 'sms', { body: 'Code {{code}} {{link}}' }), /\{\{link\}\} is not a known variable/);
  assert.match(bad('passwordReset', 'voice', { body: 'Reset {{codeSpoken}} {{link}}' }), /cannot be used/);
  assert.match(bad('mfa', 'sms', { body: 'No code here' }), /must include \{\{code\}\}/);
  assert.match(bad('mfa', 'voice', { body: 'Code {{code}}' }), /\{\{codeSpoken\}\}/);
  assert.match(bad('mfa', 'email', { subject: '', body: '{{code}}' }), /subject cannot be empty/);
  assert.match(bad('mfa', 'sms', { body: '{{code}} {{ }}' }), /not a valid placeholder/);
  assert.match(bad('mfa', 'sms', { body: `{{code}}${'x'.repeat(1001)}` }), /limit is 1000/);
  assert.deepEqual(templates.check('mfa', 'sms', { body: 'Code {{ code }}' }), []);
});

test('line breaks in values cannot split a subject', () => {
  const out = templates.render('mfa', 'email', { username: 'a\r\nBcc: x@evil.test', code: '1' });
  assert.equal(/[\r\n]/.test(out.subject), false);
  assert.equal(out.text.includes('\r'), false);
});

test('the console API reads, saves, previews and audits templates', async () => {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    return { status: r.status, json: await r.json() };
  };
  await call('/api/session');
  await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });

  const got = await call('/api/admin/settings/messaging/templates');
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.kinds.map((k) => k.key), ['mfa', 'mfaNumberMatch', 'mfaYesNo', 'mfaYesNoVerified', 'passwordReset', 'attestationReminder']);
  const reminder = got.json.kinds.find((k) => k.key === 'attestationReminder');
  assert.deepEqual(reminder.channels.map((c) => c.key), ['email']);
  assert.equal(got.json.templates.attestationReminder.sms, undefined);
  const reset = got.json.kinds.find((k) => k.key === 'passwordReset');
  assert.ok(reset.variables.find((v) => v.name === 'link').description);
  assert.equal(reset.channels.find((c) => c.key === 'voice').variables.includes('link'), false);

  const put = await call('/api/admin/settings/messaging/templates', { method: 'PUT', body: { mfa: { sms: { body: 'Your {{appName}} PIN: {{code}}' } } } });
  assert.equal(put.status, 200);
  assert.equal(put.json.templates.mfa.sms.body, 'Your {{appName}} PIN: {{code}}');
  assert.equal(put.json.templates.mfa.email.subject, got.json.templates.mfa.email.subject);
  assert.match(templates.render('mfa', 'sms', { username: 'u', code: '9' }).text, /^Your .+ PIN: 9$/);

  const rejected = await call('/api/admin/settings/messaging/templates', { method: 'PUT', body: { mfa: { sms: { body: 'PIN {{pin}}' } } } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.errors[0], /\{\{pin\}\} is not a known variable/);
  assert.match(templates.templates().mfa.sms.body, /PIN: \{\{code\}\}/);

  const pv = await call('/api/admin/settings/messaging/templates/preview', { method: 'POST', body: { kind: 'passwordReset', channel: 'email', subject: 'Hi {{displayName}}', body: 'Go to {{link}}' } });
  assert.equal(pv.status, 200);
  assert.equal(pv.json.subject, 'Hi Jordan Rivera');
  assert.match(pv.json.text, /^Go to https:\/\//);
  assert.equal((await call('/api/admin/settings/messaging/templates/preview', { method: 'POST', body: { kind: 'x', channel: 'sms', body: 'y' } })).status, 400);
});

test('sendTemplated delivers the saved wording', async () => {
  const base0 = settings.messaging().sms;
  const c = cfg({ sms: { ...base0, provider: 'http', from: '+15550000000', http: { ...base0.http, url: `${pbase()}/s`, body: '{"to":"{{to}}","text":"{{message}}"}' } } });
  await messaging.sendTemplated('mfa', 'sms', '+15551234567', { username: 'srivera', code: '123456' }, { config: c });
  assert.match(JSON.parse(requests[0].body).text, /123456/);
});
