// The reports that ship with Pons Identity. They are ordinary report scripts, run the same way as ones people write, so each one
// doubles as an example. `input` is what the script receives by default; the person running it can change it.

const BUILTIN = [
  {
    key: 'users-without-mfa', name: 'Active users without MFA', requires: ['users.view'],
    description: 'Active accounts that are not required to use a second factor.',
    input: {},
    script: `const users = await report.users({ active: true });
return users
  .filter((u) => !u.mfa_required)
  .map((u) => ({ username: u.username, name: u.display_name, email: u.email, department: u.department, source: u.source }));
`,
  },
  {
    key: 'inactive-users', name: 'Deactivated users', requires: ['users.view'],
    description: 'Accounts that cannot sign in, with when they were created and last signed in.',
    input: {},
    script: `const users = await report.users({ active: false });
return users.map((u) => ({ username: u.username, name: u.display_name, email: u.email, department: u.department, created_at: u.created_at, last_sign_in: u.last_sign_in }));
`,
  },
  {
    key: 'stale-passwords', name: 'Old passwords', requires: ['users.view'],
    description: 'Active local accounts whose password has not changed in a number of days (input.days, default 365).',
    input: { days: 365 },
    script: `const cutoff = Date.now() - (input.days || 365) * 86400000;
const users = await report.users({ active: true });
return users
  .filter((u) => u.source === 'local')
  .filter((u) => !u.password_changed_at || Date.parse(u.password_changed_at) < cutoff)
  .map((u) => ({ username: u.username, name: u.display_name, email: u.email, password_changed_at: u.password_changed_at }))
  .sort((a, b) => String(a.password_changed_at).localeCompare(String(b.password_changed_at)));
`,
  },
  {
    key: 'users-by-department', name: 'Users by department', requires: ['users.view'],
    description: 'How many active and inactive users each department has.',
    input: {},
    script: `const counts = {};
for (const u of await report.users()) {
  const key = u.department || '(none)';
  counts[key] ||= { department: key, active: 0, inactive: 0 };
  counts[key][u.active ? 'active' : 'inactive']++;
}
return Object.values(counts).sort((a, b) => b.active - a.active);
`,
  },
  {
    key: 'group-sizes', name: 'Group sizes', requires: ['groups.view'],
    description: 'Every group and how many members it has, smallest first.',
    input: {},
    script: `return (await report.groups()).sort((a, b) => a.members - b.members || a.name.localeCompare(b.name));
`,
  },
  {
    key: 'failed-sign-ins', name: 'Failed sign-ins by user', requires: ['audit.view'],
    description: 'Who failed to sign in the most in the last input.days days (default 7), and from how many addresses.',
    input: { days: 7 },
    script: `const events = await report.signIns({ days: input.days || 7, outcome: 'failure', limit: 5000 });
const by = {};
for (const e of events) {
  const key = e.username || '(unknown)';
  by[key] ||= { username: key, failures: 0, addresses: new Set(), last_failure: e.time };
  by[key].failures++;
  by[key].addresses.add(e.ip);
}
return Object.values(by)
  .map((r) => ({ username: r.username, failures: r.failures, addresses: r.addresses.size, last_failure: r.last_failure }))
  .sort((a, b) => b.failures - a.failures);
`,
  },
  {
    key: 'admin-changes', name: 'Administrative changes', requires: ['audit.view'],
    description: 'Changes made in the console in the last input.days days (default 30), most recent first.',
    input: { days: 30 },
    script: `const events = await report.audit({ days: input.days || 30, category: 'admin', limit: 5000 });
return events.map((e) => ({ time: e.time, actor: e.actor, action: e.action, target: e.target, outcome: e.outcome }));
`,
  },
];

const find = (key) => BUILTIN.find((b) => b.key === key) || null;

module.exports = { BUILTIN, find };
