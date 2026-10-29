const crypto = require('crypto');
const net = require('net');
const ssh2 = require('ssh2');

const { Server } = ssh2;
const { STATUS_CODE, OPEN_MODE } = ssh2.utils.sftp;
const sshUtils = ssh2.utils;
const appSettings = require('../app-settings');
const auditLog = require('../audit');
const accounts = require('../service-accounts');
const throttle = require('../throttle');
const store = require('./store');

// The SFTP server: other software signs in as a service account (with its password or one of its SSH keys) and lists, reads,
// writes, renames and removes files in the directories the account is granted. Its view is the files module, so what it
// writes is what the console shows, and what an integration writes is what it downloads. A service account sees the files
// module's paths as they are: a file in /exports/hr is /exports/hr on the server.
//
// Each request checks the account again, so a disabled account is refused at once and a changed grant applies to the next
// request. A file written over SFTP is kept when the client closes it, not piece by piece. Settings are in the console
// (Integrations → Files); the host key is created on first start and kept with them.

const SETTINGS_KEY = 'sftp_server';
const HOST_KEY = 'sftp_host_key';
const DEFAULTS = { enabled: false, port: 2222, bindAddress: '0.0.0.0' };
const MAX_AUTH_ATTEMPTS = 6;

let server = null;
const clients = new Set();
// Each connection that has signed in, and as which account, so a lockdown can close that account's connections.
const accountOf = new Map();
let state = { running: false, error: '' };

class Denied extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const settings = () => ({ ...DEFAULTS, ...(appSettings.read(SETTINGS_KEY) || {}) });

/** Validates the settings form. Returns { data, errors }. */
function parse(body = {}) {
  const errors = [];
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('The SFTP port must be a number from 1 to 65535.');
  const bindAddress = typeof body.bindAddress === 'string' && body.bindAddress.trim() ? body.bindAddress.trim() : DEFAULTS.bindAddress;
  if (!net.isIP(bindAddress)) errors.push('The address to listen on must be an IP address, such as 0.0.0.0 for every address.');
  return { errors, data: { enabled: Boolean(body.enabled), port, bindAddress } };
}

/** The server's host key (OpenSSH private text), made on first use. */
function hostKey() {
  const saved = appSettings.read(HOST_KEY);
  if (saved && saved.privateKey) return saved.privateKey;
  const pair = sshUtils.generateKeyPairSync('ed25519', { comment: 'Pons Identity SFTP' });
  appSettings.write(HOST_KEY, { privateKey: pair.private, created_at: new Date().toISOString() });
  return pair.private;
}

/** The fingerprint clients are shown when they first connect, as "SHA256:…" (the form ssh-keygen prints). */
function fingerprint() {
  const pub = sshUtils.parseKey(hostKey()).getPublicSSH();
  return `SHA256:${crypto.createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')}`;
}

const secs = (iso) => Math.floor((Date.parse(iso) || 0) / 1000);
const attrsOf = (e) => ({
  mode: e.kind === 'dir' ? 0o40755 : 0o100644, uid: 0, gid: 0, size: e.size || 0, atime: secs(e.updated_at), mtime: secs(e.updated_at),
});
const longname = (e) => `${e.kind === 'dir' ? 'd' : '-'}rw-r--r-- 1 pons-identity pons-identity ${String(e.size || 0).padStart(10)} ${new Date(Date.parse(e.updated_at) || 0).toUTCString().slice(5, 16)} ${e.name}`;

