process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.BASE_URL = 'http://localhost:0';
process.env.ALLOW_PRIVATE_FETCH = 'true';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const db = require('../src/db');
const { hashPassword } = require('../src/crypto');
const { newGuid } = require('../src/guid');
const { createApp, seedAdmin } = require('../src/server');
const messaging = require('../src/messaging');
const msgSettings = require('../src/messaging/settings');
const templates = require('../src/messaging/templates');
const factorSettings = require('../src/factors/settings');

seedAdmin();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
const sent = [];
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { sent.push({ url: req.url, headers: req.headers, body }); res.end('{}'); });
});
test.before(() => new Promise((r) => provider.listen(0, r)));
test.after(() => { server.close(); provider.close(); });
const pbase = () => `http://localhost:${provider.address().port}`;

async function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') { headers['content-type'] = 'application/json'; headers['x-csrf-token'] = (await (await fetch(`${base}/api/session`, { headers })).json()).csrf; }
    const r = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (sc.length) cookie = sc.join('; ');
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null, text };
  };
  await call('/api/session');
  return call;
}
const login = async (username, password) => { const call = await client(); const r = await call('/api/login', { method: 'POST', body: { username, password } }); return { call, r }; };
const signedIn = async (call) => (await call('/api/session')).json.me;
const mkUser = (name) => Number(db.run('INSERT INTO users (guid, username, password_hash, email) VALUES (?,?,?,?)', newGuid(), name, hashPassword(`${name}-password`), `${name}@x.net`).lastInsertRowid);
const enroll = (userId, type, destination) => Number(db.run("INSERT INTO user_factors (user_id, type, destination, verified) VALUES (?, ?, ?, 1)", userId, type, destination).lastInsertRowid);
const lastSent = () => sent[sent.length - 1];
const setFactors = (over) => factorSettings.save({ ...factorSettings.get(), ...over });
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers, body });

// Email by Postmark, text by Twilio, voice by Twilio: every provider the tests check is pointed at the local provider server.
function configureMessaging(email = {}) {
  const { data, errors } = msgSettings.parse({
    email: { provider: 'postmark', from: 'idp@x.net', postmark: { serverToken: 'pm-server-token-123', inboundToken: 'inbound-tok-1' }, ...email },
    sms: { provider: 'twilio', from: '+15550000000', twilio: { accountSid: 'AC1', authToken: 'twilio-token', from: '+15550000000' } },
    voice: { provider: 'twilio', twilio: { accountSid: 'AC1', authToken: 'twilio-token', from: '+15550000000' } },
  }, msgSettings.messaging());
  assert.deepEqual(errors, []);
  msgSettings.save(data);
  Object.assign(messaging.deps, { twilioBase: pbase(), postmarkBase: pbase(), mailgunBase: pbase(), sesBase: pbase() });
}
test.beforeEach(() => { sent.length = 0; messaging.resetRateLimits(); });

/* ------------------------------ replies to sign-in messages ------------------------------ */

test('yes or no by email: a reply of Y from the enrolled address approves the sign-in; anyone else changes nothing', async () => {
  configureMessaging();
  setFactors({ email: { enabled: true, modes: ['yes_no'] } });
  const id = mkUser('dana');
  enroll(id, 'email', 'dana@x.net');
  const s = await login('dana', 'dana-password');
  const option = (await s.call('/api/login/mfa')).json.factors[0];
  assert.equal(option.method, 'email:yes_no');
  assert.equal(option.phishing_resistant, false);
  const ch = await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: option.id } });
  assert.equal(ch.json.mode, 'yes_no');
  assert.equal(ch.json.number, undefined, 'an unverified yes or no shows no number');
  const message = JSON.parse(lastSent().body);
  assert.match(message.TextBody, /Reply Y to approve/);
  assert.match(message.TextBody, /or N to deny/);

  // A reply from another address, or a reply that is not an answer, approves nothing.
  assert.equal((await post('/messaging/inbound/postmark/inbound-tok-1', JSON.stringify({ From: 'eve@x.net', TextBody: 'Y' }), { 'content-type': 'application/json' })).status, 200);
  assert.equal((await post('/messaging/inbound/postmark/inbound-tok-1', JSON.stringify({ From: 'dana@x.net', TextBody: 'thanks' }), { 'content-type': 'application/json' })).status, 200);
  assert.equal((await s.call('/api/login/mfa/challenge/status')).json.result, 'waiting');

  // The real answer, with the quoted message below it, which is ignored.
  const reply = 'Y\n\nOn Mon, Oct 26, Pons Identity wrote:\n> Are you signing in?';
  assert.equal((await post('/messaging/inbound/postmark/inbound-tok-1', JSON.stringify({ From: 'dana@x.net', TextBody: reply }), { 'content-type': 'application/json' })).status, 200);
  const done = await s.call('/api/login/mfa/challenge/status');
  assert.ok(done.json.next, JSON.stringify(done.json));
  assert.equal((await signedIn(s.call)).username, 'dana');
});

