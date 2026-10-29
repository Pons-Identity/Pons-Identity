const db = require('./db');
const auditLog = require('./audit');

// Append a group change to the audit trail. `actor` is a username, or 'system' for automated changes. `actorObj`
// ({ type, id, name }) names a non-session actor such as an API token.
// Also written to the central audit log so group changes show up next to everything else.
function audit(actor, group, action, detail = '', actorObj) {
  db.run('INSERT INTO group_audit (ts, actor, group_id, group_name, action, detail) VALUES (?, ?, ?, ?, ?, ?)',
    Math.floor(Date.now() / 1000), actor || 'system', group.id, group.name, action, detail);
  auditLog.admin(action.startsWith('group.') ? action : `group.${action}`, {
    actor: actorObj || (!actor || actor === 'system' ? { type: 'system', name: 'system' } : undefined),
    target: { type: 'group', id: group.id, name: group.name },
    detail: { change: detail },
  });
}

const recent = (groupId, limit = 200) => db.all(
  'SELECT id, ts, actor, action, detail FROM group_audit WHERE group_id = ? ORDER BY id DESC LIMIT ?', groupId, limit);

module.exports = { audit, recent };
