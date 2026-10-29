const db = require('./db');
const gm = require('./group-membership');

// Regular attestation: a group's managers confirm, monthly, quarterly or annually, that its membership is still
// right. Attesting records who the members were and moves the next due date one period on.

const FREQUENCIES = { monthly: 1, quarterly: 3, annually: 12 };
const DUE_SOON_SECONDS = 14 * 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

// `ts` plus the frequency's months, in UTC. Jan 31 + 1 month is Feb 28/29, not early March.
function addPeriod(ts, frequency) {
  const d = new Date(ts * 1000);
  const target = d.getUTCMonth() + FREQUENCIES[frequency];
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), target + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(d.getUTCFullYear(), target, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000);
}

const statusOf = (nextDue, now = nowSec()) => {
  if (nextDue <= now) return 'overdue';
  return nextDue - now <= DUE_SOON_SECONDS ? 'due_soon' : 'ok';
};

const policyOf = (groupId) => db.get('SELECT frequency, next_due, set_by, set_at FROM group_attestation_policy WHERE group_id = ?', groupId);

const managersOf = (groupId) => db.all(
  `SELECT u.id, u.username, u.display_name, u.email, u.active, m.added_by, m.added_at FROM group_managers m
     JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.username`, groupId);

const isManager = (groupId, userId) => Boolean(db.get('SELECT 1 FROM group_managers WHERE group_id = ? AND user_id = ?', groupId, userId));

const lastAttestation = (groupId) => db.get(
  'SELECT id, ts, attested_by, member_count, note FROM group_attestations WHERE group_id = ? ORDER BY id DESC LIMIT 1', groupId) || null;

// The schedule as the API shows it, or null when the group has none.
function scheduleOf(groupId, now = nowSec()) {
  const p = policyOf(groupId);
  return p && { frequency: p.frequency, next_due: p.next_due, status: statusOf(p.next_due, now), set_by: p.set_by, set_at: p.set_at };
}

// Sets (or changes) the schedule. The first due date is one period from the last attestation, or from now if there
// has never been one, unless `firstDue` (epoch seconds) is given.
function setSchedule(groupId, frequency, actor, { firstDue = null, now = nowSec() } = {}) {
  const last = lastAttestation(groupId);
  const nextDue = firstDue ?? addPeriod(last ? last.ts : now, frequency);
  db.run(`INSERT INTO group_attestation_policy (group_id, frequency, next_due, set_by, set_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(group_id) DO UPDATE SET frequency = excluded.frequency, next_due = excluded.next_due,
            set_by = excluded.set_by, set_at = excluded.set_at`, groupId, frequency, nextDue, actor, now);
  return scheduleOf(groupId, now);
}

/** Records an attestation by `actor` ({ username }) and moves the due date on. Returns the attestation. */
function attest(group, actor, note = '', now = nowSec()) {
  return db.tx(() => {
    const ids = [...gm.effectiveMembers(group.id, now)];
    const names = ids.length
      ? db.all(`SELECT username FROM users WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY username`, ...ids).map((u) => u.username)
      : [];
    const id = Number(db.run(
      'INSERT INTO group_attestations (group_id, group_name, ts, attested_by, member_count, members, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      group.id, group.name, now, actor.username, names.length, JSON.stringify(names), note).lastInsertRowid);
    const p = policyOf(group.id);
    if (p) db.run('UPDATE group_attestation_policy SET next_due = ?, last_reminder_at = NULL WHERE group_id = ?', addPeriod(now, p.frequency), group.id);
    return { id, ts: now, attested_by: actor.username, member_count: names.length, note };
  });
}

const history = (groupId, limit = 50) => db.all(
  'SELECT id, ts, attested_by, member_count, members, note FROM group_attestations WHERE group_id = ? ORDER BY id DESC LIMIT ?',
  groupId, limit).map((r) => ({ ...r, members: JSON.parse(r.members) }));

// Every group with a schedule, soonest due first, for the administrator's overview.
function overview(now = nowSec()) {
  return db.all(
    `SELECT g.id, g.name, g.source, p.frequency, p.next_due,
            (SELECT MAX(ts) FROM group_attestations a WHERE a.group_id = g.id) AS last_attested
       FROM group_attestation_policy p JOIN groups g ON g.id = p.group_id ORDER BY p.next_due, g.name`)
    .map((r) => ({ ...r, status: statusOf(r.next_due, now), managers: managersOf(r.id).map((m) => m.username) }));
}

module.exports = { FREQUENCIES, addPeriod, statusOf, scheduleOf, setSchedule, attest, history, overview, managersOf, isManager, lastAttestation };
