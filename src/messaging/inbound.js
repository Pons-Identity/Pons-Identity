const crypto = require('crypto');
const express = require('express');
const messagingSettings = require('./settings');
const { safeRequest } = require('../safe-fetch');
const challenges = require('../factors/challenges');
const { baseUrl } = require('../config');
const emailAuth = require('./email-auth');
const { twilioSignatureOk } = require('./twilio-signature');

// Replies that come back to us: a person answers a sign-in message by email or text ("Y", "N", or the code on the sign-in
// screen). Each provider's webhook is checked before anything is read: a wrong token, signature or certificate gets a 403
// and nothing is recorded. The reply itself goes to factors/challenges.reply, which only ever matches a pending sign-in.

const MAX_BODY = 512 * 1024;

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- Parsing the bodies providers send ----------

/** Splits a MIME part or message into its header lines (unfolded, lower-cased names) and its body. */
function splitMessage(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i);
  const body = i < 0 ? '' : raw.slice(raw.indexOf('\n', i) + 1).replace(/^\r?\n/, '');
  const lines = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && lines.length) lines[lines.length - 1] += ` ${line.trim()}`;
    else lines.push(line);
  }
  const headers = {};
  for (const line of lines) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  return { headers, body };
}

const param = (value = '', name) => {
  const m = new RegExp(`${name}="?([^";]+)"?`, 'i').exec(value);
  return m ? m[1] : '';
};

/** The text fields of a multipart/form-data body (file parts are skipped). */
function multipartFields(raw, contentType) {
  const boundary = param(contentType, 'boundary');
  const out = {};
  if (!boundary) return out;
  for (const part of raw.split(`--${boundary}`)) {
    const { headers, body } = splitMessage(part.replace(/^\r?\n/, ''));
    const disposition = headers['content-disposition'] || '';
    const name = param(disposition, 'name');
    if (name && !/filename=/i.test(disposition)) out[name] = body.replace(/\r?\n$/, '');
  }
  return out;
}

/** The fields of a body sent as a web form, as a plain object. */
const formFields = (raw) => Object.fromEntries(new URLSearchParams(raw));

/** Decodes a MIME body by its transfer encoding. */
function decodeBody({ headers, body }) {
  const encoding = (headers['content-transfer-encoding'] || '').toLowerCase();
  if (encoding === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  }
  if (encoding === 'base64') return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
  return body;
}

