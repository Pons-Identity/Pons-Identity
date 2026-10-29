const appSettings = require('../app-settings');
const messaging = require('../messaging/settings');

// Which extra sign-in factors are on, and how each channel (email, SMS, voice) proves the person is at the device. A channel can
// have several ways on at once, and each way is its own factor, so a policy can allow one and refuse another. The ways are:
//   code             a code is sent and typed into the sign-in page (like an authenticator app).
//   number_match     the sign-in page shows a number, and the person sends it back from the device that got the message: by
//                    following the link, on the phone keypad, or by replying to the message. Nothing is typed into the sign-in
//                    page, so a fake page has nothing to collect: phishing resistant.
//   yes_no           unverified: the device is asked "are you logging in?" and answers Y or N. Nothing is shown on the sign-in
//                    page, so a request the person did not start can be approved by mistake: not phishing resistant.
//   yes_no_verified  verified: the same question, but a yes must be answered with the number shown on the sign-in page.
// Everything is off until an administrator turns it on, so installing this changes nobody's sign-in.
const KEY = 'factors';
const CHANNELS = ['email', 'sms', 'voice'];
const MODES = ['code', 'number_match', 'yes_no', 'yes_no_verified'];
const MODE_LABELS = {
  code: 'code typed into the sign-in page',
  number_match: 'number matching',
  yes_no: 'yes or no, unverified',
  yes_no_verified: 'yes or no, verified with the code on the sign-in page',
};
const TYPES = ['totp', 'webauthn', ...CHANNELS];
const LENGTH = { min: 2, max: 6 };

// The methods that can be counted as phishing resistant, for policies and for risk-based limits. A channel is one method per way
// it can be used. An administrator picks which count; the defaults are the ones that cannot be relayed from a fake sign-in page.
const NAMES = { email: 'Email', sms: 'Text message', voice: 'Phone call' };
const SHORT = { email: 'Email', sms: 'SMS', voice: 'Voice' };
const METHODS = [
  { id: 'webauthn', label: 'Security keys and passkeys', recommended: true },
  { id: 'totp', label: 'Authenticator app (six-digit code)', recommended: false },
  ...CHANNELS.flatMap((ch) => MODES.map((mode) => ({
    id: `${ch}:${mode}`,
    label: `${NAMES[ch]}, ${MODE_LABELS[mode]}`,
    recommended: mode === 'number_match' || mode === 'yes_no_verified',
  }))),
];
const DEFAULT_PHISHING_RESISTANT = METHODS.filter((m) => m.recommended).map((m) => m.id);

const DEFAULTS = {
  phishingResistantMethods: DEFAULT_PHISHING_RESISTANT,
  // Digits in a typed code, and in the number the sign-in page shows for number matching (the same keypad either way).
  codeLength: 6,
  numberLength: 3,
  webauthn: { enabled: false, userVerification: 'preferred' },
  email: { enabled: false, modes: ['code'] },
  sms: { enabled: false, modes: ['code'] },
  voice: { enabled: false, modes: ['code'] },
};

// A channel's ways. A channel that was saved with one `mode` (before there were several) keeps that one; so does a request that
// sends `mode` instead of `modes`.
const modesFrom = (c) => {
  if (Array.isArray(c.modes)) return MODES.filter((m) => c.modes.includes(m));
  return MODES.includes(c.mode) ? [c.mode] : [];
};
const lengthOf = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) >= LENGTH.min && Number(value) <= LENGTH.max ? Number(value) : fallback);

const get = () => {
  const saved = appSettings.read(KEY) || {};
  const out = {
    codeLength: lengthOf(saved.codeLength, DEFAULTS.codeLength),
    numberLength: lengthOf(saved.numberLength, DEFAULTS.numberLength),
    webauthn: { ...DEFAULTS.webauthn, ...(saved.webauthn || {}) },
  };
  for (const ch of CHANNELS) {
    const c = saved[ch] || {};
    out[ch] = { enabled: Boolean(c.enabled), modes: Array.isArray(c.modes) || MODES.includes(c.mode) ? modesFrom(c) : ['code'] };
  }
  out.phishingResistantMethods = Array.isArray(saved.phishingResistantMethods) ? saved.phishingResistantMethods : DEFAULT_PHISHING_RESISTANT;
  return out;
};

