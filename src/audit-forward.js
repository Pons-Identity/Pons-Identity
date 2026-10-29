const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const tls = require('tls');
const db = require('./db');
const audit = require('./audit');
const settings = require('./settings');

// Forwards audit events to an external log server / SIEM. audit_log is the queue: every sink has a cursor
// (audit_forward_state.last_id) and ships the rows after it in order, so events survive outages and restarts
// (at-least-once; the row id is in every event for de-duplication on the receiving side).

const BATCH = 200;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const FAILURE_AUDIT_EVERY_MS = 10 * 60 * 1000;
const FACILITIES = { kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7, uucp: 8, cron: 9, authpriv: 10, ftp: 11,
  local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23 };

// ---- Formats ----------------------------------------------------------------------------------------

const iso = (ts) => new Date(ts * 1000).toISOString();

function eventObject(r) {
  return {
    id: r.id,
    timestamp: iso(r.ts),
    category: r.category,
    action: r.action,
    outcome: r.outcome,
    actor: { type: r.actor_type, id: r.actor_id, name: r.actor_name },
    target: { type: r.target_type, id: r.target_id, name: r.target_name },
    source: { ip: r.ip, user_agent: r.user_agent },
    session_id: r.session_id,
    request_id: r.request_id,
    detail: audit.safeParse(r.detail),
  };
}

// Elastic Common Schema field names.
function ecsObject(r) {
  const e = eventObject(r);
  return {
    '@timestamp': e.timestamp,
    message: `${r.action} ${r.outcome}`,
    event: { id: String(r.id), kind: 'event', category: [r.category === 'user' ? 'authentication' : 'configuration'],
      action: r.action, outcome: r.outcome, dataset: 'simpleidp.audit', module: 'simpleidp' },
    user: { id: r.actor_id == null ? undefined : String(r.actor_id), name: r.actor_name || undefined },
    source: r.ip ? { ip: r.ip } : undefined,
    user_agent: r.user_agent ? { original: r.user_agent } : undefined,
    trace: r.request_id ? { id: r.request_id } : undefined,
    simpleidp: { category: r.category, actor_type: r.actor_type, target: e.target, session_id: r.session_id, detail: e.detail },
  };
}

const cefHeader = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const cefExt = (s) => String(s).replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\r?\n/g, '\\n');

function cef(r) {
  const severity = r.outcome === 'failure' ? 5 : 3;
  const ext = [
    `rt=${r.ts * 1000}`, `externalId=${r.id}`, `outcome=${cefExt(r.outcome)}`, `cat=${cefExt(r.category)}`,
    r.actor_name && `suser=${cefExt(r.actor_name)}`, r.ip && `src=${cefExt(r.ip)}`,
    r.target_name && `duser=${cefExt(r.target_name)}`, r.target_type && `cs1Label=targetType cs1=${cefExt(r.target_type)}`,
    r.request_id && `cs2Label=requestId cs2=${cefExt(r.request_id)}`, `cs3Label=detail cs3=${cefExt(r.detail)}`,
  ].filter(Boolean).join(' ');
  return `CEF:0|Pons Identity|Pons Identity|1.0|${cefHeader(r.action)}|${cefHeader(r.action)}|${severity}|${ext}`;
}

