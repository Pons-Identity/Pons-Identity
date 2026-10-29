const attributeDefs = require('../attribute-defs');
const { USER_FIELDS } = require('../admin-data');
const host = require('./host');
const events = require('./events');
const variables = require('./variables');
const schedules = require('./schedule');
const engine = require('./engine');
const userFunctions = require('./functions');
const inputNames = require('./input-names');
const { RUNS_KEPT } = require('./index');

// Plausible values for common input names, so the example for a function reads like real data.
const SAMPLE = {
  email: '"sam@example.net"', first_name: '"Sam"', last_name: '"Rivera"', display_name: '"Sam Rivera"', name: '"Sam Rivera"',
  username: '"srivera"', user: '"srivera"', phone: '"(555) 123-4567"', text: '"Hello Sam"', value: '"yes"', days: '90', size: '20',
  items: '[{ username: "srivera" }, { username: "jdoe" }]', key: '"email"', groups: '["Staff"]', request: '{ url: "https://api.example.net/v1/people" }',
  employee_id: '"10442"', department: '"Sailing"', title: '"Foreman"', generate_password: 'true',
};
const sampleValue = (name) => SAMPLE[name] || '"…"';

// The object of sample values for a function's inputs, in the same form callKeys uses.
const sampleKeys = (inputs) => (inputs.length ? `{ ${inputs.map((i) => `${/^[A-Za-z_$][\w$]*$/.test(i.name) ? i.name : JSON.stringify(i.name)}: ${sampleValue(i.name)}`).join(', ')} }` : '');

// The object a caller passes a function: one key per input, quoted where the name is not a plain identifier.
const callKeys = (inputs) => (inputs.length ? `{ ${inputs.map((i) => `${/^[A-Za-z_$][\w$]*$/.test(i.name) ? i.name : JSON.stringify(i.name)}: value`).join(', ')} }` : '');

// What the console's Reference tab shows. Built here, not typed into the page, so the field lists, limits and defined
// attributes are the ones this server really has.

const FIELD_NOTES = {
  username: 'Sign-in name. Unique, ignoring case.',
  first_name: '', last_name: '',
  display_name: 'Defaults to first_name and last_name joined by a space.',
  email: 'The primary address. Unique across all users. See emails for more than one.',
  employee_id: 'ID from an HR or payroll system.',
  department: '', title: '', phone: '',
  upn: 'User principal name, for Active Directory style systems.',
  sam_account_name: 'Pre-Windows 2000 sign-in name.',
  distinguished_name: 'LDAP distinguished name.',
  mail_nickname: '', company: '',
  manager: 'The manager, as free text (a name, username or DN).',
  office: '', mobile: '', street_address: '', city: '', state: '', postal_code: '', country: '', description: '',
};

const stringFields = () => USER_FIELDS.map((name) => ({ name, type: 'string', description: FIELD_NOTES[name] || '', ...(name === 'username' ? { required: true } : {}) }));

const attributeNote = () => {
  const defs = attributeDefs.list();
  const defined = defs.length
    ? ` Defined here: ${defs.map((d) => `${d.name} (${d.type}${d.options.length ? `: ${d.options.join(' | ')}` : ''}${d.required ? ', required' : ''})`).join('; ')}.`
    : ' None are defined yet (Settings → User attributes).';
  return `Name → text value. A name that is defined is checked against its type and may be required; any other name (letters, digits, . _ -) is stored as free text.${defined}`;
};

// An example value for a defined attribute, shaped by its type. A default value, if it has one, is the best example.
function attributeExample(def) {
  if (def.default_value) return def.default_value;
  if (def.type === 'enum') return def.options[0];
  if (def.type === 'number') return '42';
  if (def.type === 'bool') return 'true';
  if (def.type === 'date') return '2027-06-30';
  return 'Example text';
}

const attributeExamples = () => attributeDefs.list().map((d) => ({
  name: d.name, label: d.label, type: d.type, required: d.required,
  options: d.options, example: attributeExample(d),
}));

// The example attributes object shows the defined attributes; with none defined, a free-form pair stands in.
const attributesExample = () => {
  const defined = attributeExamples().slice(0, 3);
  return defined.length ? Object.fromEntries(defined.map((a) => [a.name, a.example])) : { pet: 'owl' };
};

