const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');
const db = require('../db');
const auditLog = require('../audit');
const engine = require('./engine');
const functions = require('./functions');
const inputs = require('./inputs');
const host = require('./host');
const schedules = require('./schedule');
const { EVENTS, fieldsOf } = require('./events');
const logging = require('./logging');
const logStore = require('../files/logs');
const files = require('../files/store');
const gm = require('../group-membership');

// Integrations: named scripts an administrator writes, with the scopes they may use and an optional webhook. Running one
// records the run in integration_runs (the newest RUNS_KEPT per integration): it is 'running' until it ends, then its status,
// output, log and result are kept. The log lines it chose to save go to the files module (files/logs.js).

const RUNS_KEPT = 50;
// Runs that are going now: each one's lines so far, and a feed that tells the run pages watching it about each new line and the end.
const liveRuns = new Map();
// The server a run happened on, for the run's page. NODE_NAME names it; otherwise its host name.
const NODE = process.env.NODE_NAME || os.hostname();
const MAX_INTEGRATIONS = 100;
const NAME_MAX = 100;
// The Inputs table names the data the integration is started with; each variable holds one value.
const STARTER = `// Runs when the integration is started. first_name, last_name and email are its inputs.
// Return a value to store it as the run result.
const user = await idp.users.find({ email });
if (user) return { skipped: true, reason: 'already exists', username: user.username };

return await idp.users.create({
  username: await idp.users.suggestUsername(first_name, last_name),
  first_name,
  last_name,
  email,
  generate_password: true,
});
`;
const STARTER_INPUTS = [
  { name: 'first_name', variable: 'first_name' },
  { name: 'last_name', variable: 'last_name' },
  { name: 'email', variable: 'email' },
];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scopesOf = (row) => row.scopes.split(' ').filter(Boolean);

const scheduleViews = (integrationId) => db.all('SELECT * FROM integration_schedules WHERE integration_id = ? ORDER BY id', integrationId)
  .map((s) => ({ id: s.id, ...JSON.parse(s.schedule), label: schedules.describe(JSON.parse(s.schedule)), next_run_at: s.next_run_at }));

const view = (r, { script = true } = {}) => ({
  id: r.id, name: r.name, description: r.description, enabled: Boolean(r.enabled),
  ...(script ? { script: r.script } : {}),
  scopes: scopesOf(r), timeout_seconds: r.timeout_seconds, inputs: JSON.parse(r.inputs || '[]'),
  schedules: scheduleViews(r.id),
  events: r.events.split(' ').filter(Boolean), event_inputs: JSON.parse(r.event_inputs || '[]'),
  run_groups: db.all('SELECT g.id, g.name FROM integration_run_groups x JOIN groups g ON g.id = x.group_id WHERE x.integration_id = ? ORDER BY g.name COLLATE NOCASE', r.id),
  logging: logging.overrideView(r.id),
  file_dirs: parseJson(r.file_dirs, []),
  home_dir: r.home_dir || '',
  files_folder: homeOf(r),
  api_enabled: Boolean(r.api_enabled),
  builtin: r.builtin || '',
  deletable: require('./builtin').isDeletable(r.builtin),
  api_path: `/api/v1/integrations/${r.id}/runs`,
  webhook: { enabled: Boolean(r.webhook_token_hash), created_at: r.webhook_token_created_at, path: `/hooks/integrations/${r.id}` },
  created_at: r.created_at, created_by: r.created_by, updated_at: r.updated_at,
  last_run: db.get('SELECT id, status, started_at, trigger FROM integration_runs WHERE integration_id = ? ORDER BY id DESC LIMIT 1', r.id) || null,
});

const list = () => db.all('SELECT * FROM integrations ORDER BY name COLLATE NOCASE').map((r) => view(r, { script: false }));
const get = (id) => { const r = db.get('SELECT * FROM integrations WHERE id = ?', Number(id)); return r && view(r); };

