const crypto = require('crypto');
const appSettings = require('../app-settings');
const { baseUrl } = require('../config');

// Outbound messaging used for password recovery and for email, SMS and voice sign-in factors. Secrets (SMTP password,
// API keys, auth tokens) are stored like the Duo secret key but are never sent back to the console: the view says
// whether one is set, and saving a blank value keeps the stored one.
const KEY = 'messaging';
const EMAIL_PROVIDERS = ['none', 'smtp', 'sendgrid', 'ses', 'postmark', 'mailgun'];
const MAILGUN_REGIONS = { us: 'https://api.mailgun.net', eu: 'https://api.eu.mailgun.net' };
const PHONE_PROVIDERS = ['none', 'twilio', 'http'];
const SECRETS = {
  email: [['smtp', 'pass'], ['sendgrid', 'apiKey'], ['ses', 'secretAccessKey'], ['postmark', 'serverToken'], ['mailgun', 'apiKey'], ['mailgun', 'signingKey']],
  sms: [['twilio', 'authToken'], ['http', 'authValue']],
  voice: [['twilio', 'authToken'], ['http', 'authValue']],
};

const HTTP_DEFAULTS = { url: '', contentType: 'json', body: '', authHeader: 'Authorization', authValue: '', headers: '' };
const TWILIO_DEFAULTS = { accountSid: '', authToken: '', from: '' };
const DEFAULTS = {
  email: {
    provider: 'none', from: '', fromName: '',
    // Which checks the provider must report as passed on a reply before it counts (messaging/email-auth.js). All off = replies are
    // trusted on the sender address alone, which anyone can forge.
    inboundAuth: { spf: false, dkim: false, dmarc: false },
    smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
    sendgrid: { apiKey: '', apiUrl: 'https://api.sendgrid.com' },
    // Amazon SES: the API with an IAM access key. Inbound mail arrives through an SES receipt rule that publishes to an SNS topic.
    ses: { accessKeyId: '', secretAccessKey: '', region: 'us-east-1', configurationSet: '', snsTopicArn: '' },
    // Postmark: the server API token. Inbound mail is posted to /messaging/inbound/postmark/<inboundToken>.
    postmark: { serverToken: '', messageStream: 'outbound', inboundToken: '' },
    // Mailgun: the private API key and the sending domain. Inbound mail is checked with the HTTP signing key.
    mailgun: { apiKey: '', domain: '', region: 'us', signingKey: '' },
  },
  sms: { provider: 'none', twilio: { ...TWILIO_DEFAULTS }, http: { ...HTTP_DEFAULTS, body: '{"to":"{{to}}","from":"{{from}}","text":"{{message}}"}' }, from: '' },
  // verifySignature: check Twilio's X-Twilio-Signature on the requests it makes while a sign-in call is answered.
  voice: { provider: 'none', twilio: { ...TWILIO_DEFAULTS, verifySignature: false }, http: { ...HTTP_DEFAULTS, body: '{"to":"{{to}}","from":"{{from}}","say":"{{message}}"}' }, from: '' },
};

const merge = (base, saved) => {
  const out = {};
  for (const k of Object.keys(base)) {
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], (saved || {})[k]) : ((saved || {})[k] ?? base[k]);
  }
  return out;
};