function types() {
  return [
    {
      name: 'User', description: 'A local account, as returned by idp.users.find, search, create and update.',
      fields: [
        { name: 'id', type: 'string', description: 'The GUID. Use it to refer to the user from other systems; it never changes.' },
        ...stringFields(),
        { name: 'emails', type: '{ email, primary }[]', description: 'Every organizational address. Exactly one is primary and is also in `email`.' },
        { name: 'personal_email', type: 'string | null', description: 'Recovery address. Never one of the organizational addresses.' },
        { name: 'active', type: 'boolean', description: 'false means the person cannot sign in.' },
        { name: 'mfa_required', type: 'boolean', description: 'Whether this person must use a second factor.' },
        { name: 'attributes', type: 'object', description: attributeNote() },
        { name: 'groups', type: 'string[]', description: 'Names of the groups the person was directly added to.' },
        { name: 'password_changed_at', type: 'string | null', description: 'ISO time of the last password change.' },
        { name: 'password_changed_via', type: 'string | null', description: '"self", "admin", "recovery", "api" or "bulk". Scripts set passwords as "api".' },
        { name: 'created_at', type: 'string', description: 'ISO time.' },
        { name: 'generated_password', type: 'string', description: 'Only on the result of idp.users.create with generate_password: true. It is shown once and not kept anywhere.' },
      ],
      example: { id: '3f2b6c1e-9d1a-4c61-8f0e-2a6d5b7c9e10', username: 'srivera', first_name: 'Sam', last_name: 'Rivera', display_name: 'Sam Rivera', email: 'sam@example.net', employee_id: '10442', department: 'Sailing', '…': 'the other text fields, empty if unset', emails: [{ email: 'sam@example.net', primary: true }], personal_email: null, active: true, mfa_required: false, attributes: attributesExample(), groups: ['Staff'], password_changed_at: '2026-10-01T10:00:00.000Z', password_changed_via: 'api', created_at: '2026-10-01T10:00:00.000Z' },
    },
    {
      name: 'DirectoryUser', description: 'A person in an external directory, as returned by dir.find, search, create and update.',
      fields: [
        { name: 'dn', type: 'string', description: 'The entry\'s distinguished name.' },
        { name: 'username, first_name, last_name, email, …', type: 'string', description: 'The profile fields the directory maps to LDAP attributes (External systems → Directories → Attribute mapping). Fields with no value are left out.' },
        { name: 'groups', type: 'string[]', description: 'Names from the directory\'s group membership attribute (for example memberOf).' },
        { name: 'active', type: 'boolean', description: 'Active Directory only: false when the account is disabled.' },
        { name: 'attributes', type: 'object', description: 'Only when attributes were asked for: each name with its list of values.' },
        { name: 'created, changed', type: 'boolean | string[]', description: 'created: true on the result of create; changed on the result of update.' },
      ],
      example: { dn: 'CN=Bea Wilson,OU=Staff,DC=example,DC=net', username: 'bwilson', first_name: 'Bea', last_name: 'Wilson', email: 'bea@example.net', department: 'Hull', groups: ['Welders'], active: true },
    },
    {
      name: 'NewUser', description: 'What idp.users.create accepts. Any field not listed here is refused, so a typo fails instead of being ignored.',
      fields: [
        ...stringFields(),
        { name: 'password', type: 'string', description: 'At least 8 characters. Required unless generate_password is true.' },
        { name: 'generate_password', type: 'boolean', description: 'Make a random password and return it as generated_password.' },
        { name: 'emails', type: '(string | { email, primary })[]', description: 'More addresses. Each must be valid and unused. If none is marked primary, `email` or the first one is.' },
        { name: 'personal_email', type: 'string', description: 'Recovery address, treated as verified. Must differ from the organizational ones.' },
        { name: 'groups', type: 'string[]', description: 'Names of local groups to join. A group that does not exist, or is managed by Grouper or a directory, is an error.' },
        { name: 'active', type: 'boolean', description: 'Default true.' },
        { name: 'mfa_required', type: 'boolean', description: 'Default false.' },
        { name: 'attributes', type: 'object', description: attributeNote() },
      ],
      example: { username: 'srivera', first_name: 'Sam', last_name: 'Rivera', email: 'sam@example.net', groups: ['Staff'], attributes: { pet: 'owl' }, generate_password: true },
    },
    {
      name: 'UserPatch', description: 'What idp.users.update accepts: only the fields you include are changed.',
      fields: [
        ...stringFields().map((f) => ({ ...f, required: false })),
        { name: 'password', type: 'string', description: 'Checked against the password policy for this person. Setting it signs them out everywhere.' },
        { name: 'emails', type: '(string | { email, primary })[]', description: 'Replaces the whole list. Setting `email` alone changes the primary and keeps the others.' },
        { name: 'personal_email', type: 'string', description: 'Use "" to clear it.' },
        { name: 'active', type: 'boolean', description: 'false also signs the person out everywhere.' },
        { name: 'mfa_required', type: 'boolean', description: '' },
        { name: 'attributes', type: 'object', description: `${attributeNote()} Use "" or null to remove a value. Groups are not changed here: use idp.groups.addMember and removeMember.` },
      ],
      example: { title: 'Master Weaver', active: true, attributes: { pet: '' } },
    },
    {
      name: 'Group', description: 'From idp.groups.list.',
      fields: [
        { name: 'id', type: 'number', description: 'The group\'s ID number, shown on the group\'s page and in the Groups list. It never changes, even if the group is renamed. Anywhere a script takes a group, you can pass this number instead of the name.' },
        { name: 'name', type: 'string', description: 'Unique, ignoring case.' },
        { name: 'description', type: 'string', description: '' },
        { name: 'source', type: 'string', description: '"local", "grouper" or "directory". Only local groups can be changed by a script.' },
      ],
      example: { id: 4, name: 'Staff', description: 'All staff', source: 'local' },
    },
    {
      name: 'GroupMember', description: 'From idp.groups.members, which includes people who belong through a nested group.',
      fields: [{ name: 'id', type: 'string', description: 'The user\'s GUID.' }, { name: 'username', type: 'string', description: '' }],
      example: { id: '3f2b6c1e-9d1a-4c61-8f0e-2a6d5b7c9e10', username: 'srivera' },
    },
    {
      name: 'HttpRequest', description: 'The object http.request takes. http.get and http.post fill in method and url for you.',
      fields: [
        { name: 'url', type: 'string', required: true, description: 'http or https, to a public address. Private, loopback and link-local addresses are refused.' },
        { name: 'method', type: 'string', description: 'GET (default), POST, PUT, PATCH, DELETE or HEAD.' },
        { name: 'headers', type: 'object', description: 'Header name → value, e.g. { Authorization: "Bearer " + vars.CRM_KEY }.' },
        { name: 'body', type: 'string | object', description: 'An object is sent as JSON (Content-Type is set unless you set it); a string is sent as it is. Ignored for GET and HEAD.' },
        { name: 'timeoutMs', type: 'number', description: 'Default 10000, at most 30000.' },
      ],
      example: { url: 'https://api.example.com/v1/people', method: 'POST', headers: { Authorization: 'Bearer …' }, body: { name: 'Sam' } },
    },
    {
      name: 'HttpResponse', description: 'What every http call returns. An HTTP error status does not throw: check ok or status.',
      fields: [
        { name: 'status', type: 'number', description: 'The HTTP status. Redirects are not followed, so a 301 is returned as it is.' },
        { name: 'ok', type: 'boolean', description: 'true for 200–299.' },
        { name: 'text', type: 'string', description: 'The body, up to 1 MB.' },
        { name: 'json', type: 'any', description: 'The body parsed as JSON, or undefined if it is not JSON.' },
      ],
      example: { status: 200, ok: true, text: '{"id":7}', json: { id: 7 } },
    },
    {
      name: 'Message', description: 'What mail.send and sms.send take.',
      fields: [
        { name: 'to', type: 'string', required: true, description: 'An email address, or for sms a number like +15551234567.' },
        { name: 'subject', type: 'string', description: 'Email only. Default "Message".' },
        { name: 'text', type: 'string', required: true, description: 'The message body.' },
      ],
      example: { to: 'sam@example.net', subject: 'Welcome', text: 'Your account is ready.' },
    },
    {
      name: 'Trigger', description: 'The global `trigger`: how this run started.',
      fields: [
        { name: 'type', type: 'string', description: '"manual", "webhook", "schedule", "event" or "test" (run from the console while turned off).' },
        { name: 'at', type: 'string', description: 'ISO time the run started.' },
        { name: 'event', type: 'string', description: 'Only when type is "event": the event name, e.g. "user.created".' },
      ],
      example: { type: 'event', at: '2026-10-01T10:00:00.000Z', event: 'user.created' },
    },
    {
      name: 'Event', description: 'The `input` of a run started by an event. Which of user, group and member are present depends on the event: see Events.',
      fields: [
        { name: 'event', type: 'string', description: 'The event name.' },
        { name: 'at', type: 'string', description: 'ISO time it happened.' },
        { name: 'outcome', type: 'string', description: '"success", or "failure" for login.failed.' },
        { name: 'actor', type: '{ type, id, name }', description: 'Who did it. type is "user", "system", "anonymous" or "integration". Events caused by an integration are never delivered.' },
        { name: 'target', type: '{ type, id, name } | null', description: 'What it was done to, as recorded in the audit log.' },
        { name: 'detail', type: 'object', description: 'The audit log detail: e.g. { via } for user changes, { reason } for failed sign-ins. Secrets are already removed.' },
        { name: 'user', type: 'User | null', description: 'Present for user events and login.succeeded. Read when the run starts; null if the user is gone.' },
        { name: 'group', type: 'string', description: 'Group events: the group name.' },
        { name: 'member', type: 'string', description: 'Group events: the username added or removed.' },
      ],
      example: { event: 'user.created', at: '2026-10-01T10:00:00.000Z', outcome: 'success', actor: { type: 'user', id: 1, name: 'admin' }, target: { type: 'user', id: '12', name: 'srivera' }, detail: { via: 'console' }, user: '(a User)' },
    },
    {
      name: 'WebhookResponse', description: 'What a webhook call gets back (HTTP 200 on success, 422 on a script error, 504 on a timeout).',
      fields: [
        { name: 'status', type: 'string', description: '"ok", "error" or "timeout".' },
        { name: 'result', type: 'any', description: 'What the script returned, or null.' },
        { name: 'logs', type: '{ level, text, color, time }[]', description: 'level is "debug", "normal", "warning" or "error"; color is a name or a hex value.' },
        { name: 'output', type: '{ text, color, time }[]', description: 'What the script printed with output().' },
        { name: 'error', type: '{ message, line } | null', description: 'line is the line of the script, when known.' },
      ],
      example: { status: 'ok', result: { created: 'srivera' }, logs: [{ level: 'normal', text: 'created srivera', color: 'default', time: '2026-10-01T10:00:01.000Z' }], output: [{ text: 'done', color: 'green', time: '2026-10-01T10:00:01.000Z' }], error: null },
    },
  ];
}