/** Validates a submitted integration. Returns { data, errors }. */
function parse(body, existingId = null) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX) errors.push(`Name the integration (up to ${NAME_MAX} characters).`);
  else if (db.get('SELECT 1 FROM integrations WHERE name = ? AND id != ?', name, existingId || 0)) errors.push('An integration with that name already exists.');
  const table = inputs.parse(body.inputs);
  errors.push(...table.errors);
  const script = typeof body.script === 'string' ? body.script : '';
  if (script.length > engine.MAX_SCRIPT) errors.push(`The script can be at most ${engine.MAX_SCRIPT} characters.`);
  else if (!table.errors.length) {
    const problem = engine.check(script, { prelude: inputs.bindings(table.inputs, 'input ?? {}') });
    if (problem) errors.push(`Script error${problem.line ? ` on line ${problem.line}` : ''}: ${problem.message}`);
  }
  const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : [];
  if (scopes.some((s) => !host.SCOPES[s])) errors.push('Unknown scope.');
  const timeout = body.timeout_seconds === undefined ? engine.TIMEOUT.default : Number(body.timeout_seconds);
  if (!Number.isInteger(timeout) || timeout < engine.TIMEOUT.min || timeout > engine.TIMEOUT.max) errors.push(`The time limit must be between ${engine.TIMEOUT.min} and ${engine.TIMEOUT.max} seconds.`);
  const sched = [];
  if (body.schedules !== undefined && !Array.isArray(body.schedules)) errors.push('The schedules are not valid.');
  else if ((body.schedules || []).length > schedules.MAX_PER_INTEGRATION) errors.push(`An integration can have at most ${schedules.MAX_PER_INTEGRATION} schedules.`);
  else {
    for (const item of body.schedules || []) {
      const parsed = schedules.parse(item);
      errors.push(...parsed.errors);
      if (parsed.schedule) sched.push(parsed.schedule);
    }
  }
  const events = Array.isArray(body.events) ? [...new Set(body.events)] : [];
  if (events.some((e) => !EVENTS[e])) errors.push('Unknown event.');
  // What each input of an event trigger takes: a value of its own, or a field of the event. Only the fields the chosen events have.
  const eventInputs = inputs.parseValuesFrom(body.event_inputs);
  errors.push(...eventInputs.errors);
  const fields = new Set(events.filter((e) => EVENTS[e]).flatMap(fieldsOf));
  for (const row of eventInputs.rows) if (row.from && !fields.has(row.from)) errors.push(`${row.name}: ${row.from} is not a field of the chosen events.`);
  const lg = logging.parseOverride(body.logging);
  errors.push(...lg.errors);
  const runGroups = Array.isArray(body.run_groups) ? [...new Set(body.run_groups.map(Number).filter(Boolean))] : [];
  if (runGroups.length > 50) errors.push('At most 50 groups can be allowed to run an integration.');
  const fileDirs = files.parseGrants(body.file_dirs);
  errors.push(...fileDirs.errors);
  const homeDir = parseHome(body.home_dir);
  errors.push(...homeDir.errors);
  return {
    errors,
    data: { loggingJson: lg.value, runGroups, fileDirs: JSON.stringify(fileDirs.grants), homeDir: homeDir.value, apiEnabled: body.api_enabled === true, schedules: sched, events: events.join(' '), eventInputs: JSON.stringify(eventInputs.rows), name, description: typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '', enabled: body.enabled !== false, script, scopes: scopes.join(' '), timeout, inputs: JSON.stringify(table.inputs) },
  };
}

/**
 * Makes the stored schedules match `list`. A schedule left exactly as it was keeps its row and its place in time; a new
 * or changed one starts counting from now. Schedules that were removed are deleted.
 */
function saveSchedules(integrationId, list) {
  const unmatched = db.all('SELECT id, schedule FROM integration_schedules WHERE integration_id = ?', integrationId);
  const added = [];
  for (const s of list) {
    const i = unmatched.findIndex((e) => e.schedule === JSON.stringify(s));
    if (i >= 0) unmatched.splice(i, 1);
    else added.push(s);
  }
  for (const e of unmatched) db.run('DELETE FROM integration_schedules WHERE id = ?', e.id);
  const now = new Date().toISOString();
  for (const s of added) {
    db.run('INSERT INTO integration_schedules (integration_id, schedule, next_run_at, created_at) VALUES (?,?,?,?)', integrationId, JSON.stringify(s), schedules.nextRun(s), now);
  }
}

function saveRunGroups(integrationId, groupIds) {
  db.run('DELETE FROM integration_run_groups WHERE integration_id = ?', integrationId);
  for (const g of groupIds) db.run('INSERT OR IGNORE INTO integration_run_groups (integration_id, group_id) SELECT ?, id FROM groups WHERE id = ?', integrationId, g);
}

