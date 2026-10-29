// Help articles. Each one is shown only when its `visible` test passes for the signed-in person.
// Blocks: a string is a paragraph; { steps } is a numbered list; { tip } is a short note; { warning } is a caution.
// Text may use **bold** for button and field names.

import { everyone, admin, holds } from './visibility.js';
import { INTEGRATION_ARTICLES } from './integrations.js';
import { GROUPER_ARTICLES } from './grouper.js';
import { REPORT_ARTICLES } from './reports.js';
import { PROTOCOL_ARTICLES } from './protocols.js';
import { FEDERATION_ARTICLES } from './federation.js';
import { SETUP_ARTICLES } from './setup.js';
import { MIGRATION_ARTICLES } from './migration.js';

// Sections appear in this order on the help index.
// Headings on the help index, in order. Each follows a console module or one of its settings tabs.
export const SECTIONS = [
  'Your account',
  'Admin console',
  'Users',
  'Groups',
  'Roles',
  'Single sign-on',
  'Policies',
  'Sign-in factors',
  'Risk-based sign-in',
  'Messaging and recovery',
  'Branding',
  'Network devices',
  'API',
  'Reports',
  'Audit and sign-in logs',
  'Setup and migration',
  'Data export',
  'Integrations',
  'Integration access',
  'Integration scripts',
  'Integration reference',
  'Grouper',
  'Federation',
  'Upgrades',
];

