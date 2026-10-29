const appSettings = require('./app-settings');
const messagingSettings = require('./messaging/settings');
const factorSettings = require('./factors/settings');

// Session lifetime, and the risks an administrator has to accept in writing before a setting that weakens sign-in can be saved.
//
// Session: `sessionHours` is how long after signing in a session ends whatever the person does (an absolute limit); `idleMinutes`
// ends it sooner when nothing has happened for that long (0 = no idle limit). Both are enforced on the server for every request
// (see sessionLimits in server.js).
//
// Acknowledgements: some settings are allowed but dangerous. Saving one of them is refused (409) until the request carries
// `acknowledge: [id, ...]`, the administrator having read the warning. The acknowledgement is kept (who, when) for as long as the
// risk stays; once the setting is fixed it is forgotten, so turning the risk back on asks again.
const KEY = 'security';
const SESSION_HOURS = { min: 1, max: 720, default: 8 };
const IDLE_MINUTES = { min: 5, max: 1440 };

const WARNINGS = {
  email_inbound_auth: {
    scope: ['messaging', 'factors'],
    title: 'Email replies are not checked for forgery',
    message: 'Email sign-in is allowed to be approved by replying to a message, but no SPF, DKIM or DMARC check is required on those replies. '
      + 'Anyone who knows or guesses the address can forge the sender of a reply, so a forged "yes" or number could approve a sign-in. '
      + 'Require DMARC (and ideally SPF and DKIM) under Messaging, or accept the risk.',
  },
  yes_no: {
    scope: ['factors'],
    title: 'Unverified yes or no approval is on',
    message: 'The person is asked "are you logging in?" and a plain Y approves it, with nothing on the sign-in page to match. '
      + 'Someone who has stolen a password can send requests until a tired or distracted person says yes (push fatigue). '
      + 'Number matching, or yes or no verified with the number on the sign-in page, is much safer. Accept the risk only if you must keep the unverified way.',
  },
  voice_signature: {
    scope: ['messaging', 'factors'],
    title: 'Voice call answers are not signature-checked',
    message: 'Voice sign-in calls are answered through a web address that only a secret token in its path protects. Twilio signs every request it makes, '
      + 'but the signature is not being verified, so anyone who learns a token (from a log or proxy, for instance) can approve a sign-in. '
      + 'Turn on Twilio signature verification under Messaging, or accept the risk.',
  },
  idle_timeout: {
    scope: ['session'],
    title: 'There is no idle timeout',
    message: 'A session stays open for its full length even if nobody is using it, so a computer left signed in, or a stolen session cookie, '
      + 'keeps working until the session limit. Set an idle timeout, or accept the risk.',
  },
};

const get = () => {
  const saved = appSettings.read(KEY) || {};
  const hours = Number(saved.sessionHours);
  const idle = Number(saved.idleMinutes);
  return {
    sessionHours: Number.isFinite(hours) && hours >= SESSION_HOURS.min && hours <= SESSION_HOURS.max ? hours : SESSION_HOURS.default,
    idleMinutes: Number.isFinite(idle) && idle >= IDLE_MINUTES.min && idle <= IDLE_MINUTES.max ? idle : 0,
    acknowledged: saved.acknowledged && typeof saved.acknowledged === 'object' ? saved.acknowledged : {},
  };
};

const save = (data) => appSettings.write(KEY, data);

/** Validates the session limits an administrator submitted. */
function parseSession(body) {
  const errors = [];
  const hours = Number(body.sessionHours);
  if (!Number.isInteger(hours) || hours < SESSION_HOURS.min || hours > SESSION_HOURS.max) {
    errors.push(`The session length must be a whole number of hours from ${SESSION_HOURS.min} to ${SESSION_HOURS.max}.`);
  }
  const idle = body.idleMinutes === '' || body.idleMinutes === undefined || body.idleMinutes === null ? 0 : Number(body.idleMinutes);
  if (!Number.isInteger(idle) || (idle !== 0 && (idle < IDLE_MINUTES.min || idle > IDLE_MINUTES.max))) {
    errors.push(`The idle timeout must be 0 (off) or a whole number of minutes from ${IDLE_MINUTES.min} to ${IDLE_MINUTES.max}.`);
  }
  if (!errors.length && idle && idle > hours * 60) errors.push('The idle timeout cannot be longer than the session length.');
  return { data: { sessionHours: hours, idleMinutes: idle }, errors };
}

// Which risks the given settings carry. Each argument defaults to what is saved now.
function active({ messaging = messagingSettings.messaging(), factors = factorSettings.get(), security = get() } = {}) {
  const ids = [];
  const email = factors.email;
  if (email.enabled && email.modes.some((m) => m !== 'code') && !['spf', 'dkim', 'dmarc'].some((k) => messaging.email.inboundAuth[k])) ids.push('email_inbound_auth');
  if (['email', 'sms', 'voice'].some((ch) => factors[ch].enabled && factors[ch].modes.includes('yes_no'))) ids.push('yes_no');
  const voice = factors.voice;
  if (voice.enabled && voice.modes.some((m) => m !== 'code') && messaging.voice.provider === 'twilio' && !messaging.voice.twilio.verifySignature) ids.push('voice_signature');
  if (!security.idleMinutes) ids.push('idle_timeout');
  return ids;
}

const describe = (id, acknowledged) => ({ id, title: WARNINGS[id].title, message: WARNINGS[id].message, acknowledged: Boolean(acknowledged[id]) });

/** The risks that apply to one settings page right now, for showing when it opens. */
function status(scope, candidate) {
  const { acknowledged } = get();
  return active(candidate).filter((id) => WARNINGS[id].scope.includes(scope)).map((id) => describe(id, acknowledged));
}

/**
 * Called by a save handler with the settings it is about to store. Returns the warnings that still need acknowledging on this
 * page (empty = go ahead), taking `acknowledge` (ids from the request) and earlier acknowledgements into account.
 */
function unacknowledged(scope, candidate, acknowledge) {
  const sent = new Set(Array.isArray(acknowledge) ? acknowledge.filter((x) => typeof x === 'string') : []);
  const { acknowledged } = get();
  return active(candidate).filter((id) => WARNINGS[id].scope.includes(scope) && !acknowledged[id] && !sent.has(id)).map((id) => describe(id, false));
}

/**
 * After a save: remember who accepted each risk that is still present, and forget the risks that are gone.
 * Returns the ids newly accepted, for the audit log.
 */
function recordAcknowledgements(candidate, acknowledge, actor) {
  const sent = new Set(Array.isArray(acknowledge) ? acknowledge : []);
  const current = get();
  const next = {};
  const added = [];
  for (const id of active(candidate)) {
    if (current.acknowledged[id]) next[id] = current.acknowledged[id];
    else if (sent.has(id)) { next[id] = { by: actor, at: new Date().toISOString() }; added.push(id); }
  }
  save({ ...current, ...(candidate.security || {}), acknowledged: next });
  return added;
}

module.exports = { get, save, parseSession, active, status, unacknowledged, recordAcknowledgements, WARNINGS, SESSION_HOURS, IDLE_MINUTES };
