const db = require('./db');
const gm = require('./group-membership');
const { buildModel } = require('./grouper-export');
const { audit } = require('./group-audit');
const ieGroups = require('./group-include-exclude');
const push = require('./grouper-push');
const appSettings = require('./app-settings');

// Hands the built-in groups over to Grouper once it holds them. A converted group becomes a 'grouper' group:
// read-only here, named as Grouper names it, and adopted by Grouper's SCIM provisioner (which matches on name).
// Because it will then be a plain list of members, nesting and composites are flattened into direct members first,
// so nobody loses access in the gap before Grouper's first sync. Every cutover is recorded so it can be reverted.

const VERIFIED_FOR_MS = 60 * 60 * 1000;
const verified = new Map(); // group id -> { status, at, key }
const keyOf = (o) => `${o.subjectField}|${o.rootStem}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const chunks = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

/** What a cutover would do to each local group. */
function buildPlan(exportOptions) {
  const model = buildModel(exportOptions);
  const graph = gm.loadGraph();
  const memo = new Map();
  const roleNames = new Set(db.all('SELECT group_name FROM grouper_role_map').map((r) => r.group_name.toLowerCase()));
  const key = keyOf(model.options);
  const groups = model.groups.map((g) => {
    const conflict = db.get('SELECT name FROM groups WHERE name = ? AND id != ?', g.name, g.id);
    const v = verified.get(g.id);
    return {
      id: g.id,
      name: g.local_name,
      grouper_name: g.name,
      renamed: g.name !== g.local_name,
      conflict: conflict ? `Another group is already named "${g.name}".` : '',
      direct: db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', g.id).n,
      effective: gm.effectiveMembers(g.id, undefined, graph, memo).size,
      nested: db.get('SELECT COUNT(*) AS n FROM group_includes WHERE group_id = ?', g.id).n,
      composite: Boolean(db.get('SELECT 1 FROM group_composites WHERE group_id = ?', g.id)),
      delegations: db.get('SELECT COUNT(*) AS n FROM group_admins WHERE group_id = ?', g.id).n,
      carries_role: roleNames.has(g.name.toLowerCase()),
      verification: v && v.key === key && Date.now() - v.at < VERIFIED_FOR_MS ? v.status : 'unverified',
    };
  });
  return { options: model.options, groups };
}

/**
 * Compares each group's members here with what Grouper holds. A group is 'match' only if Grouper has the group and exactly
 * the same people, and nobody here was left out of the push (a person with no identifier would lose the group at cutover).
 */
async function verify(ws, exportOptions, rawPushOptions, groupIds) {
  const { options: pushOptions, errors } = push.parseOptions(rawPushOptions);
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { errors });
  const plan = buildPlan(exportOptions);
  const wanted = groupIds ? new Set(groupIds.map(Number)) : null;
  const targets = plan.groups.filter((g) => !wanted || wanted.has(g.id));
  const field = plan.options.subjectField;

  const graph = gm.loadGraph();
  const memo = new Map();
  const users = new Map(db.all(`SELECT id, username, ${field} AS subject FROM users`).map((u) => [u.id, { username: u.username, subject: String(u.subject || '').trim() }]));
  const effective = new Map(targets.map((g) => [g.id, [...gm.effectiveMembers(g.id, undefined, graph, memo)].map((uid) => ({ uid, ...users.get(uid) }))]));

  // Ask Grouper who each identifier is, so the comparison uses Grouper's own subject IDs.
  const values = [...new Set([...effective.values()].flat().map((m) => m.subject).filter(Boolean))];
  const resolved = new Map();
  for (const batch of chunks(values, 100)) {
    const found = await ws.getSubjects(batch.map((v) => ({ [pushOptions.lookupBy]: v, ...(pushOptions.subjectSourceId ? { subjectSourceId: pushOptions.subjectSourceId } : {}) })));
    found.forEach((f, i) => { if (f.found && f.id) resolved.set(batch[i], f.id); });
  }

  const rows = [];
  for (const batch of chunks(targets, 20)) {
    const live = await ws.getMembers(batch.map((g) => g.grouper_name));
    batch.forEach((g, i) => {
      const mine = effective.get(g.id);
      const unpushed = mine.filter((m) => !m.subject).map((m) => m.username);
      const unknown = mine.filter((m) => m.subject && !resolved.has(m.subject)).map((m) => m.username);
      const row = { id: g.id, grouper_name: g.grouper_name, name: g.name, code: live[i].code, unpushed, unknown, missing: [], extraCount: 0 };
      if (!live[i].found) {
        row.status = 'missing';
      } else {
        const theirs = new Set(live[i].members.filter((m) => m.sourceId !== 'g:isa').map((m) => m.id));
        const expected = new Map(mine.filter((m) => resolved.has(m.subject)).map((m) => [resolved.get(m.subject), m.username]));
        row.missing = [...expected].filter(([id]) => !theirs.has(id)).map(([, username]) => username);
        row.extraCount = [...theirs].filter((id) => !expected.has(id)).length;
        row.status = !row.missing.length && !row.extraCount && !unpushed.length && !unknown.length ? 'match' : 'differs';
      }
      verified.set(g.id, { status: row.status, at: Date.now(), key: keyOf(plan.options) });
      rows.push(row);
    });
  }
  const summary = { checked: rows.length, match: rows.filter((r) => r.status === 'match').length, differs: rows.filter((r) => r.status === 'differs').length, missing: rows.filter((r) => r.status === 'missing').length };
  return { summary, rows: rows.map((r) => ({ ...r, missing: r.missing.slice(0, 20), missingCount: r.missing.length, unpushed: r.unpushed.slice(0, 20), unpushedCount: r.unpushed.length, unknown: r.unknown.slice(0, 20), unknownCount: r.unknown.length })) };
}

class CutoverError extends Error {
  constructor(errors, status = 400) { super([].concat(errors).join(' ')); this.errors = [].concat(errors); this.status = status; }
}

/** Converts the chosen groups to Grouper-managed ones. All or nothing. */
function apply({ groupIds, exportOptions, actor, force = false, pinRoleMembers = true }) {
  const plan = buildPlan(exportOptions);
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  const chosen = [...new Set((groupIds || []).map(Number))].map((id) => byId.get(id));
  if (!chosen.length) throw new CutoverError('Choose at least one group.');
  if (chosen.some((g) => !g)) throw new CutoverError(`Only groups kept in ${appSettings.productName()} can be handed to Grouper.`);
  const conflicts = chosen.filter((g) => g.conflict);
  if (conflicts.length) throw new CutoverError(conflicts.map((g) => `${g.name}: ${g.conflict}`), 409);
  const unverified = chosen.filter((g) => g.verification !== 'match');
  if (unverified.length && !force) {
    throw new CutoverError(`Not confirmed identical in Grouper: ${unverified.map((g) => g.name).join(', ')}. Check them first, or override.`, 409);
  }

  return db.tx(() => {
    const now = nowSec();
    // Resolve everything from the structure as it is now, before any of it is removed.
    const graph = gm.loadGraph();
    const memo = new Map();
    const effective = new Map(chosen.map((g) => [g.id, gm.effectiveMembers(g.id, now, graph, memo)]));

    const snapshot = [];
    let pinned = 0;
    for (const g of chosen) {
      const row = db.get('SELECT id, name, description FROM groups WHERE id = ?', g.id);
      const direct = db.all('SELECT user_id, start_at, end_at, pinned, via_grouper FROM group_members WHERE group_id = ?', g.id);
      const eff = effective.get(g.id);
      const entry = {
        id: g.id, name: row.name, description: row.description, direct,
        includes: db.all('SELECT member_group_id FROM group_includes WHERE group_id = ?', g.id).map((r) => r.member_group_id),
        composite: db.get('SELECT op, left_id, right_id FROM group_composites WHERE group_id = ?', g.id) || null,
        admins: db.all('SELECT subject_type, subject_id, privilege FROM group_admins WHERE group_id = ?', g.id),
        materialized: [...eff].filter((uid) => !direct.some((d) => d.user_id === uid)),
      };
      snapshot.push(entry);

      // Grouper owns membership dates, so a member outside their window is dropped rather than made permanent.
      db.run(`DELETE FROM group_members WHERE group_id = ? AND NOT (pinned = 1 AND via_grouper = 0)
              ${eff.size ? `AND user_id NOT IN (${[...eff].map(() => '?').join(',')})` : ''}`, g.id, ...eff);
      const pin = pinRoleMembers && g.carries_role ? 1 : 0;
      for (const uid of eff) {
        db.run(`INSERT INTO group_members (group_id, user_id, via_grouper, pinned) VALUES (?, ?, 1, ?)
                ON CONFLICT(group_id, user_id) DO UPDATE SET via_grouper = 1, start_at = NULL, end_at = NULL,
                  pinned = MAX(pinned, excluded.pinned)`, g.id, uid, pin);
        pinned += pin;
      }
      // Grouper owns the membership from here on, so this group's local include and exclude groups go too.
      ieGroups.removeFor(g.id, actor);
      db.run('DELETE FROM group_includes WHERE group_id = ?', g.id);
      db.run('DELETE FROM group_composites WHERE group_id = ?', g.id);
      db.run('DELETE FROM group_admins WHERE group_id = ?', g.id);
      db.run("UPDATE groups SET name = ?, source = 'grouper', external_id = '' WHERE id = ?", g.grouper_name, g.id);
      audit(actor, { id: g.id, name: g.grouper_name }, 'cutover', g.renamed ? `renamed from ${row.name}` : '');
      verified.delete(g.id);
    }
    const id = Number(db.run('INSERT INTO grouper_cutover (ts, actor, snapshot) VALUES (?, ?, ?)', now, actor, JSON.stringify(snapshot)).lastInsertRowid);
    return { id, converted: chosen.length, renamed: chosen.filter((g) => g.renamed).length, pinned };
  });
}

function history() {
  return db.all('SELECT id, ts, actor, snapshot, reverted_at FROM grouper_cutover ORDER BY id DESC LIMIT 20').map((r) => {
    const groups = JSON.parse(r.snapshot);
    return { id: r.id, ts: r.ts, actor: r.actor, reverted_at: r.reverted_at, groups: groups.length, names: groups.slice(0, 10).map((g) => g.name) };
  });
}

/** Puts a cutover's groups back as editable local groups. Groups that changed since are skipped and reported. */
function revert(id, actor) {
  const row = db.get('SELECT * FROM grouper_cutover WHERE id = ?', Number(id));
  if (!row) throw new CutoverError('No such cutover.', 404);
  if (row.reverted_at) throw new CutoverError('That cutover was already reverted.', 409);
  const snapshot = JSON.parse(row.snapshot);
  return db.tx(() => {
    const skipped = [];
    let reverted = 0;
    for (const e of snapshot) {
      const g = db.get('SELECT id, name, source FROM groups WHERE id = ?', e.id);
      if (!g) { skipped.push({ name: e.name, reason: 'The group no longer exists.' }); continue; }
      if (g.source !== 'grouper') { skipped.push({ name: e.name, reason: 'The group is no longer Grouper-managed.' }); continue; }
      if (db.get('SELECT 1 FROM groups WHERE name = ? AND id != ?', e.name, e.id)) { skipped.push({ name: e.name, reason: 'Another group now has the original name.' }); continue; }

      db.run("UPDATE groups SET name = ?, source = 'local', external_id = '' WHERE id = ?", e.name, e.id);
      for (const uid of e.materialized) db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', e.id, uid);
      db.run('UPDATE group_members SET via_grouper = 0, pinned = 0, start_at = NULL, end_at = NULL WHERE group_id = ?', e.id);
      if (e.composite) db.run('DELETE FROM group_members WHERE group_id = ?', e.id);
      for (const d of e.direct) {
        if (!db.get('SELECT 1 FROM users WHERE id = ?', d.user_id)) continue;
        db.run(`INSERT INTO group_members (group_id, user_id, start_at, end_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(group_id, user_id) DO UPDATE SET start_at = excluded.start_at, end_at = excluded.end_at`,
        e.id, d.user_id, d.start_at, d.end_at);
      }
      if (e.composite && db.get('SELECT 1 FROM groups WHERE id = ?', e.composite.left_id) && db.get('SELECT 1 FROM groups WHERE id = ?', e.composite.right_id)) {
        db.run('INSERT OR REPLACE INTO group_composites (group_id, op, left_id, right_id) VALUES (?, ?, ?, ?)', e.id, e.composite.op, e.composite.left_id, e.composite.right_id);
      }
      for (const child of e.includes) {
        if (db.get('SELECT 1 FROM groups WHERE id = ?', child) && !gm.wouldCycle(e.id, child)) {
          db.run('INSERT OR IGNORE INTO group_includes (group_id, member_group_id) VALUES (?, ?)', e.id, child);
        }
      }
      for (const a of e.admins) {
        const exists = a.subject_type === 'everyone' || db.get(a.subject_type === 'user' ? 'SELECT 1 FROM users WHERE id = ?' : 'SELECT 1 FROM groups WHERE id = ?', a.subject_id);
        if (exists) db.run('INSERT OR IGNORE INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, ?, ?, ?)', e.id, a.subject_type, a.subject_id, a.privilege);
      }
      audit(actor, { id: e.id, name: e.name }, 'cutover.revert', g.name !== e.name ? `was ${g.name}` : '');
      reverted += 1;
    }
    db.run('UPDATE grouper_cutover SET reverted_at = ? WHERE id = ?', nowSec(), row.id);
    return { reverted, skipped };
  });
}

module.exports = { buildPlan, verify, apply, history, revert, CutoverError };
