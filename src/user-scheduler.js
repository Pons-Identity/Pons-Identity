const db = require('./db');
const roles = require('./roles');
const gm = require('./group-membership');
const bulk = require('./bulk-users');
const userService = require('./user-service');
const auditLog = require('./audit');

// Account actions set to happen at a time: create accounts, and activate, deactivate or delete a person or every
// member of a group. Group deprovisioning is by membership at the moment it runs, not when it was scheduled.
// Each action is checked again when it runs, against the administrator who scheduled it: if they have lost access, or the
// target now outranks them, it fails instead of acting. Nobody is ever removed from the last active administrator role.

const ACTIONS = ['create', 'activate', 'deactivate', 'delete'];
const GROUP_ACTIONS = ['activate', 'deactivate'];
const nowSec = () => Math.floor(Date.now() / 1000);

class ScheduleError extends Error {}

const view = (r) => ({
  id: r.id, action: r.action, run_at: r.run_at, scope: r.scope, user_id: r.user_id, group_id: r.group_id, target: r.target_name,
  status: r.status, result: r.result, created_by: r.created_by_name, created_at: r.created_at, ran_at: r.ran_at,
  count: r.action === 'create' ? (JSON.parse(r.payload).rows || []).length : undefined,
});

const list = ({ status } = {}) => db.all(`SELECT * FROM user_schedule ${status ? 'WHERE status = ?' : ''} ORDER BY run_at DESC, id DESC LIMIT 500`, ...(status ? [status] : [])).map(view);
const forUser = (userId) => db.all("SELECT * FROM user_schedule WHERE user_id = ? AND scope = 'user' AND status = 'pending' ORDER BY run_at", userId).map(view);
const forGroup = (groupId) => db.all("SELECT * FROM user_schedule WHERE group_id = ? AND scope = 'group' AND status = 'pending' ORDER BY run_at", groupId).map(view);

function parseRunAt(v) {
  const t = typeof v === 'number' ? v : Date.parse(v);
  const sec = typeof v === 'number' ? v : Math.floor(t / 1000);
  if (!Number.isFinite(sec) || sec <= 0) throw new ScheduleError('Choose a valid date and time.');
  if (sec < nowSec() - 60) throw new ScheduleError('The time must be in the future.');
  return sec;
}

/**
 * Schedules an action. `spec` is { action, run_at (ISO string or epoch seconds), user_id | group_id | rows }.
 * For 'create', `rows` are the users (each with a password; generated ones are not supported because nobody would see
 * them). The actor is { id, name, canGroups }.
 */
async function schedule(spec, actor) {
  const action = spec.action;
  if (!ACTIONS.includes(action)) throw new ScheduleError(`Action must be one of: ${ACTIONS.join(', ')}.`);
  const runAt = parseRunAt(spec.run_at);
  let scope; let userId = null; let groupId = null; let name = ''; let payload = {};

  if (action === 'create') {
    scope = 'new';
    const results = await bulk.prepare(spec.rows, { canGroups: actor.canGroups, generatePasswords: false });
    const bad = results.filter((r) => r.status === 'error');
    if (bad.length) throw new ScheduleError(`Row ${bad[0].row}: ${bad[0].errors[0]}`);
    payload = { rows: results.map((r) => r.raw), on_error: spec.on_error === 'abort' ? 'abort' : 'skip' };
    name = results.length === 1 ? results[0].username : `${results.length} new users`;
  } else if (spec.group_id !== undefined && spec.group_id !== null) {
    if (!GROUP_ACTIONS.includes(action)) throw new ScheduleError('A group can be scheduled for activation or deactivation only.');
    const g = db.get('SELECT id, name FROM groups WHERE id = ?', Number(spec.group_id));
    if (!g) throw new ScheduleError('No such group.');
    scope = 'group'; groupId = g.id; name = g.name;
  } else {
    const u = db.get('SELECT id, username FROM users WHERE id = ?', Number(spec.user_id));
    if (!u) throw new ScheduleError('No such user.');
    if (actor.integration) {
      const refused = integrationRefusal(u);
      if (refused) throw new ScheduleError(`${u.username} ${refused}.`);
    } else {
      if (u.id === actor.id && action !== 'activate') throw new ScheduleError('You cannot schedule your own deactivation or deletion.');
      if (!roles.outranks(actor.id, u.id)) throw new ScheduleError('You cannot modify a user who has more access than you.');
    }
    scope = 'user'; userId = u.id; name = u.username;
  }
  // An API token has no account behind it: what it scheduled is tied to the token, which must still exist when it runs.
  if (actor.integration) payload = { ...payload, token_id: actor.tokenId };
  const id = Number(db.run(`INSERT INTO user_schedule (action, run_at, scope, user_id, group_id, target_name, payload, created_by, created_by_name, created_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`, action, runAt, scope, userId, groupId, name, JSON.stringify(payload), actor.integration ? null : actor.id, actor.name, nowSec()).lastInsertRowid);
  auditLog.admin('schedule.create', { actor: actorRef(actor), target: { type: scope === 'group' ? 'group' : 'user', id: userId || groupId || '', name },
    detail: { schedule: id, action, scope, run_at: new Date(runAt * 1000).toISOString() } });
  return view(db.get('SELECT * FROM user_schedule WHERE id = ?', id));
}