/** Serves the SFTP protocol for one session. `account` is the service account's name, as it signed in. */
function serve(sftp, account, client) {
  const handles = new Map();
  let nextHandle = 1;
  const newHandle = (h) => {
    const id = nextHandle++;
    handles.set(id, h);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id);
    return buf;
  };
  const handleOf = (buf) => {
    const h = buf && buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : null;
    if (!h) throw new Denied(STATUS_CODE.FAILURE, 'That handle is not open.');
    return h;
  };
  const audit = (op, path, detail = {}) => {
    auditLog.user('service_account.file', { actor: { type: 'service_account', name: account }, target: { type: 'file', name: path }, detail: { op, ...detail }, outcome: 'success' });
  };

  // The grants as they are now. A disabled account gets nothing, and the connection is closed.
  const grants = () => {
    const row = accounts.enabledByName(account);
    if (!row) { client.end(); throw new Denied(STATUS_CODE.PERMISSION_DENIED, 'This account is disabled.'); }
    return accounts.grantsOf(row);
  };
  const path = (p) => store.normalize(p === '' || p === '.' || p === undefined ? '/' : p);
  const need = (g, full, op) => {
    const ok = op === 'list' ? store.canList(g, full) : op === 'see' ? store.canSee(g, full) : store.allows(g, full, op);
    if (!ok) throw new Denied(STATUS_CODE.PERMISSION_DENIED, 'This account may not use that path.');
  };
  // A folder a grant needs (or one on the way to it) shows even before anything is in it, so a client can walk down to its grant.
  const onTheWay = (g, full) => g.some((gr) => gr.path === full || gr.path.startsWith(`${full === '/' ? '' : full}/`));
  const virtualFolder = (full) => ({ path: full, name: store.nameOf(full), kind: 'dir', size: 0, updated_at: '' });
  const entry = (full, g) => {
    const e = store.stat(full);
    if (e) return e;
    if (onTheWay(g, full)) return virtualFolder(full);
    throw new Denied(STATUS_CODE.NO_SUCH_FILE, 'No such file.');
  };
  const realEntry = (full) => {
    const e = store.stat(full);
    if (!e) throw new Denied(STATUS_CODE.NO_SUCH_FILE, 'No such file.');
    return e;
  };
  // The grant folders directly inside `dir` that are not in the store yet.
  const missingChildren = (g, dir) => {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const found = new Map();
    for (const gr of g) {
      if (gr.path === dir || !gr.path.startsWith(prefix)) continue;
      const child = `${prefix}${gr.path.slice(prefix.length).split('/')[0]}`;
      if (!found.has(child) && !store.stat(child)) found.set(child, virtualFolder(child));
    }
    return [...found.values()];
  };
  const reply = (reqid, fn) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof Denied) return sftp.status(reqid, e.code, e.message);
      if (e instanceof store.FileError) return sftp.status(reqid, STATUS_CODE.FAILURE, e.message);
      console.error('sftp server:', e);
      return sftp.status(reqid, STATUS_CODE.FAILURE, 'The server could not do that.');
    }
    return undefined;
  };

  sftp.on('REALPATH', (reqid, p) => reply(reqid, () => {
    const full = path(p);
    sftp.name(reqid, [{ filename: full, longname: full, attrs: attrsOf(store.stat(full) || { kind: 'dir', size: 0, updated_at: '' }) }]);
  }));

  sftp.on('STAT', (reqid, p) => reply(reqid, () => { const full = path(p); const g = grants(); need(g, full, 'see'); sftp.attrs(reqid, attrsOf(entry(full, g))); }));
  sftp.on('LSTAT', (reqid, p) => reply(reqid, () => { const full = path(p); const g = grants(); need(g, full, 'see'); sftp.attrs(reqid, attrsOf(entry(full, g))); }));
  sftp.on('FSTAT', (reqid, buf) => reply(reqid, () => {
    const h = handleOf(buf);
    sftp.attrs(reqid, h.dir ? attrsOf({ kind: 'dir', size: 0, updated_at: '' }) : attrsOf({ kind: 'file', size: h.buffer.length, updated_at: '' }));
  }));
  // Attributes are not changed over SFTP: the files module keeps its own times. Clients that set them still succeed.
  sftp.on('SETSTAT', (reqid) => reply(reqid, () => sftp.status(reqid, STATUS_CODE.OK)));
  sftp.on('FSETSTAT', (reqid) => reply(reqid, () => sftp.status(reqid, STATUS_CODE.OK)));

  sftp.on('OPENDIR', (reqid, p) => reply(reqid, () => {
    const full = path(p);
    const g = grants();
    need(g, full, 'list');
    if (full !== '/' && entry(full, g).kind !== 'dir') throw new Denied(STATUS_CODE.FAILURE, 'That is not a folder.');
    sftp.handle(reqid, newHandle({ dir: true, path: full, sent: false }));
  }));
  sftp.on('READDIR', (reqid, buf) => reply(reqid, () => {
    const h = handleOf(buf);
    if (!h.dir) throw new Denied(STATUS_CODE.FAILURE, 'That is not a folder.');
    if (h.sent) return sftp.status(reqid, STATUS_CODE.EOF);
    h.sent = true;
    const g = grants();
    const names = [...store.visibleIn(g, store.list(h.path)), ...missingChildren(g, h.path)].map((e) => ({ filename: e.name, longname: longname(e), attrs: attrsOf(e) }));
    return names.length ? sftp.name(reqid, names) : sftp.status(reqid, STATUS_CODE.EOF);
  }));

  sftp.on('OPEN', (reqid, p, flags) => reply(reqid, () => {
    const full = path(p);
    const g = grants();
    const writing = Boolean(flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC));
    const existing = store.stat(full);
    if (writing) {
      need(g, full, 'write');
      if (existing?.kind === 'dir') throw new Denied(STATUS_CODE.FAILURE, 'That is a folder.');
      if (existing && flags & OPEN_MODE.CREAT && flags & OPEN_MODE.EXCL) throw new Denied(STATUS_CODE.FAILURE, 'That file already exists.');
      if (!existing && !(flags & OPEN_MODE.CREAT)) throw new Denied(STATUS_CODE.NO_SUCH_FILE, 'No such file.');
      const keep = existing && !(flags & OPEN_MODE.TRUNC) ? store.read(full) : null;
      return sftp.handle(reqid, newHandle({ write: true, path: full, buffer: keep || Buffer.alloc(0), dirty: !existing }));
    }
    need(g, full, 'read');
    if (realEntry(full).kind === 'dir') throw new Denied(STATUS_CODE.FAILURE, 'That is a folder.');
    return sftp.handle(reqid, newHandle({ write: false, path: full, buffer: store.read(full) || Buffer.alloc(0) }));
  }));

  sftp.on('READ', (reqid, buf, offset, length) => reply(reqid, () => {
    const h = handleOf(buf);
    if (h.write || h.dir) throw new Denied(STATUS_CODE.FAILURE, 'That handle cannot be read.');
    if (offset >= h.buffer.length) return sftp.status(reqid, STATUS_CODE.EOF);
    return sftp.data(reqid, h.buffer.subarray(offset, offset + length));
  }));

  sftp.on('WRITE', (reqid, buf, offset, data) => reply(reqid, () => {
    const h = handleOf(buf);
    if (!h.write) throw new Denied(STATUS_CODE.FAILURE, 'That handle is read-only.');
    const end = offset + data.length;
    if (end > store.LIMITS.fileBytes) throw new Denied(STATUS_CODE.FAILURE, `A file can be at most ${store.LIMITS.fileBytes / 1024 / 1024} MB.`);
    if (end > h.buffer.length) h.buffer = Buffer.concat([h.buffer, Buffer.alloc(end - h.buffer.length)]);
    data.copy(h.buffer, offset);
    h.dirty = true;
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  // Writing happens when the client closes the file: what it sent is saved in one piece.
  sftp.on('CLOSE', (reqid, buf) => reply(reqid, () => {
    const h = handleOf(buf);
    handles.delete(buf.readUInt32BE(0));
    if (h.write && h.dirty) {
      need(grants(), h.path, 'write');
      store.write(h.path, h.buffer, { by: `service:${account}` });
      audit('write', h.path, { size: h.buffer.length });
    }
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('REMOVE', (reqid, p) => reply(reqid, () => {
    const full = path(p);
    need(grants(), full, 'write');
    if (realEntry(full).kind === 'dir') throw new Denied(STATUS_CODE.FAILURE, 'That is a folder; remove it as a folder.');
    store.remove(full);
    audit('delete', full);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('RMDIR', (reqid, p) => reply(reqid, () => {
    const full = path(p);
    need(grants(), full, 'write');
    if (realEntry(full).kind !== 'dir') throw new Denied(STATUS_CODE.FAILURE, 'That is not a folder.');
    store.remove(full);
    audit('rmdir', full);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('MKDIR', (reqid, p) => reply(reqid, () => {
    const full = path(p);
    need(grants(), full, 'write');
    if (store.stat(full)) throw new Denied(STATUS_CODE.FAILURE, 'That already exists.');
    store.mkdir(full, { by: `service:${account}` });
    audit('mkdir', full);
    sftp.status(reqid, STATUS_CODE.OK);
  }));

  sftp.on('RENAME', (reqid, from, to) => reply(reqid, () => {
    const a = path(from); const b = path(to);
    const g = grants();
    need(g, a, 'write');
    need(g, b, 'write');
    store.rename(a, b, { by: `service:${account}` });
    audit('rename', a, { to: b });
    sftp.status(reqid, STATUS_CODE.OK);
  }));
}

/** One connection: signs the account in (password or key), then serves its SFTP session. */
function onConnection(client, info) {
  let account = null;
  let attempts = 0;
  clients.add(client);
  client.on('error', () => {});
  client.on('close', () => { clients.delete(client); accountOf.delete(client); });

  const failed = (ctx, method) => {
    auditLog.user('service_account.sftp_login', { outcome: 'failure', actor: { type: 'service_account', name: ctx.username || '' }, detail: { method } });
    return ctx.reject();
  };

  client.on('authentication', async (ctx) => {
    attempts++;
    if (attempts > MAX_AUTH_ATTEMPTS) return client.end();
    // The per-connection cap above is not enough alone: a client can simply reconnect. Failures are counted per account and per
    // address in the database (throttle.js), so reconnecting does not reset them.
    const who = { account: ctx.username || '', ip: info && info.ip };
    if (ctx.method === 'password') {
      if (throttle.check('sftp', who).blocked) return failed(ctx, 'throttled');
      let row;
      try { row = await accounts.authenticateAsync(ctx.username, ctx.password); } catch { return failed(ctx, 'busy'); }
      if (!row) { throttle.fail('sftp', who); return failed(ctx, 'password'); }
      throttle.reset('sftp', who);
      account = row.username;
    } else if (ctx.method === 'publickey') {
      const row = accounts.enabledByName(ctx.username);
      const match = row && accounts.keysOf(row).find((k) => k.type === ctx.key.algo && k.getPublicSSH().equals(ctx.key.data));
      if (!match || (ctx.signature && match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)) return failed(ctx, 'publickey');
      // A key the account owns but has not yet proved is accepted, so the client goes on to sign with it.
      if (!ctx.signature) return ctx.accept();
      account = row.username;
    } else {
      return failed(ctx, ctx.method);
    }
    accountOf.set(client, account);
    auditLog.user('service_account.sftp_login', { outcome: 'success', actor: { type: 'service_account', name: account }, detail: { method: ctx.method } });
    return ctx.accept();
  });

  client.on('ready', () => {
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      session.on('sftp', (acceptSftp) => serve(acceptSftp(), account, client));
    });
  });
}

/**
 * Starts listening with the saved settings. Resolves once it is listening or has failed; a failure is kept for the console
 * instead of stopping the server.
 */
function start() {
  return new Promise((resolve) => {
    const cfg = settings();
    if (!cfg.enabled) { state = { running: false, error: '' }; resolve(); return; }
    const failed = (message) => {
      state = { running: false, error: message };
      console.error(`SFTP server: ${message}`);
      resolve();
    };
    try {
      server = new Server({ hostKeys: [hostKey()] }, onConnection);
      server.on('error', (e) => failed(e.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use.` : e.message));
      server.listen(cfg.port, cfg.bindAddress, () => {
        state = { running: true, error: '' };
        console.log(`SFTP server listening on ${cfg.bindAddress}:${cfg.port}`);
        resolve();
      });
    } catch (e) {
      failed(e.message);
    }
  });
}

/** Closes every open connection signed in as this account. Returns how many were closed. */
function disconnect(username) {
  const name = String(username || '').toLowerCase();
  let closed = 0;
  for (const [client, account] of accountOf) {
    if (account.toLowerCase() !== name) continue;
    client.end();
    accountOf.delete(client);
    closed++;
  }
  return closed;
}

/** Stops listening and ends any sessions. */
function stop() {
  if (server) server.close();
  for (const c of clients) c.end();
  clients.clear();
  accountOf.clear();
  server = null;
  state = { running: false, error: '' };
}

/** Applies the saved settings: stops, and starts again when enabled. */
async function apply() {
  stop();
  await start();
}

/** The settings and what is running, for the console. */
function status() {
  const cfg = settings();
  return { ...cfg, running: state.running, error: state.error, fingerprint: fingerprint() };
}

/** Saves the settings, applies them, and resolves with what is running now. */
async function save(data) {
  appSettings.write(SETTINGS_KEY, data);
  await apply();
  return status();
}

module.exports = { parse, save, status, start, stop, apply, fingerprint, settings, disconnect, DEFAULTS };