const fn = (signature, description, returns, extra = {}) => ({ signature, description, returns, ...extra });

function functions() {
  return [
    { group: 'Users', scope: 'users:read', items: [
      fn('await idp.users.find({ id | username | email | employee_id })', 'Looks one user up. email also matches additional addresses. Usernames are matched ignoring case.', 'User, or null if there is none.',
        { throws: 'If none of the four keys is given.', example: 'const u = await idp.users.find({ employee_id: input.employee_id });\nif (!u) log("not found");' }),
      fn('await idp.users.search(text | { q, limit })', 'Users whose username, display name or email contains the text. With no text, the first users by username.', 'User[] (at most `limit`, default 50, maximum 200).',
        { example: 'const hits = await idp.users.search({ q: "rivera", limit: 20 });\nreturn hits.map((u) => `${u.username} ${u.email}`);' }),
      fn('await idp.users.suggestUsername(first, last)', 'First initial plus last name, lower case, accents and punctuation removed; a number is added until it is free ("srivera", "srivera2").', 'string. Nothing is reserved, so create the user promptly.',
        { example: 'const username = await idp.users.suggestUsername("Sam", "Rivera");  // "srivera"\nawait idp.users.create({ username, first_name: "Sam", last_name: "Rivera", email: "sam@example.net", generate_password: true });' }),
    ] },
    { group: 'Users', scope: 'users:write', items: [
      fn('await idp.users.create(NewUser)', 'Creates a local account, applying the same rules as the user API and bulk import.', 'User (with generated_password if you asked for one).',
        { throws: 'With every problem in the message, e.g. "That username already exists." or "Unknown field: roles." Nothing is created if anything is wrong.',
          example: 'const u = await idp.users.create({\n  username: "srivera", first_name: "Sam", last_name: "Rivera",\n  email: "sam@example.net", groups: ["Staff"], generate_password: true,\n});\nreturn u.generated_password;' }),
      fn('await idp.users.update(user, UserPatch)', 'Changes the fields you give. `user` is a GUID or a username.', 'User, after the change.',
        { throws: 'If the user does not exist, is an administrator, belongs to an external directory, or a value is invalid.', example: 'await idp.users.update("srivera", { active: false });' }),
      fn('await idp.users.delete(user)', 'Deletes the account and signs it out. This cannot be undone. To keep the record and stop sign-in, use update with active: false instead.', 'true.',
        { throws: 'Same as update.', example: 'await idp.users.delete("srivera");  // permanent: the account, its groups and its history are removed' }),
      fn('await idp.users.endSessions(user)', 'Signs the person out of every browser and ends their OAuth and OpenID Connect access and refresh tokens. `update` with a password already signs out browsers; this also ends the tokens.', '{ browsers: true, tokens } (tokens is the number ended).', { throws: 'Same as update.', example: 'await idp.users.endSessions("srivera");' }),
      fn('await idp.users.resetAuthenticators(user)', 'Removes the authenticator and every other sign-in method, and requires the person to set one up at their next sign-in. Used by the lockdown.', '{ removed } (the number of methods removed).', { throws: 'Same as update.', example: 'await idp.users.resetAuthenticators("srivera");' }),
      fn('await idp.users.forgetRemembered(user)', 'Makes every browser the person has remembered ask for a second factor again.', '{ browsers } (the number of browsers forgotten).',
        { throws: 'Same as update.', example: 'const { browsers } = await idp.users.forgetRemembered("srivera");\nlog("asked again on", browsers, "browsers");' }),
    ] },
    { group: 'Compromised accounts', scope: 'users:read', items: [
      fn('await idp.compromise.plan(user)', 'The lockdown steps that apply to a person, from the Compromised account policies: which steps are on, the network lists sign-in must match, and the policies they came from.', '{ end_sessions, reset_password, rotate_mfa, forget_remembered, lock_account, add_to_group, notify_user: boolean, groups: string[], networks: string[][], sources: string[] }.', { throws: 'If the user does not exist.', example: 'const plan = await idp.compromise.plan("srivera");' }),
    ] },
    { group: 'Compromised accounts', scope: 'users:write', items: [
      fn('await idp.compromise.restrict(user, { networks, lock })', 'Records the account as in lockdown. Sign-in is then refused from outside every list in `networks` (each list is addresses or networks such as "10.0.0.0/8"; an empty list allows nothing extra). With `lock: true` the account is turned off, unless it already was. Signs the person out. An administrator ends the lockdown from the console or with DELETE /api/v1/users/{id}/lockdown.', 'The lockdown: { started_at, started_by, policy_names, networks, locked_account }.',
        { throws: 'If networks is not a list of lists of valid addresses, or the user is an administrator or a directory user.', example: 'await idp.compromise.restrict("srivera", { networks: [["10.0.0.0/8", "192.0.2.0/24"]], lock: true });' }),
    ] },
    { group: 'Identity verification', scope: 'identity', items: [
      fn('await idp.identity.start(user, purpose?)', 'Opens an identity verification for a person with the provider set under Settings → Identity verification (Persona or the REST service), and records it. purpose is "password_reset" (the default) or "mfa_reset". The person is sent the link in `url` to complete it. Nothing is reset by this call: the reset checks the result itself.', 'The verification: { id, purpose, provider, status, url, ref, created_at }.',
        { throws: 'If no provider is set up, or the provider cannot be reached.', example: 'const v = await idp.identity.start("srivera", "password_reset");\nlog("send them to", v.url);\nreturn { id: v.id, status: v.status };' }),
      fn('await idp.identity.status(id)', 'Asks the provider for the latest status of a verification and records it. A verification is approved only by the provider.', 'The verification, with its status: pending, approved, declined, expired or error.',
        { throws: 'If the verification does not exist or the provider cannot be reached.', example: 'const v = await idp.identity.status(12);\nif (v.status === "approved") log("passed");' }),
      fn('await idp.identity.latest(user, purpose?)', 'The newest verification for this person and purpose from the last day, checked again with the provider if it is still pending. Null if there is none.', 'The verification, or null.',
        { throws: 'If the user does not exist.', example: 'const v = await idp.identity.latest("srivera", "mfa_reset");\nreturn v ? v.status : "none";' }),
    ] },
    { group: 'Groups', scope: 'groups:read', items: [
      fn('await idp.groups.list()', 'Every group.', 'Group[].',
        { example: 'const local = (await idp.groups.list()).filter((g) => g.source === "local").map((g) => g.name);\nreturn local;  // ["Staff", "Weavers", "Helpdesk"]' }),
      fn('await idp.groups.members(group)', 'The people in a group, including those who belong through nested groups.', 'GroupMember[].',
        { throws: 'If the group does not exist.', example: 'const members = await idp.groups.members("Staff");\nreturn members.map((m) => m.username);  // ["srivera", "jdoe", ...]' }),
    ] },
    { group: 'Groups', scope: 'groups:write', items: [
      fn('await idp.groups.addMember(group, user)', '`group` is the group\'s name or its ID number. Adds a person to a local group, with no end date. A lapsed membership is renewed.', 'true if anything changed, false if they were already a member.',
        { throws: 'If the group or user does not exist, or the group is not local (Grouper and directory groups are read-only here).', example: 'await idp.groups.addMember("Staff", user.username);\nawait idp.groups.addMember(4, user.username);  // the same group, by ID number' }),
      fn('await idp.groups.removeMember(group, user)', 'Removes a direct membership.', 'true if they were a direct member.',
        { throws: 'Same as addMember.', example: 'if (await idp.groups.removeMember("Interns", user.username)) log("removed from Interns");' }),
    ] },
    { group: 'Outside services', scope: 'http', items: [
      fn('await http.get(url, { headers })', 'GET a URL.', 'HttpResponse.', { throws: 'If the address is not public, the host cannot be reached or the request times out. An error status does not throw.', example: 'const r = await http.get("https://api.example.com/people", { headers: { Authorization: "Bearer " + vars.API_KEY } });\nif (!r.ok) throw new Error("API said " + r.status);\nreturn r.json;' }),
      fn('await http.post(url, body, { headers })', 'POST. An object body is sent as JSON.', 'HttpResponse.',
        { example: 'const r = await http.post("https://chat.example.net/hooks/new-hires", { text: `New account: ${user.display_name}` });\nif (!r.ok) log.warning("chat said", r.status);' }),
      fn('http.put(url, body, opts), http.patch(url, body, opts), http.delete(url, opts)', 'The other methods, the same way.', 'HttpResponse.',
        { example: 'await http.put(`https://api.example.net/v1/people/${user.employee_id}`, { active: user.active }, { headers: { Authorization: "Bearer " + vars.HR_TOKEN } });\nawait http.delete(`https://api.example.net/v1/people/${user.employee_id}/badge`, { headers: { Authorization: "Bearer " + vars.HR_TOKEN } });' }),
      fn('await http.request(HttpRequest)', 'Any method, with a timeout.', 'HttpResponse.',
        { example: 'const r = await http.request({ url: "https://api.example.net/v1/people", method: "GET", headers: { Accept: "application/json" }, timeoutMs: 15000 });\nreturn r.json;' }),
    ] },
    { group: 'Files', scope: 'files', items: [
      fn('await files.write(path, content, { append, encoding })', 'Writes a file, replacing it (or adding to it with append: true). A relative path such as "report.csv" is in the integration\'s own folder, /integrations/integration-<id>. An absolute path such as "/exports/hr/people.csv" is allowed only inside a directory granted to this integration (Integrations → Files, or the integration\'s Directories). Folders are made as needed. Other systems can collect the file over SFTP or from Integrations → Files. A file is at most 10 MB.', '{ path, name, kind, size, updated_at }.',
        { throws: 'If the path is not allowed, is not a valid path, or a limit would be passed.', example: 'const users = await idp.users.search({ limit: 200 });\nawait files.write("users.csv", await csv.stringify(users, { columns: ["username", "email", "department"] }));\nawait files.write("/exports/hr/users.csv", "…");' }),
      fn('await files.read(path, { encoding })', 'The file\'s text. Use encoding: "base64" for binary data.', 'string.', { throws: 'If there is no such file or the path is not allowed.', example: 'const rows = await csv.parse(await files.read("people.csv"));' }),
      fn('await files.list(folder?), await files.exists(path), await files.mkdir(path)', 'List what is in a folder (the folder is the integration\'s own when left out; only the parts it may see are listed), ask whether a path exists, or make a folder.', 'object[] of { path, name, kind, size, updated_at }, boolean, true.',
        { example: 'const names = (await files.list("/exports/hr")).map((f) => f.name);\nif (!(await files.exists("/exports/hr/archive"))) await files.mkdir("/exports/hr/archive");' }),
      fn('await files.delete(path, { recursive })', 'Deletes a file, or an empty folder. With recursive: true a folder is deleted with everything in it.', 'boolean: whether anything was removed.',
        { example: 'await files.delete("tmp/old-export.csv");\nawait files.delete("tmp", { recursive: true });  // a folder and everything in it' }),
    ] },
    { group: 'External directories', scope: 'directory:read', items: [
      fn('await directory.connect(name)', 'Opens a connection to an external directory (LDAP or Active Directory) that an administrator set up under External systems → Directories and allowed scripts to use (its Script access). Returns a connection to work through. Always close it: with connection.close(), or use directory.use below. A connection that is left open is closed when the run ends, however it ends (finished, failed, timed out or stopped), after 30 seconds without use, and after 5 minutes at the longest. A run may hold 3 connections at once and make 200 directory calls.', 'A connection: { directory, access } with find, search, create, update, delete and close.',
        { throws: 'If no directory has that name, it is turned off or not allowed for scripts, the server cannot be reached, or the service account is refused.',
          example: 'const dir = await directory.connect("Corporate AD");\ntry {\n  const u = await dir.find("srivera");\n  log(u ? u.dn : "not found");\n} finally {\n  await dir.close();\n}' }),
      fn('await directory.use(name, async (dir) => { … })', 'Connects, runs your function with the connection, and closes it whether the function returns or throws. The easiest safe way to use a directory.', 'Whatever your function returns.',
        { example: 'return await directory.use("Corporate AD", async (dir) => {\n  const staff = await dir.search({ filter: "(department=Sailing)", limit: 100 });\n  return staff.map((p) => p.username);\n});' }),
      fn('await directory.list()', 'The directories available to scripts.', '{ name, type, access }[], where access is "read" or "write".', { example: 'const names = (await directory.list()).map((d) => d.name);' }),
      fn('await dir.find(username | { username | dn | email … }, { attributes })', 'Looks one person up. Only people (what the directory\'s user filter matches) inside its search base are found. Besides username and dn, any mapped field such as email or employee_id works. attributes asks for more LDAP attributes, returned under attributes. Password attributes are never returned.', 'DirectoryUser, or null if there is none.',
        { throws: 'If more than one person matches.', example: 'const p = await dir.find({ email: input.email }, { attributes: ["whenCreated"] });\nif (p) log(p.dn, p.groups, p.attributes.whenCreated);' }),
      fn('await dir.search(text | { q, filter, limit, attributes })', 'People whose username, display name or email contains q, and/or that match an LDAP filter such as (&(department=Sailing)(title=Foreman)). limit is at most 200, default 50.', 'DirectoryUser[].',
        { throws: 'If the filter is not valid, or more than limit people match (narrow the search).', example: 'const foremen = await dir.search({ filter: "(title=Foreman)", limit: 100 });' }),
    ] },
    { group: 'External directories', scope: 'directory:write', items: [
      fn('await dir.create({ username, first_name, …, password, active, attributes, parentDn })', 'Creates a person. Fields are the usual profile fields (first_name, last_name, email, department …), written to the attributes the directory maps them to. password is set in the directory; active: false creates a disabled account (Active Directory only). attributes sets any other LDAP attribute (name: value or list of values). parentDn names the container (inside the search base; default the search base). The new entry is named cn=… for Active Directory and by the username attribute (such as uid) for other LDAP servers. If setting an Active Directory password fails, the account is removed again. Without a password, an Active Directory account stays disabled.', 'DirectoryUser, with created: true.',
        { throws: 'If the connection is not allowed to write (the directory\'s Script access must be "Read and write" and the integration needs directory:write), the username exists, or the directory refuses it.',
          example: 'await directory.use("Corporate AD", async (dir) => dir.create({\n  username: "bwilson", first_name: "Bea", last_name: "Wilson", email: "bea@example.net",\n  department: "Hull", password: await util.randomPassword(20), parentDn: "OU=Staff,DC=example,DC=net",\n}));' }),
      fn('await dir.update(username | { dn | email … }, { department, title, …, password, active, attributes })', 'Changes the fields given. An empty string removes a value; in attributes, null removes the attribute. A username cannot be changed. active works for Active Directory only. The service account the connection uses cannot be changed.', 'DirectoryUser, with changed: the names of what was changed.',
        { example: 'await dir.update("bwilson", { title: "Lead", attributes: { pager: null } });\nawait dir.update("bwilson", { active: false });' }),
      fn('await dir.delete(username | { dn | email … })', 'Deletes a person from the directory. This cannot be undone. The service account cannot be deleted.', '{ dn, username }.',
        { throws: 'If there is no such person or the directory refuses (for example, the entry has children).', example: 'const gone = await dir.delete(input.username);\nlog("deleted", gone.dn);' }),
    ] },
    { group: 'SFTP', scope: 'sftp', items: [
      fn('await sftp.download(connection, remotePath, fileName)', 'Copies a file from an SFTP server into this integration\'s files. connection is { host, port, username, password or privateKey (and passphrase), hostFingerprint }. Keep secrets in variables: password: vars.SFTP_PASSWORD. hostFingerprint is the server\'s "SHA256:..." key fingerprint, so its identity is checked; without it the connection is refused unless insecureSkipHostCheck: true.', '{ name, size }.',
        { throws: 'If the host is not public, the credentials are refused, the fingerprint does not match or the file is over 10 MB.',
          example: 'const hr = { host: "sftp.example.com", username: "idp", privateKey: vars.SFTP_KEY, hostFingerprint: "SHA256:..." };\nawait sftp.download(hr, "/outgoing/people.csv", "people.csv");' }),
      fn('await sftp.upload(connection, fileName, remotePath)', 'Sends one of this integration\'s files to an SFTP server.', 'true.',
        { example: 'await sftp.upload(hr, "users.csv", "/inbound/users.csv");  // hr: the connection from sftp.download below' }),
      fn('await sftp.list(connection, path), await sftp.get(connection, path, { encoding }), await sftp.put(connection, path, content, { encoding }), await sftp.delete(connection, path)', 'List a folder as { name, size, directory, modified }, read a file as text, write text to a file, or delete one. At most 20 SFTP operations per run.', 'object[], string, true, true.',
        { example: 'const names = (await sftp.list(hr, "/outgoing")).map((f) => f.name);\nconst text = await sftp.get(hr, "/outgoing/people.csv");\nawait sftp.put(hr, "/outgoing/status.txt", "ok " + names.length);' }),
    ] },
    { group: 'Messaging', scope: 'messaging', items: [
      fn('await mail.send(Message)', 'Sends through the email provider in Settings → Messaging.', 'true.',
        { throws: 'If email is not set up, the address is invalid, the provider refuses it, or that address was sent 5 messages in the last 10 minutes.',
          example: 'await mail.send({\n  to: user.email, subject: "Your account is ready",\n  text: `Hi ${user.first_name}, sign in at ${idp.baseUrl} with the username ${user.username}.`,\n});' }),
      fn('await sms.send(Message)', 'Sends a text message.', 'true.', { throws: 'Same as mail.send, for phone numbers like +15551234567.',
        example: 'const to = await fn.toE164({ phone: user.phone });  // "(555) 123-4567" becomes "+15551234567"\nif (to) await sms.send({ to, text: "Your ID office is open until 5 pm." });' }),
    ] },
    { group: 'Helpers', scope: null, items: [
      fn('output(...values)', 'Prints a line to the Output section of the run\'s page, like console.log. Objects are shown as JSON. Output is the run\'s result as a person reads it: it is kept with the run, and it is saved to the files module (/logs) only when Integrations → Logging says so. output.color(color, ...values) prints the line in a color: default, grey, red, orange, yellow, green, blue, purple, cyan or a hex value such as #b3261e.', 'nothing.',
        { example: 'output("Created", user.username);\noutput.color("green", "All done");' }),
      fn('log(...values), log.debug(...), log.normal(...), log.warning(...), log.error(...)', 'Writes a line to the Log section of the run\'s page at a level. Log is for the people who look after the integration, not for its results (that is output). log() is normal. Each level also takes a color: log.error.color("#b3261e", "…"). Lines at or above the level chosen under Integrations → Logging are saved to the files module (/logs/integration-<id>/, one file a day) and kept for the number of days set there. console.debug, console.log and console.info, console.warn and console.error are the same four levels.', 'nothing.',
        { example: 'log.debug("raw row", row);\nlog("created", user.username);\nlog.warning("no manager for", user.username);\nlog.error("could not reach the HR system");' }),
      fn('await csv.parse(text, { header })', 'Parses CSV. With header (default true) the first line names the fields.', 'object[], or string[][] with header: false.', { throws: 'If the CSV is malformed or over 1 MB.', example: 'const rows = await csv.parse(input.csv);\nfor (const r of rows) log(r.email);' }),
      fn('await csv.stringify(rows, { columns, header, safe })', 'Turns objects (or lists of values) into CSV text. columns picks and orders the fields (default: every key). A cell that starts with = + - or @ gets a leading quote so a spreadsheet does not run it as a formula; pass safe: false to write values as they are.', 'string.', { example: 'await files.write("report.csv", await csv.stringify([{ name: "Sam", score: 4 }]));' }),
      fn('await util.randomPassword(length)', 'A random password without look-alike characters. Length 8–128, default 16.', 'string.',
        { example: 'const temp = await util.randomPassword(16);  // never log it: see the note on generate_password' }),
      fn('await util.uuid()', 'A random UUID.', 'string.', { example: 'const requestId = await util.uuid();  // "c0f9a7e2-5b1e-4d7a-9e3f-6a1b2c3d4e5f"' }),
      fn('await util.sha256(text), await util.hmacSha256(key, text)', 'Hex digests.', 'string.',
        { example: 'const sig = await util.hmacSha256(vars.WEBHOOK_SECRET, JSON.stringify(input));  // sign a body for a partner who checks it\nconst digest = await util.sha256(user.email);' }),
      fn('await util.base64Encode(text), await util.base64Decode(text)', 'Base64 of UTF-8 text.', 'string.',
        { example: 'const basic = "Basic " + await util.base64Encode(vars.API_USER + ":" + vars.API_PASSWORD);' }),
      fn('await sleep(ms)', `Waits. At most ${host.LIMITS.sleepMs / 1000} seconds in total per run.`, 'true.',
        { example: 'for (const batch of await fn.chunk({ items: users, size: 20 })) {\n  for (const u of batch) await idp.users.update(u.id, { department: "Unknown" });\n  await sleep(1000);  // give a rate-limited service a moment\n}' }),
      fn('return value', 'The script\'s result: any JSON value, up to 256 KB. A password-like key in it is hidden in run history but is still sent back to a webhook caller.', '',
        { example: 'return { created: created.length, updated: updated.length, skipped: skipped.length };' }),
    ] },
    { group: 'Your functions', scope: null, items: [
      fn('await fn.NAME({ ... })', 'Calls a function written in Integrations → Functions. The object holds one key for each of its inputs. The function runs inside this run: it has this integration\'s scopes, variables and limits, and any error it throws comes back to you as an error here.',
        'Whatever the function returns.', { throws: 'Whatever the function throws. A name that has no function is a TypeError.', example: 'const email = await fn.normalizeEmail({ email: input.email });\nif (!email) throw new Error("Not an email address");' }),
      ...userFunctions.list().map((f) => fn(`await fn.${f.name}(${callKeys(f.inputs)})`, f.description || 'No description.', 'Whatever it returns.',
        { example: `const result = await fn.${f.name}(${sampleKeys(f.inputs)});`, fn: { name: f.name, description: f.description, inputs: f.inputs, script: f.script } })),
    ] },
  ];
}

