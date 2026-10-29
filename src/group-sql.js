// SQL interface to group management for external software that works on the database directly instead of the API.
//
// Everything is exposed as views named ext_*. Their columns and meaning are the supported contract; the tables
// behind them may change. The views are writable (INSTEAD OF triggers) and apply the same rules as the console and
// the group API: only local groups are edited, composites take no direct members, nesting cannot loop, folder
// moves cannot loop, and every change lands in the group history and the central audit log (actor "sql-interface").
//
// SQLite has no per-user permissions, so this is a convenience with guard rails, not a security boundary: anyone
// who can open the database file can read and write every table. Give untrusted integrations the API instead.
//
// The views are dropped and recreated at every start, so improvements ship with the application.

const VIEWS = ['ext_group_folders', 'ext_groups', 'ext_group_members', 'ext_group_includes', 'ext_group_composites', 'ext_users'];

const FK_GUARD = `SELECT RAISE(ABORT, 'Run PRAGMA foreign_keys = ON on this connection before changing groups.')
  WHERE (SELECT foreign_keys FROM pragma_foreign_keys) = 0;`;

const raise = (message, when) => `SELECT RAISE(ABORT, '${message}') WHERE ${when};`;

// Write the history entry and the central audit entry for a change made through a view (only when `when` holds).
const audit = (groupId, groupName, action, detail, when = '1') => `
  INSERT INTO group_audit (ts, actor, group_id, group_name, action, detail)
    SELECT CAST(strftime('%s', 'now') AS INTEGER), 'sql-interface', ${groupId}, ${groupName}, '${action}', ${detail} WHERE ${when};
  INSERT INTO audit_log (ts, category, action, actor_type, actor_name, target_type, target_id, target_name, detail)
    SELECT CAST(strftime('%s', 'now') AS INTEGER), 'admin', 'group.${action.replace(/^group\./, '')}', 'integration', 'sql-interface',
           'group', ${groupId}, ${groupName}, json_object('change', ${detail}, 'via', 'sql') WHERE ${when};`;

const auditFolder = (folderId, path, action, detail) => `
  INSERT INTO audit_log (ts, category, action, actor_type, actor_name, target_type, target_id, target_name, detail)
    VALUES (CAST(strftime('%s', 'now') AS INTEGER), 'admin', 'group.folder.${action}', 'integration', 'sql-interface',
            'group_folder', ${folderId}, ${path}, json_object('change', ${detail}, 'via', 'sql'));`;

// A group or user named by id or by name/username (id wins).
const groupId = (id, name) => `COALESCE(${id}, (SELECT id FROM groups WHERE name = ${name}))`;
const userId = (id, name) => `COALESCE(${id}, (SELECT id FROM users WHERE username = ${name}))`;

const NOW = "CAST(strftime('%s', 'now') AS INTEGER)";
const nextPosition = (table, col, parent) => `(SELECT COALESCE(MAX(position), 0) + 1 FROM ${table} WHERE COALESCE(${col}, 0) = COALESCE(${parent}, 0))`;
const folderPath = (id) => `(SELECT path FROM ext_group_folders WHERE id = ${id})`;