const sdEscape = (s) => String(s).replace(/[\\"\]]/g, '\\$&');

function syslogMessage(r, { facility = 'authpriv', appName = 'simpleidp' } = {}) {
  const fac = FACILITIES[facility] === undefined ? FACILITIES.authpriv : FACILITIES[facility];
  const pri = fac * 8 + (r.outcome === 'failure' ? 4 : 6); // warning / informational
  const sd = `[audit@32473 id="${r.id}" category="${sdEscape(r.category)}" action="${sdEscape(r.action)}" outcome="${sdEscape(r.outcome)}"`
    + `${r.actor_name ? ` actor="${sdEscape(r.actor_name)}"` : ''}${r.ip ? ` ip="${sdEscape(r.ip)}"` : ''}]`;
  const host = os.hostname().replace(/[^\x21-\x7e]/g, '') || '-';
  return `<${pri}>1 ${iso(r.ts)} ${host} ${appName.replace(/[^\x21-\x7e]/g, '') || '-'} ${process.pid} ${r.action.slice(0, 32)} ${sd} ${JSON.stringify(eventObject(r))}`;
}

// ---- Transports -------------------------------------------------------------------------------------

function sendUdp(host, port, messages) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    let i = 0;
    const next = () => {
      if (i >= messages.length) { sock.close(); return resolve(); }
      const buf = Buffer.from(messages[i++]);
      sock.send(buf, port, host, (err) => {
        if (err) { sock.close(); return reject(err); }
        next();
      });
    };
    sock.on('error', (e) => { try { sock.close(); } catch { /* already closed */ } reject(e); });
    next();
  });
}

// RFC 6587 octet-counting framing, so messages containing newlines are not split.
function sendStream(secure, host, port, messages, caFile) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.concat(messages.map((m) => {
      const b = Buffer.from(m);
      return Buffer.concat([Buffer.from(`${b.length} `), b]);
    }));
    const opts = { host, port, timeout: 10000 };
    if (secure && caFile) opts.ca = fs.readFileSync(caFile);
    const sock = secure ? tls.connect(opts) : net.connect(opts);
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err); else resolve();
    };
    sock.on('error', done);
    sock.on('timeout', () => done(new Error('syslog connection timed out')));
    sock.on(secure ? 'secureConnect' : 'connect', () => sock.end(payload, () => done()));
  });
}

function syslogSink(cfg) {
  const m = /^(udp|tcp|tls):\/\/(\[[^\]]+\]|[^:]+):(\d+)$/.exec(cfg.url);
  const [, proto, rawHost, port] = m;
  const host = rawHost.replace(/^\[|\]$/g, '');
  return {
    name: 'syslog',
    target: cfg.url,
    send: async (rows) => {
      const messages = rows.map((r) => syslogMessage(r, cfg));
      if (proto === 'udp') return sendUdp(host, Number(port), messages);
      return sendStream(proto === 'tls', host, Number(port), messages, cfg.caFile);
    },
  };
}

