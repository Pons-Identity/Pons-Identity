// Every permission an administrator can grant through a role. Each "manage" permission implies its "view".
const PERMISSIONS = [
  { key: 'users.view', group: 'Users', label: 'View users', description: 'See the user list and user details.' },
  { key: 'users.manage', group: 'Users', label: 'Manage users', description: 'Create, edit, delete users and reset their authenticator.', implies: ['users.view'] },
  { key: 'users.schedule', group: 'Users', label: 'Schedule account changes', description: 'Schedule account creation, activation, deactivation and deletion, for people and for groups. Each action runs with your access when it comes due.', implies: ['users.view'] },
  { key: 'groups.view', group: 'Groups', label: 'View groups', description: 'See groups and their members.' },
  { key: 'groups.manage', group: 'Groups', label: 'Manage groups', description: 'Create, edit, delete groups and change membership (including on user records).', implies: ['groups.view'] },
  { key: 'sps.view', group: 'Service providers', label: 'View service providers', description: 'See applications and their metadata.' },
  { key: 'sps.manage', group: 'Service providers', label: 'Manage service providers', description: 'Create, edit and delete applications and regenerate their certificates.', implies: ['sps.view'] },
  { key: 'roles.view', group: 'Roles', label: 'View roles', description: 'See roles, their permissions and members.' },
  { key: 'roles.manage', group: 'Roles', label: 'Manage roles', description: 'Create, edit and delete roles and assign people to them. Limited to permissions you hold yourself.', implies: ['roles.view'] },
  { key: 'policies.view', group: 'Policies', label: 'View policies', description: 'See sign-in and password policies and who they apply to.' },
  { key: 'policies.manage', group: 'Policies', label: 'Manage policies', description: 'Create, edit and delete policies for roles and groups. Cannot block your own sign-in or the Administrator role.', implies: ['policies.view'] },
  { key: 'federation.view', group: 'Federation', label: 'View federation', description: 'See federation metadata sources, imported entities and refresh status.' },
  { key: 'federation.manage', group: 'Federation', label: 'Manage federation', description: 'Configure federation metadata sources, the federation identity and inbound login policy.', implies: ['federation.view'] },
  { key: 'audit.view', group: 'Audit', label: 'View audit log', description: 'Search and export the audit log and see the status of log forwarding.' },
  { key: 'audit.manage', group: 'Settings', label: 'Configure log forwarding', description: 'Choose the syslog server and SIEM that audit events are sent to, including the access token they require.', implies: ['audit.view'] },
  { key: 'duo.manage', group: 'Settings', label: 'Configure Duo MFA', description: 'Change the Duo integration, including its secret key.' },
  { key: 'grouper.manage', group: 'Settings', label: 'Configure Grouper', description: 'Change the Grouper integration, its group attribute name and the provisioning token.' },
  { key: 'groupapi.manage', group: 'Settings', label: 'Configure the group API', description: 'Create and revoke the tokens external software uses to manage groups and folders through the group API.' },
  { key: 'directories.manage', group: 'Settings', label: 'Configure external directories', description: 'Connect LDAP / Active Directory servers, manage the REST API tokens external directories use to update identities, set up provisioning feeds from HR, ERP and payroll systems that create and deprovision users, and see the bind password they hold.' },
  { key: 'attributes.manage', group: 'Settings', label: 'Configure user attributes', description: 'Define additional user attributes, their types and which are required.' },
  { key: 'factors.manage', group: 'Settings', label: 'Configure sign-in factors', description: 'Turn security keys and email, SMS and voice sign-in on or off, and choose whether the latter are phishing resistant.' },
  { key: 'recovery.manage', group: 'Settings', label: 'Configure password recovery', description: 'Turn password recovery by personal email on or off, choose whether administrators may use it, and set up identity verification for resets.' },
  { key: 'radius.manage', group: 'Settings', label: 'Configure RADIUS', description: 'Turn the RADIUS server on or off, choose its port, and add the network devices that may use it, including their shared secrets.' },
  { key: 'risk.manage', group: 'Settings', label: 'Configure risk-based sign-in', description: 'Choose the risk signals, thresholds and actions, and set up IP geolocation.' },
  { key: 'messaging.manage', group: 'Settings', label: 'Configure messaging', description: 'Set up email, SMS and voice delivery used for password recovery and sign-in factors, including provider credentials, and edit the wording of the verification-code and password-reset messages.' },
  { key: 'sessions.manage', group: 'Settings', label: 'Configure sessions', description: 'Choose how long a sign-in session lasts and whether it ends after a period of inactivity.' },
  { key: 'userapi.manage', group: 'Settings', label: 'Configure the user API', description: 'Create and revoke the tokens external software uses to create and manage users through the user API.' },
  { key: 'integrations.view', group: 'Integrations', label: 'View integrations', description: 'See integrations, their scripts, variable names and run history. Secret values are never shown.' },
  { key: 'integrations.manage', group: 'Integrations', label: 'Manage integrations', description: 'Write and run scripts that create and change users and groups, call outside services and send messages, and set the variables they read, including secrets. Scripts run with the access of the scopes you give them, so grant this to people you trust with that access.', implies: ['integrations.view'] },
  { key: 'reports.view', group: 'Reports', label: 'Run reports', description: 'Run the pre-built reports and reports others have written, and download the results. A report shows only data the person running it could already see: users need Users access, groups Groups access, and sign-in and audit data Audit access.' },
  { key: 'reports.manage', group: 'Reports', label: 'Write reports', description: 'Write, edit and delete reports in JavaScript. Reports can only read: they cannot change anything, call outside services or see integration variables, and they run with the access of whoever runs them.', implies: ['reports.view'] },
  { key: 'setup.run', group: 'Settings', label: 'Re-run the setup wizard', description: 'Open the first-run setup wizard again after it has been completed. It is switched off once it has run, so only people holding this permission can turn it back on.' },
  { key: 'migration.manage', group: 'Settings', label: 'Import from other identity providers', description: 'Import users, groups and applications from Shibboleth, Okta, Microsoft Entra ID, AD FS and Active Directory exports. Imported applications can sign people in, so grant this to people you trust with that.' },
  { key: 'export.manage', group: 'Settings', label: 'Export data', description: 'Download configuration, users, groups and integrations as an export file. Each part of an export also needs the matching view permission (users, groups, integrations). Password hashes and secrets are never included.' },
  { key: 'branding.manage', group: 'Settings', label: 'Configure branding', description: 'Change the product name, logo and colors.' },
];

const ALL = PERMISSIONS.map((p) => p.key);
const IMPLIES = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.implies || []]));

/** Unknown keys are dropped and implied permissions are added. */
function normalize(keys) {
  const out = new Set();
  for (const k of keys || []) {
    if (!IMPLIES[k]) continue;
    out.add(k);
    for (const i of IMPLIES[k]) out.add(i);
  }
  return out;
}

const isSubset = (a, b) => [...a].every((x) => b.has(x));

module.exports = { PERMISSIONS, ALL, normalize, isSubset };
