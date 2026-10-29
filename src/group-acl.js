const db = require('./db');
const { effectiveGroupsOf } = require('./group-membership');
const attestation = require('./group-attestation');

// Per-group privileges, in increasing power. Each includes the ones before it:
//   view   - see that the group exists
//   read   - see members, structure and the audit trail
//   update - add and remove members, set membership dates (group managers hold this on their groups)
//   admin  - nest groups, make composites, and grant or revoke these privileges
const PRIVILEGES = ['view', 'read', 'update', 'admin'];
const rank = (p) => PRIVILEGES.indexOf(p);

// Self-service is separate from management and never ranks: optin lets the subject add themselves, optout lets
// them remove themselves. It can be granted to a person, a group, or everyone.
const SELF_SERVICE = ['optin', 'optout'];
const GRANTABLE = [...PRIVILEGES, ...SELF_SERVICE];

// Everything the user holds through a group_admins grant or as a group manager, as { groupId -> highest privilege }.
function delegated(userId) {
  const subjects = effectiveGroupsOf(userId).map((g) => g.id);
  const rows = db.all(
    `SELECT group_id, privilege FROM group_admins WHERE (subject_type = 'user' AND subject_id = ?)
       ${subjects.length ? `OR (subject_type = 'group' AND subject_id IN (${subjects.map(() => '?').join(',')}))` : ''}`,
    userId, ...subjects);
  const out = new Map();
  for (const r of rows) if (rank(r.privilege) > rank(out.get(r.group_id))) out.set(r.group_id, r.privilege);
  for (const r of db.all('SELECT group_id FROM group_managers WHERE user_id = ?', userId)) {
    if (rank(out.get(r.group_id)) < rank('update')) out.set(r.group_id, 'update');
  }
  return out;
}

// What the user may do to their own membership, as Map(groupId -> { optin, optout }).
function selfServiceGrants(userId) {
  const subjects = effectiveGroupsOf(userId).map((g) => g.id);
  const rows = db.all(
    `SELECT group_id, privilege FROM group_admins WHERE privilege IN ('optin', 'optout')
       AND (subject_type = 'everyone' OR (subject_type = 'user' AND subject_id = ?)
       ${subjects.length ? `OR (subject_type = 'group' AND subject_id IN (${subjects.map(() => '?').join(',')}))` : ''})`,
    userId, ...subjects);
  const out = new Map();
  for (const r of rows) out.set(r.group_id, { ...out.get(r.group_id), [r.privilege]: true });
  return out;
}

/**
 * Groups the user can join or leave themselves. A group is listed when they may opt in, or may opt out and are in it.
 * Only plain local groups qualify: composites take their members from their factors, and others are managed elsewhere.
 */
function available(userId, now = Math.floor(Date.now() / 1000)) {
  const grants = selfServiceGrants(userId);
  if (!grants.size) return [];
  const effective = new Set(effectiveGroupsOf(userId, now).map((g) => g.id));
  const direct = new Set(db.all(
    `SELECT group_id FROM group_members WHERE user_id = ? AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at > ?)`,
    userId, now, now).map((r) => r.group_id));
  const groups = db.all(
    `SELECT id, name, description FROM groups WHERE source = 'local' AND id IN (${[...grants.keys()].map(() => '?').join(',')})
       AND id NOT IN (SELECT group_id FROM group_composites) ORDER BY name`, ...grants.keys());
  return groups.map((g) => {
    const grant = grants.get(g.id);
    return {
      ...g,
      member: effective.has(g.id),
      direct: direct.has(g.id),
      can_join: Boolean(grant.optin) && !direct.has(g.id),
      can_leave: Boolean(grant.optout) && direct.has(g.id),
    };
  }).filter((g) => grants.get(g.id).optin || g.member);
}

// Administrators with groups.manage hold every privilege on every group; groups.view alone gives read.
function globalPrivilege(perms) {
  if (perms.has('groups.manage')) return 'admin';
  return perms.has('groups.view') ? 'read' : null;
}

function privilegeOn(userId, perms, groupId, held = delegated(userId)) {
  const g = globalPrivilege(perms);
  const d = held.get(groupId);
  return rank(d) > rank(g) ? d : g;
}

const can = (userId, perms, groupId, needed) => rank(privilegeOn(userId, perms, groupId)) >= rank(needed);

// Groups the user can see or manage through a delegated grant (not through a global permission).
function delegatedGroups(userId) {
  const held = delegated(userId);
  if (!held.size) return [];
  const managed = new Set(db.all('SELECT group_id FROM group_managers WHERE user_id = ?', userId).map((r) => r.group_id));
  return db.all(`SELECT id, name, description, source FROM groups WHERE id IN (${[...held.keys()].map(() => '?').join(',')}) ORDER BY name`,
    ...held.keys()).map((g) => ({ ...g, privilege: held.get(g.id), manager: managed.has(g.id), attestation: attestation.scheduleOf(g.id) }));
}

module.exports = { PRIVILEGES, SELF_SERVICE, GRANTABLE, rank, privilegeOn, can, delegated, delegatedGroups, selfServiceGrants, available };
