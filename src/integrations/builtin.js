const appSettings = require('../app-settings');
const db = require('../db');

// Integrations that come with the product. Each is created once, the first time the server starts after it was added; an
// administrator can then change it, turn it off or delete it, and it is not created again. Nobody but people who manage
// integrations can run them until an administrator allows a group (for example the help desk) on the integration's page.

const SEEDED_KEY = 'integration_builtins';

// Built-in integrations that cannot be deleted, because the product relies on them (the lockdown is run from the account pages and the
// user API). They can still be turned off, and their original code restored.
const UNDELETABLE = new Set(['compromised-account-lockdown']);
const isDeletable = (key) => !UNDELETABLE.has(key || '');

const BUILTIN = [
  {
    key: 'password-reset',
    name: 'Password reset',
    description: 'Gives a person a new random password and emails it to them (to their recovery address if they have one, otherwise their work address). Allow your help desk group to run it from Integrations.',
    scopes: ['users:read', 'users:write', 'messaging'],
    inputs: [{ name: 'username', variable: 'username' }],
    script: `// Resets one person's password and emails the new one to them. Input: username (a username or an email address).
// Administrators and people from external directories are refused by idp.users.update.
if (!username) throw new Error('Say whose password to reset: pass a username.');
const user = (await idp.users.find({ username })) || (await idp.users.find({ email: username }));
if (!user) throw new Error('There is no user "' + username + '".');
if (!user.active) throw new Error(user.username + ' is turned off. Turn the account on before resetting its password.');

const to = user.personal_email || user.email;
if (!to) throw new Error(user.username + ' has no email address to send a new password to.');

// A random part, then characters that satisfy common password policies (upper, lower, digit and symbol).
const password = (await util.randomPassword(18)) + '-7x!';
await idp.users.update(user.username, { password });
// The new password signs out their browsers; this also ends the OAuth and OpenID Connect tokens they were issued.
await idp.users.endSessions(user.username);

await mail.send({
  to,
  subject: 'Your ' + idp.appName + ' password was reset',
  text: 'Hello ' + (user.first_name || user.username) + ',\\n\\nYour password was reset. Your new password is:\\n\\n' + password
    + '\\n\\nSign in at ' + idp.baseUrl + ' and change it on your profile page.\\n',
});
log('Password reset for', user.username);
output.color('green', 'Password reset for ' + user.username + '. The new password was emailed to ' + to + '.');
return { reset: user.username, sentTo: to };
`,
  },
  {
    key: 'deactivate-user',
    name: 'Deactivate a user',
    description: 'Turns a person\'s account off so they can no longer sign in, and signs them out. Nothing is deleted.',
    scopes: ['users:read', 'users:write'],
    inputs: [{ name: 'username', variable: 'username' }],
    script: `// Turns one account off. Input: username.
if (!username) throw new Error('Say which account to turn off: pass a username.');
const user = await idp.users.find({ username });
if (!user) throw new Error('There is no user "' + username + '".');
if (!user.active) {
  output('Already turned off: ' + user.username);
  return { deactivated: false, reason: 'already off' };
}
await idp.users.update(user.username, { active: false });
output.color('orange', 'Turned off ' + user.username);
return { deactivated: true, username: user.username };
`,
  },
  {
    key: 'compromised-account-lockdown',
    name: 'Compromised account lockdown',
    description: 'Locks down an account that may be compromised, as the Compromised account policies say: signs it out everywhere, replaces the password, removes its sign-in methods, forgets remembered browsers, turns it off, adds it to a group, limits where it can sign in from, and tells the person. Run from an account\'s page in the console, or through the user API (POST /api/v1/users/{id}/lockdown). Edit this script to change the procedure.',
    scopes: ['users:read', 'users:write', 'groups:write', 'messaging'],
    inputs: [{ name: 'username', variable: 'username' }],
    script: `// Locks down one account. Input: username. The steps come from the Compromised account policies (Policies → Compromised accounts),
// which idp.compromise.plan works out for this person. Administrators and directory accounts are refused by the host functions.
if (!username) throw new Error('Say which account to lock down: pass a username.');
const user = await idp.users.find({ username });
if (!user) throw new Error('There is no user "' + username + '".');
const plan = await idp.compromise.plan(user.username);
const done = [];

// Stop what is in progress first, so nothing issued before the lockdown stays usable.
if (plan.end_sessions) { await idp.users.endSessions(user.username); done.push('signed out everywhere'); }
if (plan.forget_remembered) { await idp.users.forgetRemembered(user.username); done.push('forgot remembered browsers'); }

// Replace the credentials. A random password nobody knows; the person recovers the account or an administrator sets a new one.
if (plan.reset_password) {
  await idp.users.update(user.username, { password: (await util.randomPassword(24)) + '-Lk9!' });
  done.push('replaced the password');
}
if (plan.rotate_mfa) {
  const { removed } = await idp.users.resetAuthenticators(user.username);
  done.push('removed ' + removed + ' sign-in method' + (removed === 1 ? '' : 's'));
}

// Add the person to the groups the policies name (a group that limits what they can reach, for example).
if (plan.add_to_group) {
  for (const group of plan.groups) {
    await idp.groups.addMember(group, user.username);
    done.push('added to the group ' + group);
  }
}

// Restrict what is left. This is always recorded, so the account shows as in lockdown even if no step turns it off.
const lockdown = await idp.compromise.restrict(user.username, { networks: plan.networks, lock: plan.lock_account });
if (plan.lock_account && lockdown.locked_account) done.push('turned the account off');
if (plan.networks.length) done.push('limited sign-in to ' + plan.networks.length + ' network list' + (plan.networks.length === 1 ? '' : 's'));

if (plan.notify_user) {
  const to = user.personal_email || user.email;
  if (to) {
    await mail.send({
      to,
      subject: 'Your ' + idp.appName + ' account was locked down',
      text: 'Hello ' + (user.first_name || user.username) + ',\\n\\nYour account was locked down because it may have been used by someone else. '
        + 'You have been signed out, and you will need to set up your sign-in again.\\n\\nIf you did not expect this, contact your help desk.\\n',
    });
    done.push('emailed the person');
  }
}
output.color('orange', 'Locked down ' + user.username + ': ' + (done.join(', ') || 'no steps were set by policy') + '.');
return { locked_down: user.username, steps: done, policies: plan.sources };
`,
  },
  {
    key: 'import-users-csv',
    name: 'Import users from a CSV file',
    description: 'Creates accounts from a CSV file in this integration\'s folder (upload people.csv in Integrations → Files, or have another system send it over SFTP). Columns: username (optional), first_name, last_name, email. Writes a results file.',
    scopes: ['users:read', 'users:write', 'files'],
    inputs: [{ name: 'file', variable: 'file' }],
    script: `// Creates one account per row of a CSV file. Input: file (the file name; default people.csv).
const name = file || 'people.csv';
if (!(await files.exists(name))) throw new Error('Upload ' + name + ' to the folder of this integration first (Integrations → Files).');
const rows = await csv.parse(await files.read(name));
log('Read', rows.length, 'rows from', name);

const results = [];
for (const row of rows) {
  const username = row.username || (await idp.users.suggestUsername(row.first_name, row.last_name));
  try {
    if (row.email && (await idp.users.find({ email: row.email }))) {
      results.push({ username, status: 'skipped', detail: 'that email address already has an account' });
      continue;
    }
    await idp.users.create({ username, first_name: row.first_name, last_name: row.last_name, email: row.email, generate_password: true });
    results.push({ username, status: 'created', detail: '' });
  } catch (e) {
    log.warning(username + ': ' + e.message);
    results.push({ username, status: 'error', detail: e.message });
  }
}
await files.write('import-results.csv', await csv.stringify(results, { columns: ['username', 'status', 'detail'] }));
const count = (s) => results.filter((r) => r.status === s).length;
output('Created ' + count('created') + ', skipped ' + count('skipped') + ', failed ' + count('error') + '. Details are in import-results.csv.');
return { created: count('created'), skipped: count('skipped'), failed: count('error') };
`,
  },
  {
    key: 'export-users-csv',
    name: 'Export users to a CSV file',
    description: 'Writes every user to users.csv in this integration\'s folder, for another system to collect (over SFTP, or by downloading it from Integrations → Files).',
    scopes: ['users:read', 'files'],
    inputs: [],
    script: `// Writes users.csv with one row per person.
const people = await idp.users.search({ limit: 200 });
const rows = people.map((u) => ({ username: u.username, first_name: u.first_name, last_name: u.last_name, email: u.email, department: u.department, active: u.active }));
const file = await files.write('users.csv', await csv.stringify(rows));
output('Wrote ' + rows.length + ' people to users.csv (' + file.size + ' bytes).');
return { rows: rows.length };
`,
  },
];

/** Creates the built-in integrations that have not been created before. Returns the keys it created. */
function seed() {
  const integrations = require('./index');
  const done = new Set(appSettings.read(SEEDED_KEY) || []);
  const created = [];
  for (const b of BUILTIN) {
    if (done.has(b.key)) continue;
    done.add(b.key);
    // A name an administrator already used for their own integration is left alone.
    if (db.get('SELECT 1 FROM integrations WHERE name = ?', b.name)) continue;
    const { data, errors } = integrations.parse({ name: b.name, description: b.description, script: b.script, scopes: b.scopes, inputs: b.inputs, enabled: true, timeout_seconds: 30 });
    if (errors.length) { console.error(`Built-in integration ${b.name} is not valid:`, errors.join(' ')); continue; }
    if (integrations.create(data, 'system', { builtin: b.key }).integration) created.push(b.key);
  }
  appSettings.write(SEEDED_KEY, [...done]);
  return created;
}

module.exports = { seed, BUILTIN, isDeletable, find: (key) => BUILTIN.find((b) => b.key === key) || null };