test('a wrong inbound token is refused, and nothing is read from it', async () => {
  configureMessaging();
  const r = await post('/messaging/inbound/postmark/not-the-token', JSON.stringify({ From: 'dana@x.net', TextBody: 'Y' }), { 'content-type': 'application/json' });
  assert.equal(r.status, 403);
});

test('number matching by reply: the number on the sign-in page is the only thing that approves', async () => {
  configureMessaging();
  setFactors({ email: { enabled: true, modes: ['number_match'] } });
  const id = mkUser('nora');
  enroll(id, 'email', 'nora@x.net');
  const s = await login('nora', 'nora-password');
  const option = (await s.call('/api/login/mfa')).json.factors[0];
  const ch = await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: option.id } });
  assert.match(ch.json.number, /^\d{3}$/);
  const message = JSON.parse(lastSent().body).TextBody;
  assert.equal(message.includes(ch.json.number), false, 'the message never shows the number');
  assert.match(message, /reply to this message with that code/);
  const wrong = String((Number(ch.json.number) + 1) % 1000).padStart(3, '0');
  await post('/messaging/inbound/postmark/inbound-tok-1', JSON.stringify({ From: 'nora@x.net', TextBody: `${wrong}` }), { 'content-type': 'application/json' });
  assert.equal((await s.call('/api/login/mfa/challenge/status')).json.result, 'waiting');
  await post('/messaging/inbound/postmark/inbound-tok-1', JSON.stringify({ From: 'nora@x.net', TextBody: `${ch.json.number}` }), { 'content-type': 'application/json' });
  assert.ok((await s.call('/api/login/mfa/challenge/status')).json.next);
});

test('verified yes or no: N denies the sign-in, and the sign-in page is told', async () => {
  configureMessaging();
  setFactors({ email: { enabled: true, modes: ['yes_no_verified'] } });
  const id = mkUser('vera');
  enroll(id, 'email', 'vera@x.net');
  const s = await login('vera', 'vera-password');
  const option = (await s.call('/api/login/mfa')).json.factors[0];
  assert.equal(option.phishing_resistant, true, 'verified yes or no counts as phishing resistant by default');
  const ch = await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: option.id } });
  assert.match(ch.json.number, /^\d{3}$/);
  await post('/messaging/inbound/postmark/inbound-tok-1', JSON.stringify({ From: 'vera@x.net', TextBody: 'N' }), { 'content-type': 'application/json' });
  assert.equal((await s.call('/api/login/mfa/challenge/status')).json.result, 'failed');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'mfa.reply'"));
});

test('mailgun replies are checked with the signing key and a fresh timestamp', async () => {
  configureMessaging({ provider: 'mailgun', mailgun: { apiKey: 'key-abc123', domain: 'mail.x.net', region: 'us', signingKey: 'signing-secret-1' } });
  setFactors({ email: { enabled: true, modes: ['yes_no'] } });
  const id = mkUser('gail');
  enroll(id, 'email', 'gail@x.net');
  const s = await login('gail', 'gail-password');
  const option = (await s.call('/api/login/mfa')).json.factors[0];
  await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: option.id } });
  const sign = (timestamp, token) => crypto.createHmac('sha256', 'signing-secret-1').update(`${timestamp}${token}`).digest('hex');
  const ts = String(Math.floor(Date.now() / 1000));
  const form = (over) => new URLSearchParams({ sender: 'gail@x.net', 'stripped-text': 'Y', timestamp: ts, token: 'tok-9', signature: sign(ts, 'tok-9'), ...over });
  assert.equal((await post('/messaging/inbound/mailgun', form({ signature: 'forged' }))).status, 403);
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await post('/messaging/inbound/mailgun', form({ timestamp: old, signature: sign(old, 'tok-9') }))).status, 403);
  assert.equal((await post('/messaging/inbound/mailgun', form())).status, 200);
  assert.equal((await s.call('/api/login/mfa/challenge/status')).json.next !== undefined, true);
});