function messaging() {
  const saved = appSettings.read(KEY) || {};
  return { email: merge(DEFAULTS.email, saved.email), sms: merge(DEFAULTS.sms, saved.sms), voice: merge(DEFAULTS.voice, saved.voice) };
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const urlOk = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
const HEADER_RE = /^[A-Za-z0-9-]+$/;
const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const MAILGUN_DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const SERVER_TOKEN_RE = /^[A-Za-z0-9-]{8,100}$/;

/** A random path segment for the inbound mail address, used when an administrator has not chosen one. */
const newInboundToken = () => crypto.randomBytes(24).toString('base64url');

// A channel is usable when its provider is chosen and the fields it needs are present.
function configured(channel, cfg = messaging()) {
  const c = cfg[channel];
  if (channel === 'email') {
    if (!c.from) return false;
    if (c.provider === 'smtp') return Boolean(c.smtp.host);
    if (c.provider === 'sendgrid') return Boolean(c.sendgrid.apiKey);
    if (c.provider === 'ses') return Boolean(c.ses.accessKeyId && c.ses.secretAccessKey && AWS_REGION_RE.test(c.ses.region));
    if (c.provider === 'postmark') return Boolean(c.postmark.serverToken);
    if (c.provider === 'mailgun') return Boolean(c.mailgun.apiKey && c.mailgun.domain);
    return false;
  }
  if (c.provider === 'twilio') return Boolean(c.twilio.accountSid && c.twilio.authToken && c.twilio.from);
  if (c.provider === 'http') return Boolean(c.http.url && c.http.body);
  return false;
}

// Validates submitted settings and merges in the stored secrets where the submitted ones are blank.
function parse(body, current = messaging()) {
  const errors = [];
  const out = merge(DEFAULTS, {});
  const em = body.email || {};
  const e = out.email;
  e.provider = EMAIL_PROVIDERS.includes(em.provider) ? em.provider : 'none';
  e.from = text(em.from);
  e.fromName = text(em.fromName);
  e.inboundAuth = { spf: Boolean(em.inboundAuth?.spf), dkim: Boolean(em.inboundAuth?.dkim), dmarc: Boolean(em.inboundAuth?.dmarc) };
  e.smtp = { host: text(em.smtp?.host), port: Number(em.smtp?.port) || 587, secure: Boolean(em.smtp?.secure), user: text(em.smtp?.user), pass: text(em.smtp?.pass) };
  e.sendgrid = { apiKey: text(em.sendgrid?.apiKey), apiUrl: text(em.sendgrid?.apiUrl) || DEFAULTS.email.sendgrid.apiUrl };
  if (e.provider !== 'none' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.from)) errors.push('Email: a valid From address is required.');
  if (e.provider === 'smtp') {
    if (!e.smtp.host) errors.push('Email: SMTP host is required.');
    if (!(e.smtp.port >= 1 && e.smtp.port <= 65535)) errors.push('Email: SMTP port must be between 1 and 65535.');
  }
  if (e.provider === 'sendgrid' && !urlOk(e.sendgrid.apiUrl)) errors.push('Email: the SendGrid API URL must be an http(s) URL.');
  const ses = em.ses || {};
  e.ses = { accessKeyId: text(ses.accessKeyId), secretAccessKey: text(ses.secretAccessKey), region: text(ses.region).toLowerCase() || 'us-east-1',
    configurationSet: text(ses.configurationSet), snsTopicArn: text(ses.snsTopicArn) };
  const pm = em.postmark || {};
  e.postmark = { serverToken: text(pm.serverToken), messageStream: text(pm.messageStream) || 'outbound', inboundToken: text(pm.inboundToken) };
  const mg = em.mailgun || {};
  e.mailgun = { apiKey: text(mg.apiKey), domain: text(mg.domain).toLowerCase(), region: mg.region === 'eu' ? 'eu' : 'us', signingKey: text(mg.signingKey) };
  if (e.provider === 'ses') {
    if (!AWS_REGION_RE.test(e.ses.region)) errors.push('Email: the SES region must look like us-east-1.');
    if (!e.ses.accessKeyId || !e.ses.secretAccessKey) errors.push('Email: the SES access key ID and secret access key are required.');
    if (e.ses.snsTopicArn && !/^arn:aws[a-z-]*:sns:/.test(e.ses.snsTopicArn)) errors.push('Email: the SNS topic ARN must start with arn:aws:sns:.');
  }
  if (e.provider === 'postmark') {
    if (!e.postmark.serverToken) errors.push('Email: the Postmark server API token is required.');
    if (!/^[a-z0-9-]{1,40}$/.test(e.postmark.messageStream)) errors.push('Email: the Postmark message stream must be a short name such as outbound.');
    if (e.postmark.serverToken && !SERVER_TOKEN_RE.test(e.postmark.serverToken)) errors.push('Email: the Postmark server API token does not look right.');
  }
  if (e.provider === 'mailgun') {
    if (!e.mailgun.apiKey) errors.push('Email: the Mailgun API key is required.');
    if (!MAILGUN_DOMAIN_RE.test(e.mailgun.domain)) errors.push('Email: the Mailgun sending domain must look like mail.example.net.');
  }

  for (const ch of ['sms', 'voice']) {
    const label = ch === 'sms' ? 'SMS' : 'Voice';
    const src = body[ch] || {};
    const c = out[ch];
    c.provider = PHONE_PROVIDERS.includes(src.provider) ? src.provider : 'none';
    c.from = text(src.from);
    c.twilio = { accountSid: text(src.twilio?.accountSid), authToken: text(src.twilio?.authToken), from: text(src.twilio?.from),
      ...(ch === 'voice' ? { verifySignature: Boolean(src.twilio?.verifySignature) } : {}) };
    const h = src.http || {};
    c.http = { url: text(h.url), contentType: h.contentType === 'form' ? 'form' : 'json', body: typeof h.body === 'string' ? h.body : '',
      authHeader: text(h.authHeader) || 'Authorization', authValue: text(h.authValue), headers: typeof h.headers === 'string' ? h.headers : '' };
    if (c.provider === 'twilio') {
      if (!c.twilio.accountSid) errors.push(`${label}: Twilio account SID is required.`);
      if (!c.twilio.from) errors.push(`${label}: a From number is required.`);
    }
    if (c.provider === 'http') {
      if (!urlOk(c.http.url)) errors.push(`${label}: the provider URL must be an http(s) URL.`);
      if (!c.http.body.includes('{{to}}') || !c.http.body.includes('{{message}}')) errors.push(`${label}: the request body must include {{to}} and {{message}}.`);
      if (!HEADER_RE.test(c.http.authHeader)) errors.push(`${label}: the authentication header name is not valid.`);
      for (const line of c.http.headers.split(/\r?\n/).filter((l) => l.trim())) {
        const i = line.indexOf(':');
        if (i < 1 || !HEADER_RE.test(line.slice(0, i).trim())) errors.push(`${label}: header "${line.slice(0, 40)}" must look like Name: value.`);
      }
    }
  }
  // Blank secrets keep what is stored. The Postmark inbound token is not a secret the console hides: it is part of the address the
  // administrator gives Postmark, so it is shown. A missing one is made now.
  for (const ch of Object.keys(SECRETS)) {
    for (const [group, field] of SECRETS[ch]) {
      if (!out[ch][group][field]) out[ch][group][field] = current[ch][group][field];
    }
  }
  if (out.email.provider === 'postmark' && !out.email.postmark.inboundToken) out.email.postmark.inboundToken = newInboundToken();
  return { data: out, errors };
}

const save = (data) => appSettings.write(KEY, data);

// What the console sees: secrets replaced by whether they are set.
function view(cfg = messaging()) {
  const out = JSON.parse(JSON.stringify(cfg));
  // The addresses the providers post replies to (the Postmark one includes its token), for the administrator to paste into each provider.
  out.inbound = {
    postmark: `${baseUrl}/messaging/inbound/postmark/${cfg.email.postmark.inboundToken}`,
    mailgun: `${baseUrl}/messaging/inbound/mailgun`,
    ses: `${baseUrl}/messaging/inbound/ses`,
    twilioSms: `${baseUrl}/messaging/inbound/twilio-sms`,
  };
  for (const ch of Object.keys(SECRETS)) {
    out[ch].secrets = {};
    for (const [group, field] of SECRETS[ch]) {
      out[ch].secrets[`${group}.${field}`] = Boolean(out[ch][group][field]);
      out[ch][group][field] = '';
    }
    out[ch].configured = configured(ch, cfg);
  }
  return out;
}

module.exports = { messaging, parse, save, view, configured, EMAIL_PROVIDERS, PHONE_PROVIDERS, MAILGUN_REGIONS };
