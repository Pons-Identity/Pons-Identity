const db = require('../db');
const store = require('./store');
const logging = require('../integrations/logging');

// Saved log lines. They are kept in the files module, one plain text file a day for each integration:
//   /logs/integration-<id>/2026-10-25.log
// Each line is tab-separated: time (UTC, ISO), run number, stream (log | output), level, color (empty for the level's
// default) and text. A line's text has its tabs, new lines and backslashes escaped, so one line of the file is one line printed.
// The files can be downloaded in the console, or read over SFTP by a service account granted /logs.
// Retention: a file is removed once its date is older than the "keep for" days of the integration's settings (its own, or
// the global ones). The line's color is kept so the console shows what the script chose.

const LOG_ROOT = '/logs';
// A day's file is YYYY-MM-DD.log; when it is full (a file is at most 10 MB) the rest of the day goes to YYYY-MM-DD-2.log, -3 and so on.
const FILE_RE = /^\d{4}-\d{2}-\d{2}(?:-\d{1,3})?\.log$/;
const MAX_PARTS = 100;
const MAX_QUERY = 1000;

const logDir = (integrationId) => `${LOG_ROOT}/integration-${Number(integrationId)}`;
const integrationOfDir = (path) => { const m = /\/integration-(\d+)$/.exec(path); return m ? Number(m[1]) : null; };

const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
const unescapeText = (s) => s.replace(/\\(.)/g, (_, c) => ({ t: '\t', r: '\r', n: '\n' })[c] || c);

const lineOf = ({ time, run, stream, level, color, text }) => `${time}\t${run}\t${stream}\t${level}\t${color || ''}\t${escapeText(text)}\n`;

/**
 * Saves a finished run's lines: the log lines at or above the saved level, and the output lines when they are to be saved.
 * `logs` are { level, text, color, time } and `output` are { text, color, time }; both already redacted. Returns how many
 * lines were saved.
 */
function saveRun({ integrationId, runId, logs, output }, cfg = logging.get()) {
  const rank = logging.LEVELS.indexOf(cfg.saveLevel);
  const keep = [];
  if (rank >= 0) for (const l of logs) if (logging.LEVELS.indexOf(logging.levelOf(l.level)) >= rank) keep.push({ time: l.time, run: runId, stream: 'log', level: logging.levelOf(l.level), color: l.color, text: l.text });
  if (cfg.saveOutput) for (const o of output) keep.push({ time: o.time, run: runId, stream: 'output', level: 'normal', color: o.color, text: o.text });
  if (!keep.length) return 0;
  // Lines are grouped by the day they were written, so each one lands in the right file.
  const byDay = new Map();
  for (const k of keep) {
    const day = String(k.time).slice(0, 10);
    byDay.set(day, (byDay.get(day) || '') + lineOf(k));
  }
  for (const [day, text] of byDay) appendToDay(integrationId, day, text, 'logging');
  return keep.length;
}

// Adds lines to a day's file. When the file has no room for the next line, the lines go on into the next part of the day.
function appendToDay(integrationId, day, text, by) {
  const lines = text.split(/(?<=\n)/);
  let i = 0;
  for (let part = 1; i < lines.length; part++) {
    if (part > MAX_PARTS) throw new store.FileError(`The log for ${day} is full.`);
    const path = `${logDir(integrationId)}/${part === 1 ? day : `${day}-${part}`}.log`;
    const room = store.LIMITS.fileBytes - (store.stat(path)?.size || 0);
    let chunk = ''; let size = 0;
    for (; i < lines.length && size + Buffer.byteLength(lines[i]) <= room; i++) {
      chunk += lines[i];
      size += Buffer.byteLength(lines[i]);
    }
    if (chunk) store.write(path, Buffer.from(chunk, 'utf8'), { append: true, by });
  }
}

const parseLine = (line, n) => {
  const [time, run, stream, level, color, ...rest] = line.split('\t');
  return { time, run_id: Number(run), stream, level, color: color || '', text: unescapeText(rest.join('\t')), line: n };
};

/**
 * Saved lines, newest first. Filters: integration, run, level (this and above), stream (log | output), q (text, any case),
 * from and to (times), limit. Returns { lines, more }.
 */
