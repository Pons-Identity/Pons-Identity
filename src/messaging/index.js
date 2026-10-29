const nodemailer = require('nodemailer');
const { safeRequest } = require('../safe-fetch');
const { messaging, configured, MAILGUN_REGIONS } = require('./settings');
const templates = require('./templates');
const aws = require('./aws');

// Sends email, SMS and voice messages through the providers an administrator configured. Callers get a MessagingError
// with a message that is safe to show: provider responses and credentials are never copied into it.
class MessagingError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Where the provider APIs live. Tests point these at a local server; sesBase is the SES endpoint with no region (the region is added).
const deps = { createTransport: nodemailer.createTransport, twilioBase: 'https://api.twilio.com', postmarkBase: 'https://api.postmarkapp.com', sesBase: '', mailgunBase: '' };
const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A destination may be sent to RATE_MAX times in RATE_WINDOW_MS, so the sign-in and recovery pages cannot be used to
// spam a person or run up the provider bill.
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const sent = new Map();

function allow(key, now = Date.now()) {
  const recent = (sent.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) { sent.set(key, recent); return false; }
  recent.push(now);
  sent.set(key, recent);
  if (sent.size > 10000) for (const [k, v] of sent) if (!v.some((t) => now - t < RATE_WINDOW_MS)) sent.delete(k);
  return true;
}
const resetRateLimits = () => sent.clear();

const jsonEscape = (v) => JSON.stringify(String(v)).slice(1, -1);
const xmlEscape = (v) => String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const fill = (tpl, vars, esc) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? esc(vars[k]) : ''));

// The From address as the HTTP email APIs take it: "Name <address>" when a name is set.
const fromField = (c) => (c.fromName ? `${c.fromName} <${c.from}>` : c.from);

