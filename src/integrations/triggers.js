const db = require('../db');
const auditLog = require('../audit');
const integrations = require('./index');
const schedules = require('./schedule');
const events = require('./events');
const inputValues = require('./inputs');

// Starts integrations without a person: on a schedule, or when something happens (see events.js). Every automatic run goes
// through one queue and runs one at a time, so a burst of events or several schedules due together cannot pile up in
// parallel. A schedule that is still waiting or running is not queued again.

const MAX_QUEUE = 100;
const queue = [];
const queued = new Set(); // keys of scheduled runs waiting or running
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try { await job.run(); } catch (e) { console.error('Integration trigger failed:', e.message); }
      if (job.key) queued.delete(job.key);
    }
  } finally { draining = false; }
}

function enqueue(job) {
  if (job.key && queued.has(job.key)) return false;
  if (queue.length >= MAX_QUEUE) {
    auditLog.system('integration.queue_full', { outcome: 'failure', detail: { dropped: job.label } });
    return false;
  }
  if (job.key) queued.add(job.key);
  queue.push(job);
  drain();
  return true;
}

/** Resolves when everything queued so far has run. For tests and shutdown. */
async function idle() {
  while (queue.length || draining) await new Promise((r) => setTimeout(r, 10));
}

/** Queues every enabled scheduled integration that is due. Returns how many were queued. */
function runDue(now = new Date()) {
  let n = 0;
  const due = db.all(`SELECT s.id, s.integration_id, s.schedule, s.next_run_at, i.name, i.enabled FROM integration_schedules s
    JOIN integrations i ON i.id = s.integration_id WHERE s.next_run_at != '' AND s.next_run_at <= ?`, now.toISOString());
  for (const row of due) {
    const schedule = JSON.parse(row.schedule);
    // Moving the time on first means a crash during the run cannot make it run again at once.
    db.run('UPDATE integration_schedules SET next_run_at = ? WHERE id = ?', schedules.nextRun(schedule, now), row.id);
    if (!row.enabled) continue;
    const queuedOk = enqueue({
      key: `schedule:${row.id}`, label: `${row.name} (schedule)`,
      run: () => {
        const fresh = db.get('SELECT * FROM integrations WHERE id = ? AND enabled = 1', row.integration_id);
        return fresh && integrations.execute(fresh, { input: schedules.inputFor(schedule, row.next_run_at), trigger: 'schedule', actor: 'schedule' });
      },
    });
    if (queuedOk) n++;
  }
  return n;
}

/** Called with each audit row; queues a run for every enabled integration listening for what it records. */
function onAudit(row) {
  const event = events.eventOf(row);
  if (!event) return;
  const listening = db.all("SELECT * FROM integrations WHERE enabled = 1 AND events != ''").filter((i) => i.events.split(' ').includes(event));
  if (!listening.length) return;
  let detail = {};
  try { detail = JSON.parse(row.detail); } catch { /* an unreadable detail is passed on as empty */ }
  for (const i of listening) {
    enqueue({
      label: `${i.name} (${event})`,
      run: () => {
        const fresh = db.get('SELECT * FROM integrations WHERE id = ? AND enabled = 1', i.id);
        // The user is read when the run starts, so the script sees the person as they are then. Each input the integration
        // takes from the event (or gives a value of its own) is added to it.
        if (!fresh) return undefined;
        const eventInput = events.inputFor(event, row, detail);
        const rows = JSON.parse(fresh.event_inputs || '[]');
        return integrations.execute(fresh, { input: { ...eventInput, ...inputValues.valuesToInput(rows, eventInput) }, trigger: 'event', actor: 'event', event });
      },
    });
  }
}

let registered = false;
/** Starts listening for events. Safe to call more than once. */
function listen() {
  if (registered) return;
  registered = true;
  auditLog.onRecord(onAudit);
}

function startJob({ intervalMs = 30 * 1000 } = {}) {
  listen();
  const timer = setInterval(() => { try { runDue(); } catch (e) { console.error('Scheduled integrations failed:', e.message); } }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startJob, listen, runDue, idle, enqueue };