function parse(body, msg = messaging.messaging()) {
  const errors = [];
  const out = get();
  if (body.phishingResistantMethods !== undefined) {
    const ids = new Set(METHODS.map((m) => m.id));
    if (!Array.isArray(body.phishingResistantMethods) || body.phishingResistantMethods.some((m) => !ids.has(m))) errors.push('Unknown phishing-resistant method.');
    else out.phishingResistantMethods = METHODS.map((m) => m.id).filter((id) => body.phishingResistantMethods.includes(id));
  }
  for (const [key, label] of [['codeLength', 'The code length'], ['numberLength', 'The number length']]) {
    if (body[key] === undefined) continue;
    if (lengthOf(body[key], null) === null) errors.push(`${label} must be a whole number from ${LENGTH.min} to ${LENGTH.max}.`);
    else out[key] = lengthOf(body[key], null);
  }
  const w = body.webauthn || {};
  out.webauthn = { enabled: Boolean(w.enabled), userVerification: w.userVerification === 'required' ? 'required' : 'preferred' };
  for (const ch of CHANNELS) {
    const c = body[ch] || {};
    const label = SHORT[ch];
    const modes = modesFrom(c);
    out[ch] = { enabled: Boolean(c.enabled), modes };
    if (out[ch].enabled && !modes.length) errors.push(`${label}: choose at least one way to prove it.`);
    if (out[ch].enabled && !messaging.configured(ch, msg)) errors.push(`${label} cannot be turned on until its delivery is set up under Messaging.`);
    // A voice call can only collect a number or a Y/N answer on the keypad through Twilio, which fetches instructions from this server.
    if (ch === 'voice' && out[ch].enabled && modes.some((m) => m !== 'code') && msg.voice.provider !== 'twilio') {
      errors.push('Voice number matching and yes or no answers need the Twilio provider, which takes the answer on the phone keypad. Use code mode with another provider.');
    }
  }
  return { data: out, errors };
}

const save = (data) => appSettings.write(KEY, data);

/** Is this factor type switched on? Authenticator apps are always available unless a policy excludes them. */
const enabled = (type, cfg = get()) => {
  if (type === 'totp') return true;
  if (CHANNELS.includes(type)) return Boolean(cfg[type] && cfg[type].enabled && cfg[type].modes.length);
  return Boolean(cfg[type] && cfg[type].enabled);
};

/** The ways a channel is on, e.g. ['code', 'yes_no'], or [] when it is off. */
const modesOf = (channel, cfg = get()) => (cfg[channel] && cfg[channel].enabled ? cfg[channel].modes : []);

/** The method an identifier stands for: 'totp', 'webauthn', or 'channel:mode' for an email, SMS or voice way. */
const methodOf = (type, mode) => (CHANNELS.includes(type) ? `${type}:${mode}` : type);

/** Is this method (or a whole channel, for an older policy) switched on? */
const methodEnabled = (method, cfg = get()) => {
  const [type, mode] = method.split(':');
  if (!mode) return enabled(type, cfg);
  return modesOf(type, cfg).includes(mode);
};

/** Counts as phishing resistant: a method the administrator chose. A channel name alone counts only if every way it is on counts. */
const phishingResistant = (method, cfg = get()) => {
  if (method.includes(':')) return cfg.phishingResistantMethods.includes(method);
  if (CHANNELS.includes(method)) return modesOf(method, cfg).every((mode) => cfg.phishingResistantMethods.includes(`${method}:${mode}`));
  return cfg.phishingResistantMethods.includes(method);
};

const codeLength = (cfg = get()) => cfg.codeLength;
const numberLength = (cfg = get()) => cfg.numberLength;

module.exports = {
  get, parse, save, enabled, modesOf, methodOf, methodEnabled, phishingResistant, codeLength, numberLength,
  METHODS, MODE_LABELS, DEFAULT_PHISHING_RESISTANT, CHANNELS, MODES, TYPES, LENGTH,
};