const CORE_ARTICLES = [
  {
    slug: 'open-an-application',
    section: 'Your account',
    title: 'Open an application',
    summary: 'Sign in to a service through this identity provider.',
    visible: everyone,
    body: [
      { steps: [
        'Open the application the way you normally do, from its own website or app.',
        'When it sends you to the sign-in page, sign in here. If you are already signed in, you go straight back to the application.',
      ] },
      { tip: 'Only enter your password on the sign-in page of your organization. If an application asks for it directly, stop and contact an administrator.' },
    ],
  },
  {
    slug: 'change-password',
    section: 'Your account',
    title: 'Change your password',
    summary: 'Set a new password from your profile.',
    visible: everyone,
    body: [
      { steps: [
        'Select your name in the top bar, then select **Profile**.',
        'In the **Password** section, type your **Current password**.',
        'Type your **New password**, then type it again in **Confirm new password**.',
        'Select **Change password**.',
      ] },
      'If the **Password** section says your password is managed by your directory, change it in your directory instead.',
    ],
  },
  {
    slug: 'change-color-theme',
    section: 'Your account',
    title: 'Change the color theme',
    summary: 'Switch between light, dark and system colors.',
    visible: everyone,
    body: [
      { steps: [
        'Select your name in the top bar, then select **Profile**.',
        'Scroll to **Color theme**.',
        'Select **System**, **Light** or **Dark**.',
      ] },
      'Your choice is saved in this browser only.',
    ],
  },
  {
    slug: 'set-up-authenticator-app',
    section: 'Your account',
    title: 'Set up an authenticator app',
    summary: 'Add a six-digit code app to your sign-in.',
    visible: everyone,
    body: [
      { steps: [
        'Select your name in the top bar, then select **Profile**.',
        'In the **Authenticator app** section, scan the QR code with your authenticator app. If you cannot scan it, select **Copy key** and enter the key in the app by hand.',
        'Type the six-digit code that your app shows into the **Six-digit code** field.',
        'Select **Turn on**.',
      ] },
    ],
  },
  {
    slug: 'remove-authenticator-app',
    section: 'Your account',
    title: 'Remove your authenticator app',
    summary: 'Turn off the authenticator app for your account.',
    visible: everyone,
    body: [
      { steps: [
        'Select your name in the top bar, then select **Profile**.',
        'In the **Authenticator app** section, type a current six-digit code into the **Six-digit code** field.',
        'Select **Remove authenticator**.',
      ] },
      'If the **Authenticator app** section says an administrator requires MFA for your account, you cannot remove it. Contact your administrator.',
    ],
  },
  {
    slug: 'add-security-key',
    section: 'Your account',
    title: 'Add a security key or passkey',
    summary: 'Register a hardware key or passkey to sign in.',
    visible: everyone,
    body: [
      { steps: [
        'Select your name in the top bar, then select **Profile**.',
        'In the **Other ways to verify** section, type a name for the key in **Name for this key**, such as "Desk key".',
        'Select **Add a security key**.',
        'Follow your browser\'s prompts to touch your key or confirm with your device.',
      ] },
      'If you do not see this option, your administrator has not turned on security keys yet.',
    ],
  },
  {
    slug: 'add-email-text-or-call',
    section: 'Your account',
    title: 'Add email, text or phone call codes',
    summary: 'Verify sign-ins with a code sent to your email or phone.',
    visible: everyone,
    body: [
      { steps: [
        'Select your name in the top bar, then select **Profile**.',
        'In the **Other ways to verify** section, open the **Add** menu and choose **Email**, **Text message** or **Phone call**.',
        'Type your email address or phone number, such as +15551234567, and select **Send a code**.',
        'Type the code you receive into the code field and select **Confirm**.',
      ] },
      'If you do not see these options, your administrator has not turned them on.',
    ],
  },
  {
    slug: 'add-recovery-email',
    section: 'Your account',
    title: 'Add a personal recovery email',
    summary: 'Use a personal email address to reset a forgotten password.',
    visible: everyone,
    body: [
      { steps: [
        'Select your name in the top bar, then select **Profile**.',
        'In the **Password recovery** section, type your personal email address in **Personal email address**.',
        'Type your **Current password**, then select **Send a code**.',
        'Type the code from that address into the code field and select **Confirm**.',
      ] },
      'Use an address other than your work address, so you can still reach it if you lose access to your work email.',
    ],
  },
  {
    slug: 'understand-sign-in-factors',
    section: 'Your account',
    title: 'Understand sign-in factors',
    summary: 'What each way of proving it is you is, and which ones resist phishing.',
    visible: everyone,
    body: [
      'Your password is the first step. A **factor** is a second way to prove it is you, such as a code from your phone or a key you tap. Some sign-ins ask for one; a policy can require one for a role or group.',
      { table: {
        head: ['Factor', 'What you do', 'Phishing resistant'],
        rows: [
          ['Authenticator app', 'Type the six-digit code the app shows.', 'No'],
          ['Security key or passkey', 'Insert the key and touch it, or confirm with your device.', 'Yes'],
          ['Email, text or phone call code', 'Type the code sent to you.', 'No'],
          ['Number matching by email, text or phone call', 'Enter the number shown on the sign-in page on the device that got the message, or on the phone keypad for a call.', 'Yes'],
        ],
      } },
      { heading: 'Why phishing resistant matters' },
      'A fake sign-in page can ask for your password and any code you type into it, then use them before you do. A security key only answers the site it was registered on, so a fake page gets nothing from it. Number matching works the same way: nothing is typed into the sign-in page, so there is no code for a fake page to collect.',
      { tip: 'When you can, use a security key or passkey. Check that the address bar shows the right site before you type a password or code.' },
      'Your administrator decides which factors are available. To add one, see [Add a security key or passkey](/help/add-security-key) or [Add email, text or phone call codes](/help/add-email-text-or-call).',
    ],
  },
  {
    slug: 'join-or-leave-group',
    section: 'Groups',
    title: 'Join or leave a group',
    summary: 'Add yourself to a group you may join, or step out of one.',
    visible: ({ me }) => Boolean(me.self_service),
    body: [
      { steps: [
        'Select **My groups** in the top bar.',
        'To join a group, find it in the list of groups you can join and select **Join**.',
        'To leave a group, find it in your list of groups and select **Leave**.',
      ] },
    ],
  },
  {
    slug: 'manage-group-members',
    section: 'Groups',
    title: 'Add and remove members of your group',
    summary: 'Manage the people in a group you run.',
    visible: ({ me }) => Boolean(me.manages_groups),
    body: [
      { steps: [
        'Select **My groups** in the top bar.',
        'Select the group you manage.',
        'To add someone, type their name in **Add people** and choose them. Select **Add**.',
        'To remove someone, find them in the member list and select **Remove**.',
      ] },
    ],
  },
  {
    slug: 'attest-group-membership',
    section: 'Groups',
    title: 'Attest to a group\'s membership',
    summary: 'Confirm, when it is due, that the people in a group you manage still belong there.',
    visible: ({ me }) => Boolean(me.manages_groups) || Boolean(me.is_admin),
    body: [
      'Attestation is a regular check that a group\'s membership is still right. People who manage a group (group managers) are asked to confirm it, on a schedule, so that people who have changed roles or left are not left with access they no longer need.',
      { heading: 'When you need to attest' },
      { bullets: [
        'A group with an attestation schedule is **Up to date**, **Due soon** (within 14 days) or **Overdue**. The status shows on the group\'s **Managers & attestation** tab.',
        'You can attest if you are one of the group\'s managers, or if you have admin access to the group.',
      ] },
      { heading: 'To attest' },
      { steps: [
        'Select **My groups** in the top bar and select the group. (Administrators can also open it from **Groups** in the module menu.)',
        'Look through the **Members** tab. The list of effective members marks each person **Direct**, **Indirect** or **Direct, Indirect**, so you can see who was added on purpose and who is in through a member group.',
        'Remove anyone who should no longer be in the group. A person who is only indirectly a member cannot be removed here: take them out of the member group instead.',
        'Select the **Managers & attestation** tab.',
        'Optionally type a **Note**, for example "Removed two contractors".',
        'Select **Attest membership**.',
      ] },
      { tip: 'Attesting records who attested, when, and the list of members at that moment. It also moves the next due date one period on. The record is in **Attestation history** and cannot be edited.' },
    ],
  },
  {
    slug: 'build-group-from-ldap-query',
    section: 'Groups',
    title: 'Build a group\'s members from an LDAP query',
    summary: 'Let a query decide who is in a group, once or continuously, and read how each person got there.',
    visible: holds('groups.manage'),
    body: [
      'A group can take its members from an LDAP query over the people in this system, such as everyone in Underwater Basket-Weaving who has a title containing "Master Weaver". You can run the query once (a snapshot) or keep the group in step with it (ongoing).',
      { steps: [
        'Open **Groups** from the module menu and select the group. Groups managed in Grouper or a directory, and composite groups, cannot use a query.',
        'Select the **Membership query** tab.',
        'Type a query that starts with **(**, or select **Query builder** to build one from conditions. The builder writes the query, checks its syntax and tells you how many people match.',
        'Choose **Ongoing** or **Snapshot**, then select **Save and start** (or **Run once**).',
      ] },
      { bullets: [
        '**Snapshot** adds whoever matches now as ordinary members. Nothing is tracked afterwards; select **Run again now** to add whoever matches later.',
        '**Ongoing** re-runs the query every few minutes and after people are created or changed. People are added when they start to match and removed when they stop. People you added by hand are never removed by the query.',
        'The query reads the same attributes as the people search: `uid`, `cn`, `mail`, `department`, `title`, `memberOf` and the rest. The builder lists them.',
        'Removing the query keeps the people it added as ordinary members.',
      ] },
      { heading: 'How a person ended up in the group' },
      'The member list says how each person is in the group: **Direct** (added to this group, by hand or by its query), **Indirect** (in through a member group or a composite) or **Direct, Indirect** (both). A note under it names the member group they came through, or says they were added by the query. A person\'s own page lists their groups the same way.',
    ],
  },
  {
    slug: 'run-an-integration',
    section: 'Your account',
    title: 'Run an integration you have been given',
    summary: 'Use a task an administrator opened to your group, such as resetting a password.',
    visible: ({ me }) => Boolean(me.runs_integrations),
    body: [
      'An integration is a task an administrator set up, for example resetting a person\'s password. Administrators can open specific ones to a group, so you can do that one job without being given broader access.',
      { steps: [
        'Select **Run an integration** in the top bar.',
        'Find the task, fill in the boxes it asks for (for example the username), and select **Run**.',
        'Read the **Output**, **Log** and **Result** tabs to see what happened. If something failed, the error says why.',
      ] },
      { tip: 'Every run is recorded in the audit log under your name.' },
    ],
  },
  {
    slug: 'let-groups-run-integrations',
    section: 'Integration access',
    title: 'Let a group run an integration',
    summary: 'Open one integration to a group, such as the help desk, without giving them the Integrations permission.',
    visible: holds('integrations.manage'),
    body: [
      { steps: [
        'Open **Integrations** and select the integration.',
        'Under **Who can run it**, choose one or more groups in **Groups that may run it**.',
        'Select **Save**.',
      ] },
      { bullets: [
        'Members of those groups (including through nested groups) see **Run an integration** in the top bar and can run only the integrations opened to them. They cannot read or edit the script, its variables or its history.',
        'The integration runs with its own scopes, not the runner\'s. Give it only the scopes the task needs, and open it only to people you trust with that.',
        'Built-in integrations such as **Password reset** are ready to use but are not opened to anyone until you do this.',
      ] },
    ],
  },
  {
    slug: 'integration-files',
    section: 'Integration access',
    title: 'Files and SFTP access',
    summary: 'Where integrations keep files, which directories they may use, and how other software exchanges files with them over SFTP.',
    visible: holds('integrations.view'),
    body: [
      'The **files module** keeps the files integrations write and read, and the files other software exchanges with them. Browse it under **Integrations → Files**. A script reaches its own folder, `/integrations/integration-<id>`, with relative paths such as `users.csv`, and the directories an administrator has granted it under **Directories it may use**, with absolute paths such as `/exports/hr/users.csv`. Give the integration the **files** scope to use files, and the **sftp** scope to exchange them with another system.',
      { heading: 'Write a CSV for another system' },
      { code: `const people = await idp.users.search({ limit: 200 });
await files.write('users.csv', await csv.stringify(people, { columns: ['username', 'email', 'department'] }));
await files.write('/exports/hr/users.csv', await csv.stringify(people)); // only if /exports/hr is granted` },
      { bullets: [
        'Other systems collect the file from **Integrations → Files**, or over SFTP as a service account granted that folder.',
        '`csv.stringify` puts a quote in front of any cell that starts with `=`, `+`, `-` or `@`, so a spreadsheet does not run it as a formula.',
      ] },
      { heading: 'Bring in a file over SFTP' },
      { code: `const hr = { host: 'sftp.example.com', username: 'idp', privateKey: vars.SFTP_KEY, hostFingerprint: 'SHA256:...' };
await sftp.download(hr, '/outgoing/people.csv', 'people.csv');
const rows = await csv.parse(await files.read('people.csv'));` },
      { bullets: [
        'Keep the password or private key in a **secret variable** (Integrations → Variables), not in the script.',
        '`hostFingerprint` is the server\'s key as `ssh-keygen -lf` prints it. It makes sure you are talking to the right server; without it the connection is refused (unless the script sets `insecureSkipHostCheck: true`).',
        'Only public addresses can be reached. A file is at most 10 MB.',
        'Every SFTP operation is written to the audit log.',
      ] },
      { heading: 'Let other software use the files' },
      { steps: [
        'Turn on the SFTP server under **Integrations → Files**, choose its port (2222 by default), and save. The page shows the server\'s key fingerprint.',
        'Under **Users → Service accounts**, make an account for the software, with a password or an SSH public key, and the directories it may use: read, write, or read and write. A drop box for a partner is write only.',
        'The software connects with `sftp -P 2222 name@server` and signs in with that account. It sees only the directories it was granted.',
      ] },
      { tip: 'The built-in **Import users from a CSV file** and **Export users to a CSV file** integrations show these calls in use. The README describes the module, the grants and the SFTP server in full under *Files and SFTP access*.' },
    ],
  },
  {
    slug: 'run-integration-from-api',
    section: 'Integration access',
    title: 'Run an integration from the REST API',
    summary: 'Let other software start an integration and read its result.',
    visible: holds('integrations.manage', 'userapi.manage'),
    body: [
      { steps: [
        'On the integration\'s page, turn on **Allow API requests to run this** and save.',
        'In **API → User API**, create a token with the **integrations:run** scope.',
        'Send `POST /api/v1/integrations/<id>/runs` with `Authorization: Bearer <token>` and a body like `{ "input": { "username": "srivera" } }`.',
      ] },
      { bullets: [
        'The response is the run: `status`, `result`, `output`, `logs` and `error`. It is `201` even when the script failed, so check `status`.',
        '`GET /api/v1/integrations` lists the integrations open to the API, and `GET /api/v1/integrations/<id>/runs/<runId>` reads a run again.',
        'The script runs with the integration\'s own scopes. An `Idempotency-Key` header stops a repeated request from running it twice.',
        'The full description is in the API reference linked from API → User API.',
      ] },
    ],
  },
  {
    slug: 'set-up-radius',
    section: 'Network devices',
    title: 'Let network devices sign people in with RADIUS',
    summary: 'Use this server as the RADIUS identity server for VPNs, switches and wireless networks.',
    visible: holds('radius.manage'),
    body: [
      'RADIUS is the protocol many network devices use to ask a central server whether a person may sign in. Turn it on here and the device sends the person\'s username and password to this server, which answers Accept or Reject using the same account, password and second-factor rules as the sign-in page.',
      { heading: 'Turn it on' },
      { steps: [
        'Open **Settings** from the module menu and select **RADIUS**.',
        'Select **Add a client** for each device (or range of devices). Give it a **Name**, its **Address** (one address, or a range such as 10.0.0.0/24) and a **Shared secret**. Select **Generate** for a strong one, and type the same secret into the device.',
        'Optionally limit **Who may sign in through this client** to some groups, and add **Attributes sent with an acceptance**, for example a VLAN for members of a group.',
        'Switch on **Answer RADIUS requests** and select **Save**. The server shows **Listening** when it is ready.',
        'On the device, set this server\'s address and the UDP port (1812 by default) as its RADIUS server, with PAP as the method.',
      ] },
      { heading: 'Second factors' },
      { bullets: [
        'A person with an authenticator app is asked for the code. By default the device shows a prompt and sends the code back (**Ask for the code after the password**). Choose **The person types the code right after the password** for a device that cannot show a prompt: the person types their password followed by the six-digit code.',
        'Security keys and codes sent by email, text or phone need a web page, so they cannot be used here. A person who must use a second factor but has no authenticator app is rejected.',
      ] },
      { heading: 'What is and is not supported' },
      { bullets: [
        'PAP is supported. CHAP, MS-CHAPv2 and EAP are not, because only one-way password hashes are stored.',
        'Keep **Require the device to sign its requests** on unless a device cannot send a Message-Authenticator.',
        'Accounting is not supported, and risk-based sign-in rules are not applied to RADIUS sign-ins.',
      ] },
      { tip: 'Every RADIUS sign-in and rejection is in the **Sign-in log** with the name of the device that asked. Devices not on the list are ignored and noted once in the audit log.' },
    ],
  },
  {
    slug: 'set-up-group-attestation',
    section: 'Groups',
    title: 'Set up group attestation',
    summary: 'Choose who manages a group and how often they must confirm its membership.',
    visible: holds('groups.view', 'groups.manage'),
    body: [
      'Group attestation makes sure someone is regularly accountable for who is in a group. You pick the group\'s managers, choose how often they must attest, and the group tracks whether each attestation is up to date.',
      { heading: 'Appoint managers' },
      { steps: [
        'Open **Groups** from the module menu and select the group. Groups managed in Grouper or a directory cannot have managers here.',
        'Select the **Managers & attestation** tab.',
        'Under **Group managers**, choose a person in **Add a manager** and select **Add**. Appoint more than one so there is always someone to attest. Select the cross on a name to remove a manager.',
      ] },
      { heading: 'Set the schedule' },
      { steps: [
        'Under **Attestation**, choose a **Frequency**: monthly, quarterly or annually.',
        'Optionally choose a **First due** date. Without one, the first attestation is due one period from today (or from the last attestation).',
        'Select **Save schedule**.',
      ] },
      { bullets: [
        'The status is **Up to date**, **Due soon** (14 days or less before the due date) or **Overdue**.',
        'Each attestation moves the next due date one period on from the day it is made, not from the old due date.',
        'Select **Remove schedule** to stop requiring attestation. The history is kept.',
      ] },
      { heading: 'What a manager can do' },
      { bullets: [
        'A manager can change the group\'s members and attest to them from **My groups**, without needing an administrator role.',
        'Only a person with admin access to the group, or the Manage groups permission, can appoint managers and change the schedule.',
      ] },
      { heading: 'Review attestations' },
      { bullets: [
        'The **Attestation history** table lists every attestation: when, who, how many members and the note. Hover over the member count to see exactly who was in the group at that moment.',
        'Changes to managers and schedules, and every attestation, are written to the group\'s **History** tab and to the audit log (`group.attestation.complete`, `group.attestation.schedule`, `group.manager.add` and so on).',
      ] },
      { tip: 'For a group whose membership comes from an LDAP query, attestation is still worth doing: the managers confirm that the query itself still describes the right people.' },
    ],
  },
  {
    slug: 'lock-down-compromised-account',
    section: 'Users',
    title: 'Lock down a compromised account',
    summary: 'Sign someone out everywhere, replace their password and stop sign-in until it is safe.',
    visible: holds('users.manage', 'integrations.manage'),
    body: [
      'When an account may have been used by someone else, lock it down. Which steps run depends on the **Compromised account policies** that apply to the person, so an account in a sensitive group can be locked down more firmly than others.',
      'There is a pre-built integration which you can modify for compromised accounts (if you\'re an integration developer). It\'s used to drive the front-end compromised account lockdown. This pre-built integration is also useful for third-party applications that detect compromised accounts or account takeover attempts. Your external tool can be used to directly and automatically lock an account down if it detects an attempted or confirmed account takeover by calling the RESTful API.',
      { heading: 'Lock an account down' },
      { steps: [
        'Open **Users**, select the person, and find the **Compromised account** card on their page.',
        'Select **Lock down account**, check the steps it lists, and confirm.',
        'When it has run, the card shows the lockdown. To see each step, open the run in **Integrations → Compromised account lockdown**.',
      ] },
      { heading: 'End a lockdown' },
      { steps: [
        'On the person\'s page, select **End lockdown** in the **Compromised account** card.',
        'If the lockdown turned the account off, it is turned back on. Their password and sign-in methods are not restored: set a new password and help them set up their sign-in again.',
      ] },
      { heading: 'Decide what a lockdown does' },
      { steps: [
        'Open **Policies** and select the **Compromised accounts** tab.',
        'Edit the **Everyone** policy to set the steps for every account. A policy for a role or group adds steps for the people in it, and every step that any policy that applies sets is run.',
        'To put locked-down accounts in a group (for example one that limits what they can reach), turn on **Add to a group** and choose the group. A group is required before the policy can be saved with this step on.',
        'Under **Restrict sign-in to these networks**, list the addresses or networks the person may sign in from while the lockdown is in force. Sign-in from anywhere else is refused.',
      ] },
      { heading: 'Lock an account down using the API' },
      { steps: [
        'Go to **Settings**, then **User API**. Generate an API token with the right permissions to effect an account lockdown.',
        'Provide the API token and endpoint information to your integration developers. When the correct endpoint is `POST`ed to, that account will be locked down.',
      ] },
      'You can end a lockdown automatically (using the API) or from the user detail page.',
      { tip: 'A lockdown runs the **Compromised account lockdown** integration, which you can read and change on the **Integrations** page. It can also be started through the user API (see [the API reference](/help/user-api-reference)). While that integration is turned off, lockdowns cannot run.' },
    ],
  },
  {
    slug: 'user-api-reference',
    section: 'API',
    title: 'Read the user API reference',
    summary: 'Open the rendered documentation for the user API: every endpoint, its scopes and its responses.',
    visible: holds('integrations.manage', 'userapi.manage'),
    body: [
      'The user API lets other software create, change, lock down and delete accounts. Its reference is generated from the OpenAPI description and served by this server.',
      { steps: [
        'Open the [API documentation](/api/v1/docs) to read every endpoint, the scope each one needs and the responses it returns.',
        'For a tool that reads OpenAPI, download the [OpenAPI description](/api/v1/openapi.yaml).',
        'Create tokens and choose their scopes under **API → User API**.',
      ] },
      { tip: 'The documentation needs no sign-in, but every request to the API must carry a bearer token.' },
    ],
  },
  {
    slug: 'find-your-way-in-console',
    section: 'Admin console',
    title: 'Find your way around the admin console',
    summary: 'Open any admin area, or search the whole console.',
    visible: admin,
    body: [
      { steps: [
        'Select the module menu in the top bar to open the list of areas you can use. Each area lists what it does.',
        'Select **Search** in the top bar, or press Ctrl+K (⌘K on a Mac), to search people, applications, groups, integrations and logs at once.',
      ] },
      'You see only the areas your permissions allow. If an area you need is missing, ask an administrator for the permission it needs.',
    ],
  },
  {
    slug: 'create-user',
    section: 'Users',
    title: 'Create a user',
    summary: 'Add a new account by hand.',
    visible: holds('users.manage'),
    body: [
      { steps: [
        'Open **Users** from the module menu, then select **New user**.',
        'Type a **Username** and a **Password**.',
        'Fill in the name and email fields you need.',
        'Leave **Active** on so the person can sign in.',
        'Select **Save**.',
      ] },
      'Turn on **Require MFA** to make the person set up an authenticator at their next sign-in. This protects accounts with privileged access.',
    ],
  },
  {
    slug: 'import-users',
    section: 'Users',
    title: 'Import users from a CSV file',
    summary: 'Create many accounts at once from a spreadsheet.',
    visible: holds('users.manage'),
    body: [
      { steps: [
        'Open **Users**, then select **Import**.',
        'Select **Download template** and fill in one row per person. Keep the header row.',
        'Select **Choose CSV file** and pick your file, or paste the rows into the **CSV** box.',
        'Select **Check**. Fix any rows the check flags, then check again.',
        'Select **Create users**. To run the import later, choose a time under **Schedule import**.',
      ] },
      'Choose **Create the other rows** under **If a row has errors** to keep the good rows, or **Create nothing** to stop the whole import when one row fails. After an import, select **Errors CSV** to download the rows that failed.',
    ],
  },
  {
    slug: 'reset-user-password',
    section: 'Users',
    title: 'Reset a user\'s password',
    summary: 'Give someone a new password they can sign in with.',
    visible: holds('users.manage'),
    body: [
      { steps: [
        'Open **Users** and select the person.',
        'Type a new password in **New password**.',
        'Select **Save**.',
        'Tell the person the new password through a channel you trust, and ask them to change it on their **Profile** page.',
      ] },
    ],
  },
  {
    slug: 'reset-user-authenticator',
    section: 'Users',
    title: 'Reset a user\'s authenticator app',
    summary: 'Remove an authenticator app so the person can set up a new one.',
    visible: holds('users.manage'),
    body: [
      { steps: [
        'Open **Users** and select the person.',
        'Select **Reset authenticator**, then confirm.',
        'Let the person know that they will set up their authenticator again at their next sign-in.',
      ] },
    ],
  },
  {
    slug: 'remove-user-sign-in-method',
    section: 'Users',
    title: 'Remove a sign-in method from a user',
    summary: 'Take away a lost security key or other verification method.',
    visible: holds('users.manage'),
    body: [
      { steps: [
        'Open **Users** and select the person.',
        'In the list of sign-in methods, find the one to remove and select **Remove**.',
        'To remove every method at once, select **Remove all**.',
      ] },
      'Removing every method can lock the person out. Only do this when they have lost all their devices and have confirmed who they are.',
    ],
  },
  {
    slug: 'deactivate-or-delete-user',
    section: 'Users',
    title: 'Deactivate or delete a user',
    summary: 'Stop someone from signing in, or remove their account.',
    visible: holds('users.manage'),
    body: [
      { steps: [
        'To stop someone from signing in, open **Users**, select the person, turn off **Active**, and select **Save**.',
        'To remove the account, open the person and select **Delete user**, then confirm.',
      ] },
      'Deactivating keeps the account and its history, and you can turn **Active** back on later. Deleting cannot be undone.',
    ],
  },
  {
    slug: 'create-group',
    section: 'Groups',
    title: 'Create a group',
    summary: 'Make a new group.',
    visible: holds('groups.manage'),
    body: [
      { steps: [
        'Open **Groups** from the module menu.',
        'Type a **Name** and, if you like, a **Description**.',
        'Select **Create group**.',
      ] },
    ],
  },
  {
    slug: 'add-group-members',
    section: 'Groups',
    title: 'Add members to a group',
    summary: 'Put people into a group, or take them out.',
    visible: holds('groups.manage'),
    body: [
      { steps: [
        'Open **Groups** and select the group.',
        'Select the **Members** tab.',
        'Under **Add members**, open **People to add**, type to search, tick the people you want and select **Add selected**.',
        'To remove someone, find them in the member list and select **Remove**.',
      ] },
    ],
  },
  {
    slug: 'add-application',
    section: 'Single sign-on',
    title: 'Add an application',
    summary: 'Register a SAML, CAS, OpenID Connect or OAuth 2.0 application.',
    visible: holds('sps.manage'),
    body: [
      { steps: [
        'Open **Applications** and select **New application**.',
        'Choose the protocol the application uses: **SAML 2.0**, **OpenID Connect**, **OAuth 2.0** or **CAS**.',
        'Type a **Name** and fill in the application\'s details, such as its metadata or its redirect addresses. The application\'s documentation lists these.',
        'Under access, choose who can sign in: everyone, certain groups, or nobody.',
        'Select **Save**, then give the application the values this page shows for it, such as the IdP metadata.',
      ] },
      'Only a confidential client receives a client secret. The secret is shown once, so copy it before you leave the page.',
    ],
  },
  {
    slug: 'create-role',
    section: 'Roles',
    title: 'Create a role',
    summary: 'Group permissions into a role you can give to people.',
    visible: holds('roles.manage', 'roles.view'),
    body: [
      { steps: [
        'Open **Settings** and select the **Roles & permissions** tab.',
        'Select **New role**.',
        'Type a **Name** and a **Description**.',
        'Tick each permission the role needs. Select **All permissions** to tick every one.',
        'Select **Save**.',
      ] },
      'You can grant only the permissions you hold yourself. Roles keep access consistent: give people a role instead of granting permissions one by one.',
    ],
  },
  {
    slug: 'assign-role',
    section: 'Roles',
    title: 'Give someone a role',
    summary: 'Add a person to one or more roles.',
    visible: holds('roles.manage'),
    body: [
      { steps: [
        'Open **Users** and select the person.',
        'In the roles list, tick each role to give them.',
        'Select **Save**.',
      ] },
      'You can also open a role in **Settings → Roles & permissions** and add people from its **Members** list.',
    ],
  },
  {
    slug: 'require-authenticator-policy',
    section: 'Policies',
    title: 'Require an authenticator for a role or group',
    summary: 'Make people in a role or group set up MFA.',
    visible: holds('policies.manage', 'policies.view'),
    body: [
      { steps: [
        'Open **Policies** and select **Sign-in policies**.',
        'Select **New policy**.',
        'Type a **Name**, then choose **Role** or **Group** under **Applies to** and pick it.',
        'Tick **Require an authenticator at sign-in**. Add other rules as you need them.',
        'Select **Save**.',
      ] },
      'A policy cannot block your own sign-in or the Administrator role, so you cannot lock yourself out with it.',
    ],
  },
  {
    slug: 'turn-on-risk-based-sign-in',
    section: 'Risk-based sign-in',
    title: 'Turn on risk-based sign-in',
    summary: 'Score each sign-in and step up or block the risky ones, starting in report-only mode.',
    visible: holds('risk.manage'),
    body: [
      'Risk-based sign-in looks at each sign-in after the password is right. It compares the sign-in with the person\'s own history and with what is known about the request, then acts only if you have told it to.',
      { steps: [
        'Open **Settings** and select the **Risk** tab.',
        'Under **Mode**, choose **Report only: score and log, change nothing**.',
        'Select **Save**.',
        'Leave it in report-only mode for a few days. Open **Sign-in log**, choose **Medium** or **High** under **Risk**, and read the reasons for each sign-in.',
        'When the flagged sign-ins look right, return to **Risk**, choose **Enforce: apply the actions below** under **Mode**, and set the actions (see **Choose what a risky sign-in must do**).',
        'Select **Save**.',
      ] },
      { tip: 'Impossible travel, new country and new network need the IP geolocation database files. Without them, those signals stay quiet, and the sign-in log shows addresses only. Upload the database files under **IP geolocation** on the **Risk** tab.' },
      'A score can only ask for more proof. It never signs someone in without the password, and it never lets a person set up a new sign-in method.',
    ],
  },
  {
    slug: 'choose-what-a-risky-sign-in-must-do',
    section: 'Risk-based sign-in',
    title: 'Choose what a risky sign-in must do',
    summary: 'Set the score levels, the action for each level, and the signals that count.',
    visible: holds('risk.manage'),
    body: [
      'Each signal that fires adds its weight to the sign-in\'s score, up to 100. The score falls in one of three levels: **low** is below the **Medium risk from score**, **medium** is from there up to the **High risk from score**, and **high** is at or above it.',
      { table: {
        head: ['Signal', 'What it means', 'Default weight'],
        rows: [
          ['Password spraying', 'Many accounts failing from one address or network, or one account failing from many addresses, in a short time.', '50'],
          ['Impossible travel', 'The last sign-in was too far away to have been reached in the time between them.', '60'],
          ['Unrecognized device', 'This browser has not signed in to this account before.', '20'],
          ['New country', 'The account has not signed in from this country before.', '25'],
          ['Country mismatch', 'The sign-in country differs from the country on the person\'s profile.', '15'],
          ['New network', 'The account has not signed in from this network before.', '15'],
          ['Device location', 'The browser\'s own location is far from the address\'s. Off by default. It asks the person\'s browser for permission.', '30'],
          ['Sensitive groups', 'The person is in one of the groups you choose, such as the C-suite or people often targeted by phishing. Counts from the first sign-in.', '30'],
        ],
      } },
      { steps: [
        'Open **Settings** and select the **Risk** tab.',
        'Set **Medium risk from score** and **High risk from score**. The high number must be above the medium number. The defaults are 30 and 60.',
        'Under **Signals**, turn a signal on or off with its box, and change its **Weight** (0 to 100).',
        'Choose the action **At medium risk** and the action **At high risk**.',
        'Select **Save**.',
      ] },
      { heading: 'Actions' },
      { table: {
        head: ['Action', 'What the person must do'],
        rows: [
          ['Allow', 'Nothing extra.'],
          ['Require a second factor', 'Confirm with any second factor they have.'],
          ['Phishing-resistant factors only', 'Confirm with a factor that resists phishing.'],
          ['Security keys only', 'Confirm with a security key or passkey.'],
          ['Block', 'Refuse the sign-in.'],
        ],
      } },
      'A high-risk sign-in gets the medium action as well as the high one, and the stricter of the two applies.',
      { heading: 'Policies make them stricter' },
      'A policy can add its own **Medium risk** and **High risk** actions for the people it covers. Open **Policies**, select **Sign-in policies**, and set them on a policy. The stricter action wins, so a policy can raise a response but never lower the one you set on the **Risk** tab.',
      { heading: 'Check a sign-in before you rely on it' },
      'On the **Risk** tab, use **Try it**. Enter a username and the details of a sign-in, then select **Score it** to see its score, level, signals and action. Nothing is recorded or changed.',
      { tip: 'Administrators are never locked out by a score. A block becomes security keys only for them, and if they have no security key the rule steps aside. A person who would need a factor they do not have is refused and must contact an administrator.' },
    ],
  },
  {
    slug: 'turn-on-sign-in-methods',
    section: 'Sign-in factors',
    title: 'Turn on security keys and other sign-in methods',
    summary: 'Let people verify with security keys, email, text or voice.',
    visible: holds('factors.manage'),
    body: [
      { steps: [
        'Open **Settings** and select the **Sign-in factors** tab.',
        'Turn on **Allow security keys**, and turn on any of email, text or voice you want.',
        'Choose how each channel verifies the person.',
        'Select **Save**.',
      ] },
      'Email, text and voice codes need delivery set up first. Set it up under **Settings → Messaging**.',
    ],
  },
  {
    slug: 'require-phishing-resistant-factors',
    section: 'Sign-in factors',
    title: 'Require phishing-resistant sign-in',
    summary: 'Offer phishing-resistant factors, then require them for a role or group.',
    visible: holds('factors.manage', 'policies.manage'),
    body: [
      'Phishing-resistant factors are security keys and passkeys, and email, text or phone call codes that use number matching. Make them available first, so people have one to use before you require it.',
      { heading: 'Step 1: Offer the factors' },
      { steps: [
        'Open **Settings** and select the **Sign-in factors** tab.',
        'Turn on **Allow security keys**. Under **User verification**, choose **Required** if keys must also check the person with a PIN or fingerprint.',
        'For email, text or phone call, turn on the channel, then choose **Number matching — phishing resistant** under **How the person proves it**.',
        'Select **Save**.',
      ] },
      'Email, text and phone call factors need delivery set up under **Settings → Messaging** first. Voice number matching needs the Twilio provider, because the number is entered on the phone keypad.',
      { heading: 'Step 2: Require it for a role or group' },
      { steps: [
        'Open **Policies** and select **Sign-in policies**.',
        'Select **New policy**, or open the policy you want to change.',
        'Choose the **Role** or **Group** the policy applies to.',
        'Tick **Require a phishing-resistant factor**. This also requires a second factor.',
        'Optionally, tick **Allowed sign-in factors** to limit the choices. If none are ticked, there is no limit.',
        'Select **Save**.',
      ] },
      { tip: 'People who have only weaker factors, such as an authenticator app alone, are refused at sign-in until an administrator resets their sign-in methods. Ask them to add a security key or a number-matching factor before you turn the policy on. Check the **Factor** column in the **Sign-in log** to confirm what people use.' },
      { heading: 'Duo' },
      'When Duo is your second factor, a sign-in that must be phishing resistant uses Pons Identity\'s own factors instead of Duo. Make sure the people covered have one of them set up.',
    ],
  },
  {
    slug: 'set-up-message-delivery',
    section: 'Messaging and recovery',
    title: 'Set up email, text and voice delivery',
    summary: 'Connect the services that send codes and recovery messages.',
    visible: holds('messaging.manage'),
    body: [
      { steps: [
        'Open **Settings** and select the **Messaging** tab.',
        'Choose a provider for email, text or voice, and enter its credentials.',
        'Select **Save**.',
        'Select **Send test** to confirm that a message arrives.',
      ] },
    ],
  },
  {
    slug: 'turn-on-password-recovery',
    section: 'Messaging and recovery',
    title: 'Turn on password recovery by email',
    summary: 'Let people reset a forgotten password from their personal email.',
    visible: holds('recovery.manage'),
    body: [
      { steps: [
        'Open **Settings** and select the **Password recovery** tab.',
        'Turn on **Allow password recovery by personal email**.',
        'Select **Save**.',
      ] },
      'Recovery needs email delivery set up under **Settings → Messaging**. Keep **Allow administrators to recover this way** off unless you have a reason to turn it on.',
    ],
  },
  {
    slug: 'change-branding',
    section: 'Branding',
    title: 'Change the name, logo and colors',
    summary: 'Brand the sign-in page and console.',
    visible: holds('branding.manage'),
    body: [
      { steps: [
        'Open **Settings** and select the **Branding** tab.',
        'Type a **Product name**. Leave it empty for the default name.',
        'Leave **Name propagation** on to use the product name in messages, help and generated files too. Turn it off to keep the default name in those places; the header, sign-in page and browser title always use the product name.',
        'Select **Upload logo** to add a logo, or **Remove** to take it away.',
        'Choose a **Primary color** and a **Header color**.',
        'Select **Save**.',
      ] },
      'Changes apply to everyone after you save. Check the **Preview** before you save.',
    ],
  },
  {
    slug: 'find-log-entries',
    section: 'Audit and sign-in logs',
    title: 'Find events in the audit and sign-in logs',
    summary: 'Search for changes and sign-ins, then export them.',
    visible: holds('audit.view'),
    body: [
      { steps: [
        'Open **Audit log** to find administrative changes, or **Sign-in log** to find sign-ins.',
        'Fill in the fields you know, such as a name, a date range or an action.',
        'Select **Search**.',
        'To keep the results, select **Export CSV**. To see more, select **Load more**.',
      ] },
      'Select **Clear** to reset every field and start again.',
    ],
  },
  {
    slug: 'run-a-report',
    section: 'Reports',
    title: 'Run a report',
    summary: 'Run a built-in or saved report and download the results.',
    visible: holds('reports.view'),
    body: [
      { steps: [
        'Open **Reports** from the module menu.',
        'Select the report you want.',
        'Fill in any input the report asks for, then select **Run report**.',
        'Download the results from the output section.',
      ] },
      'A report shows only the data you could already see in the console. If a report shows **Needs** and a permission name, ask an administrator for that permission.',
    ],
  },
  {
    slug: 'create-api-token',
    section: 'API',
    title: 'Create an API token',
    summary: 'Make a token for software that manages users or groups.',
    visible: holds('userapi.manage', 'groupapi.manage'),
    body: [
      { steps: [
        'Open **Settings** and select the **User API** tab, or the **Group API** tab for group management.',
        'Type a name for the token and select **Create token**.',
        'Copy the token now and store it somewhere safe.',
      ] },
      'The token is shown only once. If you lose it, revoke it and create a new one.',
    ],
  },
];

export const ARTICLES = [...CORE_ARTICLES, ...INTEGRATION_ARTICLES, ...GROUPER_ARTICLES, ...REPORT_ARTICLES, ...PROTOCOL_ARTICLES, ...FEDERATION_ARTICLES, ...SETUP_ARTICLES, ...MIGRATION_ARTICLES];

export const visibleArticles = (ctx) => ARTICLES.filter((a) => a.visible(ctx));