function install(db) {
  db.exec('BEGIN');
  try {
    for (const v of VIEWS) db.exec(`DROP VIEW IF EXISTS ${v}`);
    db.exec(schema());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function schema() {
  const g = (id, name) => groupId(id, name);
  return `
-- Folders. path is read-only ("Parent/Child"); parent_id NULL = top level. position orders siblings (0 = by name).
CREATE VIEW ext_group_folders AS
  WITH RECURSIVE t(id, path) AS (
    SELECT id, name FROM group_folders WHERE parent_id IS NULL
    UNION ALL SELECT f.id, t.path || '/' || f.name FROM group_folders f JOIN t ON f.parent_id = t.id)
  SELECT f.id, f.parent_id, f.name, f.description, f.position, t.path FROM group_folders f JOIN t ON t.id = f.id;

CREATE TRIGGER ext_group_folders_insert INSTEAD OF INSERT ON ext_group_folders BEGIN
  ${FK_GUARD}
  ${raise('A folder needs a name.', "NEW.name IS NULL OR trim(NEW.name) = ''")}
  ${raise('A folder name cannot contain a slash.', "instr(NEW.name, '/') > 0")}
  ${raise('No such parent folder.', 'NEW.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM group_folders WHERE id = NEW.parent_id)')}
  INSERT INTO group_folders (parent_id, name, description, position)
    VALUES (NEW.parent_id, trim(NEW.name), COALESCE(NEW.description, ''),
            COALESCE(NEW.position, ${nextPosition('group_folders', 'parent_id', 'NEW.parent_id')}));
  ${auditFolder('last_insert_rowid()', folderPath('last_insert_rowid()'), 'create', "'created'")}
END;

CREATE TRIGGER ext_group_folders_update INSTEAD OF UPDATE ON ext_group_folders BEGIN
  ${FK_GUARD}
  ${raise('A folder id cannot be changed.', 'NEW.id IS NOT OLD.id')}
  ${raise('A folder needs a name.', "NEW.name IS NULL OR trim(NEW.name) = ''")}
  ${raise('A folder name cannot contain a slash.', "instr(NEW.name, '/') > 0")}
  ${raise('No such parent folder.', 'NEW.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM group_folders WHERE id = NEW.parent_id)')}
  UPDATE group_folders SET parent_id = NEW.parent_id, name = trim(NEW.name), description = COALESCE(NEW.description, ''),
    position = COALESCE(NEW.position, 0) WHERE id = OLD.id;
  ${auditFolder('OLD.id', folderPath('OLD.id'), 'update', "'was ' || OLD.path")}
END;

-- Deleting a folder moves its groups and subfolders up to its parent.
CREATE TRIGGER ext_group_folders_delete INSTEAD OF DELETE ON ext_group_folders BEGIN
  ${FK_GUARD}
  ${auditFolder('OLD.id', 'OLD.path', 'delete', "'deleted; contents moved to ' || COALESCE((SELECT path FROM ext_group_folders WHERE id = OLD.parent_id), 'the top level')")}
  DELETE FROM group_folders WHERE id = OLD.id;
END;

-- Groups. Insert creates a local group. Name and description change only on local groups; folder_id and
-- position (filing) change on any group. Delete is for local groups only.
CREATE VIEW ext_groups AS
  SELECT g.id, g.name, g.description, g.source, g.folder_id, f.path AS folder_path, g.position,
         (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS direct_member_count,
         EXISTS (SELECT 1 FROM group_composites c WHERE c.group_id = g.id) AS is_composite
  FROM groups g LEFT JOIN ext_group_folders f ON f.id = g.folder_id;

CREATE TRIGGER ext_groups_insert INSTEAD OF INSERT ON ext_groups BEGIN
  ${FK_GUARD}
  ${raise('A group needs a name.', "NEW.name IS NULL OR trim(NEW.name) = ''")}
  ${raise('Groups created here are always local.', "NEW.source IS NOT NULL AND NEW.source != 'local'")}
  ${raise('No such folder.', 'NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM group_folders WHERE id = NEW.folder_id)')}
  INSERT INTO groups (name, description, folder_id, position)
    VALUES (trim(NEW.name), COALESCE(NEW.description, ''), NEW.folder_id,
            COALESCE(NEW.position, ${nextPosition('groups', 'folder_id', 'NEW.folder_id')}));
  ${audit('last_insert_rowid()', 'trim(NEW.name)', 'group.create', "''")}
END;

CREATE TRIGGER ext_groups_update INSTEAD OF UPDATE ON ext_groups BEGIN
  ${FK_GUARD}
  ${raise('A group id cannot be changed.', 'NEW.id IS NOT OLD.id')}
  ${raise('A group source cannot be changed.', 'NEW.source IS NOT OLD.source')}
  ${raise('This group is managed outside Pons Identity (Grouper or an external directory); only its folder and position can change here.',
    "OLD.source != 'local' AND (NEW.name IS NOT OLD.name OR NEW.description IS NOT OLD.description)")}
  ${raise('A group needs a name.', "NEW.name IS NULL OR trim(NEW.name) = ''")}
  ${raise('No such folder.', 'NEW.folder_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM group_folders WHERE id = NEW.folder_id)')}
  UPDATE groups SET name = trim(NEW.name), description = COALESCE(NEW.description, ''), folder_id = NEW.folder_id,
    position = COALESCE(NEW.position, 0) WHERE id = OLD.id;
  ${audit('OLD.id', 'trim(NEW.name)', 'group.update', "'renamed from ' || OLD.name", 'NEW.name IS NOT OLD.name')}
  ${audit('OLD.id', 'trim(NEW.name)', 'move', "'from ' || COALESCE(OLD.folder_path, 'the top level') || ' to ' || COALESCE((SELECT path FROM ext_group_folders WHERE id = NEW.folder_id), 'the top level')",
    'NEW.folder_id IS NOT OLD.folder_id')}
END;

CREATE TRIGGER ext_groups_delete INSTEAD OF DELETE ON ext_groups BEGIN
  ${FK_GUARD}
  ${raise('This group is managed outside Pons Identity (Grouper or an external directory). Delete it there.', "OLD.source != 'local'")}
  ${audit('OLD.id', 'OLD.name', 'group.delete', "''")}
  DELETE FROM groups WHERE id = OLD.id;
END;

-- Direct members of local and other groups. Insert names the group (group_id or group_name) and the person
-- (user_id or username); start_at/end_at are epoch seconds (NULL = open-ended). Local, non-composite groups only.
CREATE VIEW ext_group_members AS
  SELECT m.group_id, g.name AS group_name, g.source AS group_source, m.user_id, u.username, m.start_at, m.end_at,
         ((m.start_at IS NULL OR m.start_at <= ${NOW}) AND (m.end_at IS NULL OR m.end_at > ${NOW})) AS active
  FROM group_members m JOIN groups g ON g.id = m.group_id JOIN users u ON u.id = m.user_id;

CREATE TRIGGER ext_group_members_insert INSTEAD OF INSERT ON ext_group_members BEGIN
  ${FK_GUARD}
  ${raise('No such group.', `${g('NEW.group_id', 'NEW.group_name')} IS NULL OR NOT EXISTS (SELECT 1 FROM groups WHERE id = ${g('NEW.group_id', 'NEW.group_name')})`)}
  ${raise('No such user.', `${userId('NEW.user_id', 'NEW.username')} IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId('NEW.user_id', 'NEW.username')})`)}
  ${raise('This group is managed outside Pons Identity (Grouper or an external directory). Change it there.',
    `(SELECT source FROM groups WHERE id = ${g('NEW.group_id', 'NEW.group_name')}) != 'local'`)}
  ${raise('This is a composite group; its members come from its two factor groups.',
    `EXISTS (SELECT 1 FROM group_composites WHERE group_id = ${g('NEW.group_id', 'NEW.group_name')})`)}
  ${raise('The end date must be after the start date.', 'NEW.start_at IS NOT NULL AND NEW.end_at IS NOT NULL AND NEW.end_at <= NEW.start_at')}
  INSERT INTO group_members (group_id, user_id, start_at, end_at)
    VALUES (${g('NEW.group_id', 'NEW.group_name')}, ${userId('NEW.user_id', 'NEW.username')}, NEW.start_at, NEW.end_at)
    ON CONFLICT(group_id, user_id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at;
  ${audit(g('NEW.group_id', 'NEW.group_name'), `(SELECT name FROM groups WHERE id = ${g('NEW.group_id', 'NEW.group_name')})`, 'member.add',
    `(SELECT username FROM users WHERE id = ${userId('NEW.user_id', 'NEW.username')})`)}
END;

CREATE TRIGGER ext_group_members_update INSTEAD OF UPDATE ON ext_group_members BEGIN
  ${FK_GUARD}
  ${raise('Only start_at and end_at of a membership can change; delete and insert to move it.', 'NEW.group_id IS NOT OLD.group_id OR NEW.user_id IS NOT OLD.user_id')}
  ${raise('This group is managed outside Pons Identity (Grouper or an external directory). Change it there.', "OLD.group_source != 'local'")}
  ${raise('The end date must be after the start date.', 'NEW.start_at IS NOT NULL AND NEW.end_at IS NOT NULL AND NEW.end_at <= NEW.start_at')}
  UPDATE group_members SET start_at = NEW.start_at, end_at = NEW.end_at WHERE group_id = OLD.group_id AND user_id = OLD.user_id;
  ${audit('OLD.group_id', 'OLD.group_name', 'member.window', "OLD.username || ': ' || COALESCE(NEW.start_at, 'now') || ' to ' || COALESCE(NEW.end_at, 'open-ended')")}
END;

CREATE TRIGGER ext_group_members_delete INSTEAD OF DELETE ON ext_group_members BEGIN
  ${FK_GUARD}
  ${raise('This group is managed outside Pons Identity (Grouper or an external directory). Change it there.', "OLD.group_source != 'local'")}
  DELETE FROM group_members WHERE group_id = OLD.group_id AND user_id = OLD.user_id;
  ${audit('OLD.group_id', 'OLD.group_name', 'member.remove', 'OLD.username')}
END;

-- Nested groups: member_group_id's members are members of group_id. Insert names each group by id or name.
CREATE VIEW ext_group_includes AS
  SELECT i.group_id, p.name AS group_name, i.member_group_id, c.name AS member_group_name
  FROM group_includes i JOIN groups p ON p.id = i.group_id JOIN groups c ON c.id = i.member_group_id;

CREATE TRIGGER ext_group_includes_insert INSTEAD OF INSERT ON ext_group_includes BEGIN
  ${FK_GUARD}
  ${raise('No such group to nest into.', `${g('NEW.group_id', 'NEW.group_name')} IS NULL OR NOT EXISTS (SELECT 1 FROM groups WHERE id = ${g('NEW.group_id', 'NEW.group_name')})`)}
  ${raise('No such group to nest.', `${g('NEW.member_group_id', 'NEW.member_group_name')} IS NULL OR NOT EXISTS (SELECT 1 FROM groups WHERE id = ${g('NEW.member_group_id', 'NEW.member_group_name')})`)}
  ${raise('This group is managed outside Pons Identity (Grouper or an external directory). Change it there.',
    `(SELECT source FROM groups WHERE id = ${g('NEW.group_id', 'NEW.group_name')}) != 'local'`)}
  ${raise('A composite group takes its members from its two factor groups; it cannot also nest groups.',
    `EXISTS (SELECT 1 FROM group_composites WHERE group_id = ${g('NEW.group_id', 'NEW.group_name')})`)}
  ${raise('Nesting that group here would create a loop.', `EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT ${g('NEW.member_group_id', 'NEW.member_group_name')}
      UNION SELECT i.member_group_id FROM group_includes i JOIN reach r ON i.group_id = r.id
      UNION SELECT c.left_id FROM group_composites c JOIN reach r ON c.group_id = r.id
      UNION SELECT c.right_id FROM group_composites c JOIN reach r ON c.group_id = r.id)
    SELECT 1 FROM reach WHERE id = ${g('NEW.group_id', 'NEW.group_name')})`)}
  INSERT OR IGNORE INTO group_includes (group_id, member_group_id)
    VALUES (${g('NEW.group_id', 'NEW.group_name')}, ${g('NEW.member_group_id', 'NEW.member_group_name')});
  ${audit(g('NEW.group_id', 'NEW.group_name'), `(SELECT name FROM groups WHERE id = ${g('NEW.group_id', 'NEW.group_name')})`, 'include.add',
    `(SELECT name FROM groups WHERE id = ${g('NEW.member_group_id', 'NEW.member_group_name')})`)}
END;

CREATE TRIGGER ext_group_includes_delete INSTEAD OF DELETE ON ext_group_includes BEGIN
  ${FK_GUARD}
  ${raise('This group is managed outside Pons Identity (Grouper or an external directory). Change it there.',
    "(SELECT source FROM groups WHERE id = OLD.group_id) != 'local'")}
  DELETE FROM group_includes WHERE group_id = OLD.group_id AND member_group_id = OLD.member_group_id;
  ${audit('OLD.group_id', 'OLD.group_name', 'include.remove', 'OLD.member_group_name')}
END;

-- Composite groups (read-only): members are op(left, right), op being union, intersect or minus.
CREATE VIEW ext_group_composites AS
  SELECT c.group_id, g.name AS group_name, c.op, c.left_id, l.name AS left_name, c.right_id, r.name AS right_name
  FROM group_composites c JOIN groups g ON g.id = c.group_id JOIN groups l ON l.id = c.left_id JOIN groups r ON r.id = c.right_id;

-- People, without credentials (read-only), so integrations can look up ids without touching the users table.
CREATE VIEW ext_users AS
  SELECT id, guid, username, display_name, email, active FROM users;
`;
}

module.exports = { install, VIEWS };
