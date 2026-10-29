const crypto = require('crypto');
const db = require('./db');
const appSettings = require('./app-settings');
const { effectiveGroupsOf } = require('./group-membership');
const { ALL, normalize, isSubset } = require('./permissions');

// Roles are sets of permissions. The built-in Administrator role (key 'admin') always holds every
// permission, including ones added later, and cannot be edited or deleted. Custom roles list theirs
// in role_permissions.

const ADMIN_ROLE = 'admin';

// A user's roles are the ones assigned in the console (roleIds) plus any granted by membership of a
// Grouper group mapped to a role (grantedRoleIds). Only the union decides access.
const adminRoleId = () => db.get('SELECT id FROM roles WHERE key = ?', ADMIN_ROLE).id;

// Roles that the given groups (from effectiveGroupsOf) grant through Grouper role mappings.
function roleIdsGrantedBy(groups) {
  if (!appSettings.grouper().enabled) return [];
  const names = new Set(groups.filter((g) => g.source === 'grouper').map((g) => g.name.toLowerCase()));
  return [...new Set(db.all('SELECT group_name, role_id FROM grouper_role_map')
    .filter((m) => names.has(m.group_name.toLowerCase())).map((m) => m.role_id))];
}

const grantedRoleIds = (userId) => roleIdsGrantedBy(effectiveGroupsOf(userId));

const effectiveRoleIds = (userId) => [...new Set([...roleIds(userId), ...grantedRoleIds(userId)])];

const isAdmin = (userId) => effectiveRoleIds(userId).includes(adminRoleId());

const roleIds = (userId) => db.all('SELECT role_id FROM user_roles WHERE user_id = ?', userId).map((r) => r.role_id);

const rolePermissions = (role) => (role.key === ADMIN_ROLE
  ? new Set(ALL)
  : new Set(db.all('SELECT permission FROM role_permissions WHERE role_id = ?', role.id).map((r) => r.permission)));

/** Union of the permissions of the given role ids. */
function permissionsOfRoles(ids) {
  const out = new Set();
  for (const id of ids) {
    const role = db.get('SELECT id, key FROM roles WHERE id = ?', Number(id));
    if (role) for (const p of rolePermissions(role)) out.add(p);
  }
  return out;
}

const guestExpired = (userId) => {
  const u = db.get('SELECT host_id, expires_at FROM users WHERE id = ?', userId);
  return Boolean(u && u.host_id && !(Date.parse(u.expires_at) > Date.now()));
};

// A guest never holds more than the person hosting them, whatever roles they were given: the cap is applied every time, so it
// follows the host's access as it changes. A guest of a host who is deactivated holds nothing.
function permissionsOf(userId) {
  const own = permissionsOfRoles(effectiveRoleIds(userId));
  const host = db.get('SELECT h.id, h.active FROM users u JOIN users h ON h.id = u.host_id WHERE u.id = ?', userId);
  if (!host) return own;
  if (!host.active) return new Set();
  if (guestExpired(userId)) return new Set();
  const cap = permissionsOf(host.id);
  return new Set([...own].filter((p) => cap.has(p)));
}

/** Replace a custom role's permissions (implied ones are added). */
function setRolePermissions(roleId, keys) {
  db.run('DELETE FROM role_permissions WHERE role_id = ?', roleId);
  for (const p of normalize(keys)) db.run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', roleId, p);
}

const newRoleKey = () => `custom-${crypto.randomBytes(6).toString('hex')}`;

/**
 * You can only change a role assignment if you hold every permission the role carries, so nobody
 * can hand out (or take away) more access than they have.
 */
function assignmentErrors(actorId, currentIds, nextIds) {
  const cur = new Set(currentIds.map(Number));
  const next = new Set(nextIds.map(Number));
  const changed = [...cur, ...next].filter((id) => cur.has(id) !== next.has(id));
  const mine = permissionsOf(actorId);
  const errors = [];
  for (const id of changed) {
    const role = db.get('SELECT id, key, name FROM roles WHERE id = ?', id);
    if (role && !isSubset(rolePermissions(role), mine)) {
      errors.push(`You cannot change the "${role.name}" role because it carries permissions you do not have.`);
    }
  }
  return errors;
}

/** You can only modify a user whose access is no greater than yours. */
const outranks = (actorId, targetId) => isSubset(permissionsOf(targetId), permissionsOf(actorId));

module.exports = {
  ADMIN_ROLE, isAdmin, adminRoleId, roleIds, grantedRoleIds, roleIdsGrantedBy, effectiveRoleIds, rolePermissions, permissionsOfRoles, permissionsOf,
  setRolePermissions, newRoleKey, assignmentErrors, outranks,
};
