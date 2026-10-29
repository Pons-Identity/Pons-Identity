// Pure helpers for the group tree: nesting the flat folder/group lists, and turning a drag onto a row into a move.

export function buildIndex({ folders, groups }) {
  const folderKids = new Map();
  const groupKids = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const f of folders) push(folderKids, f.parent_id ?? null, f);
  for (const g of groups) push(groupKids, g.folder_id ?? null, g);
  return { folders, groups, folderKids, groupKids, folderById: new Map(folders.map((f) => [f.id, f])) };
}

// Ids of the folder and every folder below it.
export function subtree(index, id) {
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) for (const k of index.folderKids.get(stack.pop()) || []) { out.add(k.id); stack.push(k.id); }
  return out;
}

// Rows in display order: a folder, then (if open) its subfolders and groups. Folders come before groups.
export function visibleRows(index, expanded) {
  const rows = [];
  const walk = (parent, depth) => {
    for (const f of index.folderKids.get(parent) || []) {
      rows.push({ kind: 'folder', item: f, depth });
      if (expanded.has(f.id)) walk(f.id, depth + 1);
    }
    for (const g of index.groupKids.get(parent) || []) rows.push({ kind: 'group', item: g, depth });
  };
  walk(null, 0);
  return rows;
}

// Where `drag` ({ kind, id }) lands when dropped on `target` ('root' or { kind, id }) at vertical `ratio` (0 top, 1 bottom).
// Returns { parent_id, before_id?, hint } for the move API, or null when the drop makes no sense.
export function resolveDrop(index, expanded, drag, target, ratio = 0.5) {
  if (!drag) return null;
  if (target === 'root') return { parent_id: null, hint: 'into' };
  if (drag.kind === target.kind && drag.id === target.id) return null;

  const siblings = (kind, parent) => ((kind === 'folder' ? index.folderKids : index.groupKids).get(parent) ?? []).filter((s) => !(s.id === drag.id && kind === drag.kind));
  const after = (kind, parent, id) => {
    const list = siblings(kind, parent);
    return list[list.findIndex((s) => s.id === id) + 1]?.id;
  };
  const placed = (kind, parent, anchor, where) => ({
    parent_id: parent,
    hint: where,
    ...(where === 'before' ? { before_id: anchor } : after(kind, parent, anchor) !== undefined ? { before_id: after(kind, parent, anchor) } : {}),
  });

  if (target.kind === 'folder') {
    const t = index.folderById.get(target.id);
    if (drag.kind === 'folder') {
      if (subtree(index, drag.id).has(t.id)) return null;
      if (ratio < 0.25) return placed('folder', t.parent_id ?? null, t.id, 'before');
      if (ratio > 0.75 && !expanded.has(t.id)) return placed('folder', t.parent_id ?? null, t.id, 'after');
    }
    return { parent_id: t.id, hint: 'into' };
  }

  const g = index.groups.find((x) => x.id === target.id);
  const parent = g.folder_id ?? null;
  if (drag.kind === 'group') return placed('group', parent, g.id, ratio < 0.5 ? 'before' : 'after');
  if (parent !== null && subtree(index, drag.id).has(parent)) return null;
  return { parent_id: parent, hint: 'after' };
}

// Folders as choices for a "move to" menu, indented by depth; a folder cannot be moved below itself.
export function folderChoices(index, exceptFolderId) {
  const blocked = exceptFolderId == null ? new Set() : subtree(index, exceptFolderId);
  const out = [];
  const walk = (parent, depth) => {
    for (const f of index.folderKids.get(parent) || []) {
      if (blocked.has(f.id)) continue;
      out.push({ id: f.id, label: f.path, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
