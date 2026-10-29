const crypto = require('crypto');
const audit = require('./audit');
const db = require('./db');
const { GrouperWs, WsError, parseTarget } = require('./grouper-ws');
const push = require('./grouper-push');

// Runs one push at a time in the background and keeps its progress for the console to poll. Credentials live only
// in the running closure; the saved record of the last run holds counts and failures, never the connection details.

let current = null;
const LAST_KEY = 'grouper_push_last';

const lastRun = () => {
  const row = db.get('SELECT value FROM settings WHERE key = ?', LAST_KEY);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
};
const saveLast = (value) => db.run(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', LAST_KEY, JSON.stringify(value));

/** Builds a client from the connection form. Throws Error with an admin-facing message when it is invalid. */
function connect(conn = {}, fetchImpl) {
  const baseUrl = parseTarget(conn.url, conn.version || 'v2_5_000');
  if (!conn.username || !conn.password) throw new Error('Enter the username and password of a Grouper web services account.');
  return new GrouperWs({ baseUrl, username: String(conn.username), password: String(conn.password), fetchImpl });
}

const view = (job) => job && {
  id: job.id, state: job.state, actor: job.actor, started_at: job.started_at, finished_at: job.finished_at,
  target: job.target, progress: job.progress, counts: job.counts, report: job.report,
};

function status() {
  return current ? view(current) : (lastRun() ? { ...lastRun(), saved: true } : null);
}

/** Starts a push. Resolves immediately with the job; rejects if one is already running. */
function start({ ws, model, options, actor, target }) {
  if (current && current.state === 'running') throw Object.assign(new Error('A push is already running.'), { status: 409 });
  const job = {
    id: crypto.randomBytes(6).toString('hex'), state: 'running', actor, target, started_at: new Date().toISOString(), finished_at: '',
    progress: { phase: 'groups', done: 0, total: model.groups.length }, counts: model.counts, report: null, cancel: false,
  };
  current = job;
  audit.record({ category: 'admin', action: 'grouper.push.start', actor: actor ? { type: 'user', name: actor } : undefined, target: { type: 'grouper', name: target && target.name ? target.name : '' }, detail: { jobId: job.id, counts: model.counts } });
  const finish = (state, report) => {
    audit.system('grouper.push.finish', { outcome: state === 'failed' ? 'failure' : 'success', target: { type: 'grouper' }, detail: { jobId: job.id, state, failureCount: report && report.failureCount, error: report && report.error } });
    job.state = state;
    job.report = report;
    job.finished_at = new Date().toISOString();
    saveLast(view(job));
  };
  push.run(ws, model, options, {
    progress: (phase, done, total) => { job.progress = { phase, done, total }; },
    cancelled: () => job.cancel,
  }).then((report) => finish(report.state, report))
    .catch((err) => finish('failed', { error: err instanceof WsError ? err.message : 'The push stopped unexpectedly.', phases: null, failures: [], failureCount: 0 }));
  return view(job);
}

function cancel() {
  if (current && current.state === 'running') current.cancel = true;
  return status();
}

module.exports = { connect, start, status, cancel, lastRun };
