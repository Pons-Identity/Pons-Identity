const appSettings = require('../app-settings');

// The wording of the messages the identity provider sends: sign-in verification codes (MFA) and password resets, each
// for email, SMS and voice. An administrator edits them in the console. A template is plain text with {{variable}}
// placeholders; KINDS below is the single list of which variables exist, where they may be used and what they hold, and
// it is what the console shows next to the editor, so changing it documents the change.
const KEY = 'messageTemplates';
const CHANNELS = ['email', 'sms', 'voice'];
const ALL = CHANNELS;
const LIMITS = { subject: 200, email: 5000, sms: 1000, voice: 1000 };

const COMMON = [
  { name: 'appName', description: 'The application name from Branding.', example: 'Pons Identity', channels: ALL },
  { name: 'username', description: 'The username of the person the message is for.', example: 'srivera', channels: ALL },
  { name: 'displayName', description: 'The person’s display name; their username when they have none.', example: 'Jordan Rivera', channels: ALL },
  { name: 'expiresInMinutes', description: 'How many minutes the code or link stays valid, as a number.', example: '10', channels: ALL },
];
const CODE = [
  { name: 'code', description: 'The one-time code, for example 482913. Email and SMS show it as-is.', example: '482913', channels: ALL },
  { name: 'codeSpoken', description: 'The same code with the digits separated so a voice call reads them one at a time (4, 8, 2, 9, 1, 3). Use this instead of {{code}} in voice messages, which would be read as a single number.', example: '4, 8, 2, 9, 1, 3', channels: ALL },
];

const LINK = { name: 'link', description: 'The address that opens the number-matching page on the device. Single use, for five minutes. Not available in voice messages, which take the answer on the keypad.', example: 'https://idp.example.net/approve/Zk3x9Q', channels: ['email', 'sms'] };

// Each way a sign-in can be confirmed has a phrase its message must contain, so the person knows what to send back. A channel that
// takes a reply needs the word for it; a voice call needs the keypad instruction.
const RESPOND_WITH_CODE = {
  email: { re: /\b(reply|respond|enter)\b[^.]*\bcode\b/i, text: 'tell the person to reply with, or enter, the code shown on their sign-in screen' },
  sms: { re: /\b(reply|respond|enter)\b[^.]*\bcode\b/i, text: 'tell the person to reply with, or enter, the code shown on their sign-in screen' },
  voice: { re: /\b(enter|press)\b[^.]*\bcode\b/i, text: 'tell the person to enter the code shown on their sign-in screen on the keypad' },
};
const YES_NO = {
  email: { re: /\bY\b[\s\S]*\bN\b/, text: 'tell the person to reply Y to approve or N to deny' },
  sms: { re: /\bY\b[\s\S]*\bN\b/, text: 'tell the person to reply Y to approve or N to deny' },
  voice: { re: /press 1[\s\S]*press 2|press 2[\s\S]*press 1/i, text: 'tell the person to press 1 to approve or 2 to deny' },
};
const YES_NO_VERIFIED = {
  email: { re: /\b(reply|respond)\b[^.]*\bcode\b/i, text: 'tell the person to reply with the code shown on their sign-in screen to approve' },
  sms: { re: /\b(reply|respond)\b[^.]*\bcode\b/i, text: 'tell the person to reply with the code shown on their sign-in screen to approve' },
  voice: { re: /\b(enter|press)\b[^.]*\bcode\b/i, text: 'tell the person to enter the code shown on their sign-in screen on the keypad' },
};

