const metadata = require('./metadata-source');
const health = require('./health');
const mdq = require('./mdq');
const audit = require('../audit');

const TICK_MS = 15 * 60 * 1000;
let timer = null;
let running = false;

/** Refresh every due source, one at a time. Failures are recorded on the source and never thrown. */
async function runOnce(log = console) {
  if (running) return;
  running = true;
  try {
    for (const src of metadata.dueSources()) {
      try {
        const r = await metadata.refreshSource(src.id);
        audit.system('federation.refresh', { target: { type: 'federation_source', id: src.id, name: src.name }, detail: { notModified: Boolean(r.notModified), entities: r.count } });
        log.log(r.notModified ? `Federation source "${src.name}" unchanged.` : `Federation source "${src.name}" refreshed: ${r.count} entities.`);
      } catch (e) {
        audit.system('federation.refresh', { outcome: 'failure', target: { type: 'federation_source', id: src.id, name: src.name }, detail: { error: e.message } });
        log.error(`Federation source "${src.name}" refresh failed: ${e.message}`);
      }
    }
    mdq.pruneCache();
    // Surface anything serious in the server log so it reaches whoever watches it, not only people who open the console.
    for (const a of health.alerts().filter((x) => x.severity === 'error')) log.error(`Federation alert (${a.code}) ${a.title}: ${a.detail}`);
  } finally {
    running = false;
  }
}

/** Check shortly after startup, then every 15 minutes. Sources are only fetched when their own interval has elapsed. */
function start(log = console) {
  if (timer) return;
  timer = setInterval(() => runOnce(log), TICK_MS);
  timer.unref();
  setTimeout(() => runOnce(log), 5000).unref();
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, runOnce };
