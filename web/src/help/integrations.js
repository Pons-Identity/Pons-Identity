// Help articles for integrations: how to build and run them, and the reference for writing their scripts.
// Blocks: a string is a paragraph; { steps } numbered; { bullets } a list; { tip } a note; { heading } a subheading;
// { code } a block of code; { table: { head, rows } } a table. **bold** marks control names; `code` marks code.

import { holds } from './visibility.js';

const view = holds('integrations.view');
const manage = holds('integrations.manage');

export const INTEGRATION_ARTICLES = [
  {
    slug: 'integrations-overview',
    section: 'Integrations',
    title: 'How integrations work',
    summary: 'What an integration is, how it starts, and what it can reach.',
    visible: view,
    body: [
      'An integration is a JavaScript script that moves data between Pons Identity and another system: it can create users from an HR feed, look people up in an outside service, or post to a chat channel. You find them under **Integrations** in the module menu.',
      { table: {
        head: ['Trigger', 'How it starts', 'What `input` holds', '`trigger.type`'],
        rows: [
          ['Console', 'You select **Run now**.', 'The values in the **Run** table, each under its input name. You can add a custom input for any other name.', '`manual`'],
          ['Webhook', 'Another system sends `POST /hooks/integrations/<id>`.', 'The JSON body of the request.', '`webhook`'],
          ['Schedule', 'A timer fires, in UTC.', 'The values set on the schedule, and `scheduled_for`, an ISO time.', '`schedule`'],
          ['Event', 'Something happens in the IdP, such as a user being created.', 'An Event object, with the values set for the trigger, and any input taken from an Event field such as `user.email`.', '`event`'],
        ],
      } },
      { heading: 'Where things are' },
      { bullets: [
        '**Integrations**: the list, and each integration\'s settings, triggers, inputs, script and run history.',
        '**Functions**: reusable scripts that any integration can call. See [Write a reusable function](/help/integration-functions).',
        '**Variables**: settings and secrets scripts read. See [Store settings and secrets](/help/integration-variables).',
        '**Reference**: the complete list of functions, objects and events, generated from this server.',
      ] },
      { tip: 'Turning an integration off stops its webhook, schedules and events. **Run now** still works while it is off, so you can test changes first.' },
    ],
  },
  {
    slug: 'create-integration',
    section: 'Integrations',
    title: 'Create an integration',
    summary: 'Write a script, choose what it may use, and test it.',
    visible: manage,
    body: [
      { steps: [
        'Open **Integrations** from the module menu, then select **New integration**. The form starts with a short example script and the `users:read` and `users:write` scopes ticked.',
        'On the **Details** tab, type a **Name**. The name appears in run history and in the audit log, as `integration:<name>`. Optionally type a **Home folder**, where relative file paths in the script go.',
        'Set **Time limit (seconds)**. It can be from 1 to 60, and the default is 10.',
        'Select **Create integration**. The other tabs open once it exists, and each one has its own **Save** and **Discard changes** buttons. You cannot switch tabs while the current one has unsaved changes.',
        'On the **Permissions** tab, under **What the script may use**, tick only the scopes the script needs. The [scope table](/help/reference-integration-limits) lists what each one allows.',
        'On the **Triggers** tab, add schedules and tick any events that should start it. The webhook is on the **Webhook & API** tab.',
        'On the **Inputs** tab, add one row for each key of the input that the script reads. See [Map inputs to variables](/help/integration-inputs).',
        'Write the script on the **Script** tab. See [Write an integration script](/help/integration-scripting).',
        'Select **Create integration**.',
      ] },
      { heading: 'Test it' },
      { steps: [
        'Under **Run**, type a value in the box beside each input your script expects, such as `10442` for `employee_id`. Choose its type (text, number, yes or no, or JSON). Add a custom input for any other name.',
        'Select **Run now**.',
        'The run opens in a new tab. It shows the integration, the node it ran on and when it started, then the **Output**, **Log** and **Result** sections, and when it started and ended. Any error and its line number are shown at the top.',
      ] },
      { tip: 'Every run is kept in history, and the last 50 runs appear with their input, logs and result. Fields named like a password, secret or token are shown as `[redacted]`.' },
    ],
  },
  {
    slug: 'integrations-git',
    section: 'Integrations',
    title: 'Version-control integrations with Git',
    summary: 'Commit your integrations to a Git repository and push them to a remote.',
    visible: view,
    body: [
      { steps: [
        'Open **Integrations** from the module menu, then select **Git**.',
        'Read the status line. It tells you whether a repository exists yet, and how many files have changed since the last commit.',
        'Type a **Commit message** that says what changed, such as "Add the HR feed schedule", and select **Commit all changes**.',
        'To send the commits to a remote, type its **Remote URL (https)**, such as `https://git.example.net/team/idp.git`, and check the **Branch**.',
        'Type an **Access token (not stored)** with write access to that repository, then select **Push**.',
      ] },
      'The first commit creates the repository for you. Each integration becomes a folder with its settings and script, and each function and the variables list get their own files, so changes show up as readable differences.',
      { tip: 'Secret variable values, webhook tokens and run history are never committed.' },
      'You need **Manage integrations** to commit or push. Anyone who can view integrations can see the status. Pushes are never forced, so if the remote has newer commits, merge them there first.',
      { warning: 'Pons Identity does not keep the access token. You type it for each push. Use a token that can write only to this repository, and revoke it in your Git host when you no longer need it.' },
    ],
  },
  {
    slug: 'integration-webhook',
    section: 'Integrations',
    title: 'Start an integration from a webhook',
    summary: 'Turn on a webhook URL, send it a request, and read the reply.',
    visible: manage,
    body: [
      { steps: [
        'Open the integration and scroll to **Webhook**.',
        'Select **Turn on webhook**.',
        'Copy the **Webhook token** now. It is shown once, and the server keeps only a hash of it. The token starts with `iwh_`.',
        'Use the **Webhook URL** shown on the page. Send a `POST` with the token in an `Authorization` header and the input as a JSON body.',
      ] },
      { code: `curl -X POST "https://idp.example.net/hooks/integrations/4" \\
  -H "Authorization: Bearer iwh_..." \\
  -H "Content-Type: application/json" \\
  -d '{"employee_id":"10442","group":"Staff"}'` },
      { heading: 'Replies' },
      { table: {
        head: ['Status', 'Meaning', 'Body'],
        rows: [
          ['200', 'The script finished.', '`WebhookResponse` with `status: "ok"`'],
          ['422', 'The script threw an error.', '`WebhookResponse` with `status: "error"` and `error: { message, line }`'],
          ['504', 'The run passed its time limit.', '`WebhookResponse` with `status: "timeout"`'],
          ['401', 'The token is missing or wrong.', '`{ "error": "A valid bearer token is required." }`'],
          ['409', 'The integration is turned off.', '`{ "error": "This integration is turned off." }`'],
          ['429', 'Too many failed attempts recently.', '`{ "error": "Too many failed attempts. Try again shortly." }`'],
        ],
      } },
      'Select **Replace token** to issue a new token. The old one stops working at once. Select **Turn off** to remove the token and stop the webhook from accepting calls.',
    ],
  },
  {
    slug: 'integration-schedules-and-events',
    section: 'Integrations',
    title: 'Run an integration on a schedule or an event',
    summary: 'Choose a timetable, or react to something that happens in the IdP.',
    visible: manage,
    body: [
      { heading: 'Schedules' },
      { steps: [
        'Open the integration, find **Triggers**, and select **Add a schedule**.',
        'Choose a **Schedule** type: minutes between runs, daily, every weekday, weekly, monthly, or custom.',
        'Set the time under **Time (UTC)**, or the interval under **Minutes between runs** or **Repeat every** with its **Unit**.',
        'For a custom schedule, you can add **Days of the week**, **Starts on** and **Ends on**.',
        'Select **Save**.',
      ] },
      { bullets: [
        'Minutes between runs: 5 to 10080.',
        'Day of the month: 1 to 28.',
        'An integration can have up to 10 schedules, each with its own next run.',
        'A run still going when the next is due is not started again. A server that was off runs a missed schedule once when it starts.',
        'The scheduled input holds the values set on the schedule, and `scheduled_for`, the ISO time the run was due.',
      ] },
      { heading: 'Events' },
      'Tick one or more events under **Events**. The script receives an Event object as `input`. Events come from the audit log, so a change made in the console, the user API, an import or another script all count, except changes made by an integration: those never start an integration, so two integrations cannot start each other in a loop.',
      { table: {
        head: ['Event', 'Starts when', 'Extra input fields'],
        rows: [
          ['`user.created`', 'A user is created, or a scheduled creation runs.', '`user`'],
          ['`user.updated`', 'A user is changed.', '`user`'],
          ['`user.deleted`', 'A user is deleted.', 'none'],
          ['`user.password_reset`', 'An administrator or the user API resets a password.', '`user`'],
          ['`group.member_added`', 'Someone is added to a group.', '`group`, `member`'],
          ['`group.member_removed`', 'Someone is removed from a group.', '`group`, `member`'],
          ['`login.succeeded`', 'Someone signs in.', '`user` (the person who signed in)'],
          ['`login.failed`', 'A sign-in fails.', 'none; `outcome` is `"failure"`'],
        ],
      } },
      'Events go through one queue and run one at a time. Up to 100 can wait. For every field, see [Reference: events](/help/reference-integration-events).',
    ],
  },
  {
    slug: 'integration-inputs',
    section: 'Integrations',
    title: 'Map inputs to variables',
    summary: 'Name the values a run receives, and the variables your script reads them from.',
    visible: manage,
    body: [
      'The **Inputs** table tells Pons Identity which parts of the input the script needs, and what name the script reads each one by. Each row has two columns: **Input** (the key in the input object) and **Variable in code** (the name your script uses).',
      { steps: [
        'Open the integration and find **Inputs**.',
        'Select **Add input**.',
        'In **Input**, choose a name from the list, or type your own. The list offers every input the server supplies, sorted alphabetically, with a description of each.',
        'In **Variable in code**, type the name your script will use.',
        'Select **Save**. The rows are checked when you save.',
      ] },
      { heading: 'Example' },
      { code: `// Inputs: email -> address, employee_id -> staffId
const user = await idp.users.find({ employee_id: staffId });
if (!user) return { missing: staffId };
return { found: user.username, address };` },
      { tip: 'The whole input is always available as `input`, even when you have rows. Use the rows to give the key a shorter name, or to keep the script readable.' },
    ],
  },
  {
    slug: 'integration-scripting',
    section: 'Integration scripts',
    title: 'Write an integration script',
    summary: 'The rules every integration script follows, with patterns that work.',
    visible: manage,
    body: [
      { heading: 'The shape of a script' },
      { bullets: [
        'The script is the body of an `async` function. Use `await` anywhere, and `return` a value to record it as the run\'s result.',
        'Read the input from `input`, the run from `trigger`, the integration from `integration` (`{ id, name }`), settings from `vars`, and reusable functions from `fn`.',
        'Use `idp.users.*`, `idp.groups.*`, `http.*`, `mail.send`, `sms.send`, `csv.parse`, `util.*`, `sleep`, `output` and `log`. The full list is in [Reference: integration functions](/help/reference-integration-api).',
        'There is no `require`, `process`, `fetch`, file or database access, and no `eval`. The functions above are everything a script can reach.',
      ] },
      { heading: 'Print, log and fail clearly' },
      { bullets: [
        '`output(...values)` prints a line, like `console.log`. It appears in the **Output** section of the run\'s page: what the run produced, kept with the run. Objects appear as JSON.',
        '`log(...values)` writes a line to the **Log** section of the run\'s page at the normal level. Log is for the people who look after the integration; output is for its results. `log.debug()`, `log.warning()` and `log.error()` write at the other levels (debug, normal, warning, error). `console.debug`, `console.log`, `console.warn` and `console.error` are the same levels.',
        'Give one line its own color with `output.color("green", "done")` or `log.error.color("#b3261e", "…")`. A color is `default`, `grey`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `cyan` or a hex value. Without one, a line uses the default color of its stream or level, which an administrator can change under **Integrations → Logging**.',
        'To keep log lines after the run history rolls over, choose a level under **Integrations → Logging**. Lines at or above it are saved as a plain text file a day for the integration, under `/logs` in the files module (**Integrations → Files**), and kept for the number of days set there. `output()` lines are saved too if you turn that on.',
        'A thrown `Error` ends the run as an error and reports its line number. Use `throw` for a problem the run cannot continue past.',
        'Wrap a call in `try`/`catch` when you want to keep going. Every function throws an `Error` with a readable message.',
        'An HTTP error status does not throw. Check `r.ok` or `r.status` yourself.',
      ] },
      { heading: 'Check before you create' },
      { code: `// Create a person only when nobody has their employee ID yet.
const existing = await idp.users.find({ employee_id: input.employee_id });
if (existing) return { skipped: existing.username };

const user = await idp.users.create({
  username: await idp.users.suggestUsername(input.first, input.last),
  first_name: input.first,
  last_name: input.last,
  email: input.email,
  employee_id: input.employee_id,
  groups: ['Staff'],
  generate_password: true,
});
return { created: user.username };` },
      { tip: 'Do not return a generated password. Send it to the person with `mail.send` instead, so it is not kept in run history.' },
      { heading: 'Work in batches' },
      { code: `// Send work in groups of 50, so one run does not exceed the call limits.
for (const batch of await fn.chunk({ items: input.people, size: 50 })) {
  for (const p of batch) await fn.findOrCreateUser({ email: p.email, first_name: p.first, last_name: p.last });
}
return { done: input.people.length };` },
      { tip: 'A run may make 2000 calls, 50 web requests and 25 messages. A loop over a long list reaches those limits quickly, so batch the work or split it across runs.' },
    ],
  },
  {
    slug: 'integration-variables',
    section: 'Integration scripts',
    title: 'Store settings and secrets in variables',
    summary: 'Keep URLs, keys and other settings out of the script.',
    visible: manage,
    body: [
      { steps: [
        'Open **Integrations** and select the **Variables** tab.',
        'In the form at the top of the page, type a **Name**. Use letters, digits and underscores, and start with a letter or underscore, for example `CRM_API_KEY`.',
        'Type the **Value**.',
        'Tick **Secret (hide the value, and blank it from run output)** for a password, key or token.',
        'Type a **Description** so the next administrator knows what it is for.',
        'Select **Add variable**. To change an existing variable, select **Edit** in its row, make the change, and select **Save variable**.',
      ] },
      { heading: 'Read a variable in a script' },
      { code: `const base = vars.CRM_URL;
const key = vars.CRM_API_KEY;
const region = vars.get("CRM_REGION", "us");  // the second argument is used when the variable is not set` },
      { heading: 'Secrets' },
      { bullets: [
        'A secret\'s value is never shown again in the console. Edit it to change it: a blank **Value** keeps the stored one.',
        'A secret cannot be turned back into an ordinary variable. The value would then show.',
        'Anywhere a secret\'s value would appear in run output, logs, results or errors, the text `[secret]` appears instead.',
      ] },
      { heading: 'Limits' },
      'You can have up to 200 variables. A value can be up to 8000 characters. A name can be up to 64 characters.',
      { heading: 'Built-in read-only values' },
      'Pons Identity also supplies values your script can read but not change. The full list, with each one\'s type, is in [Reference: variables and input names](/help/reference-integration-variables).',
    ],
  },
  {
    slug: 'integration-functions',
    section: 'Integration scripts',
    title: 'Write a reusable function',
    summary: 'Write a function once, and call it from any integration.',
    visible: manage,
    body: [
      'A function is JavaScript that an administrator writes once. Any integration can call it as `fn.NAME`. It runs inside the calling integration\'s run, so it has that integration\'s scopes, variables and time limit, and it cannot do anything the caller could not.',
      { steps: [
        'Open **Integrations** and select the **Functions** tab, then select **New function**.',
        'On the **Details** tab, type a **Name**. Use letters, digits and underscores. You cannot change the name after you create the function.',
        'Type a **Description**, which other administrators see in the list.',
        'Select **Add function**. Its **Inputs** and **Function body** tabs open once it exists.',
        'On the **Inputs** tab, select **Add input** for each key of the object the caller passes, and name the variable your body reads it from.',
        'On the **Function body** tab, write the body. Use `return` for the result, and select **Save function**.',
      ] },
      { heading: 'Call a function' },
      { code: `const email = await fn.normalizeEmail({ email: input.email });
if (!email) throw new Error("Not an email address");` },
      'Pass one key for each input the function lists. The object\'s keys are the input names, not the variable names.',
      { tip: 'A function that throws returns its error to the caller, where it can be caught with `try`/`catch`. A function cannot call reports.' },
      { heading: 'Starter functions' },
      'A new installation starts with these functions. You can edit or delete any of them. A deleted starter stays deleted.',
      { table: {
        head: ['Function', 'Inputs (key → variable)', 'What it does', 'Scope needed'],
        rows: [
          ['`normalizeEmail`', 'email → email', 'Trims and lower-cases an address. Returns `""` if it is not one.', 'none'],
          ['`fullName`', 'first_name → first_name, last_name → last_name', 'Joins the two names, leaving out a blank part.', 'none'],
          ['`splitName`', 'display_name → name', 'Splits a full name into `{ first_name, last_name }`.', 'none'],
          ['`slugify`', 'text → text', 'Makes a lower-case, URL-safe slug.', 'none'],
          ['`toE164`', 'phone → phone', 'Formats a phone number as `+E.164`. A 10-digit number is read as +1. Returns `""` if it cannot.', 'none'],
          ['`parseBoolean`', 'value → value', 'Reads yes/no, true/false, y/n, 1/0 or on/off. Returns `null` for anything else.', 'none'],
          ['`dateInDays`', 'days → days', 'The date that many days from now, as `YYYY-MM-DD` in UTC.', 'none'],
          ['`chunk`', 'items → items, size → size', 'Splits a list into lists of at most `size` items.', 'none'],
          ['`uniqueBy`', 'items → items, key → key', 'Keeps the first item for each value of `key`.', 'none'],
          ['`requestJson`', 'request → request', 'Calls a web service with an `HttpRequest` and returns its JSON. Throws on an error status.', 'http'],
          ['`restCall`', 'request → request', 'Calls a REST API: a `baseUrl`, a `path`, any method, a `query`, a bearer `token` and a `body`. Returns `{ status, data }`. Throws on an error status.', 'http'],
          ['`findOrCreateUser`', 'email, first_name, last_name, username, groups, generate_password', 'Finds the person with this email, or creates them. Returns `{ user, created }`.', 'users:read and users:write'],
          ['`addToGroups`', 'user → user, groups → groups', 'Adds one person to several local groups. Returns the groups they were added to.', 'groups:write'],
          ['`sendEmail`', 'to → to, subject → subject, text → text', 'Sends an email through the provider in Settings → Messaging. Returns `true`.', 'messaging'],
          ['`sendSms`', 'to → to, text → text', 'Sends a text message to a number such as `+15551234567`. Returns `true`.', 'messaging'],
        ],
      } },
    ],
  },
  {
    slug: 'reference-integration-api',
    section: 'Integration reference',
    title: 'Reference: integration functions',
    summary: 'Every function an integration can call, with its scope and its result.',
    visible: view,
    body: [
      'Each function needs the scope shown, unless it says "none". A function that needs a scope the integration does not have throws an error that names the scope. Limits are in [the limits reference](/help/reference-integration-limits).',
      { heading: 'Users' },
      { table: {
        head: ['Call', 'Scope', 'Returns', 'Notes'],
        rows: [
          ['`await idp.users.find({ id | username | email | employee_id })`', 'users:read', '`User` or `null`', 'Give one key. `username` ignores case. `email` also matches extra addresses. Throws if no key is given.'],
          ['`await idp.users.search(text | { q, limit })`', 'users:read', '`User[]`', 'Matches username, display name or email. Default `limit` 50, maximum 200. With no text, returns the first users by username.'],
          ['`await idp.users.suggestUsername(first, last)`', 'users:read', 'string', 'First initial and last name, lower case, with accents removed. Adds a number while taken: `srivera`, `srivera2`. Reserves nothing.'],
          ['`await idp.users.create(NewUser)`', 'users:write', '`User`, with `generated_password` if asked', 'The same rules as the user API and bulk import. Throws with every problem at once and creates nothing if any problem is found.'],
          ['`await idp.users.update(user, UserPatch)`', 'users:write', '`User`', '`user` is a GUID or a username. Throws for an administrator, a directory user or an invalid value.'],
          ['`await idp.users.delete(user)`', 'users:write', '`true`', 'Deletes the account and signs it out. This cannot be undone.'],
          ['`await idp.users.endSessions(user)`', 'users:write', '`{ browsers, tokens }`', 'Signs the person out of every browser and ends their OAuth and OpenID Connect tokens. Throws for an administrator or a directory user.'],
          ['`await idp.users.resetAuthenticators(user)`', 'users:write', '`{ removed }`', 'Removes every sign-in method the person has, and requires them to set one up again at sign-in.'],
          ['`await idp.users.forgetRemembered(user)`', 'users:write', '`{ browsers }`', 'Makes every browser the person has remembered ask for a second factor again.'],
          ['`await idp.compromise.plan(user)`', 'users:read', '`{ end_sessions, reset_password, rotate_mfa, forget_remembered, lock_account, add_to_group, notify_user, groups, networks, sources }`', 'The lockdown steps that apply to the person, from the Compromised account policies.'],
          ['`await idp.compromise.restrict(user, { networks, lock })`', 'users:write', '`{ started_at, started_by, policy_names, networks, locked_account }`', 'Records the account as in lockdown: sign-in is refused from outside every list in `networks`. With `lock: true` the account is turned off, unless it already was.'],
        ],
      } },
      { heading: 'Groups' },
      { table: {
        head: ['Call', 'Scope', 'Returns', 'Notes'],
        rows: [
          ['`await idp.groups.list()`', 'groups:read', '`Group[]`', 'Every group.'],
          ['`await idp.groups.members(group)`', 'groups:read', '`GroupMember[]`', 'Includes people in nested groups. Throws if the group does not exist.'],
          ['`await idp.groups.addMember(group, user)`', 'groups:write', '`true` if added, `false` if already a member', 'Local groups only. A lapsed membership is renewed. `group` is a name or an ID number. `user` is a GUID, a username or a `User`.'],
          ['`await idp.groups.removeMember(group, user)`', 'groups:write', '`true` if a direct member was removed', 'Local groups only. Removes a direct membership, not a nested one.'],
        ],
      } },
      { heading: 'Outside services' },
      { table: {
        head: ['Call', 'Scope', 'Returns', 'Notes'],
        rows: [
          ['`await http.get(url, { headers })`', 'http', '`HttpResponse`', 'Public addresses only. Redirects are not followed.'],
          ['`await http.post(url, body, { headers })`', 'http', '`HttpResponse`', 'An object `body` is sent as JSON.'],
          ['`http.put(url, body, opts)`, `http.patch(url, body, opts)`, `http.delete(url, opts)`', 'http', '`HttpResponse`', 'The same, for the other methods.'],
          ['`await http.request(HttpRequest)`', 'http', '`HttpResponse`', 'Any method, with its own `timeoutMs`.'],
        ],
      } },
      { heading: 'Messages' },
      { table: {
        head: ['Call', 'Scope', 'Returns', 'Notes'],
        rows: [
          ['`await mail.send(Message)`', 'messaging', '`true`', 'Sent through the email provider under **Settings → Messaging**. An address can receive 5 messages in 10 minutes.'],
          ['`await sms.send(Message)`', 'messaging', '`true`', '`to` is a number such as `+15551234567`.'],
        ],
      } },
      { heading: 'Helpers' },
      { table: {
        head: ['Call', 'Scope', 'Returns', 'Notes'],
        rows: [
          ['`output(...values)`', 'none', 'nothing', 'Prints a line to the Output section of the run\'s page. `output.color(color, ...values)` prints it in a color.'],
          ['`log(...values)`', 'none', 'nothing', 'Writes a normal-level line to the Log section of the run\'s page. `log.debug`, `log.normal`, `log.warning` and `log.error` pick the level; each also has `.color(color, ...values)`. `console.log` and `console.info` are normal, `console.debug` is debug, `console.warn` is warning and `console.error` is error.'],
          ['`await csv.parse(text, { header })`', 'none', '`object[]`, or `string[][]` with `header: false`', 'With `header` on (the default), the first line names the fields. Up to 1 MB.'],
          ['`await util.randomPassword(length)`', 'none', 'string', 'No look-alike characters. Length 8 to 128, default 16.'],
          ['`await util.uuid()`', 'none', 'string', 'A random UUID.'],
          ['`await util.sha256(text)`, `await util.hmacSha256(key, text)`', 'none', 'hex string', 'Digests.'],
          ['`await util.base64Encode(text)`, `await util.base64Decode(text)`', 'none', 'string', 'Base64 of UTF-8 text.'],
          ['`await sleep(ms)`', 'none', '`true`', 'At most 10 seconds of sleep in total for one run.'],
          ['`return value`', 'none', 'the run result', 'Any JSON value, up to 256 KB.'],
        ],
      } },
      { heading: 'Your functions' },
      'Call a function you wrote with `await fn.NAME({ ... })`. It needs no scope of its own: it uses the scopes of the integration that calls it. The starter functions are listed in [Write a reusable function](/help/integration-functions).',
    ],
  },
  {
    slug: 'reference-integration-objects',
    section: 'Integration reference',
    title: 'Reference: integration objects',
    summary: 'The fields of every object a script receives or passes.',
    visible: view,
    body: [
      { heading: 'User' },
      'Returned by `idp.users.find`, `search`, `create` and `update`. Only local accounts are returned.',
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`id`', 'string', 'The GUID. It never changes, so use it to refer to the user elsewhere.'],
          ['`username`', 'string', 'Sign-in name. Unique, ignoring case.'],
          ['`first_name`, `last_name`', 'string', ''],
          ['`display_name`', 'string', 'Defaults to first and last name joined by a space.'],
          ['`email`', 'string', 'The primary address. Unique across all users.'],
          ['`emails`', '`{ email, primary }[]`', 'Every organizational address. Exactly one is primary, and it is also in `email`.'],
          ['`personal_email`', 'string or `null`', 'Recovery address. Never one of the organizational addresses.'],
          ['`employee_id`, `department`, `title`, `phone`', 'string', 'From an HR or payroll system, where you supply them.'],
          ['`upn`, `sam_account_name`, `distinguished_name`, `mail_nickname`', 'string', 'Active Directory style identifiers.'],
          ['`company`, `manager`, `office`, `mobile`, `street_address`, `city`, `state`, `postal_code`, `country`, `description`', 'string', '`manager` is free text: a name, username or DN.'],
          ['`active`', 'boolean', '`false` means the person cannot sign in.'],
          ['`mfa_required`', 'boolean', 'Whether a second factor is required.'],
          ['`attributes`', 'object', 'Name to text value, for the attributes defined under **Settings → User attributes**.'],
          ['`groups`', 'string[]', 'Groups the person was directly added to.'],
          ['`password_changed_at`', 'string or `null`', 'ISO time.'],
          ['`password_changed_via`', 'string or `null`', '`self`, `admin`, `recovery`, `api` or `bulk`. Scripts set passwords as `api`.'],
          ['`created_at`', 'string', 'ISO time.'],
          ['`generated_password`', 'string', 'Only on the result of `create` with `generate_password: true`. Shown once and kept nowhere.'],
        ],
      } },
      { heading: 'NewUser' },
      'What `idp.users.create` accepts. Any field not listed here is refused, so a typo fails instead of being ignored.',
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`username`', 'string', 'Required.'],
          ['all the string fields of `User`', 'string', 'As above.'],
          ['`password`', 'string', 'At least 8 characters. Required unless `generate_password` is `true`.'],
          ['`generate_password`', 'boolean', 'Makes a random password and returns it as `generated_password`.'],
          ['`emails`', 'string or `{ email, primary }`, as a list', 'Extra addresses. Each must be valid and unused. If none is primary, `email` or the first one is.'],
          ['`personal_email`', 'string', 'Treated as verified. Must differ from the organizational addresses.'],
          ['`groups`', 'string[]', 'Local group names. A missing group, or one managed by Grouper or a directory, is an error.'],
          ['`active`', 'boolean', 'Default `true`.'],
          ['`mfa_required`', 'boolean', 'Default `false`.'],
          ['`attributes`', 'object', 'Name to text value.'],
        ],
      } },
      { heading: 'UserPatch' },
      'What `idp.users.update` accepts. Only the fields you include change.',
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['any string field of `User`', 'string', 'Optional. Pass `""` to clear it where that makes sense.'],
          ['`password`', 'string', 'Checked against the password policy for this person. Setting it signs them out everywhere.'],
          ['`emails`', 'list', 'Replaces the whole list. Setting `email` alone changes the primary and keeps the others.'],
          ['`personal_email`', 'string', '`""` clears it.'],
          ['`active`', 'boolean', '`false` also signs the person out everywhere.'],
          ['`mfa_required`', 'boolean', ''],
          ['`attributes`', 'object', '`""` or `null` removes a value. Groups are not changed here: use `groups.addMember` and `groups.removeMember`.'],
        ],
      } },
      { heading: 'Group, GroupMember' },
      { table: {
        head: ['Object', 'Field', 'Type', 'Notes'],
        rows: [
          ['`Group`', '`id`', 'number', 'The group\'s ID number, shown on its page and in the Groups list. It never changes when the group is renamed. Anywhere a script takes a group, you can pass the ID instead of the name.'],
          ['`Group`', '`name`', 'string', 'Unique, ignoring case.'],
          ['`Group`', '`description`', 'string', ''],
          ['`Group`', '`source`', 'string', '`local`, `grouper` or `directory`. Only local groups change.'],
          ['`GroupMember`', '`id`, `username`', 'string', 'The person\'s GUID and username. Includes people in nested groups.'],
        ],
      } },
      { heading: 'HttpRequest and HttpResponse' },
      { table: {
        head: ['Object', 'Field', 'Type', 'Notes'],
        rows: [
          ['`HttpRequest`', '`url`', 'string', 'Required. `http` or `https`, to a public address. Private, loopback and link-local addresses are refused.'],
          ['`HttpRequest`', '`method`', 'string', '`GET` (default), `POST`, `PUT`, `PATCH`, `DELETE` or `HEAD`.'],
          ['`HttpRequest`', '`headers`', 'object', 'Header name to value, such as `{ Authorization: "Bearer " + vars.CRM_KEY }`.'],
          ['`HttpRequest`', '`body`', 'string or object', 'An object is sent as JSON, and `Content-Type` is set unless you set it. Ignored for `GET` and `HEAD`.'],
          ['`HttpRequest`', '`timeoutMs`', 'number', 'Default 10000, at most 30000.'],
          ['`HttpResponse`', '`status`', 'number', 'The HTTP status. A `301` is returned as it is.'],
          ['`HttpResponse`', '`ok`', 'boolean', '`true` for 200 to 299.'],
          ['`HttpResponse`', '`text`', 'string', 'The body, up to 1 MB.'],
          ['`HttpResponse`', '`json`', 'any', 'The body parsed as JSON, or `undefined` if it is not JSON.'],
        ],
      } },
      { heading: 'Message' },
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`to`', 'string', 'Required. An email address, or for `sms.send` a number such as `+15551234567`.'],
          ['`subject`', 'string', 'Email only. Default `"Message"`.'],
          ['`text`', 'string', 'Required. The body.'],
        ],
      } },
      { heading: 'Trigger' },
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`type`', 'string', '`manual`, `webhook`, `schedule`, `event`, or `test` (a run from the console while the integration is off).'],
          ['`at`', 'string', 'ISO time the run started.'],
          ['`event`', 'string', 'Only for `type: "event"`: for example `user.created`.'],
        ],
      } },
      { heading: 'Event' },
      'The `input` of a run started by an event. Which of `user`, `group` and `member` appear depends on the event: see [Reference: events](/help/reference-integration-events).',
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`event`', 'string', 'The event name.'],
          ['`at`', 'string', 'ISO time it happened.'],
          ['`outcome`', 'string', '`"success"`, or `"failure"` for `login.failed`.'],
          ['`actor`', '`{ type, id, name }`', '`type` is `user`, `system`, `anonymous` or `integration`.'],
          ['`target`', '`{ type, id, name }` or `null`', 'What it was done to, as the audit log records it.'],
          ['`detail`', 'object', 'The audit detail, such as `{ via }` for a change or `{ reason }` for a failed sign-in. Secrets are already removed.'],
          ['`user`', '`User` or `null`', 'For user events and `login.succeeded`. Read when the run starts.'],
          ['`group`', 'string', 'The group name, for group events.'],
          ['`member`', 'string', 'The username added or removed, for group events.'],
        ],
      } },
      { heading: 'WebhookResponse' },
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`status`', 'string', '`ok`, `error` or `timeout`.'],
          ['`result`', 'any', 'What the script returned, or `null`.'],
          ['`logs`', '`{ level, text, color, time }[]`', '`level` is `debug`, `normal`, `warning` or `error`.'],
          ['`output`', '`{ text, color, time }[]`', 'What the script printed with `output()`.'],
          ['`error`', '`{ message, line }` or `null`', '`line` is the line of the script, when known.'],
        ],
      } },
    ],
  },
  {
    slug: 'reference-integration-events',
    section: 'Integration reference',
    title: 'Reference: events',
    summary: 'Each event, the audit actions behind it, and the input it sends.',
    visible: view,
    body: [
      'Events are read from the audit log. An event fires for each audit row whose action is listed below, except rows made by an integration.',
      { table: {
        head: ['Event', 'Label in the console', 'Audit actions', 'Input fields'],
        rows: [
          ['`user.created`', 'A user was created', '`user.create`, `user.scheduled_create`', '`user`'],
          ['`user.updated`', 'A user was changed', '`user.update`', '`user`'],
          ['`user.deleted`', 'A user was deleted', '`user.delete`', 'none'],
          ['`user.password_reset`', 'An administrator or API reset a password', '`user.password_reset`', '`user`'],
          ['`user.locked_down`', 'An account was locked down through the user API or the console', '`user.lockdown`', '`user`'],
          ['`group.member_added`', 'Someone was added to a group', '`group.member.add`', '`group`, `member`'],
          ['`group.member_removed`', 'Someone was removed from a group', '`group.member.remove`', '`group`, `member`'],
          ['`login.succeeded`', 'Someone signed in', '`login.success`', '`user`'],
          ['`login.failed`', 'A sign-in failed', '`login.failure`', 'none'],
        ],
      } },
      { heading: 'Every event has these fields' },
      'The base input is `event`, `at`, `outcome`, `actor`, `target` and `detail`, as described in [Reference: integration objects](/help/reference-integration-objects). `user` holds the User affected, or `null` if the account no longer exists. For `login.succeeded`, `user` is the person who signed in.',
      { heading: 'Example' },
      { code: `{
  "event": "user.created",
  "at": "2026-10-01T10:00:00.000Z",
  "outcome": "success",
  "actor": { "type": "user", "id": 1, "name": "admin" },
  "target": { "type": "user", "id": "12", "name": "srivera" },
  "detail": { "via": "console" },
  "user": { "id": "5f0c...", "username": "srivera", "email": "sam@example.net", "active": true, "groups": ["Staff"] }
}` },
      { tip: 'A script that changes a user in response to `user.updated` does not trigger another `user.updated` for the same change, because changes made by an integration are never delivered as events.' },
    ],
  },
  {
    slug: 'reference-integration-variables',
    section: 'Integration reference',
    title: 'Reference: variables and input names',
    summary: 'The built-in read-only values, and the names an input can take.',
    visible: view,
    body: [
      { heading: 'Built-in read-only values' },
      { table: {
        head: ['Name', 'Type', 'What it holds'],
        rows: [
          ['`idp.baseUrl`', 'string', 'The public URL of this server.'],
          ['`idp.appName`', 'string', 'The product name from **Settings → Branding**.'],
          ['`idp.userFields`', 'string[]', 'The user field names that `idp.users.create` and `update` accept, except `username`.'],
          ['`idp.attributes`', 'string[]', 'Names of the attributes defined under **Settings → User attributes**.'],
          ['`idp.channels`', '`{ email, sms, voice }`', 'Whether each messaging channel is set up.'],
          ['`input`', 'any', 'The data the run started with.'],
          ['`trigger`', 'Trigger', 'How the run started. See [Reference: integration objects](/help/reference-integration-objects).'],
          ['`integration`', '`{ id, name }`', 'The integration being run.'],
          ['`vars`', 'object', 'Your variables: `vars.NAME`, or `vars.get("NAME", fallback)`.'],
          ['`fn`', 'object', 'Your functions: `await fn.NAME({ ... })`.'],
        ],
      } },
      { heading: 'User field names' },
      'These are the names of the user fields, usable as inputs and in `NewUser` and `UserPatch`:',
      { code: 'username, first_name, last_name, display_name, email, employee_id, department, title, phone,\nupn, sam_account_name, distinguished_name, mail_nickname, company, manager, office, mobile,\nstreet_address, city, state, postal_code, country, description' },
      { heading: 'Other input names' },
      { table: {
        head: ['Name', 'What it holds'],
        rows: [
          ['`active`', 'Whether the person can sign in. Default `true` for new users.'],
          ['`actor`', 'Event: who did it, as `{ type, id, name }`.'],
          ['`at`', 'Event: the ISO time it happened.'],
          ['`attributes`', 'Name to text value, for the attributes defined under **Settings → User attributes**.'],
          ['`days`', 'A number of days, such as 90.'],
          ['`detail`', 'Event: the audit detail, such as `{ via }`. Secrets are removed.'],
          ['`emails`', 'Extra addresses: strings or `{ email, primary }` objects.'],
          ['`event`', 'Event: the event name, such as `user.created`.'],
          ['`generate_password`', '`true` to have a random password made and returned as `generated_password`.'],
          ['`group`', 'Group events: the group name.'],
          ['`groups`', 'Local group names the person belongs to, or is added to.'],
          ['`items`', 'A list of values, or of objects, to work through.'],
          ['`key`', 'The field to compare by, such as `email`.'],
          ['`member`', 'Group events: the username added or removed.'],
          ['`mfa_required`', 'Whether the person must use a second factor.'],
          ['`outcome`', 'Event: `success`, or `failure` for a failed sign-in.'],
          ['`password`', 'A password to set, checked against the password policy.'],
          ['`personal_email`', 'A recovery address, kept apart from the organizational ones.'],
          ['`request`', 'An HTTP request: `{ url, method, headers, body }`.'],
          ['`scheduled_for`', 'Schedule: the ISO time the run was due.'],
          ['`size`', 'How many items go in each part.'],
          ['`target`', 'Event: what it was done to, as `{ type, id, name }`, or `null`.'],
          ['`text`', 'Text to convert, such as a title to make into a slug.'],
          ['`user`', 'Event: the User affected, or for a sign-in the person who signed in. `null` if they no longer exist.'],
          ['`value`', 'A value to read as yes or no, such as `"yes"`, `"off"` or `true`.'],
        ],
      } },
      { tip: 'The **Inputs** name list shows the same names, with a description of each. You can type a name that is not in the list.' },
    ],
  },
  {
    slug: 'reference-integration-limits',
    section: 'Integration reference',
    title: 'Reference: limits, scopes and security',
    summary: 'What each scope allows, the limits on every run, and what scripts can never change.',
    visible: view,
    body: [
      { heading: 'Scopes' },
      { table: {
        head: ['Scope', 'Allows', 'Functions'],
        rows: [
          ['`users:read`', 'Look up and search users.', '`idp.users.find`, `search`, `suggestUsername`'],
          ['`users:write`', 'Create, change, deactivate and delete ordinary users.', '`idp.users.create`, `update`, `delete`'],
          ['`groups:read`', 'List groups and their members.', '`idp.groups.list`, `members`'],
          ['`groups:write`', 'Add and remove members of local groups.', '`idp.groups.addMember`, `removeMember`'],
          ['`http`', 'Call outside web services, at public addresses only.', '`http.*`'],
          ['`messaging`', 'Send email and text messages.', '`mail.send`, `sms.send`'],
        ],
      } },
      'Helpers such as `log`, `csv.parse`, `sleep` and `util.*` need no scope. A function you wrote (`fn.NAME`) needs none either: it runs with the scopes of the caller.',
      { heading: 'Limits for each run' },
      { table: {
        head: ['Limit', 'Value'],
        rows: [
          ['Time', '1 to 60 seconds, set per integration. The default is 10. The run is stopped when it passes the limit.'],
          ['Calls', '2000 calls to `idp`, `http`, `mail`, `sms`, `csv`, `util` and `sleep` combined.'],
          ['Web requests', '50 `http` calls.'],
          ['Messages', '25 `mail` and `sms` sends.'],
          ['Sleep', '10 seconds in total.'],
          ['Memory', '96 MB.'],
          ['Script size', '100,000 characters.'],
          ['Input size', '1 MB.'],
          ['Result size', '256 KB.'],
          ['Log lines', '200 per run.'],
          ['Run history', 'The latest 50 runs of each integration.'],
          ['Concurrency', 'Scheduled and event runs go through one queue, one at a time. Up to 100 can wait.'],
          ['Schedules', 'Every 5 to 10080 minutes, or daily, weekday, weekly, monthly (day 1 to 28) or custom. Up to 10 per integration. Always UTC.'],
        ],
      } },
      { heading: 'What a script can never change' },
      { bullets: [
        'An administrator account.',
        'A user whose account an external directory owns.',
        'A role. A script cannot grant roles.',
        'A group managed by Grouper or a directory. Only local groups change.',
      ] },
      { heading: 'Outside calls' },
      '`http` calls go to public addresses only. Redirects are not followed. An administrator can allow private addresses by setting `ALLOW_PRIVATE_FETCH=true` on the server.',
      { heading: 'Audit and redaction' },
      { bullets: [
        'Every change a script makes is audited with the actor `integration:<name>`.',
        'Changing an integration is audited without its script text. Changing a variable is audited without its value.',
        'A field in a stored input or result whose name looks like a password, secret or token is saved as `[redacted]`.',
        'A secret variable\'s value appears as `[secret]` in run output, logs, results and errors.',
      ] },
      { tip: 'These limits contain mistakes and runaway loops. They are not a defence against a hostile administrator. Give `integrations.manage` only to people you trust with the scopes you grant.' },
    ],
  },
  {
    slug: 'integration-examples',
    section: 'Integration scripts',
    title: 'Integration examples',
    summary: 'Complete scripts for common jobs: an HR feed, a webhook and an event.',
    visible: view,
    body: [
      { heading: 'Create people from an HR feed' },
      'Start this from a schedule or a webhook. Its input is `{ people: [...] }`, where each person has `employee_id`, `first`, `last` and `email`. It needs the `users:read`, `users:write` and `groups:write` scopes.',
      { code: `// Input: { people: [{ employee_id, first, last, email }] }
const results = [];
for (const p of input.people) {
  const email = await fn.normalizeEmail({ email: p.email });
  if (!email) {
    log("skipped, no usable address:", p.employee_id);
    continue;
  }
  const { user, created } = await fn.findOrCreateUser({
    email, first_name: p.first, last_name: p.last, groups: ["Staff"],
  });
  results.push({ username: user.username, created });
}
return results;` },
      'This uses the starter `normalizeEmail` and `findOrCreateUser` functions. It does not return a generated password: send one with `mail.send` if you need to.',
      { heading: 'Add a user to a group from a webhook' },
      'Scopes: `users:read` and `groups:write`.',
      { code: `// Input: { employee_id, group }
const user = await idp.users.find({ employee_id: input.employee_id });
if (!user) throw new Error("No user with employee ID " + input.employee_id);
const added = await idp.groups.addMember(input.group, user.username);
return { user: user.username, added };` },
      { heading: 'Welcome new users by email' },
      'Trigger: the event `user.created`. Scopes: `users:read` and `messaging`.',
      { code: `// Input: an Event. input.user is the new User.
const u = input.user;
if (!u || !u.email) return "no address";
await mail.send({
  to: u.email,
  subject: "Welcome, " + (u.first_name || u.username),
  text: "Your account " + u.username + " is ready. Sign in at " + idp.baseUrl + ".",
});
return "sent";` },
      { heading: 'Pull a list from a web service' },
      'Scope: `http`. Uses the starter `requestJson` function, and a key kept in a secret variable named `CRM_API_KEY`.',
      { code: `const people = await fn.requestJson({
  request: {
    url: vars.CRM_URL + "/v1/people?active=true",
    headers: { Authorization: "Bearer " + vars.CRM_API_KEY },
  },
});
return { count: people.length };` },
    ],
  },
  {
    slug: 'write-scripts-with-an-ai-assistant',
    section: 'Integration scripts',
    title: 'Write scripts with an AI assistant',
    summary: 'Give an AI assistant the script reference, then check and test what it writes.',
    visible: view,
    body: [
      'The script reference lists every variable, object, function and limit a script can use. Copy it as plain text, or download it as a file, and give it to an AI assistant so the code it writes matches this server.',
      { heading: 'Get the reference' },
      { steps: [
        'Open **Integrations** and select the **Reference** tab. The same content is in an integration\'s editor, under **Variables and functions available to scripts**.',
        'Select **Copy as text** to copy the whole reference to the clipboard, or **Download as text** to save it as `integration-script-reference.txt`.',
      ] },
      'The text has no formatting and should be easy to paste or upload to your chat. It is made from this server, so it lists only what this server really has.',
      { heading: 'Ask for a script' },
      { steps: [
        'Start a new chat with the assistant and paste the copied text, or attach the downloaded file.',
        'Describe the job in plain words: what starts the run (a schedule, a webhook, an event or a manual run), what arrives in `input`, and which systems it should change.',
        'Ask the assistant to name the scopes the script needs and the variables it reads, and to use only the functions in the reference.',
        'Ask for a script that `return`s a result and reports progress with `output` or `log`.',
      ] },
      { warning: 'You are responsible for checking with your organization\'s policies regarding the use of AI with potentially restricted data.' },
      { heading: 'Check it before you save' },
      { bullets: [
        'Compare each function call with the reference. An assistant can invent a function or a field name. If it is not in the reference, it does not exist here.',
        'Check the scopes. A function that needs a scope the integration does not have throws an error, so give the integration only the scopes the script uses.',
        'Put URLs, keys and other settings in variables, and read them with `vars`. Do not paste passwords, API keys or real personal data into the chat. Name the variable instead, and keep a key in a secret variable.',
        'Add a row under **Inputs** for each name the script reads from `input`, so the form and the script agree.',
        'Start from a recipe in the reference when one is close to the job. Ask the assistant to change its names, groups and variables to match your systems.',
      ] },
      { warning: 'You are responsible for code you try to run! AI can get things wrong, so always run potentially destructive commands in a safe environment and double-check results.'},
      { tip: 'Save the script, then run it on a test input first. Check the **Output** and **Log** sections of the run\'s page. A script that changes accounts should be tried on one person before it runs on everyone.' },
      { heading: 'Keep it current' },
      'The reference changes when the server is updated. If a script fails with an unknown function or a missing scope, copy the reference again and ask the assistant to check the code against it.',
    ],
  },
];
