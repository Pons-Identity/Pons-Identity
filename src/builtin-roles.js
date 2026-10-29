const { PERMISSIONS } = require('./permissions');

// Roles created on first start for common jobs. They are ordinary roles once created: an administrator can
// change their permissions or delete them, and they are not created again.
const VIEW_ONLY = PERMISSIONS.filter((p) => p.key.endsWith('.view')).map((p) => p.key);

const BUILTIN_ROLES = [
  {
    key: 'helpdesk',
    name: 'Helpdesk',
    description: 'Look up and edit people, reset their authenticators, and check the audit log.',
    permissions: ['users.manage', 'groups.view', 'audit.view'],
  },
  {
    key: 'identity-admin',
    name: 'Identity administrator',
    description: 'Manage user accounts, scheduled changes, groups, attributes and role membership.',
    permissions: ['users.manage', 'users.schedule', 'groups.manage', 'attributes.manage', 'roles.view'],
  },
  {
    key: 'sso-admin',
    name: 'SSO administrator',
    description: 'Register and configure applications, and see federation and groups they use.',
    permissions: ['sps.manage', 'federation.view', 'groups.view'],
  },
  {
    key: 'integration-developer',
    name: 'Integration developer',
    description: 'Write and run integration scripts and create the tokens for the user and group APIs.',
    permissions: ['integrations.manage', 'userapi.manage', 'groupapi.manage', 'users.view', 'groups.view'],
  },
  {
    key: 'report-viewer',
    name: 'Report viewer',
    description: 'Run the pre-built and saved reports and download their results.',
    permissions: ['reports.view'],
  },
  {
    key: 'federation-admin',
    name: 'Federation administrator',
    description: 'Configure federation metadata sources, the federation identity and inbound login policy.',
    permissions: ['federation.manage', 'sps.view'],
  },
  {
    key: 'directory-admin',
    name: 'Directory administrator',
    description: 'Connect external directories and provisioning feeds, and manage their API tokens.',
    permissions: ['directories.manage', 'users.view', 'groups.view'],
  },
  {
    key: 'policy-author',
    name: 'Policy author',
    description: 'Write sign-in and password policies for roles and groups.',
    permissions: ['policies.manage', 'roles.view', 'groups.view'],
  },
  {
    key: 'read-only',
    name: 'Read-only',
    description: 'View users, groups, applications, roles, policies, federation, integrations, reports and the audit log without changing anything.',
    permissions: VIEW_ONLY,
  },
];

module.exports = { BUILTIN_ROLES };