function httpSink(cfg) {
  const format = cfg.format || 'json';
  return {
    name: 'http',
    target: cfg.url,
    send: async (rows) => {
      const headers = { ...(cfg.headers || {}) };
      let body;
      if (format === 'splunk-hec') {
        headers['Content-Type'] = 'application/json';
        if (cfg.authToken && !headers.Authorization) headers.Authorization = `Splunk ${cfg.authToken}`;
        body = rows.map((r) => JSON.stringify({ time: r.ts, host: os.hostname(), source: 'simpleidp', sourcetype: '_json', event: eventObject(r) })).join('\n');
      } else if (format === 'cef') {
        headers['Content-Type'] = 'text/plain';
        body = rows.map(cef).join('\n');
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(rows.map(format === 'ecs' ? ecsObject : eventObject));
      }
      if (cfg.authToken && !headers.Authorization) headers.Authorization = `Bearer ${cfg.authToken}`;
      const res = await fetch(cfg.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from log server`);
    },
  };
}

const stdoutSink = () => ({
  name: 'stdout',
  target: 'stdout',
  send: async (rows) => { for (const r of rows) process.stdout.write(`${JSON.stringify({ audit: eventObject(r) })}\n`); },
});

// ---- Delivery ---------------------------------------------------------------------------------------

let active = [];
let kickTimer = null;
let unsubscribed = false;

const getCursor = (name) => { const r = db.get('SELECT last_id FROM audit_forward_state WHERE sink = ?', name); return r ? r.last_id : null; };
const setCursor = (name, id) => db.run(
  'INSERT INTO audit_forward_state (sink, last_id) VALUES (?, ?) ON CONFLICT(sink) DO UPDATE SET last_id = excluded.last_id', name, id);

function buildSinks(cfg) {
  const out = [];
  if (cfg.auditSyslog && cfg.auditSyslog.url) out.push(syslogSink(cfg.auditSyslog));
  if (cfg.auditHttp && cfg.auditHttp.url) out.push(httpSink(cfg.auditHttp));
  if (cfg.auditStdout) out.push(stdoutSink());
  return out;
}

// One attempt: send everything after the cursor, in order. Records the outcome on the sink.
async function attempt(s) {
  try {
    for (;;) {
      // Events about forwarding itself are kept locally only, so an unreachable SIEM cannot feed on its own errors.
      const rows = db.all('SELECT * FROM audit_log WHERE id > ? ORDER BY id LIMIT ?', s.lastId, BATCH);
      if (!rows.length) break;
      const sendable = rows.filter((r) => r.action !== 'audit.forward.failure');
      if (sendable.length) await s.send(sendable);
      s.lastId = rows[rows.length - 1].id;
      setCursor(s.name, s.lastId);
      s.lastSuccess = Date.now();
      if (s.failures) {
        s.failures = 0;
        s.lastError = null;
      }
      if (rows.length < BATCH) break;
    }
  } catch (e) {
    s.failures += 1;
    s.lastError = { at: Date.now(), message: e.message };
    s.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(s.failures, 9));
    console.error(`audit forwarding to ${s.name} (${s.target}) failed: ${e.message}`);
    if (Date.now() - s.lastFailureAudit > FAILURE_AUDIT_EVERY_MS) {
      s.lastFailureAudit = Date.now();
      audit.system('audit.forward.failure', { outcome: 'failure', target: { type: 'log_sink', name: s.name }, detail: { sink: s.name, error: e.message } });
    }
    scheduleKick(s.retryAt - Date.now());
  }
}

// At most one delivery loop per sink. A request that arrives while one is running makes it go round again,
// so rows recorded mid-flight are never left waiting for the next event.
function flushSink(s) {
  if (s.busy) {
    s.again = true;
    return s.inflight;
  }
  if (Date.now() < s.retryAt) return Promise.resolve();
  s.busy = true;
  s.inflight = (async () => {
    try {
      do {
        s.again = false;
        await attempt(s);
      } while (s.again && Date.now() >= s.retryAt);
    } finally {
      s.busy = false;
    }
  })();
  return s.inflight;
}

function flushAll() {
  return Promise.all(active.map(flushSink));
}

function scheduleKick(delay = 50) {
  if (!active.length) return;
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => { flushAll().catch((e) => console.error('audit forward:', e.message)); }, Math.max(delay, 50));
  kickTimer.unref();
}

/** Start forwarding to the sinks in `cfg` (defaults to the startup settings). Safe to call again to reconfigure. */
function start(cfg = settings) {
  stop();
  active = buildSinks(cfg).map((s) => {
    let last = getCursor(s.name);
    if (last === null) { // first time for this sink: forward new events only, not the whole history
      const m = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log');
      last = m.id;
      setCursor(s.name, last);
    }
    return { ...s, lastId: last, busy: false, retryAt: 0, failures: 0, lastSuccess: null, lastError: null, lastFailureAudit: 0 };
  });
  if (active.length && !unsubscribed) {
    audit.onRecord(() => scheduleKick());
    unsubscribed = true;
  }
  scheduleKick(0); // replay anything missed while down
  return active.map((s) => s.name);
}

function stop() {
  clearTimeout(kickTimer);
  active = [];
}

/** Resolves once every sink has caught up or failed; for shutdown and tests. */
const flush = () => flushAll();

function status() {
  const max = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log').id;
  return active.map((s) => ({
    sink: s.name,
    target: s.target,
    pending: max - s.lastId,
    lastForwardedId: s.lastId,
    lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
    lastError: s.lastError ? { at: new Date(s.lastError.at).toISOString(), message: s.lastError.message } : null,
    consecutiveFailures: s.failures,
  }));
}

module.exports = { start, stop, flush, status, eventObject, ecsObject, cef, syslogMessage, FACILITIES };