function create(data, by, { builtin = '' } = {}) {
  if (db.get('SELECT COUNT(*) AS n FROM integrations').n >= MAX_INTEGRATIONS) return { errors: [`At most ${MAX_INTEGRATIONS} integrations are allowed.`] };
  const now = new Date().toISOString();
  return db.tx(() => {
    const id = Number(db.run('INSERT INTO integrations (name, description, enabled, script, scopes, timeout_seconds, events, event_inputs, inputs, logging, api_enabled, builtin, created_at, created_by, updated_at, file_dirs, home_dir) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      data.name, data.description, data.enabled ? 1 : 0, data.script, data.scopes, data.timeout, data.events, data.eventInputs, data.inputs, data.loggingJson || '', data.apiEnabled ? 1 : 0, builtin, now, by, now, data.fileDirs, data.homeDir).lastInsertRowid);
    saveSchedules(id, data.schedules);
    saveRunGroups(id, data.runGroups || []);
    return { integration: get(id) };
  });
}

function update(id, data) {
  return db.tx(() => {
    db.run('UPDATE integrations SET name = ?, description = ?, enabled = ?, script = ?, scopes = ?, timeout_seconds = ?, events = ?, event_inputs = ?, inputs = ?, logging = ?, api_enabled = ?, file_dirs = ?, home_dir = ?, updated_at = ? WHERE id = ?',
      data.name, data.description, data.enabled ? 1 : 0, data.script, data.scopes, data.timeout, data.events, data.eventInputs, data.inputs, data.loggingJson || '', data.apiEnabled ? 1 : 0, data.fileDirs, data.homeDir, new Date().toISOString(), Number(id));
    saveSchedules(Number(id), data.schedules);
    saveRunGroups(Number(id), data.runGroups || []);
    return get(id);
  });
}

/** Enabled integrations a person may run because they belong to one of its run groups (nested groups count). */
function runnableBy(userId) {
  const mine = new Set(gm.effectiveGroupsOf(userId).map((g) => g.id));
  if (!mine.size) return [];
  const allowed = db.all('SELECT DISTINCT integration_id, group_id FROM integration_run_groups');
  const ids = new Set(allowed.filter((a) => mine.has(a.group_id)).map((a) => a.integration_id));
  return db.all('SELECT * FROM integrations WHERE enabled = 1 ORDER BY name COLLATE NOCASE').filter((r) => ids.has(r.id));
}

const remove = (id) => db.run('DELETE FROM integrations WHERE id = ?', Number(id)).changes > 0;

/**
 * Puts a built-in integration's original name, description, script, scopes, inputs and time limit back. Its schedules, events,
 * run groups, webhook and whether it is turned on are left as they are. Returns { integration } or { errors }.
 */
function restoreBuiltin(id) {
  const row = db.get('SELECT * FROM integrations WHERE id = ?', Number(id));
  const original = row && require('./builtin').find(row.builtin);
  if (!original) return { errors: ['Only a built-in integration can be restored.'] };
  const { data, errors } = parse({ name: original.name, description: original.description, script: original.script, scopes: original.scopes, inputs: original.inputs, timeout_seconds: 30, enabled: row.enabled === 1 }, row.id);
  if (errors.length) return { errors };
  db.run('UPDATE integrations SET name = ?, description = ?, script = ?, scopes = ?, timeout_seconds = ?, inputs = ?, updated_at = ? WHERE id = ?',
    data.name, data.description, data.script, data.scopes, data.timeout, data.inputs, new Date().toISOString(), row.id);
  return { integration: get(row.id) };
}

/** Makes (or replaces) the webhook token. The token is returned only here; only its hash is stored. */
function newWebhookToken(id) {
  const token = `iwh_${crypto.randomBytes(32).toString('base64url')}`;
  db.run('UPDATE integrations SET webhook_token_hash = ?, webhook_token_created_at = ? WHERE id = ?', sha256(token), new Date().toISOString(), Number(id));
  return token;
}

const clearWebhookToken = (id) => db.run("UPDATE integrations SET webhook_token_hash = '', webhook_token_created_at = '' WHERE id = ?", Number(id));

function webhookMatches(row, presented) {
  if (!row.webhook_token_hash || typeof presented !== 'string') return false;
  const a = Buffer.from(sha256(presented)); const b = Buffer.from(row.webhook_token_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Passwords and tokens a script produced must not sit in run history.
const SECRET_KEY = /pass(word)?|secret|token|authorization|api_?key/i;
function hideSecrets(json) {
  try {
    return JSON.stringify(JSON.parse(json), (k, v) => (SECRET_KEY.test(k) && typeof v === 'string' ? '[redacted]' : v));
  } catch { return json; }
}

const preview = (v) => { const s = JSON.stringify(v ?? null); return s.length > 4000 ? `${s.slice(0, 4000)}…` : s; };

/** The folder relative paths in an integration's script are in: its home folder if one is set, else its own folder. */
const homeOf = (row) => row.home_dir || files.integrationHome(row.id);

/** A home folder as the form sends it. '' or nothing means the default. Returns { value, errors }. */
function parseHome(input) {
  if (input === undefined || input === null || input === '') return { value: '', errors: [] };
  try {
    const full = files.normalize(input);
    if (full === '/') return { value: '', errors: ['The home folder cannot be the top folder. Choose a folder such as /exports/hr, or leave it empty.'] };
    return { value: full, errors: [] };
  } catch (e) {
    return { value: '', errors: [`Home folder: ${e.message}`] };
  }
}

/** The folders and directories an integration may use: its home folder, then the ones granted to it. */
const fileGrants = (row) => [{ path: homeOf(row), access: 'readwrite' }, ...parseJson(row.file_dirs, [])];

/**
 * Starts a run and returns at once: { runId, done }. The run is recorded as 'running' straight away, so it can be opened while it
 * goes; `done` resolves to { outcome, run } when it has ended and its output, log and result are stored. `actor` is the console
 * user's name or 'webhook'. A disabled integration runs only as a 'test' from the console. `saveLevel` ('off' or a level), when given,
 * is the lowest level whose log lines this run saves, in place of the integration's setting.
 */
function startRun(row, { input, trigger, actor, event = '', saveLevel }) {
  const started = new Date().toISOString();
  const runId = Number(db.run('INSERT INTO integration_runs (integration_id, trigger, status, started_at, duration_ms, actor, input, node) VALUES (?,?,?,?,?,?,?,?)',
    row.id, trigger, 'running', started, 0, actor, hideSecrets(preview(input)), NODE).lastInsertRowid);
  // Lines are kept here while the run goes and pushed to the run pages following it; the database gets the whole run when it ends.
  const lines = { logs: [], output: [] };
  const feed = new EventEmitter();
  feed.setMaxListeners(0);
  liveRuns.set(runId, { lines, feed });
  const done = engine.run({ id: row.id, name: row.name, script: row.script, scopes: scopesOf(row), home: homeOf(row), fileGrants: fileGrants(row), timeoutSeconds: row.timeout_seconds, inputs: JSON.parse(row.inputs || '[]') },
    { input, trigger, event, functions: functions.sources(), live: lines, onLine: (stream, line) => feed.emit('line', stream, line) })
    .then((outcome) => {
      try { return finishRun(row, runId, outcome, { trigger, actor, event, saveLevel }); } finally {
        liveRuns.delete(runId);
        feed.emit('end');
      }
    });
  return { runId, done };
}

/**
 * Follows a run while it goes: `listener` gets { snapshot(lines), line(stream, line), end() } — the lines so far, then each new line,
 * then the end. Returns a function that stops following, or null if the run is not going.
 */
function follow(runId, listener) {
  const entry = liveRuns.get(Number(runId));
  if (!entry) return null;
  listener.snapshot({ logs: entry.lines.logs.slice(), output: entry.lines.output.slice() });
  const onLine = (stream, line) => listener.line(stream, line);
  const onEnd = () => listener.end();
  entry.feed.on('line', onLine);
  entry.feed.once('end', onEnd);
  return () => { entry.feed.off('line', onLine); entry.feed.off('end', onEnd); };
}

/** Records how a run ended, saves its log lines, and audits it. Returns { outcome, run }. */
function finishRun(row, runId, outcome, { trigger, actor, event, saveLevel }) {
  const stored = outcome.result ? hideSecrets(outcome.result) : '';
  db.run('UPDATE integration_runs SET status = ?, duration_ms = ?, result = ?, logs = ?, output = ?, error = ?, finished_at = ? WHERE id = ?',
    outcome.status, outcome.durationMs, stored, JSON.stringify(outcome.logs), JSON.stringify(outcome.output), outcome.error ? JSON.stringify(outcome.error) : '', new Date().toISOString(), runId);
  try {
    const cfg = logging.effective(row.id);
    logStore.saveRun({ integrationId: row.id, runId, logs: outcome.logs, output: outcome.output }, saveLevel === undefined ? cfg : { ...cfg, saveLevel });
  } catch (e) {
    console.error(`integration ${row.name}: saved log lines could not be written: ${e.message}`);
  }
  db.run('DELETE FROM integration_runs WHERE integration_id = ? AND id NOT IN (SELECT id FROM integration_runs WHERE integration_id = ? ORDER BY id DESC LIMIT ?)', row.id, row.id, RUNS_KEPT);
  auditLog.admin('integration.run', {
    actor: ['webhook', 'schedule', 'event'].includes(actor) ? { type: 'integration', id: row.id, name: `integration:${row.name}` } : undefined,
    outcome: outcome.status === 'ok' ? 'success' : 'failure',
    target: { type: 'integration', id: row.id, name: row.name },
    detail: { trigger, ...(event ? { event } : {}), status: outcome.status, run: runId, durationMs: outcome.durationMs, ...(outcome.error ? { error: outcome.error.message } : {}) },
  });
  return { outcome, run: runView(db.get('SELECT * FROM integration_runs WHERE id = ?', runId)) };
}

/** Runs an integration and waits for it to end: { outcome, run }. Used by the webhook, schedules, events and the user API. */
function execute(row, opts) {
  return startRun(row, opts).done;
}

/** Marks runs that were still going when the server stopped as errors, so they do not show as running for ever. */
function recoverRuns() {
  return db.run("UPDATE integration_runs SET status = 'error', finished_at = ?, error = ? WHERE status = 'running'",
    new Date().toISOString(), JSON.stringify({ message: 'The server stopped while this run was going.', line: null })).changes;
}

function parseJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }
const runView = (r) => ({
  id: r.id, trigger: r.trigger, status: r.status, started_at: r.started_at, finished_at: r.finished_at || null, duration_ms: r.duration_ms, actor: r.actor, node: r.node,
  input: parseJson(r.input, null), result: parseJson(r.result, null), logs: parseJson(r.logs, []).map((l) => ({ ...l, level: logging.levelOf(l.level), color: l.color || logging.defaultColor('log', l.level) })),
  output: parseJson(r.output, []).map((o) => ({ ...o, color: o.color || logging.defaultColor('output') })), error: parseJson(r.error, null),
});
const runs = (integrationId, limit = RUNS_KEPT) => db.all('SELECT * FROM integration_runs WHERE integration_id = ? ORDER BY id DESC LIMIT ?', Number(integrationId), limit).map(runView);

const getRun = (integrationId, runId) => {
  const r = db.get('SELECT * FROM integration_runs WHERE id = ? AND integration_id = ?', Number(runId), Number(integrationId));
  return r ? runView(r) : null;
};

/**
 * The input a run was started with, to start it again: { input }, or { status, error } when it cannot be had. A stored input has its
 * secret-looking values replaced and long inputs cut, so a run with either cannot be run again faithfully.
 */
function rerunInput(integrationId, runId) {
  const r = db.get('SELECT input FROM integration_runs WHERE id = ? AND integration_id = ?', Number(runId), Number(integrationId));
  if (!r) return { status: 404, error: 'No such run.' };
  if (r.input.includes('"[redacted]"')) return { status: 409, error: 'This run had a secret value in its input, which is not kept, so it cannot run again from here. Run it from the editor.' };
  try { return { input: JSON.parse(r.input || 'null') }; } catch { return { status: 409, error: 'This run\'s input was too long to keep, so it cannot run again from here. Run it from the editor.' }; }
}

module.exports = { restoreBuiltin, getRun, rerunInput, runnableBy, runView, list, get, parse, create, update, remove, newWebhookToken, clearWebhookToken, webhookMatches, execute, startRun, follow, recoverRuns, fileGrants, runs, NODE, STARTER, STARTER_INPUTS, RUNS_KEPT };
