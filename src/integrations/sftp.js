const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { isPrivateAddress } = require('../safe-fetch');

// SFTP for integration scripts: list, read, write and delete files on another system. The connection is described by the
// script (host, user and a password or private key, usually from secret variables). Safeguards:
//   - only public addresses, as for http (ALLOW_PRIVATE_FETCH=true permits internal ones); the name is resolved once and that
//     address is the one connected to
//   - the server's host key must match a fingerprint the script gives (hostFingerprint, "SHA256:..."), or the script must say it
//     does not care (insecureSkipHostCheck: true), so a man in the middle cannot collect the credentials by default
//   - a time limit and a size limit on every transfer
// It uses the ssh2 package, loaded only when a script first needs it.

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20000;

class SftpError extends Error {}

let ssh2;
function lib() {
  if (!ssh2) {
    try { ssh2 = require('ssh2'); } catch { throw new SftpError('SFTP is not available: the ssh2 package is not installed on this server.'); }
  }
  return ssh2;
}

const plain = (v) => (typeof v === 'string' ? v : '');

// "SHA256:abc..." or the bare base64 digest, without padding.
const normalizeFingerprint = (f) => plain(f).trim().replace(/^SHA256:/i, '').replace(/=+$/, '');

async function resolve(host) {
  if (net.isIP(host)) {
    if (process.env.ALLOW_PRIVATE_FETCH !== 'true' && isPrivateAddress(host)) throw new SftpError('That address is not public.');
    return host;
  }
  const found = await dns.lookup(host, { all: true });
  if (!found.length) throw new SftpError(`${host} could not be found.`);
  if (process.env.ALLOW_PRIVATE_FETCH !== 'true' && found.some((a) => isPrivateAddress(a.address))) throw new SftpError(`${host} resolves to a non-public address.`);
  return found[0].address;
}

/** Validates a connection description from a script. Returns the cleaned object. */
function connectionOf(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new SftpError('Describe the connection with an object: { host, username, password or privateKey, hostFingerprint }.');
  const host = plain(c.host).trim();
  const username = plain(c.username).trim();
  if (!host || !username) throw new SftpError('The connection needs a host and a username.');
  if (!c.password && !c.privateKey) throw new SftpError('The connection needs a password or a privateKey.');
  const port = c.port === undefined ? 22 : Number(c.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SftpError('The port must be a number from 1 to 65535.');
  const fingerprint = normalizeFingerprint(c.hostFingerprint);
  if (!fingerprint && c.insecureSkipHostCheck !== true) {
    throw new SftpError('Give the server\'s hostFingerprint ("SHA256:..." as ssh-keygen -lf prints it) so its identity can be checked, or set insecureSkipHostCheck: true.');
  }
  return { host, port, username, password: c.password ? String(c.password) : undefined, privateKey: c.privateKey ? String(c.privateKey) : undefined, passphrase: c.passphrase ? String(c.passphrase) : undefined, fingerprint };
}

const remote = (p) => {
  const s = plain(p);
  if (!s || s.length > 1024 || s.includes('\0')) throw new SftpError('Give the remote path as a string.');
  return s;
};

/** Connects, runs `fn(sftp)`, and always closes. */
async function withSftp(connection, fn) {
  const c = connectionOf(connection);
  const address = await resolve(c.host);
  const { Client } = lib();
  const client = new Client();
  const run = new Promise((resolveRun, rejectRun) => {
    client.on('error', (e) => rejectRun(new SftpError(`SFTP connection failed: ${e.level === 'client-authentication' ? 'the server refused the credentials' : e.message}`)));
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) return rejectRun(new SftpError(`SFTP could not start: ${err.message}`));
        Promise.resolve().then(() => fn(sftp)).then(resolveRun, (e) => rejectRun(e instanceof SftpError ? e : new SftpError(`SFTP failed: ${e.message}`)));
        return undefined;
      });
    });
    client.connect({
      host: address, port: c.port, username: c.username, password: c.password, privateKey: c.privateKey, passphrase: c.passphrase,
      readyTimeout: TIMEOUT_MS, hostHash: 'sha256',
      hostVerifier: (hash) => {
        if (!c.fingerprint) return true;
        const got = Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '');
        return got.length === c.fingerprint.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(c.fingerprint));
      },
    });
  });
  const timer = new Promise((_, rej) => { setTimeout(() => rej(new SftpError('The SFTP transfer took too long.')), TIMEOUT_MS * 3).unref(); });
  try { return await Promise.race([run, timer]); } finally { client.end(); }
}

const call = (sftp, method, ...args) => new Promise((res, rej) => sftp[method](...args, (err, out) => (err ? rej(err) : res(out))));

async function list(connection, path) {
  return withSftp(connection, async (sftp) => {
    const entries = await call(sftp, 'readdir', remote(path));
    return entries.map((e) => ({ name: e.filename, size: e.attrs.size, directory: typeof e.attrs.isDirectory === 'function' ? e.attrs.isDirectory() : false, modified: e.attrs.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null }));
  });
}

/** The remote file's bytes. */
async function get(connection, path) {
  return withSftp(connection, async (sftp) => {
    const p = remote(path);
    const stat = await call(sftp, 'stat', p);
    if (stat.size > MAX_BYTES) throw new SftpError(`That file is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    return Buffer.from(await call(sftp, 'readFile', p));
  });
}

async function put(connection, path, data) {
  if (data.length > MAX_BYTES) throw new SftpError(`A file can be at most ${MAX_BYTES / 1024 / 1024} MB.`);
  return withSftp(connection, async (sftp) => { await call(sftp, 'writeFile', remote(path), data); return true; });
}

async function remove(connection, path) {
  return withSftp(connection, async (sftp) => { await call(sftp, 'unlink', remote(path)); return true; });
}

module.exports = { list, get, put, remove, connectionOf, normalizeFingerprint, SftpError, MAX_BYTES };