function cancel(id, actor) {
  const r = db.get('SELECT * FROM user_schedule WHERE id = ?', id);
  if (!r) return null;
  if (actor.integration && r.created_by !== null) throw new ScheduleError('That schedule was created by an administrator, not through the API.');
  if (r.status !== 'pending') throw new ScheduleError('Only a pending schedule can be cancelled.');
  db.run("UPDATE user_schedule SET status = 'cancelled', ran_at = ? WHERE id = ? AND status = 'pending'", nowSec(), id);
  auditLog.admin('schedule.cancel', { actor: actorRef(actor), target: { type: 'user', name: r.target_name }, detail: { schedule: id, action: r.action } });
  return view(db.get('SELECT * FROM user_schedule WHERE id = ?', id));
}

const actorRef = (a) => (a.integration ? { type: 'integration', id: a.tokenId, name: a.name } : { type: 'user', id: a.id, name: a.name });

// An API token may only act on ordinary local accounts: never on anyone holding a role (an administrator) or owned by an
// external directory. Otherwise a token that can edit users could take over an administrator.
function integrationRefusal(u) {
  if (u.directory_id) return 'is managed by an external directory';
  if (roles.permissionsOf(u.id).size) return 'has administrative access';
  return null;
}

// Does acting on `target` leave at least one other active administrator?
const lastAdmin = (targetId) => roles.isAdmin(targetId)
  && !db.all('SELECT id FROM users WHERE active = 1 AND id != ?', targetId).some((u) => roles.isAdmin(u.id));

// Applies one action to one account. Returns null on success or a short reason it was skipped.
function applyToUser(action, userId, creator) {
  const u = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return 'no longer exists';
  if (creator.integration) {
    const refused = integrationRefusal(u);
    if (refused) return refused;
  } else {
    if (u.id === creator.id && action !== 'activate') return 'is the administrator who scheduled this';
    if (!roles.outranks(creator.id, u.id)) return 'has more access than the administrator who scheduled this';
  }
  if (action !== 'activate' && lastAdmin(u.id)) return 'is the last active administrator';
  if (action === 'activate') {
    db.run('UPDATE users SET active = 1 WHERE id = ?', u.id);
  } else if (action === 'deactivate') {
    db.run('UPDATE users SET active = 0 WHERE id = ?', u.id);
    userService.revokeSessions(u.id);
  } else {
    userService.revokeSessions(u.id);
    db.run('DELETE FROM users WHERE id = ?', u.id);
  }
  auditLog.system(`user.scheduled_${action}`, { actor: actorRef(creator), target: { type: 'user', id: u.id, name: u.username }, detail: {} });
  return null;
}

function creatorOf(row) {
  if (row.created_by === null) {
    const tokenId = JSON.parse(row.payload).token_id;
    if (!tokenId || !db.get('SELECT 1 FROM user_api_tokens WHERE id = ?', tokenId)) throw new ScheduleError('The API token that scheduled this has been revoked.');
    return { creator: null, who: { integration: true, tokenId, name: row.created_by_name }, groups: true };
  }
  const creator = db.get('SELECT id, username FROM users WHERE id = ? AND active = 1', row.created_by);
  if (!creator) throw new ScheduleError('The administrator who scheduled this is no longer active.');
  const perms = roles.permissionsOf(creator.id);
  if (!perms.has('users.manage') || !perms.has('users.schedule')) throw new ScheduleError('The administrator who scheduled this no longer has permission to manage and schedule users.');
  return { creator, who: { id: creator.id, name: creator.username }, groups: perms.has('groups.manage') };
}