const KINDS = {
  mfa: {
    label: 'Sign-in verification code',
    description: 'Sent when a person signs in with a code they type into the sign-in page.',
    variables: [...CODE, ...COMMON],
    // Every channel must deliver the code, or the message is useless.
    required: { email: ['code'], sms: ['code'], voice: ['codeSpoken'] },
  },
  mfaNumberMatch: {
    label: 'Number matching',
    description: 'Sent when the sign-in page shows a number. The person sends that number back from this device: by following the link, '
      + 'pressing it on the keypad, or replying with it. The number itself is not in the message.',
    variables: [LINK, ...COMMON],
    required: { email: ['link'], sms: ['link'], voice: [] },
    phrase: RESPOND_WITH_CODE,
  },
  mfaYesNo: {
    label: 'Yes or no (unverified)',
    description: 'Sent when the person is asked whether they are signing in. They answer Y or N (or 1 or 2 on the keypad). Nothing is shown on the sign-in page, so it is weaker than number matching.',
    variables: [...COMMON],
    required: { email: [], sms: [], voice: [] },
    phrase: YES_NO,
  },
  mfaYesNoVerified: {
    label: 'Yes or no (verified)',
    description: 'Sent when the person is asked whether they are signing in, and a yes must be answered with the number shown on the sign-in page.',
    variables: [...COMMON],
    required: { email: [], sms: [], voice: [] },
    phrase: YES_NO_VERIFIED,
  },
  passwordReset: {
    label: 'Password reset',
    description: 'Sent when a person asks to reset a forgotten password.',
    variables: [
      { name: 'link', description: 'The address where the person chooses a new password. Single use. Not available in voice messages, which cannot carry a link.', example: 'https://idp.example.net/reset/Zk3x9Q', channels: ['email', 'sms'] },
      ...CODE,
      ...COMMON,
    ],
    // Email and SMS need the link or the code; a phone call can only give the code.
    required: { email: ['link', 'code'], sms: ['link', 'code'], voice: ['codeSpoken'] },
  },
  attestationReminder: {
    label: 'Attestation reminder',
    description: 'Sent each week to a group manager while a group they manage is due for attestation, until it is attested. The list of groups is filled in automatically. Email only.',
    channels: ['email'],
    variables: [
      { name: 'groups', description: 'The groups due for attestation, one per line: the group name, its due date and the address of its page. Each group is listed once.', example: '- Payroll (due 2026-10-01): https://idp.example.net/groups/4', channels: ['email'], multiline: true },
      ...COMMON.filter((v) => v.name !== 'expiresInMinutes'),
    ],
    required: { email: [] },
  },
};

const CHANNEL_LABELS = { email: 'Email', sms: 'SMS', voice: 'Voice call' };

