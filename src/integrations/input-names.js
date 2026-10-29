const { USER_FIELDS } = require('../admin-data');

// The names an integration or function can take as an input: the ones this server supplies (user fields, the parts of an
// Event, a schedule's time) and the ones a user object takes. The console offers them, alphabetically, in the Inputs table;
// a caller can still use any other name. Built here so the reference and the console agree.

const EXTRA = [
  { name: 'active', description: 'Whether the person can sign in. Users created or updated by a script; true by default for new users.' },
  { name: 'at', description: 'Event: the ISO time it happened.' },
  { name: 'attributes', description: 'Name → text value, for the user attributes defined in Settings → User attributes.' },
  { name: 'actor', description: 'Event: who did it, as { type, id, name }.' },
  { name: 'detail', description: 'Event: the audit log detail, e.g. { via }. Secrets are already removed.' },
  { name: 'days', description: 'A number of days, e.g. 90.' },
  { name: 'emails', description: 'Extra email addresses: strings, or { email, primary } objects.' },
  { name: 'event', description: 'Event: the event name, e.g. "user.created".' },
  { name: 'generate_password', description: 'true to have a random password made, returned as generated_password.' },
  { name: 'group', description: 'Group events: the group name.' },
  { name: 'items', description: 'A list of values, or of objects, to work through.' },
  { name: 'key', description: 'The field to compare by, e.g. "email".' },
  { name: 'groups', description: 'Local group names the person belongs to, or is added to.' },
  { name: 'member', description: 'Group events: the username added or removed.' },
  { name: 'mfa_required', description: 'Whether the person must use a second factor.' },
  { name: 'outcome', description: 'Event: "success", or "failure" for a failed sign-in.' },
  { name: 'request', description: 'An HTTP request: { url, method, headers, body }.' },
  { name: 'size', description: 'How many items go in each part.' },
  { name: 'subject', description: 'An email subject line.' },
  { name: 'to', description: 'Who a message goes to: an email address, or a phone number such as +15551234567 for a text.' },
  { name: 'password', description: 'A password to set, checked against the password policy.' },
  { name: 'personal_email', description: 'A recovery address, kept separate from the organizational ones.' },
  { name: 'scheduled_for', description: 'Schedule: the ISO time the run was due.' },
  { name: 'target', description: 'Event: what it was done to, as { type, id, name }, or null.' },
  { name: 'text', description: 'Text to convert, e.g. a title to make into a slug.' },
  { name: 'value', description: 'A value read as yes or no, e.g. "yes", "off" or true.' },
  { name: 'user', description: 'Event: the User affected (for a sign-in, the person who signed in), or null if they no longer exist.' },
];

const fromUserFields = USER_FIELDS.map((name) => ({ name, description: `The user's ${name.replace(/_/g, ' ')}.` }));

/** Every input name the console offers, sorted alphabetically, each with what it holds. */
const catalog = [...fromUserFields, ...EXTRA].sort((a, b) => a.name.localeCompare(b.name));

module.exports = { catalog };
