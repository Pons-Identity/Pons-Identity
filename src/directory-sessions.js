const ldap = require('./ldap');

// Open connections to external directories, for integration scripts. A script connects, works, and closes; this registry is what
// makes sure a connection never outlives the run that opened it:
//   - closeOwner() is called when a run ends for any reason (finished, failed, timed out, worker crashed), so a script that
//     forgets to close, or is stopped half way, leaves nothing behind;
//   - a connection that sits unused for IDLE_MS is closed, and none lives longer than MAX_MS;
//   - closeAll() runs when the server is asked to stop.
// If the whole process dies, the operating system closes its sockets and the directory server drops the sessions.
// An "owner" is the run's context object; one run cannot use another's connection.

const IDLE_MS = 30 * 1000;
const MAX_MS = 5 * 60 * 1000;
const UNBIND_MS = 3000;
const MAX_PER_OWNER = 3;

class SessionError extends Error {}

const sessions = new Map();
let nextId = 1;

const timer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };

/** Unbinds, but never waits longer than UNBIND_MS on a server that has stopped answering. */
async function release(client) {
  let t;
  try {
    await Promise.race([ldap.unbind(client), new Promise((resolve) => { t = timer(resolve, UNBIND_MS); })]);
  } finally { clearTimeout(t); }
}

async function close(session) {
  if (!sessions.delete(session.id)) return false;
  clearTimeout(session.idleTimer);
  clearTimeout(session.maxTimer);
  session.closed = true;
  await release(session.client);
  return true;
}

function touch(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = timer(() => { session.reason = 'idle'; close(session).catch(() => {}); }, IDLE_MS);
}

/** Connects and binds the service account. `access` is what the directory allows scripts: 'read' or 'write'. */
async function open(owner, dir, access) {
  if (owner.closed) throw new SessionError('This run has ended.');
  const mine = [...sessions.values()].filter((s) => s.owner === owner).length;
  if (mine >= MAX_PER_OWNER) throw new SessionError(`A script may hold at most ${MAX_PER_OWNER} directory connections at once. Close one first.`);
  const client = await ldap.connect(dir.config);
  try {
    await ldap.bindService(client, dir.config);
  } catch (e) {
    await release(client);
    throw e;
  }
  // The run may have been stopped while we were connecting.
  if (owner.closed) { await release(client); throw new SessionError('This run has ended.'); }
  const session = { id: nextId++, owner, dir, client, access, closed: false, reason: '' };
  sessions.set(session.id, session);
  touch(session);
  session.maxTimer = timer(() => { session.reason = 'too long'; close(session).catch(() => {}); }, MAX_MS);
  return session;
}

/** The owner's open session `id`, marked as in use. */
function get(owner, id) {
  const session = sessions.get(Number(id));
  if (!session || session.owner !== owner) throw new SessionError('That directory connection is closed. Connect again.');
  touch(session);
  return session;
}

const closeOwner = async (owner) => {
  owner.closed = true;
  await Promise.all([...sessions.values()].filter((s) => s.owner === owner).map((s) => close(s).catch(() => {})));
};

const closeAll = () => Promise.all([...sessions.values()].map((s) => close(s).catch(() => {})));

module.exports = { open, get, touch, close, closeOwner, closeAll, count: () => sessions.size, SessionError, IDLE_MS, MAX_MS, MAX_PER_OWNER };
