// Help articles for reports: writing custom reports, and the reference for the functions they call.
// Block types are described in integrations.js.

import { holds } from './visibility.js';

const view = holds('reports.view');
const write = holds('reports.manage');

export const REPORT_ARTICLES = [
  {
    slug: 'write-a-report',
    section: 'Reports',
    title: 'Write a custom report',
    summary: 'Write a script that returns a table, then run and download it.',
    visible: write,
    body: [
      { steps: [
        'Open **Reports** from the module menu and select **New report**. To start from a built-in report instead, open it and select **Copy to a new report**.',
        'Type a **Name** and an optional **Description**.',
        'Set **Time limit (seconds)**. It can be from 1 to 60, and the default is 20.',
        'Write the **Script**. See the rules below.',
        'Select **Create report**. Once it exists, a change is saved with **Save**.',
        'To run it, type JSON in **Input (JSON)** if the script reads `input`, then select **Run report**.',
      ] },
      { heading: 'The rules' },
      { bullets: [
        'The script is the body of an `async` function, so `await` works anywhere.',
        '`return` an array of objects to show a table. Each object is a row. Any other value is shown as JSON.',
        'The value you type under **Input (JSON)** arrives as `input`. Its default is the report\'s own default input, such as `{ days: 7 }`.',
        'Reports can only read. They cannot change anything, call an outside service, send a message or see integration variables.',
        'A report runs with the access of whoever runs it, not whoever wrote it. Each `report.*` call checks the runner\'s permissions and fails with a message that names the missing one.',
        'The same sandbox as integrations applies: no `require`, `process`, `fetch` or `eval`. You also get `log()`, `csv.parse` and `util.*`.',
      ] },
      { heading: 'Example' },
      { code: `// Active users in one department, with how many groups each belongs to.
const dept = input.department || "Underwater Basket-Weaving";
const users = await report.users({ active: true });
return users
  .filter((u) => u.department === dept)
  .map((u) => ({ username: u.username, email: u.email, groups: u.groups.length }))
  .sort((a, b) => a.username.localeCompare(b.username));` },
      { code: `// Successful sign-ins from outside the United States in the last week.
const events = await report.signIns({ days: 7, outcome: "success", limit: 5000 });
return events
  .filter((e) => e.country && e.country !== "US")
  .map((e) => ({ time: e.time, username: e.username, country: e.country, ip: e.ip }));` },
      { heading: 'Results and download' },
      { bullets: [
        'The result appears as a table in the browser. **Download CSV** saves the same rows as a file.',
        'A result can be up to 4 MB. It is returned to the person who ran the report and is not stored.',
        'Cells in the CSV that start with `=`, `+`, `-` or `@` get an apostrophe in front, so a spreadsheet does not run them as formulas.',
      ] },
      { heading: 'Limits' },
      { table: {
        head: ['Limit', 'Value'],
        rows: [
          ['Time', '1 to 60 seconds, set per report. The default is 20.'],
          ['Script size', '100,000 characters.'],
          ['Memory', '96 MB.'],
          ['Rows from `report.users`', 'Up to 20,000.'],
          ['Rows from `report.signIns` and `report.audit`', 'Up to 5,000 per call, from up to 365 days back.'],
          ['Result size', '4 MB.'],
          ['Reports', 'Up to 200.'],
        ],
      } },
      { tip: 'Running a report is audited as `report.run`, with its name, outcome and duration. The rows are not recorded.' },
    ],
  },
  {
    slug: 'reference-report-functions',
    section: 'Reports',
    title: 'Reference: report functions',
    summary: 'The four functions reports call, what each needs, and the fields each returns.',
    visible: view,
    body: [
      { table: {
        head: ['Call', 'Needs', 'Parameters', 'Returns'],
        rows: [
          ['`await report.users({ active?, limit? })`', '`users.view`', '`active`: `true` or `false` to filter, omitted for all. `limit`: 1 to 20000, default 20000.', 'One object per user, below. Ordered by username.'],
          ['`await report.groups()`', '`groups.view`', 'None.', 'One object per group, below.'],
          ['`await report.signIns({ days?, type?, outcome?, username?, country?, ip?, limit? })`', '`audit.view`', '`days`: 1 to 365, default 7. `limit`: 1 to 5000, default 1000. `type`, `outcome`, `username`, `country` and `ip` filter the rows.', 'One object per sign-in, newest first, below.'],
          ['`await report.audit({ days?, category?, action?, outcome?, actor?, limit? })`', '`audit.view`', '`days` and `limit` as for `signIns`. `category`, `action`, `outcome` and `actor` filter the rows.', 'One object per audit entry, newest first, below.'],
        ],
      } },
      'A call the runner may not make throws an error that names the permission, so the report can catch it with `try`/`catch`. Each function also needs the runner, not the author, to hold the permission.',
      { heading: 'report.users' },
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`id`', 'string', 'The GUID.'],
          ['`username`, `first_name`, `last_name`, `display_name`', 'string', ''],
          ['`email`, `employee_id`, `department`, `title`, `company`, `manager`', 'string', ''],
          ['`active`', 'boolean', '`false` means the person cannot sign in.'],
          ['`mfa_required`', 'boolean', 'Whether a second factor is required.'],
          ['`source`', 'string', '`local` or `directory`.'],
          ['`groups`', 'string[]', 'Groups the person was directly added to.'],
          ['`attributes`', 'object', 'Name to value, for the defined attributes.'],
          ['`password_changed_at`, `created_at`', 'string or `null`', 'ISO times.'],
          ['`last_sign_in`', 'string or `null`', 'ISO time of the last successful sign-in. Filled in only when the runner also holds `audit.view`.'],
        ],
      } },
      { heading: 'report.groups' },
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`name`', 'string', ''],
          ['`description`', 'string', ''],
          ['`source`', 'string', '`local`, `grouper` or `directory`.'],
          ['`members`', 'number', 'The number of members, including people in nested groups.'],
        ],
      } },
      { heading: 'report.signIns' },
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`time`', 'string', 'ISO time.'],
          ['`type`', 'string', 'The kind of sign-in event.'],
          ['`outcome`', 'string', '`success` or `failure`.'],
          ['`reason`', 'string or `null`', 'Why it failed, when it did.'],
          ['`username`, `factor`', 'string or `null`', 'The person, and the second factor used, if any.'],
          ['`ip`, `country`, `city`', 'string or `null`', 'Where the request came from.'],
          ['`browser`, `os`, `device_type`', 'string or `null`', 'What the request came from.'],
          ['`risk_level`, `risk_score`', 'string or number', 'The risk assessment, when risk-based sign-in is on.'],
        ],
      } },
      { heading: 'report.audit' },
      { table: {
        head: ['Field', 'Type', 'Notes'],
        rows: [
          ['`time`', 'string', 'ISO time.'],
          ['`category`', 'string', 'The audit category, such as `admin`.'],
          ['`action`', 'string', 'The action, such as `user.update`.'],
          ['`outcome`', 'string', '`success` or `failure`.'],
          ['`actor`', 'string', 'Who did it. Integrations appear as `integration:<name>`.'],
          ['`target_type`, `target`', 'string or `null`', 'What it was done to.'],
          ['`ip`', 'string or `null`', 'Where it was done from.'],
          ['`detail`', 'object', 'Extra detail. Secrets are removed.'],
        ],
      } },
    ],
  },
  {
    slug: 'reference-built-in-reports',
    section: 'Reports',
    title: 'Reference: built-in reports',
    summary: 'The reports that ship with Pons Identity, what each needs, and its columns.',
    visible: view,
    body: [
      'Each built-in report is an ordinary report script. Open one to read its code, and select **Copy to a new report** to change it.',
      { table: {
        head: ['Report', 'Needs', 'Input', 'Columns'],
        rows: [
          ['**Active users without MFA**', '`users.view`', 'none', '`username`, `name`, `email`, `department`, `source`'],
          ['**Deactivated users**', '`users.view`', 'none', '`username`, `name`, `email`, `created_at`, `last_sign_in`'],
          ['**Old passwords**', '`users.view`', '`days`, default 365', 'Local accounts only: `username`, `name`, `email`, `password_changed_at`, oldest first'],
          ['**Users by department**', '`users.view`', 'none', '`department`, `active`, `inactive`, most active first'],
          ['**Group sizes**', '`groups.view`', 'none', 'Each group, with `name`, `description`, `source` and `members`, smallest first'],
          ['**Failed sign-ins by user**', '`audit.view`', '`days`, default 7', '`username`, `failures`, `addresses`, `last_failure`, most failures first'],
          ['**Administrative changes**', '`audit.view`', '`days`, default 30', '`time`, `actor`, `action`, `target`, `outcome`, newest first'],
        ],
      } },
      { tip: 'A built-in report shows **Needs** and a permission name when you do not hold that permission. Ask an administrator for it.' },
    ],
  },
];