// The defined user attributes, with an example value for each, and how a script reads and writes them.
const attributes = () => ({
  defined: attributeExamples(),
  read: 'const u = await idp.users.find({ username: "srivera" });\nconst expires = u.attributes.badge_expires;  // "2027-06-30", or undefined when not set',
  write: 'await idp.users.update("srivera", { attributes: { badge_expires: "2027-06-30" } });\nawait idp.users.update("srivera", { attributes: { pet: "" } });  // "" removes the value',
});

// Worked examples for common administrator tasks. Each uses only what the reference above describes.
const recipes = () => [
  {
    title: 'Create or update accounts from an HR export',
    description: 'Reads people.csv from the integration\'s own folder (an SFTP upload or another script can put it there). A row whose employee_id already exists updates that person; any other row creates an account. A new account gets a generated password that is never logged or emailed: the person uses Forgot password at sign-in.',
    code: `const rows = await csv.parse(await files.read("people.csv"));
let created = 0, updated = 0;
for (const row of rows) {
  const email = await fn.normalizeEmail({ email: row.email });
  if (!email) { log.warning("skipped a row with no email", row.employee_id); continue; }
  const existing = await idp.users.find({ employee_id: row.employee_id });
  if (existing) {
    await idp.users.update(existing.id, { first_name: row.first_name, last_name: row.last_name, department: row.department, title: row.title, email });
    updated++;
  } else {
    await idp.users.create({
      username: await idp.users.suggestUsername(row.first_name, row.last_name),
      first_name: row.first_name, last_name: row.last_name, email,
      employee_id: row.employee_id, department: row.department, title: row.title,
      groups: ["Staff"], generate_password: true,
    });
    created++;
  }
}
return { created, updated, rows: rows.length };`,
  },
  {
    title: 'Turn off an account when someone leaves',
    description: 'Run by a webhook the HR system calls when a person leaves: POST /hooks/integrations/<id> with { "employee_id": "10442" }. Setting active to false signs the person out everywhere and blocks sign-in. The account is kept, so it can be reactivated if the decision is reversed.',
    code: `const user = await idp.users.find({ employee_id: input.employee_id });
if (!user) return { status: "not found", employee_id: input.employee_id };
if (!user.active) return { status: "already inactive", username: user.username };
await idp.users.update(user.id, { active: false });
log("deactivated", user.username);
return { status: "deactivated", username: user.username };`,
  },
  {
    title: 'Post a welcome message when an account is created',
    description: 'An event integration listening for user.created. The event carries the new account as input.user (see Event). Only accounts created from the console or the user API are delivered; nothing an integration creates starts another run.',
    code: `const u = input.user;
if (!u) return { status: "no user in the event" };
const r = await http.post(vars.NEW_ACCOUNTS_WEBHOOK, {
  text: \`New account: \${u.display_name} (\${u.username})\${u.department ? ", " + u.department : ""}\`,
});
if (!r.ok) throw new Error("the webhook answered " + r.status);
return { status: "posted" };`,
  },
  {
    title: 'Export a group to a CSV file for another system',
    description: 'Writes the members of the Staff group, with their department and one attribute, to a file on the SFTP server through the connection in vars. Run it nightly from a schedule. idp.users.search returns at most 200 people, so the export starts from a group instead; export each large group separately.',
    code: `const members = await idp.groups.members("Staff");
const rows = [];
for (const m of members) {
  const u = await idp.users.find({ id: m.id });
  if (!u || !u.active) continue;
  rows.push({ username: u.username, email: u.email, department: u.department, badge_expires: u.attributes.badge_expires || "" });
}
const csvText = await csv.stringify(rows, { columns: ["username", "email", "department", "badge_expires"] });
await files.write("staff.csv", csvText);
await sftp.put({ host: vars.SFTP_HOST, username: vars.SFTP_USER, privateKey: vars.SFTP_KEY, hostFingerprint: vars.SFTP_FINGERPRINT }, "/inbound/staff.csv", csvText);
return { exported: rows.length };`,
  },
  {
    title: 'Warn people whose badge expires within 30 days',
    description: 'A scheduled run that reads the badge_expires attribute (a date, YYYY-MM-DD) and emails the people whose badge is due soon. Dates in this format compare correctly as text.',
    code: `const cutoff = await fn.dateInDays({ days: 30 });
let sent = 0;
for (const m of await idp.groups.members("Staff")) {
  const u = await idp.users.find({ id: m.id });
  const expires = u && u.attributes.badge_expires;
  if (!expires || expires > cutoff) continue;
  await mail.send({ to: u.email, subject: "Your badge expires soon", text: \`Hi \${u.first_name}, your badge expires on \${expires}. Ask the ID office to renew it.\` });
  sent++;
}
return { sent, cutoff };`,
  },
  {
    title: 'Call an HR API with a secret key',
    description: 'Reads one person from an external HR API. The base address and the token are variables; mark the token secret in Integrations → Variables so its value is hidden from logs and results. requestJson throws, with the status and the start of the reply, unless the service answers 2xx.',
    code: `const data = await fn.requestJson({
  request: {
    url: vars.HR_API_URL + "/people/" + input.employee_id,
    headers: { Authorization: "Bearer " + vars.HR_API_TOKEN, Accept: "application/json" },
  },
});
return { title: data.job_title, manager: data.manager_email };`,
  },
];

