const path = require('path');
const vm = require('vm');
const { Worker } = require('worker_threads');
const host = require('./host');
const variables = require('./variables');
const { wrap, bindings } = require('./inputs');
const logging = require('./logging');

// Runs an integration script in a worker thread (worker.js) and answers its calls to the server (host.js). The thread is
// stopped when the time is up, so a script cannot loop forever, and has a memory ceiling. Secret variable values are blanked
// from everything that comes back.

const WORKER = path.join(__dirname, 'worker.js');
const MAX_SCRIPT = 100000;
const MAX_INPUT = 1024 * 1024;
const MAX_RESULT = 256 * 1024;
const MAX_REPORT_RESULT = 4 * 1024 * 1024;
const MAX_LOG_LINES = 200;
const MAX_OUTPUT_LINES = 1000;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_LOG_LINE = 2000;
const MAX_CONCURRENT = 4;
const TIMEOUT = { min: 1, max: 60, default: 10 };

let running = 0;

/** Syntax problems in a script, as { message, line } or null. Compiles only; nothing runs. `options` are wrap()'s: params and prelude. */
function check(script, options) {
  try {
    new vm.Script(wrap(script, options), { filename: 'script', lineOffset: -2 });
    return null;
  } catch (e) {
    const m = /script:(\d+)/.exec(String(e.stack || ''));
    return { message: e.message, line: m ? Number(m[1]) : null };
  }
}

const escaped = (s) => JSON.stringify(s).slice(1, -1);

/** Blanks every secret value (and its JSON-escaped form) from `text`. */
function redactor(secrets) {
  const all = [...new Set(secrets.flatMap((s) => [s, escaped(s)]))].sort((a, b) => b.length - a.length);
  return (text) => all.reduce((t, s) => t.split(s).join('[secret]'), String(text));
}

/**
 * Runs a script. `integration` is { id, name, script, scopes (array), timeoutSeconds }; `input` any JSON value; `trigger` is
 * 'manual' | 'webhook' | 'schedule' | 'event' | 'test' (`event` names the event for 'event'). A report passes trigger 'report' and
 * `perms`, the Set of permissions of the person running it: the script then sees no variables and gets a larger result limit. Resolves (never rejects) with
 * { status: 'ok' | 'error' | 'timeout', result (JSON text or ''), logs: [{ level, text, color, time }], output: [{ text, color, time }],
 * error: { message, line } | null, durationMs }. A log's level is debug, normal, warning or error; a color is a name or a hex value, and a line the script
 * did not color has its stream's default.
 * `inputs` is the table of { name, variable } the script declares: each variable is bound to the input's value under its name.
 * `functions` maps each function's name to { script, inputs }, so the script can call them as fn.NAME({ ... }). A report gets none.
 * `live` is { logs, output } arrays the caller owns, and `onLine(stream, line)` is called with each line as it is recorded, both
 * already redacted, so the caller can show them while the run goes.
 */
