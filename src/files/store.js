const db = require('../db');

// The files module: one store of files and folders, shared by integrations, the SFTP server and administrators. A path is
// absolute and slash-separated ("/exports/hr/people.csv"); each part is a plain name. A folder is a row too, so an empty one can
// exist. The store does not decide who may reach a path: that is what grants are for (see allows, canRead and canWrite below),
// and every caller checks them before it calls in.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;
const MAX_DEPTH = 16;
const MAX_PATH = 512;
const LIMITS = { fileBytes: 10 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, count: 20000, grants: 50, viewBytes: 256 * 1024 };
const ACCESS = ['read', 'write', 'readwrite'];
const PATH_HELP = 'A path is "/" and names of up to 100 letters, digits, spaces, dots, dashes and underscores, each starting with a letter or digit, no more than 16 levels deep.';

class FileError extends Error {}

/**
 * A path as a clean absolute string. A relative path is taken from `base`. Throws FileError for anything unsafe, so ".." and
 * other names that start with a dot never get through.
 */
function normalize(p, base = '/') {
  if (typeof p !== 'string' || p.length > MAX_PATH || p.includes('\0')) throw new FileError(PATH_HELP);
  const parts = (p.startsWith('/') ? p : `${base}/${p}`).split('/').filter((s) => s !== '');
  if (parts.length > MAX_DEPTH || parts.some((s) => !NAME_RE.test(s))) throw new FileError(PATH_HELP);
  return `/${parts.join('/')}`;
}

const parentOf = (full) => (full === '/' ? '' : full.slice(0, full.lastIndexOf('/')) || '/');
const nameOf = (full) => (full === '/' ? '/' : full.slice(full.lastIndexOf('/') + 1));
// Every folder above `full`, top first, and `full` itself.
const lineageOf = (full) => full.split('/').filter(Boolean).map((_, i, all) => `/${all.slice(0, i + 1).join('/')}`);

const view = (r) => ({ path: r.path, name: nameOf(r.path), kind: r.kind, size: r.size, updated_at: r.updated_at, updated_by: r.updated_by });
const ROOT = { path: '/', name: '/', kind: 'dir', size: 0, updated_at: '', updated_by: '' };

/** The folder an integration keeps its own files in. Relative paths in its script start here. */
const integrationHome = (integrationId) => `/integrations/integration-${Number(integrationId)}`;

/** Details of one file or folder, or null. */
function stat(p) {
  const full = normalize(p);
  if (full === '/') return ROOT;
  const r = db.get('SELECT path, kind, size, updated_at, updated_by FROM files WHERE path = ?', full);
  return r ? view(r) : null;
}

/** What is directly inside a folder: folders first, then names. A folder that does not exist lists as empty. */
function list(dir) {
  const full = normalize(dir);
  return db.all("SELECT path, kind, size, updated_at, updated_by FROM files WHERE parent = ? ORDER BY CASE kind WHEN 'dir' THEN 0 ELSE 1 END, path COLLATE NOCASE", full).map(view);
}

/** The file's bytes, or null when there is no such file. Folders have no bytes. */
function read(p) {
  const r = db.get("SELECT content FROM files WHERE path = ? AND kind = 'file'", normalize(p));
  return r ? Buffer.from(r.content) : null;
}

// Creates the folders from the top down to `full` (inclusive) that do not exist yet. A file with the same name is an error.
function ensureFolders(full, by, now) {
  for (const dir of lineageOf(full)) {
    const r = db.get('SELECT kind FROM files WHERE path = ?', dir);
    if (r?.kind === 'file') throw new FileError(`${dir} is a file, not a folder.`);
    if (!r) db.run("INSERT INTO files (path, parent, kind, size, content, created_at, updated_at, updated_by) VALUES (?,?,'dir',0,?,?,?,?)", dir, parentOf(dir), Buffer.alloc(0), now, now, by);
  }
}

/** Creates a folder and any folders above it. Returns its details. */
function mkdir(p, { by = '' } = {}) {
  const full = normalize(p);
  if (full === '/') return ROOT;
  return db.tx(() => {
    ensureFolders(full, by, new Date().toISOString());
    return stat(full);
  });
}

/**
 * Writes a file, creating its folders. `data` is a Buffer; with `append` it is added to the end of the file that is there.
 * Returns the file's details.
 */
