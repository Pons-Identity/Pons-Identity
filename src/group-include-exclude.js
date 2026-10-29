const db = require('./db');
const { audit } = require('./group-audit');

// Grouper-style include and exclude groups for each local group (group_include_exclude in db.js). They are named after
// their base, "<base>:include" and "<base>:exclude", filed in the base's folder, and go when the base does. Every local
// group has a pair; the pairs' own groups do not get pairs of their own.

const SUFFIXES = { include: ':include', exclude: ':exclude' };

const pairOf = (groupId) => db.get('SELECT group_id, include_id, exclude_id FROM group_include_exclude WHERE group_id = ?', Number(groupId)) || null;

/** The base group that a group is the include or exclude group of, or null. */
function ownerOf(groupId) {
  const row = db.get('SELECT group_id FROM group_include_exclude WHERE include_id = ? OR exclude_id = ?', Number(groupId), Number(groupId));
  return row ? db.get('SELECT id, name FROM groups WHERE id = ?', row.group_id) : null;
}

/** Why a name cannot be used for a base group's include and exclude groups, or null. Names are compared without case. */
function nameError(name) {
  for (const suffix of Object.values(SUFFIXES)) {
    if (db.get('SELECT 1 FROM groups WHERE name = ?', name + suffix)) return `A group named ${name + suffix} already exists. Rename that group or choose another name.`;
  }
  return null;
}

/**
 * Makes a local group's include and exclude groups and links them to it. `base` is { id, name, folder_id, source }.
 * Returns { error } or { include, exclude }, each { id, name }.
 */
function create(base, by, actorObj) {
  if (base.source !== 'local') return { error: 'Only groups managed here can have include and exclude groups.' };
  if (pairOf(base.id)) return { error: 'This group already has include and exclude groups.' };
  const error = nameError(base.name);
  if (error) return { error };
  return db.tx(() => {
    const made = {};
    for (const [kind, suffix] of Object.entries(SUFFIXES)) {
      const name = base.name + suffix;
      const description = kind === 'include' ? `Included in ${base.name}: its members are members of ${base.name}.` : `Excluded from ${base.name}: its members are not members of ${base.name}.`;
      const id = Number(db.run('INSERT INTO groups (name, description, folder_id) VALUES (?, ?, ?)', name, description, base.folder_id ?? null).lastInsertRowid);
      made[kind] = { id, name };
      audit(by, made[kind], 'group.create', '', actorObj);
    }
    db.run('INSERT INTO group_include_exclude (group_id, include_id, exclude_id) VALUES (?, ?, ?)', base.id, made.include.id, made.exclude.id);
    audit(by, base, 'include-exclude.create', `${made.include.name} and ${made.exclude.name}`, actorObj);
    return made;
  });
}

/** Renames a base group's include and exclude groups to follow it. Call only after nameError(newName) has passed. */
function rename(baseId, newName, by, actorObj) {
  const pair = pairOf(baseId);
  if (!pair) return;
  db.tx(() => {
    for (const [kind, id] of [['include', pair.include_id], ['exclude', pair.exclude_id]]) {
      const name = newName + SUFFIXES[kind];
      const before = db.get('SELECT name FROM groups WHERE id = ?', id);
      db.run('UPDATE groups SET name = ? WHERE id = ?', name, id);
      audit(by, { id, name }, 'group.update', `renamed from ${before.name}`, actorObj);
    }
  });
}

/** Removes a group's include and exclude groups, and the link. Call before the base is deleted or stops being local. */
function removeFor(groupId, by, actorObj) {
  const pair = pairOf(groupId);
  if (!pair) return;
  const base = db.get('SELECT id, name FROM groups WHERE id = ?', pair.group_id);
  db.tx(() => {
    db.run('DELETE FROM group_include_exclude WHERE group_id = ?', pair.group_id);
    for (const id of [pair.include_id, pair.exclude_id]) {
      const g = db.get('SELECT id, name FROM groups WHERE id = ?', id);
      if (!g) continue;
      audit(by, g, 'group.delete', `include or exclude group of ${base.name}`, actorObj);
      db.run('DELETE FROM groups WHERE id = ?', id);
    }
  });
}

/**
 * Gives every local group that lacks one its include and exclude groups. Groups made before pairs existed get them here.
 * A group whose names are taken is skipped, and reported, until it is renamed. Returns the names of the groups skipped.
 */
function ensureAll(by = 'system') {
  const skipped = [];
  const lacking = db.all(`SELECT id, name, folder_id, source FROM groups WHERE source = 'local'
                          AND id NOT IN (SELECT group_id FROM group_include_exclude)
                          AND id NOT IN (SELECT include_id FROM group_include_exclude)
                          AND id NOT IN (SELECT exclude_id FROM group_include_exclude)
                          ORDER BY id`);
  for (const g of lacking) {
    const made = create(g, by);
    if (made.error) skipped.push(g.name);
  }
  if (skipped.length) console.warn(`These groups still need include and exclude groups; their names are taken: ${skipped.join(', ')}`);
  return skipped;
}

module.exports = { SUFFIXES, pairOf, ownerOf, nameError, create, rename, removeFor, ensureAll };