test('a text reply is checked against Twilio\'s signature and matched by the sending number', async () => {
  configureMessaging();
  setFactors({ sms: { enabled: true, modes: ['yes_no'] } });
  const id = mkUser('tom');
  enroll(id, 'sms', '+15551230000');
  const s = await login('tom', 'tom-password');
  const option = (await s.call('/api/login/mfa')).json.factors[0];
  await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: option.id } });
  const url = 'http://localhost:0/messaging/inbound/twilio-sms';
  const fields = { From: '+15551230000', Body: 'Y' };
  const signed = (token) => crypto.createHmac('sha1', token).update(url + Object.keys(fields).sort().map((k) => `${k}${fields[k]}`).join('')).digest('base64');
  const body = new URLSearchParams(fields).toString();
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  assert.equal((await post('/messaging/inbound/twilio-sms', body, { ...form, 'x-twilio-signature': signed('not-the-token') })).status, 403);
  assert.equal((await post('/messaging/inbound/twilio-sms', body, { ...form, 'x-twilio-signature': signed('twilio-token') })).status, 200);
  assert.ok((await s.call('/api/login/mfa/challenge/status')).json.next);
});

/* ------------------------------ voice: the yes or no prompt ------------------------------ */

test('a yes or no call asks for a keypad answer or speech, and the prompt comes from the template', async () => {
  configureMessaging();
  setFactors({ voice: { enabled: true, modes: ['yes_no'] } });
  const id = mkUser('vic');
  enroll(id, 'voice', '+15551230001');
  const s = await login('vic', 'vic-password');
  const option = (await s.call('/api/login/mfa')).json.factors[0];
  await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: option.id } });
  const form = new URLSearchParams(lastSent().body);
  const token = new URL(form.get('Url')).pathname.split('/').pop();
  const twiml = await (await fetch(`${base}/factors/voice/${token}`)).text();
  assert.match(twiml, /<Gather input="dtmf speech" numDigits="1"/);
  assert.match(twiml, /Press 1 or say yes to approve/);
  const answer = await post(`/factors/voice/${token}/answer`, new URLSearchParams({ Digits: '1' }));
  assert.match(await answer.text(), /Approved/);
  assert.ok((await s.call('/api/login/mfa/challenge/status')).json.next);
});

/* ------------------------------ code length and number length ------------------------------ */

test('the code length in the policy sets how many digits a typed code has', async () => {
  configureMessaging();
  setFactors({ codeLength: 4, email: { enabled: true, modes: ['code'] } });
  const id = mkUser('cara');
  enroll(id, 'email', 'cara@x.net');
  const s = await login('cara', 'cara-password');
  const option = (await s.call('/api/login/mfa')).json.factors[0];
  const state = (await s.call('/api/login/mfa')).json;
  assert.equal(state.code_length, 4);
  await s.call('/api/login/mfa/challenge', { method: 'POST', body: { factor: option.id } });
  const code = /verification code is (\d{4})\./.exec(JSON.parse(lastSent().body).TextBody)[1];
  assert.equal((await s.call('/api/login/mfa/challenge/verify', { method: 'POST', body: { code } })).status, 200);
});

test('code and number lengths are checked to be 2 to 6 characters', () => {
  assert.ok(factorSettings.parse({ codeLength: 1 }).errors.some((e) => /code length/.test(e)));
  assert.ok(factorSettings.parse({ codeLength: 7 }).errors.some((e) => /code length/.test(e)));
  assert.ok(factorSettings.parse({ numberLength: 'x' }).errors.some((e) => /number length/.test(e)));
  assert.deepEqual(factorSettings.parse({ codeLength: 2, numberLength: 6 }).errors, []);
  const { data } = factorSettings.parse({ codeLength: 2, numberLength: 6 });
  assert.equal(data.codeLength, 2);
  assert.equal(data.numberLength, 6);
});