const triggers = () => [
  { name: 'Console', description: 'Run now, with the values in the Run table as `input` (any name can be added, typed as text, a number, yes or no, or JSON). trigger.type is "manual".' },
  { name: 'Webhook', description: 'POST /hooks/integrations/<id> with a bearer token. The JSON body is `input`; the answer is a WebhookResponse. trigger.type is "webhook".' },
  { name: 'Schedule', description: `Every N minutes (${schedules.MIN_MINUTES}–${schedules.MAX_MINUTES}), daily, every weekday, weekly, monthly (day 1–28), or custom (every N minutes, hours, days or weeks, with a start date and optional end date; weeks can be limited to chosen days), in UTC. An integration can have up to ${schedules.MAX_PER_INTEGRATION} schedules, each with its own next run. \`input\` is the schedule's input values, with { scheduled_for } (ISO). A run that is still going when the next is due is not started again, and a server that was off runs a missed schedule once when it starts. trigger.type is "schedule".` },
  { name: 'Event', description: 'When something listed under Events happens. `input` is an Event, with each input the trigger gives a value (or takes an Event field, such as user.email) added. Runs go one at a time through a queue (up to 100 waiting). trigger.type is "event".' },
];

const limits = () => [
  ['Time', `1–60 seconds per run (set per integration, default ${engine.TIMEOUT.default}); the script is stopped when it runs out.`],
  ['Calls', `${host.LIMITS.calls} calls to idp, http, mail, sms, csv, util and sleep per run; ${host.LIMITS.http} web requests; ${host.LIMITS.messages} messages.`],
  ['Memory', '96 MB.'],
  ['Size', `Script up to ${engine.MAX_SCRIPT.toLocaleString('en-US')} characters, input up to 1 MB, result up to 256 KB, 200 log lines.`],
  ['History', `The latest ${RUNS_KEPT} runs of each integration are kept.`],
  ['Errors', 'A function that fails throws an Error with a readable message, so try/catch works. An uncaught error ends the run as "error" and reports the line.'],
];

/** Everything the Reference tab and the editor's reference panel show. */
const reference = () => ({
  variables: variables.BUILTIN_DOCS, inputs: inputNames.catalog, functions: functions(), types: types(), events: events.catalog(), triggers: triggers(), limits: limits(),
  attributes: attributes(), recipes: recipes(),
});

module.exports = { reference };
