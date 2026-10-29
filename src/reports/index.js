const db = require('../db');
const auditLog = require('../audit');
const engine = require('../integrations/engine');
const builtin = require('./builtin');
const builder = require('./builder');
const functions = require('./functions');

// Reports: scripts that read data and return rows. Custom ones are stored in `reports`; the pre-built ones are in builtin.js.
// A report is run with `report:read` as its only scope and with the permissions of the person running it, so it can read no
// more than that person can, and it cannot change anything. Results are returned to the caller and never stored.

const MAX_REPORTS = 200;
const NAME_MAX = 100;
const TIMEOUT = { min: 1, max: 60, default: 20 };
const STARTER = `// Runs when someone opens the report. \`input\` holds any JSON they typed in. Return rows (an array of objects) to get
// a table that can be downloaded as CSV; anything else is shown as JSON.
const users = await report.users({ active: true });
const byDepartment = {};
for (const u of users) byDepartment[u.department || '(none)'] = (byDepartment[u.department || '(none)'] || 0) + 1;

return Object.entries(byDepartment).map(([department, users]) => ({ department, users }));
`;

const view = (r, { script = true } = {}) => ({
  id: r.id, name: r.name, description: r.description, kind: r.kind || 'script', ...(script ? { script: r.script } : {}),
  ...(r.kind === 'builder' ? { definition: JSON.parse(r.definition || '{}') } : {}),
  timeout_seconds: r.timeout_seconds, created_at: r.created_at, created_by: r.created_by, updated_at: r.updated_at, builtin: false,
});

const list = () => db.all('SELECT * FROM reports ORDER BY name COLLATE NOCASE').map((r) => view(r, { script: false }));
const get = (id) => { const r = db.get('SELECT * FROM reports WHERE id = ?', Number(id)); return r && view(r); };

const builtinView = (b, { script = true } = {}) => ({
  key: b.key, name: b.name, description: b.description, requires: b.requires, input: b.input, ...(script ? { script: b.script } : {}), builtin: true,
});

/**
 * Validates a submitted report. A 'builder' report is checked by the builder and keeps no script; a 'script' report is checked
 * as before. Returns { data, errors }.
 */
function parse(body, existingId = null) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX) errors.push(`Name the report (up to ${NAME_MAX} characters).`);
  else if (db.get('SELECT 1 FROM reports WHERE name = ? AND id != ?', name, existingId || 0)) errors.push('A report with that name already exists.');
  const kind = body.kind === 'builder' ? 'builder' : 'script';
  let script = ''; let definition = '';
  if (kind === 'builder') {
    const built = builder.parse(body.definition);
    errors.push(...built.errors);
    definition = JSON.stringify(built.data);
  } else {
    script = typeof body.script === 'string' ? body.script : '';
    if (script.length > engine.MAX_SCRIPT) errors.push(`The script can be at most ${engine.MAX_SCRIPT} characters.`);
    else {
      const problem = engine.check(script);
      if (problem) errors.push(`Script error${problem.line ? ` on line ${problem.line}` : ''}: ${problem.message}`);
    }
  }
  const timeout = body.timeout_seconds === undefined ? TIMEOUT.default : Number(body.timeout_seconds);
  if (!Number.isInteger(timeout) || timeout < TIMEOUT.min || timeout > TIMEOUT.max) errors.push(`The time limit must be between ${TIMEOUT.min} and ${TIMEOUT.max} seconds.`);
  return { errors, data: { name, description: typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '', kind, script, definition, timeout } };
}

function create(data, by) {
  if (db.get('SELECT COUNT(*) AS n FROM reports').n >= MAX_REPORTS) return { errors: [`At most ${MAX_REPORTS} reports are allowed.`] };
  const now = new Date().toISOString();
  const id = Number(db.run('INSERT INTO reports (name, description, kind, script, definition, timeout_seconds, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    data.name, data.description, data.kind, data.script, data.definition, data.timeout, now, by, now).lastInsertRowid);
  return { report: get(id) };
}

function update(id, data) {
  db.run('UPDATE reports SET name = ?, description = ?, kind = ?, script = ?, definition = ?, timeout_seconds = ?, updated_at = ? WHERE id = ?',
    data.name, data.description, data.kind, data.script, data.definition, data.timeout, new Date().toISOString(), Number(id));
  return get(id);
}

const remove = (id) => db.run('DELETE FROM reports WHERE id = ?', Number(id)).changes > 0;

/**
 * Runs a report for `user` ({ username, perms }). `subject` is { id, name, script, timeoutSeconds } and `input` any JSON.
 * Resolves with the engine's outcome, with the result parsed. The run is audited by name only, never by what it returned.
 */
async function run(subject, { input, user, key = '' }) {
  if (subject.kind === 'builder') return runBuilder(subject, user);
  const outcome = await engine.run({ id: subject.id || 0, name: subject.name, script: subject.script, scopes: ['report:read'], timeoutSeconds: subject.timeoutSeconds },
    { input: input ?? null, trigger: 'report', perms: user.perms });
  auditLog.admin('report.run', {
    outcome: outcome.status === 'ok' ? 'success' : 'failure',
    actor: { type: 'user', id: user.id, name: user.username },
    target: { type: 'report', id: subject.id || key, name: subject.name },
    detail: { status: outcome.status, builtin: Boolean(key), durationMs: outcome.durationMs, ...(outcome.error ? { error: outcome.error.message } : {}) },
  });
  let result = null;
  try { result = outcome.result ? JSON.parse(outcome.result) : null; } catch { /* a redacted result that no longer parses is shown as null */ }
  return { status: outcome.status, result, logs: outcome.logs, error: outcome.error, duration_ms: outcome.durationMs };
}

/**
 * Runs a builder report, or a definition being previewed (no subject id), with the same audit line as a script run. The result has the
 * same envelope as a script's, with `result` holding { kind: 'builder', columns, rows, chart, total, truncated }.
 */
function runBuilder(subject, user) {
  const started = Date.now();
  let outcome; let result = null; let error = null;
  try {
    result = { kind: 'builder', ...builder.run(subject.definition, { perms: user.perms }) };
    outcome = 'ok';
  } catch (e) {
    outcome = 'error';
    error = e instanceof functions.ReportError ? e.message : 'The report could not be run.';
    if (!(e instanceof functions.ReportError)) console.error('Builder report failed:', e.message);
  }
  const durationMs = Date.now() - started;
  auditLog.admin('report.run', {
    outcome: outcome === 'ok' ? 'success' : 'failure',
    actor: { type: 'user', id: user.id, name: user.username },
    target: { type: 'report', id: subject.id || 0, name: subject.name || 'preview' },
    detail: { status: outcome, builder: true, durationMs, ...(error ? { error } : {}) },
  });
  return { status: outcome, result, logs: [], error: error ? { message: error, line: null } : null, duration_ms: durationMs };
}

module.exports = { list, get, parse, create, update, remove, run, builtinView, STARTER, TIMEOUT, builder };
