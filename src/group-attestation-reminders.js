const db = require('./db');
const messaging = require('./messaging');
const { baseUrl } = require('./settings');
const { managersOf } = require('./group-attestation');
const { audit } = require('./group-audit');

// Once a group's attestation is due and still not made, its managers are emailed each week until someone attests. Attesting
// moves the due date on and clears last_reminder_at, so the reminders stop by themselves. The wording is the
// 'attestationReminder' message template. Nothing is sent unless email is set up.

const WEEK_SECONDS = 7 * 24 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Groups whose attestation is overdue and that have not been reminded in the last week. */
const dueForReminder = (now) => db.all(
  `SELECT p.group_id, p.next_due, g.name AS group_name FROM group_attestation_policy p JOIN groups g ON g.id = p.group_id
    WHERE p.next_due <= ? AND (p.last_reminder_at IS NULL OR p.last_reminder_at <= ?) ORDER BY p.next_due, g.name`,
  now, now - WEEK_SECONDS);

// One line per group: its name, when it was due, and the address of its page.
const groupList = (groups) => groups.map((g) => {
  const due = new Date(g.next_due * 1000).toISOString().slice(0, 10);
  return `- ${g.group_name} (due ${due}): ${baseUrl}/groups/${g.group_id}`;
}).join('\n');

/**
 * Emails each manager of an overdue group, once a week, one message listing all the groups they must attest. Returns how many
 * groups were reminded. `send` defaults to the configured email provider and exists so tests can capture the messages.
 */
async function sendReminders({ now = nowSec(), send = messaging.send } = {}) {
  if (!messaging.configured('email', messaging.messaging())) return 0;
  const due = dueForReminder(now);
  const byManager = new Map();
  for (const g of due) {
    for (const m of managersOf(g.group_id).filter((x) => x.active && x.email)) {
      if (!byManager.has(m.id)) byManager.set(m.id, { manager: m, groups: [] });
      byManager.get(m.id).groups.push(g);
    }
  }
  const reminded = new Set();
  for (const { manager, groups } of byManager.values()) {
    const msg = messaging.templates.render('attestationReminder', 'email', {
      username: manager.username, displayName: manager.display_name, groups: groupList(groups),
    });
    try {
      await send('email', manager.email, msg, { rateKey: `attest-reminder:${manager.id}` });
      for (const g of groups) {
        audit('system', { id: g.group_id, name: g.group_name }, 'attestation.reminder', `sent to ${manager.username}`);
        reminded.add(g.group_id);
      }
    } catch (err) {
      for (const g of groups) audit('system', { id: g.group_id, name: g.group_name }, 'attestation.reminder_failed', `${manager.username}: ${err.message}`);
    }
  }
  for (const id of reminded) db.run('UPDATE group_attestation_policy SET last_reminder_at = ? WHERE group_id = ?', now, id);
  return reminded.size;
}

/** Runs once now and then on a timer. Returns a function that stops it. */
function startReminderJob({ intervalMs = 60 * 60 * 1000, log = console } = {}) {
  const tick = () => {
    sendReminders().then((n) => {
      if (n) log.log(`Sent attestation reminders for ${n} group${n === 1 ? '' : 's'}.`);
    }).catch((err) => log.error('Attestation reminders failed:', err.message));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { sendReminders, startReminderJob };