async function execute(row) {
  const { creator, who, groups: canGroups } = creatorOf(row);
  const by = creator ? creator.id : null;

  if (row.action === 'create') {
    const payload = JSON.parse(row.payload);
    const results = await bulk.prepare(payload.rows, { canGroups, trustedHash: true, hash: false });
    bulk.commit(results, { by, onError: payload.on_error, via: creator ? 'bulk' : 'api' });
    const created = results.filter((r) => r.status === 'created');
    for (const r of created) auditLog.system('user.scheduled_create', { actor: actorRef(who), target: { type: 'user', id: r.id, name: r.username }, detail: { schedule: row.id } });
    const failed = results.filter((r) => r.status !== 'created');
    return { ok: !failed.length, text: `Created ${created.length} of ${results.length}.${failed.length ? ` ${failed.slice(0, 5).map((r) => `${r.username || `row ${r.row}`}: ${r.errors[0]}`).join(' ')}` : ''}` };
  }

  if (row.scope === 'user') {
    const reason = applyToUser(row.action, row.user_id, who);
    return { ok: !reason, text: reason ? `${row.target_name} ${reason}.` : `${row.target_name}: ${{ activate: 'activated', deactivate: 'deactivated', delete: 'deleted' }[row.action]}.` };
  }
  const g = db.get('SELECT id FROM groups WHERE id = ?', row.group_id);
  if (!g) return { ok: false, text: `Group ${row.target_name} no longer exists.` };
  const members = [...gm.effectiveMembers(g.id)];
  const skipped = [];
  let done = 0;
  for (const id of members) {
    const reason = applyToUser(row.action, id, who);
    if (reason) skipped.push(`${(db.get('SELECT username FROM users WHERE id = ?', id) || { username: `#${id}` }).username} ${reason}`); else done++;
  }
  return { ok: true, text: `${row.action === 'activate' ? 'Activated' : 'Deactivated'} ${done} of ${members.length} members of ${row.target_name}.${skipped.length ? ` Skipped: ${skipped.slice(0, 5).join('; ')}${skipped.length > 5 ? '…' : ''}.` : ''}` };
}

let running = false;

/** Runs every pending schedule that is due. Safe to call repeatedly; overlapping calls do nothing. Returns how many ran. */
async function runDue(now = nowSec()) {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    for (const row of db.all("SELECT * FROM user_schedule WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id", now)) {
      // Claiming the row first means a schedule can never run twice, even if this crashes part way.
      if (db.run("UPDATE user_schedule SET status = 'running' WHERE id = ? AND status = 'pending'", row.id).changes === 0) continue;
      let outcome;
      try {
        outcome = await execute(row);
      } catch (e) {
        outcome = { ok: false, text: e instanceof ScheduleError ? e.message : 'Unexpected error.' };
        if (!(e instanceof ScheduleError)) console.error(`Schedule ${row.id} failed:`, e.message);
      }
      db.run('UPDATE user_schedule SET status = ?, result = ?, ran_at = ? WHERE id = ?', outcome.ok ? 'done' : 'failed', outcome.text, nowSec(), row.id);
      if (!outcome.ok) auditLog.system('schedule.failure', { outcome: 'failure', actor: { type: row.created_by === null ? 'integration' : 'user', id: row.created_by, name: row.created_by_name }, target: { type: 'user', name: row.target_name }, detail: { schedule: row.id, action: row.action, result: outcome.text } });
      n++;
    }
  } finally {
    running = false;
  }
  return n;
}

// A schedule left 'running' by a crash is marked failed at start-up rather than retried, since it may have half run.
function recoverInterrupted() {
  db.run("UPDATE user_schedule SET status = 'failed', result = 'Interrupted by a restart; check the target before scheduling again.', ran_at = ? WHERE status = 'running'", nowSec());
}

function startJob({ intervalMs = 60 * 1000, log = console } = {}) {
  recoverInterrupted();
  const tick = () => runDue().then((n) => { if (n) log.log(`Ran ${n} scheduled account action${n === 1 ? '' : 's'}.`); }).catch((e) => log.error('Scheduled actions failed:', e.message));
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { lastAdmin, schedule, cancel, list, forUser, forGroup, runDue, startJob, recoverInterrupted, ScheduleError, ACTIONS };