async function sendEmail(c, to, { subject, text }) {
  if (c.provider === 'ses') return sendSes(c, to, { subject, text });
  if (c.provider === 'postmark') return sendPostmark(c, to, { subject, text });
  if (c.provider === 'mailgun') return sendMailgun(c, to, { subject, text });
  if (c.provider === 'smtp') {
    const transport = deps.createTransport({ host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure,
      auth: c.smtp.user ? { user: c.smtp.user, pass: c.smtp.pass } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    try {
      await transport.sendMail({ from: c.fromName ? { name: c.fromName, address: c.from } : c.from, to, subject, text });
    } catch {
      throw new MessagingError('The mail server did not accept the message.');
    }
    return;
  }
  const r = await safeRequest(`${c.sendgrid.apiUrl.replace(/\/+$/, '')}/v3/mail/send`, {
    headers: { authorization: `Bearer ${c.sendgrid.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: c.from, ...(c.fromName ? { name: c.fromName } : {}) },
      subject, content: [{ type: 'text/plain', value: text }] }),
  }).catch(() => { throw new MessagingError('SendGrid could not be reached.'); });
  if (!r.ok) throw new MessagingError(`SendGrid refused the message (HTTP ${r.status}).`);
}

// Amazon SES, through its v2 API. The request is signed with the access key (Signature Version 4).
async function sendSes(c, to, { subject, text }) {
  const s = c.ses;
  const base = deps.sesBase || `https://email.${s.region}.amazonaws.com`;
  const { host } = new URL(base);
  const path = '/v2/email/outbound-emails';
  const body = JSON.stringify({
    FromEmailAddress: fromField(c),
    Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
    ...(s.configurationSet ? { ConfigurationSetName: s.configurationSet } : {}),
  });
  const amzDate = aws.amzDateOf();
  const authorization = aws.authorization({
    method: 'POST', path, body, region: s.region, service: 'ses', accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, amzDate,
    headers: { 'content-type': 'application/json', host, 'x-amz-date': amzDate },
  });
  const r = await safeRequest(`${base}${path}`, {
    headers: { 'content-type': 'application/json', 'x-amz-date': amzDate, authorization }, body,
  }).catch(() => { throw new MessagingError('Amazon SES could not be reached.'); });
  if (!r.ok) throw new MessagingError(`Amazon SES refused the message (HTTP ${r.status}).`);
}

async function sendPostmark(c, to, { subject, text }) {
  const p = c.postmark;
  const r = await safeRequest(`${deps.postmarkBase}/email`, {
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': p.serverToken },
    body: JSON.stringify({ From: fromField(c), To: to, Subject: subject, TextBody: text, MessageStream: p.messageStream }),
  }).catch(() => { throw new MessagingError('Postmark could not be reached.'); });
  if (!r.ok) throw new MessagingError(`Postmark refused the message (HTTP ${r.status}).`);
}

async function sendMailgun(c, to, { subject, text }) {
  const g = c.mailgun;
  const base = deps.mailgunBase || MAILGUN_REGIONS[g.region];
  const r = await safeRequest(`${base}/v3/${encodeURIComponent(g.domain)}/messages`, {
    headers: { authorization: `Basic ${Buffer.from(`api:${g.apiKey}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ from: fromField(c), to, subject, text }).toString(),
  }).catch(() => { throw new MessagingError('Mailgun could not be reached.'); });
  if (!r.ok) throw new MessagingError(`Mailgun refused the message (HTTP ${r.status}).`);
}

async function sendPhone(channel, c, to, { text, url: url2 }) {
  if (url2 && c.provider !== 'twilio') throw new MessagingError('Interactive calls need the Twilio provider.', 500);
  let url; let headers; let body;
  if (c.provider === 'twilio') {
    const t = c.twilio;
    url = `${deps.twilioBase}/2010-04-01/Accounts/${encodeURIComponent(t.accountSid)}/${channel === 'sms' ? 'Messages' : 'Calls'}.json`;
    // With a url, Twilio fetches the call's instructions from there (used to collect a number on the keypad).
    const form = new URLSearchParams(channel === 'sms'
      ? { To: to, From: t.from, Body: text }
      : { To: to, From: t.from, ...(url2 ? { Url: url2 } : { Twiml: `<Response><Say>${xmlEscape(text)}</Say></Response>` }) });
    body = form.toString();
    headers = { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64')}` };
  } else {
    const h = c.http;
    const vars = { to, message: text, from: c.from };
    const json = h.contentType === 'json';
    url = fill(h.url, vars, encodeURIComponent);
    body = fill(h.body, vars, json ? jsonEscape : encodeURIComponent);
    if (json) { try { JSON.parse(body); } catch { throw new MessagingError('The request body template does not produce valid JSON.', 500); } }
    headers = { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' };
    for (const line of h.headers.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = fill(line.slice(i + 1).trim(), vars, (v) => String(v).replace(/[\r\n]/g, ''));
    }
    if (h.authValue) headers[h.authHeader] = h.authValue;
  }
  const r = await safeRequest(url, { headers, body }).catch(() => { throw new MessagingError('The messaging provider could not be reached.'); });
  if (!r.ok) throw new MessagingError(`The messaging provider refused the message (HTTP ${r.status}).`);
}

/** Sends `message` ({ subject, text }) to `to` over 'email', 'sms' or 'voice'. Voice reads `text` aloud. */
async function send(channel, to, message, { config = messaging(), rateKey } = {}) {
  if (!['email', 'sms', 'voice'].includes(channel)) throw new MessagingError('Unknown channel.', 500);
  if (!configured(channel, config)) throw new MessagingError(`${channel === 'email' ? 'Email' : channel.toUpperCase()} delivery is not configured.`, 503);
  if (!(channel === 'email' ? EMAIL_RE : PHONE_RE).test(to)) throw new MessagingError(channel === 'email' ? 'Not a valid email address.' : 'Phone numbers must look like +15551234567.', 400);
  if (!allow(rateKey || `${channel}:${to.toLowerCase()}`)) throw new MessagingError('Too many messages to that destination. Try again later.', 429);
  if (channel === 'email') await sendEmail(config.email, to, message);
  else await sendPhone(channel, config[channel], to, message);
}

/**
 * Sends a templated message: `kind` is 'mfa' or 'passwordReset', `vars` the values for its placeholders ({ username, code,
 * link, ... }; see templates.KINDS). The wording is whatever the administrator saved, or the built-in text.
 */
async function sendTemplated(kind, channel, to, vars, opts) {
  await send(channel, to, templates.render(kind, channel, vars), opts);
}

module.exports = { send, sendTemplated, templates, MessagingError, deps, allow, resetRateLimits, PHONE_RE, EMAIL_RE, configured, messaging };