test('a way of proving the sign-in needs at least one way, and the old single mode still reads', () => {
  const { data, errors } = factorSettings.parse({ email: { enabled: true, modes: [] } }, msgSettings.messaging());
  assert.ok(errors.some((e) => /choose at least one way/.test(e)));
  assert.equal(data.email.modes.length, 0);
  // a saved "mode" from before this change still reads as the one way
  factorSettings.save({ ...factorSettings.get(), sms: { enabled: true, mode: 'number_match' } });
  assert.deepEqual(factorSettings.get().sms.modes, ['number_match']);
});

/* ------------------------------ message templates for each way ------------------------------ */

test('number matching and yes or no messages must say what the person sends back', () => {
  const r = templates.parse({ mfaNumberMatch: { sms: { body: 'Open {{link}} to continue.' } } });
  assert.ok(r.errors.some((e) => /reply with, or enter, the code/.test(e)), JSON.stringify(r.errors));
  const y = templates.parse({ mfaYesNo: { email: { subject: 'Sign in?', body: 'Hello. Are you signing in?' } } });
  assert.ok(y.errors.some((e) => /reply Y to approve or N to deny/.test(e)));
  const ok = templates.parse({ mfaNumberMatch: { sms: { body: 'Open {{link}} and enter the code shown on your sign-in screen.' } } });
  assert.deepEqual(ok.errors, []);
});

test('the built-in number matching and yes or no messages pass the checks they are held to', () => {
  for (const kind of ['mfaNumberMatch', 'mfaYesNo', 'mfaYesNoVerified']) {
    for (const ch of ['email', 'sms', 'voice']) {
      const def = templates.DEFAULTS[kind][ch];
      const { errors } = templates.parse({ [kind]: { [ch]: def } });
      assert.deepEqual(errors, [], `${kind} ${ch}`);
    }
  }
});

/* ------------------------------ provider sending ------------------------------ */