function run(integration, { input = null, trigger = 'manual', event = '', perms = null, functions = {}, live = { logs: [], output: [] }, onLine = () => {} } = {}) {
  const report = trigger === 'report';
  const started = Date.now();
  const secrets = variables.secretValues();
  const redact = redactor(secrets);
  const { logs, output } = live;
  let outputChars = 0;
  let truncated = false;
  let outputTruncated = false;
  const colors = logging.get().colors;
  const now = () => new Date().toISOString();
  const finish = (status, result, error) => ({
    status, result: result === undefined ? '' : redact(result), error: error ? { message: redact(error.message), line: error.line ?? null } : null,
    logs: logs.concat(truncated ? [{ level: 'warning', text: `Log truncated after ${MAX_LOG_LINES} lines.`, color: colors.warning, time: now() }] : []),
    output: output.concat(outputTruncated ? [{ text: 'Output truncated.', color: colors.warning, time: now() }] : []),
    durationMs: Date.now() - started,
  });

  const inputs = integration.inputs || [];
  const problem = check(integration.script, { prelude: bindings(inputs, 'input ?? {}') });
  if (problem) return Promise.resolve(finish('error', undefined, problem));
  let inputJson;
  try { inputJson = JSON.stringify(input === undefined ? null : input); } catch { return Promise.resolve(finish('error', undefined, { message: 'The input is not valid JSON.' })); }
  if (inputJson.length > MAX_INPUT) return Promise.resolve(finish('error', undefined, { message: 'The input is too large.' }));
  if (running >= MAX_CONCURRENT) return Promise.resolve(finish('error', undefined, { message: 'Too many integrations are running at once. Try again shortly.' }));

  const timeoutSeconds = Math.min(Math.max(Number(integration.timeoutSeconds) || TIMEOUT.default, TIMEOUT.min), TIMEOUT.max);
  const ctx = { integration: { id: integration.id, name: integration.name, home: integration.home }, scopes: new Set(integration.scopes), grants: integration.fileGrants || [], used: {}, perms: perms || new Set() };

  running++;
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER, {
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      workerData: {
        colors: logging.COLORS,
        script: integration.script,
        input: JSON.parse(inputJson),
        trigger: { type: trigger, at: new Date().toISOString(), ...(event ? { event } : {}) },
        integration: { id: integration.id, name: integration.name },
        inputs,
        vars: report ? {} : variables.values(),
        idp: variables.builtins(),
        functions: report ? {} : functions,
        timeoutMs: timeoutSeconds * 1000,
      },
    });
    const end = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running--;
      worker.terminate();
      // Whatever the script left open (it finished, failed, timed out or was killed) is closed now.
      host.release(ctx);
      resolve(value);
    };
    const timer = setTimeout(() => end(finish('timeout', undefined, { message: `The script did not finish within ${timeoutSeconds} seconds and was stopped.` })), timeoutSeconds * 1000 + 250);

    worker.on('message', (m) => {
      if (settled) return;
      if (m.type === 'log') {
        const level = logging.levelOf(m.level);
        if (logs.length >= MAX_LOG_LINES) truncated = true;
        else {
          const line = { level, text: redact(String(m.text).slice(0, MAX_LOG_LINE)), color: m.color || colors[level], time: now() };
          logs.push(line);
          onLine('logs', line);
        }
      } else if (m.type === 'output') {
        const text = String(m.text).slice(0, MAX_LOG_LINE);
        if (output.length >= MAX_OUTPUT_LINES || outputChars + text.length > MAX_OUTPUT_CHARS) outputTruncated = true;
        else {
          outputChars += text.length;
          const line = { text: redact(text), color: m.color || colors.output, time: now() };
          output.push(line);
          onLine('output', line);
        }
      } else if (m.type === 'call') {
        host.call(ctx, m.name, JSON.parse(m.args)).then(
          (value) => { if (!settled) worker.postMessage({ type: 'result', id: m.id, ok: true, value: value === undefined ? '' : JSON.stringify(value) }); },
          (e) => { if (!settled) worker.postMessage({ type: 'result', id: m.id, ok: false, error: e.message }); });
      } else if (m.type === 'done') {
        if (!m.ok) {
          const stopped = /Script execution timed out/.test(m.error.message);
          end(finish(stopped ? 'timeout' : 'error', undefined, stopped ? { message: `The script did not finish within ${timeoutSeconds} seconds and was stopped.` } : m.error));
        }
        else if (m.result.length > (report ? MAX_REPORT_RESULT : MAX_RESULT)) end(finish('error', undefined, { message: 'The script returned too much data.' }));
        else end(finish('ok', m.result));
      }
    });
    worker.on('error', (e) => end(finish('error', undefined, { message: e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'The script used too much memory and was stopped.' : 'The script could not be run.' })));
    worker.on('exit', () => end(finish('error', undefined, { message: 'The script stopped unexpectedly.' })));
  });
}

module.exports = { run, check, TIMEOUT, MAX_SCRIPT };