const DEFAULTS = {
  mfa: {
    email: {
      subject: '{{appName}} verification code: {{code}}',
      body: 'Hello {{displayName}},\n\nYour {{appName}} verification code is {{code}}.\n\nIt expires in {{expiresInMinutes}} minutes. If you did not try to sign in, ignore this message and consider changing your password.',
    },
    sms: { body: '{{appName}}: your verification code is {{code}}. It expires in {{expiresInMinutes}} minutes. Do not share it.' },
    voice: { body: 'Hello. This is {{appName}}. Your verification code is {{codeSpoken}}. Again, your verification code is {{codeSpoken}}. The code expires in {{expiresInMinutes}} minutes.' },
  },
  mfaNumberMatch: {
    email: {
      subject: 'Confirm your {{appName}} sign-in for {{username}}',
      body: 'Hello {{displayName}},\n\nSomeone is signing in to {{appName}} as {{username}}. If this was you, open {{link}} within {{expiresInMinutes}} minutes and enter the code shown on your sign-in screen, or reply to this message with that code.\n\nIf this was not you, ignore this message and do not share the code.',
    },
    sms: { body: '{{appName}}: someone is signing in as {{username}}. If it was you, open {{link}} and enter the code on your sign-in screen, or reply with that code. Expires in {{expiresInMinutes}} minutes.' },
    voice: { body: 'Hello. This is {{appName}}. Someone is signing in as {{username}}. When asked, enter the code shown on your sign in screen on your keypad, then press the pound key. The request expires in {{expiresInMinutes}} minutes.' },
  },
  mfaYesNo: {
    email: {
      subject: 'Are you signing in to {{appName}}?',
      body: 'Hello {{displayName}},\n\nAre you signing in to {{appName}} as {{username}}? Reply Y to approve the sign-in, or N to deny it. The request expires in {{expiresInMinutes}} minutes.\n\nIf you did not try to sign in, reply N and change your password.',
    },
    sms: { body: '{{appName}}: are you signing in as {{username}}? Reply Y to approve or N to deny. Expires in {{expiresInMinutes}} minutes.' },
    voice: { body: 'Hello. This is {{appName}}. Are you signing in as {{username}}? Press 1 or say yes to approve. Press 2 or say no to deny.' },
  },
  mfaYesNoVerified: {
    email: {
      subject: 'Are you signing in to {{appName}}?',
      body: 'Hello {{displayName}},\n\nAre you signing in to {{appName}} as {{username}}? To approve, reply with the code shown on your sign-in screen. If this was not you, reply N.\n\nThe request expires in {{expiresInMinutes}} minutes.',
    },
    sms: { body: '{{appName}}: are you signing in as {{username}}? Reply with the code on your sign-in screen to approve, or N to deny. Expires in {{expiresInMinutes}} minutes.' },
    voice: { body: 'Hello. This is {{appName}}. Are you signing in as {{username}}? When asked, enter the code shown on your sign in screen on your keypad, then press the pound key. The request expires in {{expiresInMinutes}} minutes.' },
  },
  passwordReset: {
    email: {
      subject: 'Reset your {{appName}} password',
      body: 'Hello {{displayName}},\n\nSomeone asked to reset the password for {{username}}. To choose a new password, open this link within {{expiresInMinutes}} minutes:\n\n{{link}}\n\nIf you did not ask for this, ignore this message and your password will stay the same.',
    },
    sms: { body: '{{appName}}: reset your password at {{link}} (valid for {{expiresInMinutes}} minutes). Ignore this if you did not ask.' },
    voice: { body: 'Hello. This is {{appName}}. Your password reset code is {{codeSpoken}}. Again, your password reset code is {{codeSpoken}}. The code expires in {{expiresInMinutes}} minutes.' },
  },
  attestationReminder: {
    email: {
      subject: '{{appName}}: group attestation required',
      body: 'Hello {{displayName}},\n\nA group which you are a manager for requires your review for verification (attestation). Please complete attestation for the following groups by reviewing the current roster and confirming that each member is still active, that their access is accurate and appropriate, and that any required training or acknowledgements are current.\n\n{{groups}}\n\n'
        + 'To attest a group, open its link above and select Attest membership on the Managers & attestation tab. You can also attest by signing in to {{appName}}, opening My groups, choosing the group, then going to the Managers & attestation tab and selecting Attest membership.\n\n'
        + 'You will get this reminder once a week until every group is attested.',
    },
  },
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const SPACED_RE = /^\s*(\w+)\s*$/;

/** The templates in effect: what an administrator saved, with the built-in wording for anything not saved. */
function templates() {
  const saved = appSettings.read(KEY) || {};
  const out = clone(DEFAULTS);
  for (const kind of Object.keys(out)) {
    for (const ch of Object.keys(out[kind])) {
      for (const field of Object.keys(out[kind][ch])) {
        const v = saved[kind]?.[ch]?.[field];
        if (typeof v === 'string' && v.trim()) out[kind][ch][field] = v;
      }
    }
  }
  return out;
}

// The channels a kind has wording for. Most have all three; a kind may list fewer (attestation reminders are email only).
const kindChannels = (kind) => KINDS[kind].channels || CHANNELS;
const names = (kind, channel) => KINDS[kind].variables.filter((v) => v.channels.includes(channel)).map((v) => v.name);
const used = (text) => [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);

/** Problems with one template; an empty list means it can be saved. `where` names it for the administrator. */
function check(kind, channel, tpl) {
  const where = `${KINDS[kind].label}, ${CHANNEL_LABELS[channel].toLowerCase()}`;
  const errors = [];
  const fields = channel === 'email' ? ['subject', 'body'] : ['body'];
  const allowed = names(kind, channel);
  const seen = new Set();
  for (const field of fields) {
    const label = field === 'subject' ? 'subject' : 'message';
    const text = tpl[field];
    if (typeof text !== 'string' || !text.trim()) { errors.push(`${where}: the ${label} cannot be empty.`); continue; }
    const max = field === 'subject' ? LIMITS.subject : LIMITS[channel];
    if (text.length > max) errors.push(`${where}: the ${label} is ${text.length} characters; the limit is ${max}.`);
    for (const raw of used(text)) {
      const m = SPACED_RE.exec(raw);
      if (!m) { errors.push(`${where}: "{{${raw}}}" is not a valid placeholder. Use a name such as {{${allowed[0]}}}.`); continue; }
      seen.add(m[1]);
      if (!allowed.includes(m[1])) {
        const known = KINDS[kind].variables.some((v) => v.name === m[1]);
        errors.push(known
          ? `${where}: {{${m[1]}}} cannot be used in this message. Available here: ${allowed.map((n) => `{{${n}}}`).join(', ')}.`
          : `${where}: {{${m[1]}}} is not a known variable. Available here: ${allowed.map((n) => `{{${n}}}`).join(', ')}.`);
      }
    }
  }
  const need = KINDS[kind].required[channel];
  // A text channel needs any one of the listed variables; a voice call needs the spoken form of the code. A kind that needs
  // nothing from the list (the yes or no messages) needs no variable at all.
  const ok = need.length === 0 || (channel === 'voice' && kind === 'mfa' ? seen.has('codeSpoken') : need.some((n) => seen.has(n)));
  if (!ok) {
    errors.push(channel === 'voice' && kind === 'mfa'
      ? `${where}: the message must include {{codeSpoken}} so the code is read out.`
      : `${where}: the message must include ${need.map((n) => `{{${n}}}`).join(' or ')}, or the person cannot complete the step.`);
  }
  const phrase = KINDS[kind].phrase && KINDS[kind].phrase[channel];
  if (phrase && !phrase.re.test(Object.values(tpl).join('\n'))) {
    errors.push(`${where}: ${phrase.text}, for example "Reply with the code shown on your sign-in screen."`);
  }
  return errors;
}

/** Validates submitted templates. Anything not submitted keeps its current wording. */
function parse(body = {}, current = templates()) {
  const errors = [];
  const out = clone(current);
  for (const kind of Object.keys(KINDS)) {
    for (const ch of Object.keys(DEFAULTS[kind])) {
      const src = body?.[kind]?.[ch];
      if (src === undefined) continue;
      const tpl = {};
      for (const field of Object.keys(DEFAULTS[kind][ch])) {
        tpl[field] = typeof src?.[field] === 'string' ? src[field].replace(/\r\n?/g, '\n').trim() : '';
      }
      errors.push(...check(kind, ch, tpl));
      out[kind][ch] = tpl;
    }
  }
  return { data: out, errors };
}

const save = (data) => appSettings.write(KEY, data);

// Values go into a template on one line: a stray line break in a name could otherwise split a subject into headers.
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
const spoken = (code) => String(code).split('').join(', ');

/**
 * Fills in a template. `vars` needs `code` and/or `link` plus username; appName, displayName, codeSpoken and
 * expiresInMinutes are derived when absent. Returns { subject, text } as messaging.send expects.
 */
function render(kind, channel, vars, config = templates()) {
  if (!KINDS[kind] || !kindChannels(kind).includes(channel)) throw new Error('Unknown message template.');
  const v = {
    appName: appSettings.productName(),
    expiresInMinutes: 10,
    ...vars,
  };
  if (!v.displayName) v.displayName = v.username;
  if (v.code !== undefined && v.codeSpoken === undefined) v.codeSpoken = spoken(v.code);
  const allowed = names(kind, channel);
  // A multiline variable (such as a list of groups) keeps its line breaks in the body. Everywhere else, and always in the subject, a value stays on one line.
  const multiline = new Set(KINDS[kind].variables.filter((x) => x.multiline).map((x) => x.name));
  const fill = (tpl, field) => tpl.replace(PLACEHOLDER_RE, (_, raw) => {
    const m = SPACED_RE.exec(raw);
    if (!m || !allowed.includes(m[1]) || v[m[1]] === undefined) return '';
    return field === 'body' && multiline.has(m[1]) ? String(v[m[1]]).replace(/\r/g, '') : oneLine(v[m[1]]);
  });
  const t = config[kind][channel];
  return { subject: t.subject === undefined ? undefined : fill(t.subject, 'subject'), text: fill(t.body, 'body') };
}

/** The variable values shown in the console's preview. */
const samples = () => ({
  ...Object.fromEntries(Object.values(KINDS).flatMap((k) => k.variables).map((v) => [v.name, v.example])),
  appName: appSettings.productName(),
});

/** Renders a draft with the sample values so an administrator can see the result before saving. */
function preview(kind, channel, draft) {
  const errors = KINDS[kind] && kindChannels(kind).includes(channel) ? check(kind, channel, draft) : ['Unknown message template.'];
  if (errors.length) return { errors };
  const out = render(kind, channel, samples(), { [kind]: { [channel]: draft } });
  return { subject: out.subject, text: out.text, length: out.text.length };
}

// What the console needs to build the editor and the variable reference.
function view(current = templates()) {
  return {
    templates: current,
    defaults: clone(DEFAULTS),
    limits: LIMITS,
    kinds: Object.entries(KINDS).map(([key, k]) => ({
      key, label: k.label, description: k.description, variables: k.variables,
      channels: kindChannels(key).map((ch) => ({ key: ch, label: CHANNEL_LABELS[ch], hasSubject: ch === 'email', variables: names(key, ch) })),
    })),
  };
}

module.exports = { templates, parse, save, render, preview, view, check, KINDS, CHANNELS, DEFAULTS, LIMITS };
