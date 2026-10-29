const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const { wrap, bindings } = require('./inputs');

// Runs one integration script. This thread has no database handle and is started with an empty environment; the script
// itself runs in a bare vm context with code generation from strings switched off (no eval, no new Function), so the only
// way out is the functions built below, each of which asks the main thread (see host.js) and gets JSON text back.
// engine.js stops the whole thread if it outlives the timeout. The script is the administrator's own code: this limits
// mistakes and runaway loops, and is not a defence against a hostile administrator.

const { script, input, trigger, integration, inputs, vars, idp, functions, timeoutMs, colors: COLORS } = workerData;

let nextId = 1;
const pending = new Map();
parentPort.on('message', (m) => {
  if (m.type !== 'result') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
});

// The two functions handed into the context. Both take and return only strings.
const host = (name, args) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'call', id, name, args });
});
const emit = (level, text, color) => parentPort.postMessage({ type: 'log', level, text, color });
const emitOutput = (text, color) => parentPort.postMessage({ type: 'output', text, color });

const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });

// Everything the script sees is built here, inside the context, so it never holds an object from this realm.
const bootstrap = vm.runInContext(`(function (host, emit, emitOutput, compile, data) {
  'use strict';
  const D = JSON.parse(data);
  const call = async (name, ...args) => {
    let out;
    try { out = await host(name, JSON.stringify(args)); } catch (e) { throw new Error(String((e && e.message) || e)); }
    return out === '' ? undefined : JSON.parse(out);
  };
  const show = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  };
  // A color is a name or a hex value; an unknown one is a mistake worth stopping for, since it would silently print in the default.
  const pickColor = (c) => {
    if (typeof c !== 'string' || !(D.colors.includes(c.toLowerCase()) || /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c))) {
      throw new Error('Unknown color ' + show(c) + '. Use ' + D.colors.join(', ') + ' or a hex value such as #b3261e.');
    }
    return c.toLowerCase();
  };
  // Each printer is callable as printer(...values) and as printer.color(color, ...values) for a line of its own color.
  const printer = (write) => {
    const p = (...a) => { write(a.map(show).join(' '), ''); };
    p.color = (color, ...a) => { write(a.map(show).join(' '), pickColor(color)); };
    return p;
  };
  const logger = (level) => Object.freeze(printer((text, color) => emit(level, text, color)));

  const vars = { ...D.vars };
  if (!('get' in vars)) Object.defineProperty(vars, 'get', { value: (n, fallback) => (Object.prototype.hasOwnProperty.call(D.vars, n) ? D.vars[n] : fallback), enumerable: false });

  const withJson = (r) => {
    let parsed; let done = false;
    return { ...r, get json() { if (!done) { done = true; try { parsed = JSON.parse(r.text); } catch (e) { parsed = undefined; } } return parsed; } };
  };
  const request = async (o) => withJson(await call('http.request', o));
  const http = {
    request,
    get: (url, o = {}) => request({ ...o, url, method: 'GET' }),
    post: (url, body, o = {}) => request({ ...o, url, method: 'POST', body }),
    put: (url, body, o = {}) => request({ ...o, url, method: 'PUT', body }),
    patch: (url, body, o = {}) => request({ ...o, url, method: 'PATCH', body }),
    delete: (url, o = {}) => request({ ...o, url, method: 'DELETE' }),
  };

  const api = {
    ...D.idp,
    users: {
      find: (q) => call('users.find', q),
      search: (q) => call('users.search', q),
      create: (spec) => call('users.create', spec),
      update: (user, patch) => call('users.update', user, patch),
      delete: (user) => call('users.delete', user),
      endSessions: (user) => call('users.endSessions', user),
      resetAuthenticators: (user) => call('users.resetAuthenticators', user),
      forgetRemembered: (user) => call('users.forgetRemembered', user),
      suggestUsername: (first, last) => call('users.suggestUsername', first, last),
    },
    compromise: {
      plan: (user) => call('compromise.plan', user),
      restrict: (user, options) => call('compromise.restrict', user, options),
    },
    identity: {
      start: (user, purpose) => call('identity.start', user, purpose),
      status: (id) => call('identity.status', id),
      latest: (user, purpose) => call('identity.latest', user, purpose),
    },
    groups: {
      list: () => call('groups.list'),
      members: (name) => call('groups.members', name),
      addMember: (group, user) => call('groups.addMember', group, user),
      removeMember: (group, user) => call('groups.removeMember', group, user),
    },
  };

  const logLevels = { debug: logger('debug'), normal: logger('normal'), warning: logger('warning'), error: logger('error') };
  // log(...) is a normal line; log.debug, log.normal, log.warning (also log.warn) and log.error pick the level.
  const log = printer((text, color) => emit('normal', text, color));
  for (const [name, f] of Object.entries({ ...logLevels, warn: logLevels.warning, info: logLevels.normal })) Object.defineProperty(log, name, { value: f, enumerable: true });
  Object.freeze(log);
  const output = Object.freeze(printer((text, color) => emitOutput(text, color)));
  const g = globalThis;
  const define = (name, value) => Object.defineProperty(g, name, { value, enumerable: true });
  define('vars', Object.freeze(vars));
  define('idp', Object.freeze(api));
  define('http', Object.freeze(http));
  define('mail', Object.freeze({ send: (o) => call('mail.send', o) }));
  define('sms', Object.freeze({ send: (o) => call('sms.send', o) }));
  define('csv', Object.freeze({ parse: (text, o) => call('csv.parse', text, o), stringify: (rows, o) => call('csv.stringify', rows, o) }));
  define('files', Object.freeze({
    list: (dir) => call('files.list', dir),
    exists: (p) => call('files.exists', p),
    read: (p, o) => call('files.read', p, o),
    write: (p, content, o) => call('files.write', p, content, o),
    delete: (p, o) => call('files.delete', p, o),
    mkdir: (p) => call('files.mkdir', p),
  }));
  define('sftp', Object.freeze({
    list: (conn, path) => call('sftp.list', conn, path),
    get: (conn, path, o) => call('sftp.get', conn, path, o),
    put: (conn, path, content, o) => call('sftp.put', conn, path, content, o),
    delete: (conn, path) => call('sftp.delete', conn, path),
    download: (conn, path, name) => call('sftp.download', conn, path, name),
    upload: (conn, name, path) => call('sftp.upload', conn, name, path),
  }));
  // directory.connect(name) opens a connection and returns a handle; close() lets go of it. directory.use(name, fn) closes it for you.
  const connection = (info) => {
    const id = info.connection;
    const handle = {
      directory: info.directory,
      access: info.access,
      find: (ref, o) => call('directory.find', id, ref, o),
      search: (q) => call('directory.search', id, q),
      create: (spec) => call('directory.create', id, spec),
      update: (ref, patch) => call('directory.update', id, ref, patch),
      delete: (ref) => call('directory.delete', id, ref),
      close: () => call('directory.close', id),
    };
    return Object.freeze(handle);
  };
  const directory = {
    list: () => call('directory.list'),
    connect: async (name) => connection(await call('directory.connect', name)),
  };
  directory.use = async (name, work) => {
    const c = await directory.connect(name);
    try { return await work(c); } finally { try { await c.close(); } catch (e) { /* the run's end closes it anyway */ } }
  };
  define('directory', Object.freeze(directory));
  define('util', Object.freeze({
    randomPassword: (n) => call('util.randomPassword', n),
    uuid: () => call('util.uuid'),
    sha256: (s) => call('util.sha256', s),
    hmacSha256: (k, s) => call('util.hmacSha256', k, s),
    base64Encode: (s) => call('util.base64Encode', s),
    base64Decode: (s) => call('util.base64Decode', s),
  }));
  define('report', Object.freeze({
    users: (o) => call('report.users', o),
    groups: () => call('report.groups'),
    signIns: (o) => call('report.signIns', o),
    audit: (o) => call('report.audit', o),
  }));
  // The administrator's functions, as fn.NAME({ ... }). Each is compiled into this context, so it has this run's scopes and budget.
  const fn = Object.create(null);
  for (const [name, f] of Object.entries(D.functions)) fn[name] = compile(name, f);
  define('fn', Object.freeze(fn));
  define('sleep', (ms) => call('sleep', ms));
  define('log', log);
  define('output', output);
  define('console', Object.freeze({ log, info: logLevels.normal, debug: logLevels.debug, warn: logLevels.warning, error: logLevels.error }));
  define('input', D.input);
  define('trigger', Object.freeze(D.trigger));
  define('integration', Object.freeze(D.integration));
})`, context);