test('Amazon SES sends through its v2 API, signed with the access key', async () => {
  configureMessaging();
  const { data } = msgSettings.parse({ email: { provider: 'ses', from: 'idp@x.net', fromName: 'Office ID',
    ses: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example', region: 'us-east-1', configurationSet: 'idp-set' } } }, msgSettings.messaging());
  await messaging.send('email', 'a@y.net', { subject: 'Hi', text: 'Body' }, { config: data });
  const r = lastSent();
  assert.equal(r.url, '/v2/email/outbound-emails');
  assert.match(r.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.match(r.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  const body = JSON.parse(r.body);
  assert.equal(body.FromEmailAddress, 'Office ID <idp@x.net>');
  assert.deepEqual(body.Destination.ToAddresses, ['a@y.net']);
  assert.equal(body.Content.Simple.Body.Text.Data, 'Body');
  assert.equal(body.ConfigurationSetName, 'idp-set');
});

test('Postmark sends with the server token and the chosen message stream', async () => {
  configureMessaging();
  const cfg = msgSettings.messaging();
  await messaging.send('email', 'a@y.net', { subject: 'Hi', text: 'Body' }, { config: { ...cfg, email: { ...cfg.email, provider: 'postmark', from: 'idp@x.net', postmark: { serverToken: 'pm-token-abcdef', messageStream: 'broadcast', inboundToken: 'x' } } } });
  const r = lastSent();
  assert.equal(r.url, '/email');
  assert.equal(r.headers['x-postmark-server-token'], 'pm-token-abcdef');
  assert.deepEqual(JSON.parse(r.body), { From: 'idp@x.net', To: 'a@y.net', Subject: 'Hi', TextBody: 'Body', MessageStream: 'broadcast' });
});

test('Mailgun sends to the domain with basic auth, from the chosen region', async () => {
  configureMessaging();
  const cfg = msgSettings.messaging();
  await messaging.send('email', 'a@y.net', { subject: 'Hi', text: 'Body' }, { config: { ...cfg, email: { ...cfg.email, provider: 'mailgun', from: 'idp@x.net', fromName: '', mailgun: { apiKey: 'key-abc123', domain: 'mail.x.net', region: 'us', signingKey: '' } } } });
  const r = lastSent();
  assert.equal(r.url, '/v3/mail.x.net/messages');
  assert.equal(r.headers.authorization, `Basic ${Buffer.from('api:key-abc123').toString('base64')}`);
  const form = new URLSearchParams(r.body);
  assert.equal(form.get('to'), 'a@y.net');
  assert.equal(form.get('text'), 'Body');
});

test('email provider settings are checked for SES, Postmark and Mailgun', () => {
  const current = msgSettings.messaging();
  const ses = msgSettings.parse({ email: { provider: 'ses', from: 'idp@x.net', ses: { accessKeyId: 'AKIA', secretAccessKey: 's', region: 'useast1' } } }, current);
  assert.ok(ses.errors.some((e) => /SES region/.test(e)));
  const pm = msgSettings.parse({ email: { provider: 'postmark', from: 'idp@x.net', postmark: { serverToken: '' } } }, current);
  assert.ok(pm.errors.some((e) => /Postmark server API token/.test(e)));
  const mg = msgSettings.parse({ email: { provider: 'mailgun', from: 'idp@x.net', mailgun: { apiKey: 'key-1', domain: 'localhost' } } }, current);
  assert.ok(mg.errors.some((e) => /Mailgun sending domain/.test(e)));
  const good = msgSettings.parse({ email: { provider: 'postmark', from: 'idp@x.net', postmark: { serverToken: 'pm-token-abcdef' } } }, current);
  assert.deepEqual(good.errors, []);
  assert.ok(good.data.email.postmark.inboundToken.length >= 20, 'an inbound address is made when there is none');
});

test('the AWS signing matches the published test vector', () => {
  const aws = require('../src/messaging/aws');
  const a = aws.authorization({ method: 'GET', path: '/', headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' }, region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z' });
  assert.equal(a, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('an SNS message is refused unless its certificate is an AWS one', async () => {
  const inbound = require('../src/messaging/inbound').internal;
  assert.equal(await inbound.snsVerified({ Type: 'Notification', SigningCertURL: 'https://evil.example/cert.pem', Signature: 'x', SignatureVersion: '1', Message: '{}', MessageId: '1', Timestamp: 'now', TopicArn: 'arn' }), false);
  assert.equal(await inbound.snsVerified({ Type: 'Notification', SigningCertURL: 'http://sns.us-east-1.amazonaws.com/cert.pem', Signature: 'x', SignatureVersion: '1' }), false);
});

test('replies are read from the person\'s own words, not the quoted message', () => {
  const inbound = require('../src/messaging/inbound').internal;
  assert.equal(inbound.ownWords('Y\n\nOn Mon wrote:\n> please confirm'), 'Y');
  assert.equal(inbound.ownWords('482913\n> old text'), '482913');
  const raw = 'Content-Type: multipart/alternative; boundary="B"\r\n\r\n--B\r\nContent-Type: text/html\r\n\r\n<p>no</p>\r\n--B\r\nContent-Type: text/plain\r\n\r\nN\r\n--B--\r\n';
  assert.equal(inbound.mimeText(raw), 'N\r\n');
});

test('a Mailgun reply sent as multipart form data is read, and its text parts are found', async () => {
  configureMessaging({ provider: 'mailgun', mailgun: { apiKey: 'key-abc123', domain: 'mail.x.net', region: 'us', signingKey: 'signing-secret-2' } });
  const inbound = require('../src/messaging/inbound').internal;
  const boundary = 'XBOUNDARY';
  const ts = String(Math.floor(Date.now() / 1000));
  const token = 'tok-multipart';
  const signature = crypto.createHmac('sha256', 'signing-secret-2').update(`${ts}${token}`).digest('hex');
  const part = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = part('timestamp', ts) + part('token', token) + part('signature', signature) + part('sender', 'nobody@x.net')
    + part('stripped-text', 'Y') + `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\nxx\r\n--${boundary}--\r\n`;
  const fields = inbound.multipartFields(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(fields.signature, signature);
  assert.equal(fields['stripped-text'], 'Y');
  assert.equal(fields.attachment, undefined, 'files are not read as fields');
  const r = await post('/messaging/inbound/mailgun', body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  assert.equal(r.status, 200);
  // The nobody@ sender has no sign-in waiting, so nothing is approved, and the reply is still accepted.
});