/** The plain-text body of a MIME message, found through any multipart nesting. */
function mimeText(raw) {
  const { headers, body } = splitMessage(raw);
  const type = headers['content-type'] || 'text/plain';
  if (!/^multipart\//i.test(type)) return /text\/plain/i.test(type) ? decodeBody({ headers, body }) : '';
  const boundary = param(type, 'boundary');
  const parts = boundary ? body.split(`--${boundary}`).slice(1) : [];
  for (const part of parts) {
    const p = splitMessage(part.replace(/^\r?\n/, ''));
    if (/^text\/plain/i.test(p.headers['content-type'] || '')) return decodeBody(p);
  }
  for (const part of parts) {
    const text = mimeText(part.replace(/^\r?\n/, ''));
    if (text) return text;
  }
  return '';
}

/**
 * The part of a reply the person wrote, without the quoted message below it. Stops at the first quoted line or the
 * "On ... wrote:" line that mail clients add.
 */
function ownWords(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    if (/^>/.test(line) || /^On .+ wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: /.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').trim().slice(0, 500);
}

// ---------- Amazon SNS (used by SES inbound) ----------

const certCache = new Map();
const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** Checks an SNS message's signature against the certificate it names, as AWS describes it. */
async function snsVerified(msg) {
  let url;
  try { url = new URL(msg.SigningCertURL); } catch { return false; }
  if (url.protocol !== 'https:' || !SNS_HOST_RE.test(url.hostname)) return false;
  const keys = msg.Type === 'Notification' ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const toSign = keys.filter((k) => msg[k] !== undefined).map((k) => `${k}\n${msg[k]}\n`).join('');
  const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : msg.SignatureVersion === '1' ? 'RSA-SHA1' : null;
  if (!algorithm) return false;
  if (!certCache.has(url.href)) {
    const r = await safeRequest(url.href, { method: 'GET', maxBytes: 64 * 1024 }).catch(() => null);
    if (!r || !r.ok) return false;
    certCache.set(url.href, r.text);
  }
  try {
    return crypto.createVerify(algorithm).update(toSign, 'utf8').verify(certCache.get(url.href), msg.Signature, 'base64');
  } catch {
    return false;
  }
}

// ---------- Twilio ----------


// ---------- Routes ----------

const router = express.Router();
const emptyTwiml = (res) => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
const replyTo = (channel, from, text) => challenges.reply({ channel, from, text: ownWords(text) });

// An email reply counts only if the provider reports the checks the administrator requires (SPF, DKIM, DMARC) as passed. One that
// fails is dropped like any other stray reply: the provider still gets a 200 so it does not retry, and nothing is recorded as approved.
const authentic = (verdicts) => emailAuth.check(messagingSettings.messaging().email.inboundAuth, verdicts).ok;

// Postmark: the inbound webhook. The token is part of the address given to Postmark, so only Postmark knows it.
router.post('/postmark/:token', express.json({ limit: MAX_BODY }), (req, res) => {
  const cfg = messagingSettings.messaging().email;
  if (cfg.provider !== 'postmark' || !cfg.postmark.inboundToken || !same(req.params.token, cfg.postmark.inboundToken)) return res.sendStatus(403);
  const from = (req.body.FromFull && req.body.FromFull.Email) || req.body.From || '';
  if (authentic(emailAuth.fromHeaders(req.body.Headers))) replyTo('email', from, req.body.StrippedTextReply || req.body.TextBody || '');
  res.sendStatus(200);
});

// Mailgun: a route that forwards to this URL. Each request is signed with the HTTP signing key over its timestamp and token.
router.post('/mailgun', express.raw({ type: () => true, limit: MAX_BODY }), (req, res) => {
  const cfg = messagingSettings.messaging().email;
  if (cfg.provider !== 'mailgun' || !cfg.mailgun.signingKey) return res.sendStatus(403);
  const raw = req.body.toString('utf8');
  const type = req.headers['content-type'] || '';
  const fields = /multipart\/form-data/i.test(type) ? multipartFields(raw, type) : formFields(raw);
  const { timestamp = '', token = '', signature = '' } = fields;
  const expected = crypto.createHmac('sha256', cfg.mailgun.signingKey).update(`${timestamp}${token}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 15 * 60;
  if (!fresh || !same(signature, expected)) return res.sendStatus(403);
  if (authentic(emailAuth.fromMailgun(fields))) replyTo('email', fields.sender || fields.from || '', fields['stripped-text'] || fields['body-plain'] || '');
  res.sendStatus(200);
});

// SES: an SNS subscription on the topic that an SES receipt rule publishes to. SNS confirms the subscription first.
router.post('/ses', express.text({ type: () => true, limit: MAX_BODY }), async (req, res) => {
  const cfg = messagingSettings.messaging().email;
  if (cfg.provider !== 'ses') return res.sendStatus(403);
  let msg;
  try { msg = JSON.parse(req.body); } catch { return res.sendStatus(400); }
  if (!(await snsVerified(msg))) return res.sendStatus(403);
  if (cfg.ses.snsTopicArn && msg.TopicArn !== cfg.ses.snsTopicArn) return res.sendStatus(403);
  if (msg.Type === 'SubscriptionConfirmation') {
    const r = await safeRequest(msg.SubscribeURL, { method: 'GET' }).catch(() => null);
    return res.sendStatus(r && r.ok ? 200 : 502);
  }
  if (msg.Type !== 'Notification') return res.sendStatus(200);
  let event;
  try { event = JSON.parse(msg.Message || '{}'); } catch { return res.sendStatus(400); }
  if (event.notificationType === 'Received' && authentic(emailAuth.fromSes(event.receipt))) replyTo('email', event.mail?.source || '', mimeText(event.content || ''));
  res.sendStatus(200);
});

// Twilio: an incoming text message, checked against the account's auth token.
router.post('/twilio-sms', express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
  const cfg = messagingSettings.messaging().sms;
  if (cfg.provider !== 'twilio' || !cfg.twilio.authToken) return res.sendStatus(403);
  if (!twilioSignatureOk(`${baseUrl}/messaging/inbound/twilio-sms`, req.body, req.get('x-twilio-signature'), cfg.twilio.authToken)) return res.sendStatus(403);
  replyTo('sms', req.body.From || '', req.body.Body || '');
  emptyTwiml(res);
});

module.exports = router;
module.exports.internal = { splitMessage, multipartFields, formFields, mimeText, ownWords, twilioSignatureOk, snsVerified };
