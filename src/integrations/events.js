const db = require('../db');
const { resource } = require('../user-api');
const { USER_FIELDS } = require('../admin-data');

// Things that happen in the IdP which can start an integration. They are read from the audit log, so a change counts
// whether it came from the console, the user API, a bulk import or another script. A change made by an integration is
// never passed on, so two integrations cannot start each other in a loop.

const EVENTS = {
  'user.created': { label: 'A user was created', actions: ['user.create', 'user.scheduled_create'], has: ['user'] },
  'user.updated': { label: 'A user was changed', actions: ['user.update'], has: ['user'] },
  'user.deleted': { label: 'A user was deleted', actions: ['user.delete'], has: [] },
  'user.password_reset': { label: 'An administrator or API reset a password', actions: ['user.password_reset'], has: ['user'] },
  // Fired when the account lockdown endpoint (POST /api/v1/users/{id}/lockdown) is called, and when an administrator starts one in the console.
  'user.locked_down': { label: 'An account was locked down through the user API or the console', actions: ['user.lockdown'], has: ['user'] },
  'group.member_added': { label: 'Someone was added to a group', actions: ['group.member.add'], has: ['group', 'member'] },
  'group.member_removed': { label: 'Someone was removed from a group', actions: ['group.member.remove'], has: ['group', 'member'] },
  'login.succeeded': { label: 'Someone signed in', actions: ['login.success'], has: ['user'] },
  'login.failed': { label: 'A sign-in failed', actions: ['login.failure'], has: [] },
};

const byAction = new Map(Object.entries(EVENTS).flatMap(([name, e]) => e.actions.map((a) => [a, name])));

/** The event name an audit row stands for, or null (including for changes made by an integration). */
// Scripts record themselves as "integration:<name>" (the user API's tokens are also type 'integration', but are named otherwise).
const byScript = (row) => row.actor_type === 'integration' && String(row.actor_name).startsWith('integration:');
const eventOf = (row) => (byScript(row) ? null : byAction.get(row.action) || null);

const userById = (id) => {
  const u = id == null || id === '' ? null : db.get('SELECT * FROM users WHERE id = ?', Number(id));
  if (!u) return null;
  const { location: _l, ...rest } = resource(u);
  return rest;
};

// The fields of an Event an input can take its value from (see inputs.js valuesToInput): paths into the Event, such as user.email.
const COMMON_FIELDS = ['event', 'at', 'outcome', 'actor.type', 'actor.id', 'actor.name', 'target.type', 'target.id', 'target.name'];
/** The paths into an event's input that its listeners can use, as strings. */
function fieldsOf(event) {
  const has = EVENTS[event].has;
  return [
    ...COMMON_FIELDS,
    ...(has.includes('user') ? ['user.id', ...USER_FIELDS.map((f) => `user.${f}`), 'user.active', 'user.groups', 'user.created_at'] : []),
    ...(has.includes('group') ? ['group', 'member'] : []),
  ];
}

/** The `input` a script receives for an audit row. */
function inputFor(event, row, detail) {
  const target = row.target_type ? { type: row.target_type, id: row.target_id, name: row.target_name } : null;
  const input = { event, at: new Date(row.ts * 1000).toISOString(), outcome: row.outcome, actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name }, target, detail };
  const has = EVENTS[event].has;
  if (has.includes('user')) input.user = userById(event === 'login.succeeded' ? row.actor_id : row.target_id);
  if (has.includes('group')) { input.group = row.target_name; input.member = detail.change || ''; }
  return input;
}

const USER_EXAMPLE = { id: '5f0c…', username: 'srivera', email: 'sam@example.net', active: true, groups: ['Staff'], '…': '(a User, see Objects)' };
const BASE = { event: 'user.created', at: '2026-10-01T10:00:00.000Z', outcome: 'success', actor: { type: 'user', id: 1, name: 'admin' }, target: { type: 'user', id: '12', name: 'srivera' }, detail: { via: 'console' } };

/** Catalog for the console and its reference. */
const catalog = () => Object.entries(EVENTS).map(([name, e]) => ({
  name, label: e.label, fields: fieldsOf(name),
  extra: [
    ...(e.has.includes('user') ? [name === 'login.succeeded' ? 'user: the person who signed in' : 'user: the User affected, or null if it no longer exists'] : []),
    ...(e.has.includes('group') ? ['group: the group name', 'member: the username added or removed'] : []),
  ],
  example: { ...BASE, event: name, ...(e.has.includes('user') ? { user: USER_EXAMPLE } : {}), ...(e.has.includes('group') ? { group: 'Staff', member: 'srivera' } : {}) },
}));

module.exports = { EVENTS, eventOf, inputFor, fieldsOf, catalog };
