const db = require('../db');
const { baseUrl } = require('../config');
const appSettings = require('../app-settings');
const messagingSettings = require('../messaging/settings');
const attributeDefs = require('../attribute-defs');
const { USER_FIELDS } = require('../admin-data');

// Variables a script can read. Two kinds:
//   vars.NAME   set by an administrator (endpoints, API keys). A secret's value is never sent back to the console and is
//               blanked from run logs, results and errors.
//   idp.*       pre-made and read-only: facts about this server a script should not hard-code.

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_VALUE = 8000;
const MAX_VARIABLES = 200;
// A value this short would blank out ordinary words in the output, so it is not treated as worth hiding.
const MIN_REDACTED = 4;

const view = (r) => ({ name: r.name, secret: Boolean(r.secret), value: r.secret ? '' : r.value, set: r.value !== '', description: r.description, updated_at: r.updated_at });
const list = () => db.all('SELECT * FROM integration_variables ORDER BY name COLLATE NOCASE').map(view);

/** Every variable with its real value, for handing to a running script. */
const values = () => Object.fromEntries(db.all('SELECT name, value FROM integration_variables').map((r) => [r.name, r.value]));

/** Secret values long enough to be worth blanking from output. */
const secretValues = () => db.all('SELECT value FROM integration_variables WHERE secret = 1').map((r) => r.value).filter((v) => v.length >= MIN_REDACTED);

/**
 * Creates or changes a variable. `secret` cannot be switched off once on (the value would then be shown), and a blank value for
 * an existing secret keeps what is stored, like the other secret settings. Returns { errors } or { variable }.
 */
function save(name, body) {
  const errors = [];
  if (!NAME_RE.test(name)) errors.push('A variable name starts with a letter or underscore and has up to 64 letters, digits or underscores.');
  const existing = db.get('SELECT * FROM integration_variables WHERE name = ?', name);
  const secret = existing && existing.secret ? true : Boolean(body.secret);
  let value = typeof body.value === 'string' ? body.value : '';
  if (value.length > MAX_VALUE) errors.push(`A value can be at most ${MAX_VALUE} characters.`);
  if (existing && existing.secret && value === '') value = existing.value;
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 300) : (existing ? existing.description : '');
  if (!existing && db.get('SELECT COUNT(*) AS n FROM integration_variables').n >= MAX_VARIABLES) errors.push(`At most ${MAX_VARIABLES} variables are allowed.`);
  if (errors.length) return { errors };
  db.run(`INSERT INTO integration_variables (name, value, secret, description, updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(name) DO UPDATE SET value = excluded.value, secret = excluded.secret, description = excluded.description, updated_at = excluded.updated_at`,
  name, value, secret ? 1 : 0, description, new Date().toISOString());
  return { variable: view(db.get('SELECT * FROM integration_variables WHERE name = ?', name)), created: !existing };
}

const remove = (name) => db.run('DELETE FROM integration_variables WHERE name = ?', name).changes > 0;

/** The read-only `idp` object, as it is right now. */
function builtins() {
  const m = messagingSettings.messaging();
  return {
    baseUrl,
    appName: appSettings.productName(),
    userFields: USER_FIELDS.filter((f) => f !== 'username'),
    attributes: attributeDefs.list().map((d) => d.name),
    channels: { email: messagingSettings.configured('email', m), sms: messagingSettings.configured('sms', m), voice: messagingSettings.configured('voice', m) },
  };
}

// Documentation for the console's reference panel, in the order a person would look for it.
const BUILTIN_DOCS = [
  { name: 'idp.baseUrl', description: 'The public URL of this server. Use it to build links people click.', example: '"https://idp.example.net"' },
  { name: 'idp.appName', description: 'The product name from Settings → Branding.', example: '"Example Weaving Guild ID"' },
  { name: 'idp.userFields', description: 'The user fields idp.users.create and update accept besides username.', example: '["first_name", "last_name", "display_name", "email", "employee_id", "department", "title", "phone"]' },
  { name: 'idp.attributes', description: 'Names of the extra user attributes defined in Settings → User attributes. Each one is also listed, with its type and an example, under Attributes.', example: '["badge_expires", "pet"]' },
  { name: 'idp.channels', description: '{ email, sms, voice }: which messaging channels are set up. Check it before sending a message.', example: '{ "email": true, "sms": true, "voice": false }' },
  { name: 'input', description: 'The data the run was started with: typed into Run, the JSON body of a webhook call, { scheduled_for } for a schedule, or an Event. Each row of the Inputs table is also a variable holding one of its values.', example: '{ "employee_id": "10442", "left_on": "2026-10-01" }' },
  { name: 'trigger', description: 'A Trigger: { type, at, event? } describing how the run started. See Objects.', example: '{ "type": "schedule", "at": "2026-10-01T06:00:00.000Z" }' },
  { name: 'integration', description: '{ id, name } of the integration being run.', example: '{ "id": 4, "name": "Nightly HR sync" }' },
  { name: 'vars', description: 'Your variables: vars.NAME, or vars.get("NAME", fallback). A variable marked secret is read the same way, but its value is hidden from logs, output and results.', example: 'vars.HR_API_URL  // "https://hr.example.net/api/v2"' },
  { name: 'fn', description: 'Your functions, from Integrations → Functions: await fn.NAME({ ... }), with one key for each of its inputs. Listed under Your functions.', example: 'await fn.normalizeEmail({ email: " Sam@Example.EDU " })  // "sam@example.net"' },
];

module.exports = { list, values, secretValues, save, remove, builtins, BUILTIN_DOCS, NAME_RE, MAX_VALUE };
