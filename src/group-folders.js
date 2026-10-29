const db = require('./db');
const gm = require('./group-membership');
const auditLog = require('./audit');
const { audit: auditGroup } = require('./group-audit');

// Folders that organize groups, shared by the console, the group API and (through triggers) the SQL views.
// Folders only file groups: names, membership and what a group grants are untouched, so Grouper and directory
// groups can be filed too. Siblings are ordered by position, then name; a position of 0 means "never arranged".

class FolderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_NAME = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;

function cleanName(v) {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) throw new FolderError(400, 'A folder needs a name.');
  if (name.length > MAX_NAME) throw new FolderError(400, `A folder name must be ${MAX_NAME} characters or fewer.`);
  if (CONTROL.test(name)) throw new FolderError(400, 'A folder name must not contain control characters.');
  if (name.includes('/')) throw new FolderError(400, 'A folder name cannot contain a slash.');
  return name;
}

const cleanDescription = (v) => (typeof v === 'string' ? v.trim().slice(0, 1000) : '');

const folderRow = (id) => (id == null ? null : db.get('SELECT * FROM group_folders WHERE id = ?', Number(id)) || null);

// "Parent/Child" for a folder; '' for the top level.
function pathOf(id) {
  const names = [];
  const seen = new Set();
  for (let f = folderRow(id); f && !seen.has(f.id); f = folderRow(f.parent_id)) {
    seen.add(f.id);
    names.unshift(f.name);
  }
  return names.join('/');
}

// The folder and everything inside it, as folder ids.
function subtreeIds(id) {
  return db.all(`WITH RECURSIVE s(id) AS (SELECT ? UNION SELECT f.id FROM group_folders f JOIN s ON f.parent_id = s.id) SELECT id FROM s`, Number(id)).map((r) => r.id);
}

function parentOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const f = folderRow(v);
  if (!f) throw new FolderError(404, 'No such folder.');
  return f.id;
}

/* ------------------------------- Reading ---------------------------------- */

/** Every folder and group, flat; the caller nests them by parent_id / folder_id. */
function tree() {
  const graph = gm.loadGraph();
  const memo = new Map();
  const groups = db.all(`SELECT g.id, g.name, g.description, g.source, g.folder_id, g.position,
                                (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
                         FROM groups g ORDER BY g.position, g.name`)
    .map((g) => ({ ...g, effective_count: gm.effectiveMembers(g.id, undefined, graph, memo).size }));
  const folders = db.all('SELECT id, parent_id, name, description, position FROM group_folders ORDER BY position, name');
  const paths = new Map(folders.map((f) => [f.id, null]));
  for (const f of folders) paths.set(f.id, pathOf(f.id));
  return { folders: folders.map((f) => ({ ...f, path: paths.get(f.id) })), groups };
}

/* ------------------------------- Writing ---------------------------------- */

// ctx = { actor: { type, id, name } for the central audit log, name: string for group history }
const folderTarget = (f) => ({ type: 'group_folder', id: f.id, name: pathOf(f.id) });
const auditFolder = (ctx, action, f, detail) => auditLog.admin(`group.folder.${action}`, { actor: ctx.actor, target: folderTarget(f), detail });

function uniqueSibling(name, parentId, exceptId = 0) {
  if (db.get('SELECT 1 FROM group_folders WHERE COALESCE(parent_id, 0) = COALESCE(?, 0) AND name = ? AND id != ?', parentId, name, exceptId)) {
    throw new FolderError(409, `There is already a folder called "${name}" there.`);
  }
}

function createFolder(ctx, { name, description, parent_id: parentId }) {
  name = cleanName(name);
  const parent = parentOrNull(parentId);
  uniqueSibling(name, parent);
  const next = db.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM group_folders WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)', parent).n;
  const r = db.run('INSERT INTO group_folders (parent_id, name, description, position) VALUES (?, ?, ?, ?)', parent, name, cleanDescription(description), next);
  const folder = folderRow(r.lastInsertRowid);
  auditFolder(ctx, 'create', folder, {});
  return folder;
}

// Rename or re-describe; moving is done with place().
function updateFolder(ctx, id, { name, description }) {
  const folder = folderRow(id);
  if (!folder) throw new FolderError(404, 'No such folder.');
  const next = name === undefined ? folder.name : cleanName(name);
  uniqueSibling(next, folder.parent_id, folder.id);
  db.run('UPDATE group_folders SET name = ?, description = ? WHERE id = ?', next, description === undefined ? folder.description : cleanDescription(description), folder.id);
  auditFolder(ctx, 'update', folderRow(folder.id), next !== folder.name ? { renamedFrom: folder.name } : {});
  return folderRow(folder.id);
}