// Compiles one function from the Functions tab. It is an async function of one value, `args`: the object its caller passes, whose
// keys are the function's inputs. Each input's variable is declared from it.
const compile = (name, { script, inputs }) => new vm.Script(wrap(script, { params: 'args', prelude: bindings(inputs, 'args ?? {}') }),
  { filename: `function:${name}`, lineOffset: -2 }).runInContext(context);

const serialize = vm.runInContext(`(function (v) {
  try { const s = JSON.stringify(v); return s === undefined ? 'null' : s; } catch (e) { return JSON.stringify(String(v)); }
})`, context);

// The reported error: its message and, when the stack names the script, the line it happened on.
function describe(e) {
  let message = 'The script failed.'; let line = null;
  try {
    message = String((e && e.message) || e);
    const m = /script:(\d+):\d+/.exec(String((e && e.stack) || ''));
    if (m) line = Number(m[1]);
  } catch { /* an error whose properties throw is reported without them */ }
  return { message, line };
}

(async () => {
  try {
    bootstrap(host, emit, emitOutput, compile, JSON.stringify({ colors: COLORS, vars, idp, input, trigger, integration, functions }));
    // lineOffset puts the first line of the administrator's script on line 1.
    const compiled = new vm.Script(`${wrap(script, { prelude: bindings(inputs, 'input ?? {}') })}()`, { filename: 'script', lineOffset: -2 });
    const result = await compiled.runInContext(context, { timeout: timeoutMs });
    parentPort.postMessage({ type: 'done', ok: true, result: serialize(result) });
  } catch (e) {
    parentPort.postMessage({ type: 'done', ok: false, error: describe(e) });
  }
})();