function query(f = {}) {
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), MAX_QUERY);
  const names = new Map(db.all('SELECT id, name FROM integrations').map((r) => [r.id, r.name]));
  const dirs = f.integration ? [logDir(f.integration)] : store.list(LOG_ROOT).filter((e) => e.kind === 'dir').map((e) => e.path);
  const shownLevels = logging.LEVELS.includes(f.level) ? logging.LEVELS.slice(logging.LEVELS.indexOf(f.level)) : null;
  const q = f.q ? String(f.q).toLowerCase() : '';
  const fromDay = f.from ? String(f.from).slice(0, 10) : '';
  const toDay = f.to ? String(f.to).slice(0, 10) : '';

  // Newest day first, so a busy history stops being read once there are enough lines.
  const files = dirs.flatMap((dir) => store.list(dir)
    .filter((e) => e.kind === 'file' && FILE_RE.test(e.name))
    .map((e) => ({ path: e.path, day: e.name.slice(0, 10), integration: integrationOfDir(dir) })))
    .filter((e) => (!fromDay || e.day >= fromDay) && (!toDay || e.day <= toDay))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.path.localeCompare(b.path)));

  const found = [];
  for (let i = 0; i < files.length;) {
    const day = files[i].day;
    for (; i < files.length && files[i].day === day; i++) {
      const { path, integration } = files[i];
      const content = store.read(path)?.toString('utf8') || '';
      const rows = content.split('\n');
      rows.forEach((line, n) => {
        if (!line) return;
        const r = parseLine(line, n + 1);
        if (f.run && r.run_id !== Number(f.run)) return;
        if (f.stream && r.stream !== f.stream) return;
        if (shownLevels && r.stream !== 'output' && !shownLevels.includes(r.level)) return;
        if (q && !r.text.toLowerCase().includes(q)) return;
        if (f.from && r.time < String(f.from)) return;
        if (f.to && r.time > String(f.to)) return;
        found.push({
          id: `${path}#${r.line}`, integration_id: integration, integration: names.get(integration) || '', run_id: r.run_id,
          stream: r.stream, level: r.level, text: r.text, time: r.time, color: r.color || logging.defaultColor(r.stream, r.level), file: path,
        });
      });
    }
    if (found.length > limit) break;
  }
  found.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return { lines: found.slice(0, limit), more: found.length > limit };
}

/** Removes the saved files that are older than their integration's retention. Returns how many were removed. */
function prune(cfg = logging.get()) {
  let removed = 0;
  for (const dir of store.list(LOG_ROOT).filter((e) => e.kind === 'dir')) {
    const id = integrationOfDir(dir.path);
    const own = id ? logging.overrideOf(id) : null;
    const days = own ? own.retentionDays : cfg.retentionDays;
    if (!days) continue;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    for (const f of store.list(dir.path)) {
      if (f.kind === 'file' && FILE_RE.test(f.name) && f.name.slice(0, 10) < cutoff && store.remove(f.path)) removed++;
    }
  }
  return removed;
}

/** Deletes saved lines: one integration's, or all of them. Returns how many files were removed. */
function clear(integrationId) {
  const dirs = integrationId ? [logDir(integrationId)] : store.list(LOG_ROOT).filter((e) => e.kind === 'dir').map((e) => e.path);
  let removed = 0;
  for (const dir of dirs) {
    for (const f of store.list(dir)) if (f.kind === 'file' && store.remove(f.path)) removed++;
  }
  return removed;
}

/**
 * Moves lines kept by earlier versions (the integration_logs table) into the files module, then drops the table. Runs once, at
 * start-up; a database without the table has nothing to move.
 */
function migrateLegacy() {
  if (!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_logs'")) return 0;
  const rows = db.all('SELECT integration_id, run_id, stream, level, color, text, time FROM integration_logs ORDER BY id');
  // Grouped by integration and day, as saveRun keeps them, so each day's lines land in its file in the order they were logged.
  const byDay = new Map();
  for (const r of rows) {
    const key = `${r.integration_id}|${String(r.time).slice(0, 10)}`;
    byDay.set(key, (byDay.get(key) || '') + lineOf({ ...r, stream: r.stream === 'output' ? 'output' : 'log' }));
  }
  for (const [key, text] of byDay) {
    const [integrationId, day] = key.split('|');
    appendToDay(Number(integrationId), day, text, 'migration');
  }
  db.db.exec('DROP TABLE integration_logs');
  return rows.length;
}

module.exports = { logDir, LOG_ROOT, saveRun, query, prune, clear, migrateLegacy, escapeText, unescapeText };
