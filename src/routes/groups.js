const express = require('express');
const db = require('../db');
const gm = require('../group-membership');
const acl = require('../group-acl');
const att = require('../group-attestation');
const ieGroups = require('../group-include-exclude');
const { pipelineOf } = require('../group-pipeline');
const roles = require('../roles');
const { audit, recent } = require('../group-audit');
const { toArr } = require('../admin-data');
const appSettings = require('../app-settings');

// Routes for member groups, composites, membership, delegated administrators and the audit trail. Mounted twice:
// under /api/admin/groups (after requireAdmin) and under /api/my/groups for people who hold a per-group grant but
// no admin role. Each route asks for a privilege on the group (see group-acl.js); administrators holding
// groups.manage have every privilege. Only local groups can be restructured; Grouper and directory groups
// are changed at their source, though they can be nested into a local group.

const OPS = ['union', 'intersect', 'minus'];

module.exports = function groupRoutes({ delegated = false } = {}) {
  const router = express.Router();
  const fail = (res, errors, status = 400) => res.status(status).json({ errors: [].concat(errors) });

  // Load the group and require `needed` on it. Someone with no privilege at all is told the group does not exist.
  const access = (needed) => (req, res, next) => {
    req.group = db.get('SELECT * FROM groups WHERE id = ?', Number(req.params.id));
    const perms = req.perms || roles.permissionsOf(req.user.id);
    const held = req.group && acl.privilegeOn(req.user.id, perms, req.group.id);
    if (!held) return res.status(404).json({ error: 'No such group.' });
    if (acl.rank(held) < acl.rank(needed)) return res.status(403).json({ error: 'You do not have permission to do that.' });
    req.privilege = held;
    req.userPerms = perms;
    return next();
  };
  // Nesting or composing a group exposes its members to the parent, so the actor must at least see it.
  const visible = (req, id) => acl.can(req.user.id, req.userPerms, id, 'view');
  const local = (req, res, next) => (req.group.source === 'local'
    ? next()
    : res.status(409).json({ error: `This group is managed outside ${appSettings.productName()} (Grouper or an external directory). Change it there.` }));
  const factor = (id) => db.get('SELECT id, name, source FROM groups WHERE id = ?', Number(id));

  // epoch seconds from a number, numeric string or date string; null/'' clears; undefined = invalid
  const toEpoch = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : Math.floor(Date.parse(v) / 1000);
    return Number.isFinite(n) ? n : undefined;
  };

  function structure(g) {
    const includes = db.all(`SELECT c.id, c.name, c.source FROM group_includes i JOIN groups c ON c.id = i.member_group_id
                             WHERE i.group_id = ? ORDER BY c.name`, g.id);
    const includedIn = db.all(`SELECT p.id, p.name, p.source FROM group_includes i JOIN groups p ON p.id = i.group_id
                               WHERE i.member_group_id = ? ORDER BY p.name`, g.id);
    const comp = db.get('SELECT op, left_id, right_id FROM group_composites WHERE group_id = ?', g.id);
    const pair = ieGroups.pairOf(g.id);
    const effective = [...gm.effectiveMembers(g.id)];
    return {
      includes,
      included_in: includedIn,
      composite: comp && { op: comp.op, left: factor(comp.left_id), right: factor(comp.right_id) },
      include_exclude: pair && { include: factor(pair.include_id), exclude: factor(pair.exclude_id) },
      effective_count: effective.length,
      // Groups that depend on this one: adding any of them as a member would make a loop.
      would_loop: [...gm.containersOf(g.id)],
    };
  }

  router.get('/:id/structure', access('read'), (req, res) => res.json({ ...structure(req.group), privilege: req.privilege }));

  router.get('/:id/effective-members', access('read'), (req, res) => {
    const how = gm.explainMembers(req.group.id);
    const ids = [...how.keys()];
    const rows = new Map(db.all('SELECT user_id, start_at, end_at, via_rule FROM group_members WHERE group_id = ?', req.group.id).map((m) => [m.user_id, m]));
    const users = ids.length
      ? db.all(`SELECT id, username, display_name, email FROM users WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY username`, ...ids)
      : [];
    res.json(users.map((u) => {
      const e = how.get(u.id);
      const row = rows.get(u.id);
      return {
        ...u, direct: e.direct, indirect: e.via.length > 0, how: gm.howLabel(e), via: e.via.map((g) => g.name), composite: e.composite,
        by_rule: Boolean(e.direct && row && row.via_rule), start_at: row?.start_at ?? null, end_at: row?.end_at ?? null,
      };
    }));
  });

  router.get('/:id/audit', access('read'), (req, res) => res.json(recent(req.group.id)));

  /* Member groups: a group added as a direct member. Its members are indirect members of this group. */

  router.post('/:id/includes', access('admin'), local, (req, res) => {
    const child = factor(req.body.group_id);
    if (!child || !visible(req, child.id)) return fail(res, 'Choose a group to add as a member.');
    if (db.get('SELECT 1 FROM group_composites WHERE group_id = ?', req.group.id)) {
      return fail(res, 'A composite group takes its members from its two factor groups; it cannot also have member groups.', 409);
    }
    if (gm.wouldCycle(req.group.id, child.id)) return fail(res, `"${child.name}" already depends on "${req.group.name}", so adding it as a member would make a loop.`);
    db.run('INSERT OR IGNORE INTO group_includes (group_id, member_group_id) VALUES (?, ?)', req.group.id, child.id);
    audit(req.user.username, req.group, 'include.add', child.name);
    res.json(structure(req.group));
  });

  router.delete('/:id/includes/:childId', access('admin'), local, (req, res) => {
    const child = factor(req.params.childId);
    const r = db.run('DELETE FROM group_includes WHERE group_id = ? AND member_group_id = ?', req.group.id, Number(req.params.childId));
    if (r.changes) audit(req.user.username, req.group, 'include.remove', child ? child.name : req.params.childId);
    res.json(structure(req.group));
  });

  /* Composites */

  router.put('/:id/composite', access('admin'), local, (req, res) => {
    const { op } = req.body;
    const left = factor(req.body.left_id);
    const right = factor(req.body.right_id);
    if (!OPS.includes(op)) return fail(res, `Operation must be one of: ${OPS.join(', ')}.`);
    if (!left || !right || !visible(req, left.id) || !visible(req, right.id)) return fail(res, 'Choose both factor groups.');
    if (left.id === right.id) return fail(res, 'The two factors must be different groups.');
    if (db.get('SELECT 1 FROM group_includes WHERE group_id = ?', req.group.id)
      || db.get('SELECT 1 FROM group_members WHERE group_id = ?', req.group.id)) {
      return fail(res, 'Remove this group\'s direct members and member groups before making it a composite.', 409);
    }
    if (gm.wouldCycle(req.group.id, left.id) || gm.wouldCycle(req.group.id, right.id)) {
      return fail(res, 'A factor group would create a loop.');
    }
    db.run(`INSERT INTO group_composites (group_id, op, left_id, right_id) VALUES (?, ?, ?, ?)
            ON CONFLICT(group_id) DO UPDATE SET op = excluded.op, left_id = excluded.left_id, right_id = excluded.right_id`,
    req.group.id, op, left.id, right.id);
    audit(req.user.username, req.group, 'composite.set', `${left.name} ${op} ${right.name}`);
    res.json(structure(req.group));
  });

  router.delete('/:id/composite', access('admin'), local, (req, res) => {
    if (db.run('DELETE FROM group_composites WHERE group_id = ?', req.group.id).changes) {
      audit(req.user.username, req.group, 'composite.remove');
    }
    res.json(structure(req.group));
  });

  // The sequence a group's membership is built in, from basis groups through reference groups to this one.
  router.get('/:id/pipeline', access('read'), (req, res) => {
    res.json(pipelineOf(req.group.id));
  });

  // Grouper-style include and exclude groups, made when a group has none. Anyone who administers the group can make them.
  router.post('/:id/include-exclude', access('admin'), local, (req, res) => {
    const made = ieGroups.create(req.group, req.user.username);
    if (made.error) return fail(res, made.error, 409);
    res.status(201).json(structure(req.group));
  });

  /* Membership windows */

  router.put('/:id/members/:uid/window', access('update'), local, (req, res) => {
    const start = toEpoch(req.body.start_at);
    const end = toEpoch(req.body.end_at);
    if (start === undefined || end === undefined) return fail(res, 'Dates must be valid.');
    if (start !== null && end !== null && end <= start) return fail(res, 'The end date must be after the start date.');
    const r = db.run('UPDATE group_members SET start_at = ?, end_at = ? WHERE group_id = ? AND user_id = ?',
      start, end, req.group.id, Number(req.params.uid));
    if (!r.changes) return res.status(404).json({ error: 'That user is not a direct member.' });
    const u = db.get('SELECT username FROM users WHERE id = ?', Number(req.params.uid));
    audit(req.user.username, req.group, 'member.window', `${u.username}: ${start ?? 'now'} to ${end ?? 'open-ended'}`);
    res.json({ user_id: Number(req.params.uid), start_at: start, end_at: end });
  });

  /* Direct members */

  // People who could be added: not already direct members, matching an optional search.
  router.get('/:id/candidates', access('update'), local, (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    res.json(db.all(`SELECT id, username, display_name, email FROM users WHERE active = 1
                     AND id NOT IN (SELECT user_id FROM group_members WHERE group_id = ?)
                     AND (username LIKE ? OR display_name LIKE ? OR email LIKE ?) ORDER BY username LIMIT 25`,
    req.group.id, q, q, q));
  });

  router.get('/:id/members', access('read'), local, (req, res) => {
    res.json(db.all(`SELECT u.id, u.username, u.display_name, u.email, m.start_at, m.end_at FROM users u
                     JOIN group_members m ON m.user_id = u.id WHERE m.group_id = ? ORDER BY u.username`, req.group.id));
  });

  // The console keeps its own member routes (which also handle pinned Grouper members); these serve /api/my/groups.
  if (delegated) router.post('/:id/members', access('update'), local, (req, res) => {
    if (db.get('SELECT 1 FROM group_composites WHERE group_id = ?', req.group.id)) {
      return fail(res, 'This is a composite group; its members come from its two factor groups.');
    }
    for (const uid of toArr(req.body.user_ids)) {
      const u = db.get('SELECT id, username FROM users WHERE id = ?', Number(uid));
      if (!u) continue;
      if (gm.addDirect(req.group.id, u.id)) {
        audit(req.user.username, req.group, 'member.add', u.username);
      }
    }
    res.json({ ...structure(req.group), privilege: req.privilege });
  });

  if (delegated) router.delete('/:id/members/:uid', access('update'), local, (req, res) => {
    const u = db.get('SELECT id, username FROM users WHERE id = ?', Number(req.params.uid));
    if (u && db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', req.group.id, u.id).changes) {
      audit(req.user.username, req.group, 'member.remove', u.username);
    }
    res.json({ ...structure(req.group), privilege: req.privilege });
  });

  /* Delegated administrators */

  const adminRows = (groupId) => db.all(
    `SELECT a.id, a.subject_type, a.subject_id, a.privilege,
            CASE a.subject_type WHEN 'user' THEN (SELECT username FROM users WHERE id = a.subject_id)
                                WHEN 'group' THEN (SELECT name FROM groups WHERE id = a.subject_id)
                                ELSE 'Everyone' END AS subject_name
     FROM group_admins a WHERE a.group_id = ? ORDER BY a.subject_type, subject_name, a.id`, groupId);

  // Search active people to grant a privilege to (group admins have no access to the user list otherwise).
  router.get('/:id/people', access('admin'), (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    res.json(db.all(`SELECT id, username, display_name, email FROM users WHERE active = 1
                     AND (username LIKE ? OR display_name LIKE ? OR email LIKE ?) ORDER BY username LIMIT 25`, q, q, q));
  });

  router.get('/:id/admins', access('admin'), (req, res) => res.json(adminRows(req.group.id)));

  router.post('/:id/admins', access('admin'), local, (req, res) => {
    const { subject_type: type, privilege } = req.body;
    if (!['user', 'group', 'everyone'].includes(type)) return fail(res, 'Choose a person, a group or everyone.');
    if (!acl.GRANTABLE.includes(privilege)) return fail(res, `Privilege must be one of: ${acl.GRANTABLE.join(', ')}.`);
    if (type === 'everyone' && !acl.SELF_SERVICE.includes(privilege)) return fail(res, 'Everyone can only be given the right to join or leave the group.');
    let subject;
    if (type === 'everyone') subject = { id: 0, name: 'everyone' };
    else if (type === 'user') subject = db.get('SELECT id, username AS name FROM users WHERE id = ?', Number(req.body.subject_id));
    else subject = db.get('SELECT id, name FROM groups WHERE id = ?', Number(req.body.subject_id));
    if (!subject || (type === 'group' && !visible(req, subject.id))) return fail(res, `Choose an existing ${type}.`);
    if (db.run('INSERT OR IGNORE INTO group_admins (group_id, subject_type, subject_id, privilege) VALUES (?, ?, ?, ?)',
      req.group.id, type, subject.id, privilege).changes) {
      audit(req.user.username, req.group, 'admin.grant', `${privilege} to ${type === 'everyone' ? 'everyone' : `${type} ${subject.name}`}`);
    }
    res.status(201).json(adminRows(req.group.id));
  });

  router.delete('/:id/admins/:rowId', access('admin'), local, (req, res) => {
    const row = adminRows(req.group.id).find((r) => r.id === Number(req.params.rowId));
    if (row) {
      db.run('DELETE FROM group_admins WHERE id = ?', row.id);
      audit(req.user.username, req.group, 'admin.revoke', `${row.privilege} from ${row.subject_type === 'everyone' ? 'everyone' : `${row.subject_type} ${row.subject_name}`}`);
    }
    res.json(adminRows(req.group.id));
  });

  /* Group managers and regular attestation */

  // Managers and administrators of the group attest; a reader or updater who is neither cannot.
  const mayAttest = (req) => att.isManager(req.group.id, req.user.id) || acl.rank(req.privilege) >= acl.rank('admin');

  const attestationView = (req) => ({
    managers: att.managersOf(req.group.id),
    schedule: att.scheduleOf(req.group.id),
    last: att.lastAttestation(req.group.id),
    can_attest: mayAttest(req),
    can_configure: acl.rank(req.privilege) >= acl.rank('admin'),
  });

  // Every group with an attestation schedule, for administrators.
  if (!delegated) router.get('/attestations', (req, res) => {
    if (!(req.perms || roles.permissionsOf(req.user.id)).has('groups.view')) return res.status(403).json({ error: 'You do not have permission to do that.' });
    return res.json(att.overview());
  });

  router.get('/:id/attestation', access('read'), (req, res) => res.json(attestationView(req)));

  router.post('/:id/managers', access('admin'), (req, res) => {
    const u = db.get('SELECT id, username, active FROM users WHERE id = ?', Number(req.body.user_id));
    if (!u || !u.active) return fail(res, 'Choose an active person.');
    if (db.run('INSERT OR IGNORE INTO group_managers (group_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)',
      req.group.id, u.id, req.user.username, Math.floor(Date.now() / 1000)).changes) {
      audit(req.user.username, req.group, 'manager.add', u.username);
    }
    return res.status(201).json(attestationView(req));
  });

  router.delete('/:id/managers/:uid', access('admin'), (req, res) => {
    const u = db.get('SELECT id, username FROM users WHERE id = ?', Number(req.params.uid));
    if (u && db.run('DELETE FROM group_managers WHERE group_id = ? AND user_id = ?', req.group.id, u.id).changes) {
      audit(req.user.username, req.group, 'manager.remove', u.username);
    }
    res.json(attestationView(req));
  });

  router.put('/:id/attestation', access('admin'), (req, res) => {
    const { frequency } = req.body;
    if (!Object.keys(att.FREQUENCIES).includes(frequency)) return fail(res, `Frequency must be one of: ${Object.keys(att.FREQUENCIES).join(', ')}.`);
    const firstDue = toEpoch(req.body.first_due);
    if (firstDue === undefined) return fail(res, 'The first due date must be valid.');
    att.setSchedule(req.group.id, frequency, req.user.username, { firstDue });
    audit(req.user.username, req.group, 'attestation.schedule', `${frequency}, next due ${new Date(att.scheduleOf(req.group.id).next_due * 1000).toISOString().slice(0, 10)}`);
    res.json(attestationView(req));
  });

  router.delete('/:id/attestation', access('admin'), (req, res) => {
    if (db.run('DELETE FROM group_attestation_policy WHERE group_id = ?', req.group.id).changes) {
      audit(req.user.username, req.group, 'attestation.unschedule');
    }
    res.json(attestationView(req));
  });

  router.post('/:id/attest', access('read'), (req, res) => {
    if (!mayAttest(req)) return res.status(403).json({ error: 'Only a group manager can attest to this group.' });
    const note = String(req.body.note || '').trim().slice(0, 1000);
    const a = att.attest(req.group, req.user, note);
    audit(req.user.username, req.group, 'attestation.complete', `${a.member_count} member${a.member_count === 1 ? '' : 's'}${note ? `: ${note}` : ''}`);
    res.status(201).json(attestationView(req));
  });

  router.get('/:id/attestations', access('read'), (req, res) => res.json(att.history(req.group.id)));

  // "My groups": what the signed-in person can see or manage through a per-group grant.
  if (delegated) router.get('/', (req, res) => res.json(acl.delegatedGroups(req.user.id)));

  /* Self-service: joining or leaving a group the person has been given the right to. */

  if (delegated) {
    const itemFor = (userId, groupId) => acl.available(userId).find((g) => g.id === groupId) || null;

    router.get('/available', (req, res) => res.json(acl.available(req.user.id)));

    router.post('/:id/join', (req, res) => {
      const id = Number(req.params.id);
      const group = db.get("SELECT id, name FROM groups WHERE id = ? AND source = 'local'", id);
      const item = group && acl.available(req.user.id).find((g) => g.id === id);
      if (!item || !acl.selfServiceGrants(req.user.id).get(id)?.optin) return res.status(403).json({ error: 'You cannot join that group.' });
      if (item.direct) return res.status(409).json({ error: 'You are already a member.' });
      gm.addDirect(id, req.user.id);
      audit(req.user.username, group, 'member.join');
      return res.json(itemFor(req.user.id, id));
    });

    router.post('/:id/leave', (req, res) => {
      const id = Number(req.params.id);
      const group = db.get("SELECT id, name FROM groups WHERE id = ? AND source = 'local'", id);
      if (!group || !acl.selfServiceGrants(req.user.id).get(id)?.optout) return res.status(403).json({ error: 'You cannot leave that group.' });
      if (!db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', id, req.user.id).changes) {
        return res.status(409).json({ error: 'You are not a direct member of that group.' });
      }
      audit(req.user.username, group, 'member.leave');
      // Still listed (with the reason) if they remain a member through another group.
      return res.json(itemFor(req.user.id, id) || { id, member: false, direct: false, can_join: false, can_leave: false });
    });
  }

  return router;
};