// Deleting keeps the contents: groups and subfolders move up to the deleted folder's parent.
function deleteFolder(ctx, id) {
  const folder = folderRow(id);
  if (!folder) throw new FolderError(404, 'No such folder.');
  const path = pathOf(folder.id);
  const parent = folder.parent_id;
  const clash = db.all('SELECT name FROM group_folders WHERE parent_id = ?', folder.id)
    .find((c) => db.get('SELECT 1 FROM group_folders WHERE COALESCE(parent_id, 0) = COALESCE(?, 0) AND name = ?', parent, c.name));
  if (clash) throw new FolderError(409, `Its subfolder "${clash.name}" would clash with a folder of the same name one level up. Rename one first.`);
  const moved = db.get('SELECT (SELECT COUNT(*) FROM groups WHERE folder_id = ?) AS groups, (SELECT COUNT(*) FROM group_folders WHERE parent_id = ?) AS folders', folder.id, folder.id);
  db.run('DELETE FROM group_folders WHERE id = ?', folder.id);
  auditLog.admin('group.folder.delete', { actor: ctx.actor, target: { type: 'group_folder', id: folder.id, name: path }, detail: { movedGroups: moved.groups, movedFolders: moved.folders, movedTo: parent ? pathOf(parent) : '' } });
}

/**
 * Put a folder or group into a folder (parentId null = top level), before one of its new siblings of the same kind
 * (beforeId) or last. Siblings are renumbered, so the order is exactly what the caller asked for.
 */
function place(ctx, { type, id, parent_id: parentId, before_id: beforeId }) {
  if (type !== 'folder' && type !== 'group') throw new FolderError(400, 'type must be "folder" or "group".');
  const parent = parentOrNull(parentId);
  const isFolder = type === 'folder';
  const item = isFolder ? folderRow(id) : db.get('SELECT * FROM groups WHERE id = ?', Number(id));
  if (!item) throw new FolderError(404, isFolder ? 'No such folder.' : 'No such group.');
  const table = isFolder ? 'group_folders' : 'groups';
  const col = isFolder ? 'parent_id' : 'folder_id';
  if (isFolder) {
    if (parent !== null && subtreeIds(item.id).includes(parent)) throw new FolderError(400, 'A folder cannot be moved into itself or one of its subfolders.');
    uniqueSibling(item.name, parent, item.id);
  }
  const siblings = db.all(`SELECT id FROM ${table} WHERE COALESCE(${col}, 0) = COALESCE(?, 0) AND id != ? ORDER BY position, name`, parent, item.id).map((r) => r.id);
  let at = siblings.length;
  if (beforeId !== undefined && beforeId !== null && beforeId !== '') {
    at = siblings.indexOf(Number(beforeId));
    if (at < 0) throw new FolderError(400, 'before_id must be another item in the destination.');
  }
  siblings.splice(at, 0, item.id);
  // Callers may already hold a transaction (the group API changes name and filing together).
  (db.db.isTransaction ? (fn) => fn() : db.tx)(() => {
    db.run(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, parent, item.id);
    siblings.forEach((sid, i) => db.run(`UPDATE ${table} SET position = ? WHERE id = ?`, i + 1, sid));
    // A group's include and exclude groups are filed with it, so they move with it.
    if (!isFolder) {
      const pair = db.get('SELECT include_id, exclude_id FROM group_include_exclude WHERE group_id = ?', item.id);
      if (pair) db.run('UPDATE groups SET folder_id = ? WHERE id IN (?, ?)', parent, pair.include_id, pair.exclude_id);
    }
  });
  const before = isFolder ? item.parent_id : item.folder_id;
  if ((before ?? null) !== parent) {
    const from = before ? pathOf(before) : 'the top level';
    const to = parent ? pathOf(parent) : 'the top level';
    if (isFolder) auditFolder(ctx, 'move', item, { from, to });
    else auditGroup(ctx.name, item, 'move', `from ${from} to ${to}`, ctx.actor);
  }
  return isFolder ? folderRow(item.id) : db.get('SELECT * FROM groups WHERE id = ?', item.id);
}

module.exports = { FolderError, tree, pathOf, folderRow, createFolder, updateFolder, deleteFolder, place };