function write(p, data, { append = false, by = '' } = {}) {
  const full = normalize(p);
  if (full === '/') throw new FileError('Name a file, not the top level.');
  return db.tx(() => {
    const existing = db.get('SELECT kind FROM files WHERE path = ?', full);
    if (existing?.kind === 'dir') throw new FileError(`${full} is a folder.`);
    const old = append && existing ? read(full) : null;
    const bytes = old ? Buffer.concat([old, data]) : data;
    if (bytes.length > LIMITS.fileBytes) throw new FileError(`A file can be at most ${LIMITS.fileBytes / 1024 / 1024} MB.`);
    const others = db.get("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE kind = 'file' AND path != ?", full);
    if (others.n + 1 > LIMITS.count) throw new FileError(`The files module can keep at most ${LIMITS.count} files.`);
    if (others.bytes + bytes.length > LIMITS.totalBytes) throw new FileError(`The files module can keep at most ${LIMITS.totalBytes / 1024 / 1024} MB in all.`);
    const now = new Date().toISOString();
    ensureFolders(parentOf(full), by, now);
    db.run(`INSERT INTO files (path, parent, kind, size, content, created_at, updated_at, updated_by) VALUES (?,?,'file',?,?,?,?,?)
            ON CONFLICT(path) DO UPDATE SET size = excluded.size, content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    full, parentOf(full), bytes.length, bytes, now, now, by);
    return stat(full);
  });
}

/** Removes a file, or a folder that is empty (or any folder, with `recursive`). Returns false when there is nothing to remove. */
function remove(p, { recursive = false } = {}) {
  const full = normalize(p);
  if (full === '/') throw new FileError('The top level cannot be removed.');
  return db.tx(() => {
    const r = db.get('SELECT kind FROM files WHERE path = ?', full);
    if (!r) return false;
    if (r.kind === 'dir') {
      if (!recursive && db.get('SELECT COUNT(*) AS n FROM files WHERE parent = ?', full).n > 0) throw new FileError(`${full} is not empty.`);
      db.run('DELETE FROM files WHERE path = ? OR substr(path, 1, ?) = ?', full, full.length + 1, `${full}/`);
    } else {
      db.run('DELETE FROM files WHERE path = ?', full);
    }
    return true;
  });
}

/** Moves a file or folder (and what is in it) to a new path that is free. Returns the new details. */
function rename(from, to, { by = '' } = {}) {
  const a = normalize(from); const b = normalize(to);
  if (a === '/' || b === '/') throw new FileError('The top level cannot be renamed.');
  return db.tx(() => {
    if (!db.get('SELECT 1 FROM files WHERE path = ?', a)) throw new FileError(`No such file or folder: ${a}.`);
    if (db.get('SELECT 1 FROM files WHERE path = ?', b)) throw new FileError(`${b} already exists.`);
    if (b.startsWith(`${a}/`)) throw new FileError('A folder cannot be moved into itself.');
    const now = new Date().toISOString();
    ensureFolders(parentOf(b), by, now);
    const moved = db.all('SELECT path FROM files WHERE path = ? OR substr(path, 1, ?) = ?', a, a.length + 1, `${a}/`);
    for (const { path } of moved) {
      const next = b + path.slice(a.length);
      db.run('UPDATE files SET path = ?, parent = ?, updated_at = ?, updated_by = ? WHERE path = ?', next, parentOf(next), now, by, path);
    }
    return stat(b);
  });
}

/* --------------------------------- Grants ---------------------------------- */

// A grant is { path, access }. 'read' lists and reads what is under its path; 'write' creates, changes and removes but cannot
// read; 'readwrite' does both. Folders above a grant can be seen (their names are listed) but not read or changed.

const inside = (grant, full) => full === grant.path || full.startsWith(grant.path === '/' ? '/' : `${grant.path}/`);
const above = (grant, full) => grant.path.startsWith(full === '/' ? '/' : `${full}/`);

/** Whether a grant set lets a caller do `op` ('read' or 'write') on `full`. */
const allows = (grants, full, op) => grants.some((g) => inside(g, full) && (g.access === 'readwrite' || g.access === op));
const canRead = (grants, p) => allows(grants, normalize(p), 'read');
const canWrite = (grants, p) => allows(grants, normalize(p), 'write');
/** Whether a path may be shown at all: inside a grant, or a folder on the way to one. */
const canSee = (grants, p) => { const full = normalize(p); return grants.some((g) => inside(g, full) || above(g, full)); };
/** Whether a folder may be listed: it is readable, or it leads to a grant, in which case only those parts are listed. */
const canList = (grants, p) => { const full = normalize(p); return canRead(grants, full) || grants.some((g) => above(g, full)); };
/** The listing as one grant set shows it: only what can be seen. */
const visibleIn = (grants, entries) => entries.filter((e) => canSee(grants, e.path));

/** Grants as the forms and APIs take them. Returns { grants, errors }. */
function parseGrants(input) {
  const errors = [];
  if (input === undefined || input === null) return { grants: [], errors };
  if (!Array.isArray(input)) return { grants: [], errors: ['Directories must be a list of { path, access }.'] };
  if (input.length > LIMITS.grants) return { grants: [], errors: [`A grant set can have at most ${LIMITS.grants} directories.`] };
  const grants = [];
  for (const g of input) {
    if (!g || typeof g !== 'object') { errors.push('Each directory needs a path and an access.'); continue; }
    if (!ACCESS.includes(g.access)) { errors.push(`Access must be ${ACCESS.join(', ')}.`); continue; }
    try {
      grants.push({ path: normalize(g.path), access: g.access });
    } catch (e) {
      errors.push(`${g.path || 'A directory'}: ${e.message}`);
    }
  }
  const dupes = grants.filter((g, i) => grants.findIndex((x) => x.path === g.path) !== i);
  if (dupes.length) errors.push(`${dupes[0].path} is listed more than once.`);
  return { grants, errors };
}

module.exports = {
  normalize, stat, list, read, write, mkdir, remove, rename, integrationHome,
  allows, canRead, canWrite, canSee, canList, visibleIn, parseGrants, parentOf, nameOf, NAME_RE, ACCESS, LIMITS, FileError,
};
