const db = require('./db');
const { audit } = require('./group-audit');

// Membership end dates already take effect the moment they pass (every read checks them), so this job is housekeeping:
// it records each lapse in the group's history, once, and removes the row so the person can be added again cleanly.
// Groups owned by Grouper or a directory are skipped; they do not carry dates here.

const nowSec = () => Math.floor(Date.now() / 1000);

/** Removes memberships whose end date has passed. Returns how many were removed. */
function expireMemberships(now = nowSec()) {
  return db.tx(() => {
    const lapsed = db.all(
      `SELECT m.group_id, m.user_id, m.end_at, g.name AS group_name, u.username
         FROM group_members m JOIN groups g ON g.id = m.group_id JOIN users u ON u.id = m.user_id
        WHERE m.end_at IS NOT NULL AND m.end_at <= ? AND g.source = 'local' ORDER BY m.end_at`, now);
    for (const m of lapsed) {
      audit('system', { id: m.group_id, name: m.group_name }, 'member.expire', `${m.username} (ended ${new Date(m.end_at * 1000).toISOString()})`);
      db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', m.group_id, m.user_id);
    }
    return lapsed.length;
  });
}

/** Runs once now and then on a timer. Returns a function that stops it. */
function startExpiryJob({ intervalMs = 5 * 60 * 1000, log = console } = {}) {
  const tick = () => {
    try {
      const n = expireMemberships();
      if (n) log.log(`Expired ${n} group membership${n === 1 ? '' : 's'}.`);
    } catch (err) {
      log.error('Membership expiry failed:', err.message);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { expireMemberships, startExpiryJob };
