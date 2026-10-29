const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { extract } = require('./archive');

// In-place upgrade of an installed Pons Identity from a downloaded release (a folder or an archive), with a backup taken first and
// automatic rollback if anything after the swap fails. Run from the command line (scripts/upgrade.js) while the server is stopped.
//
//   1. find the release          a folder, an archive, or the newest release in a folder such as ~/Downloads
//   2. check it                  same product, newer version, Node version, files present
//   3. prepare it                unpack, install dependencies and build the console in a staging folder, so nothing is changed yet
//   4. back up                   the code, config and a consistent copy of the database (and the old node_modules when replaced)
//   5. swap                      replace the code; data/, config.json and node_modules (unless it changed) are left alone
//   6. migrate and verify        the new code upgrades the database's schema, then starts once and answers a request
//   7. on any failure after 4    put everything back from the backup
//
// Rolling back later (`rollback`) restores the same backup, including the database as it was before the upgrade.

class UpgradeError extends Error {}

const PRODUCT = 'simple-idp';
const DEFAULT_KEEP = 5;

const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const exists = (p) => fs.existsSync(p);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}
/** -1, 0 or 1; a release candidate sorts before the release it leads to. */
function compareVersions(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Everything the upgrade must never replace or delete, as paths relative to the install. */
function protectedPaths({ root, dbPath, backupDir }) {
  const rel = (p) => path.relative(root, p).split(path.sep)[0];
  const set = new Set(['node_modules', 'data', 'config.json', '.git', '.env', '.upgrade-tmp', 'web/node_modules']);
  if (backupDir && !path.relative(root, backupDir).startsWith('..')) set.add(rel(backupDir));
  if (dbPath && dbPath !== ':memory:' && !path.relative(root, dbPath).startsWith('..')) set.add(rel(dbPath));
  return set;
}

/* ------------------------------- Finding the release ---------------------------- */

const looksLikeRelease = (dir) => { try { return readJson(path.join(dir, 'package.json')).name === PRODUCT && exists(path.join(dir, 'src', 'server.js')); } catch { return false; } };

/** The folder inside `dir` that holds package.json: dir itself, or the one folder a GitHub-style archive wraps everything in. */
function releaseRoot(dir) {
  if (looksLikeRelease(dir)) return dir;
  const kids = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX');
  for (const k of kids) if (looksLikeRelease(path.join(dir, k.name))) return path.join(dir, k.name);
  return null;
}

const ARCHIVE_RE = /(simple-?idp|simple_idp).*\.(zip|tgz|tar\.gz|tar)$/i;

/** Looks in a folder (usually Downloads) for the newest Pons Identity release: an unpacked folder or an archive. */
function newestIn(dir) {
  const found = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory() && /simple-?idp/i.test(e.name) && releaseRoot(full)) found.push({ path: full, mtime: fs.statSync(full).mtimeMs });
      else if (e.isFile() && ARCHIVE_RE.test(e.name)) found.push({ path: full, mtime: fs.statSync(full).mtimeMs });
    } catch { /* unreadable entry */ }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** Resolves what the administrator pointed at into an unpacked release folder. Returns { dir, from, tmp }. */
function locate(source, { stage, log }) {
  let target = source ? path.resolve(source.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), 'Downloads');
  if (!exists(target)) throw new UpgradeError(`${target} does not exist.`);
  let st = fs.statSync(target);
  if (st.isDirectory() && !releaseRoot(target)) {
    const found = newestIn(target);
    if (!found.length) throw new UpgradeError(`No Pons Identity release (a folder or a .zip/.tar.gz named like simple-idp) was found in ${target}.`);
    if (found.length > 1) log(`Found ${found.length} candidates in ${target}; using the newest: ${path.basename(found[0].path)}`);
    target = found[0].path;
    st = fs.statSync(target);
  }
  if (st.isDirectory()) return { dir: releaseRoot(target), from: target };
  const into = path.join(stage, 'unpacked');
  ensureDir(into);
  log(`Unpacking ${path.basename(target)}`);
  extract(target, into);
  const dir = releaseRoot(into);
  if (!dir) throw new UpgradeError('That archive does not contain Pons Identity (no package.json named simple-idp with src/server.js).');
  return { dir, from: target };
}

/* ---------------------------------- Running things ------------------------------ */

function run(cmd, args, { cwd, env, timeout = 15 * 60 * 1000, log } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...env }, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const tail = `${stderr || ''}${stdout || ''}`.trim().split('\n').slice(-12).join('\n');
        return reject(new UpgradeError(`${[cmd, ...args].join(' ')} failed${err.code === 'ENOENT' ? ' (not installed)' : ''}.${tail ? `\n${tail}` : ''}`));
      }
      resolve(String(stdout));
    });
  });
}

const npm = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const sameFile = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };

/* ----------------------------------- Database ----------------------------------- */

/** A consistent copy of a live or idle SQLite database (VACUUM INTO also folds in the write-ahead log). */
function snapshotDb(dbPath, to) {
  ensureDir(path.dirname(to));
  rm(to);
  const db = new DatabaseSync(dbPath);
  try { db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { db.close(); }
}

function checkDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const r = db.prepare('PRAGMA quick_check').get();
    if (Object.values(r)[0] !== 'ok') throw new UpgradeError(`The database failed its integrity check (${Object.values(r)[0]}). Not upgrading.`);
  } finally { db.close(); }
}

function restoreDb(snapshot, dbPath) {
  for (const suffix of ['', '-wal', '-shm']) rm(dbPath + suffix);
  fs.copyFileSync(snapshot, dbPath);
}

/* ---------------------------------- Code swap ----------------------------------- */

const isProtected = (set, rel) => set.has(rel.split(path.sep).join('/'));

/** Removes the code from `root`, leaving what is protected. `web` is cleared inside, keeping web/node_modules. */
function clearCode(root, prot) {
  for (const name of fs.readdirSync(root)) {
    if (isProtected(prot, name)) continue;
    if (name === 'web') {
      for (const inner of fs.readdirSync(path.join(root, 'web'))) if (!isProtected(prot, `web/${inner}`)) rm(path.join(root, 'web', inner));
      continue;
    }
    rm(path.join(root, name));
  }
}

/** Copies the code of `from` into `root`, skipping what is protected. */
function copyCode(from, root, prot) {
  for (const name of fs.readdirSync(from)) {
    if (isProtected(prot, name)) continue;
    if (name === 'web') {
      ensureDir(path.join(root, 'web'));
      for (const inner of fs.readdirSync(path.join(from, 'web'))) if (!isProtected(prot, `web/${inner}`)) fs.cpSync(path.join(from, 'web', inner), path.join(root, 'web', inner), { recursive: true });
      continue;
    }
    fs.cpSync(path.join(from, name), path.join(root, name), { recursive: true });
  }
}

/* --------------------------------- Verification --------------------------------- */

// The new code upgrades the database's schema just by being loaded (db.js), so loading it against the real database IS the migration.
// Then it starts once, on a port of its own, and has to answer a request.
const MIGRATE_SCRIPT = `
const path = require('path');
const root = process.argv[1];
const db = require(path.join(root, 'src', 'db'));
const ok = db.get('PRAGMA integrity_check');
if (Object.values(ok)[0] !== 'ok') { console.error('integrity_check: ' + Object.values(ok)[0]); process.exit(2); }
`;
const VERIFY_SCRIPT = `
const path = require('path');
const root = process.argv[1];
const { createApp } = require(path.join(root, 'src', 'server'));
const server = createApp().listen(0, '127.0.0.1', async () => {
  try {
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/session');
    if (!r.ok) throw new Error('GET /api/session answered ' + r.status);
    try { require(path.join(root, 'src', 'audit')).system('system.upgrade', { detail: { from: process.argv[2], to: process.argv[3], backup: process.argv[4] } }); } catch { /* the record is a courtesy */ }
    process.exit(0);
  } catch (e) { console.error(e.message); process.exit(1); }
});
setTimeout(() => { console.error('timed out'); process.exit(1); }, 30000).unref();
`;

const childEnv = ({ dbPath }) => ({ NODE_ENV: 'production', ...(dbPath && dbPath !== ':memory:' ? { DB_PATH: dbPath } : {}) });

/* ------------------------------------ Backups ----------------------------------- */

function listBackups(backupDir) {
  if (!exists(backupDir)) return [];
  return fs.readdirSync(backupDir).map((id) => {
    try { return { ...readJson(path.join(backupDir, id, 'manifest.json')), dir: path.join(backupDir, id) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

const writeManifest = (dir, m) => fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);

function pidAlive(file) {
  try { const pid = Number(fs.readFileSync(file, 'utf8')); if (!pid) return 0; process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? -1 : 0; }
}

function refuseIfRunning({ dbPath, force }) {
  if (!dbPath || dbPath === ':memory:') return;
  const pid = pidAlive(path.join(path.dirname(dbPath), 'server.pid'));
  if (pid && !force) throw new UpgradeError(`Pons Identity appears to be running (process ${pid > 0 ? pid : 'unknown'}). Stop it first, or use --force if that is out of date.`);
}

/* ----------------------------------- Upgrade ------------------------------------ */

async function upgrade(opts) {
  const root = path.resolve(opts.root);
  const dbPath = opts.dbPath;
  const backupDir = path.resolve(opts.backupDir || path.join(root, 'upgrade-backups'));
  const log = opts.log || (() => {});
  const prot = protectedPaths({ root, dbPath, backupDir });
  const current = readJson(path.join(root, 'package.json'));
  const stage = path.join(root, '.upgrade-tmp', String(Date.now()));
  ensureDir(stage);
  try {
    const found = locate(opts.source, { stage, log });
    const pkg = readJson(path.join(found.dir, 'package.json'));
    const cmp = compareVersions(pkg.version, current.version);
    const summary = { from: current.version, to: pkg.version, source: found.from };

    // 2. check
    if (pkg.name !== current.name) throw new UpgradeError(`That is ${pkg.name}, not ${current.name}.`);
    if (cmp < 0 && !opts.allowDowngrade) throw new UpgradeError(`That release (${pkg.version}) is older than the one installed (${current.version}). Use --allow-downgrade if you mean it.`);
    if (cmp === 0 && !opts.force) throw new UpgradeError(`Version ${pkg.version} is already installed. Use --force to reinstall it.`);
    const need = pkg.engines && pkg.engines.node && /(\d+)(?:\.(\d+))?/.exec(pkg.engines.node);
    if (need && Number(process.versions.node.split('.')[0]) < Number(need[1])) throw new UpgradeError(`That release needs Node ${pkg.engines.node}; this server runs ${process.version}.`);
    refuseIfRunning({ dbPath, force: opts.force });
    const hasDb = dbPath && dbPath !== ':memory:' && exists(dbPath);
    if (hasDb) checkDb(dbPath);

    // What has to be done, and whether the plan needs the network.
    const depsChanged = !sameFile(path.join(found.dir, 'package-lock.json'), path.join(root, 'package-lock.json')) || !exists(path.join(root, 'node_modules'));
    const needsBuild = !exists(path.join(found.dir, 'web', 'dist')) && exists(path.join(found.dir, 'web', 'package.json'));
    summary.plan = [
      depsChanged && !opts.skipInstall ? 'install the new dependencies' : 'keep the installed dependencies',
      needsBuild && !opts.skipBuild ? 'build the web console' : needsBuild ? 'keep the current web console (--skip-build)' : 'use the release\'s web console',
      hasDb ? 'back up the database' : 'no database to back up',
      'back up the code', 'replace the code', 'migrate the database', 'start it once to check',
    ];
    if (opts.dryRun) return { ...summary, dryRun: true };
    if (opts.confirm && !(await opts.confirm(summary))) throw new UpgradeError('Cancelled. Nothing was changed.');

    // 3. prepare in the staging folder
    const prepared = path.join(stage, 'release');
    fs.cpSync(found.dir, prepared, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' && path.basename(src) !== '.git' });
    let newModules = null;
    if (depsChanged && !opts.skipInstall) {
      log('Installing dependencies (needs network)...');
      await run(npm(), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: prepared });
      newModules = path.join(prepared, 'node_modules');
    }
    if (needsBuild && !opts.skipBuild) {
      log('Building the web console...');
      await run(npm(), ['ci', '--no-audit', '--no-fund'], { cwd: path.join(prepared, 'web') });
      await run(npm(), ['run', 'build'], { cwd: path.join(prepared, 'web') });
      rm(path.join(prepared, 'web', 'node_modules'));
    } else if (needsBuild && exists(path.join(root, 'web', 'dist'))) {
      fs.cpSync(path.join(root, 'web', 'dist'), path.join(prepared, 'web', 'dist'), { recursive: true });
    }
    if (!exists(path.join(prepared, 'src', 'server.js'))) throw new UpgradeError('The prepared release is incomplete.');

    // 4. back up
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${current.version}_to_${pkg.version}`;
    const dir = path.join(backupDir, id);
    ensureDir(path.join(dir, 'code'));
    log(`Backing up to ${dir}`);
    copyCode(root, path.join(dir, 'code'), new Set([...prot, 'web/node_modules']));
    if (exists(path.join(root, 'config.json'))) fs.copyFileSync(path.join(root, 'config.json'), path.join(dir, 'config.json'));
    if (hasDb) snapshotDb(dbPath, path.join(dir, 'db', 'idp.db'));
    const manifest = { id, createdAt: new Date().toISOString(), fromVersion: current.version, toVersion: pkg.version, source: found.from, dbPath: hasDb ? dbPath : null, hasDb, nodeModules: false, state: 'in-progress' };
    writeManifest(dir, manifest);

    // 5. swap, 6. migrate and verify; anything that goes wrong puts the backup back
    try {
      log('Replacing the code...');
      clearCode(root, prot);
      copyCode(prepared, root, prot);
      if (newModules) {
        fs.renameSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules.old'));
        fs.renameSync(newModules, path.join(root, 'node_modules'));
        manifest.nodeModules = true;
        writeManifest(dir, manifest);
      }
      if (exists(path.join(root, 'scripts', 'post-upgrade.js'))) {
        log('Running the release\'s post-upgrade step...');
        await run(process.execPath, [path.join(root, 'scripts', 'post-upgrade.js')], { cwd: root, env: { ...childEnv({ dbPath }), UPGRADE_FROM: current.version, UPGRADE_TO: pkg.version } });
      }
      log('Migrating the database...');
      await (opts.migrate || ((r) => run(process.execPath, ['-e', MIGRATE_SCRIPT, r], { cwd: r, env: childEnv({ dbPath }) })))(root);
      log('Starting the new version once to check it...');
      await (opts.verify || ((r) => run(process.execPath, ['-e', VERIFY_SCRIPT, r, current.version, pkg.version, id], { cwd: r, env: childEnv({ dbPath }) })))(root);
      manifest.state = 'complete';
      manifest.completedAt = new Date().toISOString();
      writeManifest(dir, manifest);
    } catch (err) {
      log(`That failed: ${err.message.split('\n')[0]}\nPutting the previous version back...`);
      try {
        restore(manifest, dir, { root, dbPath, prot, keepData: false });
        manifest.state = 'failed';
        manifest.error = err.message.slice(0, 2000);
        writeManifest(dir, manifest);
      } catch (e2) {
        throw new UpgradeError(`${err.message}\n\nThe automatic rollback ALSO failed (${e2.message}). Your backup is intact at ${dir}; restore it with: node scripts/upgrade.js rollback ${id}`);
      }
      throw new UpgradeError(`${err.message}\n\nThe previous version was restored; nothing was lost.`);
    }
    pruneBackups(backupDir, opts.keep || DEFAULT_KEEP, id);
    return { ...summary, backup: id, backupDir: dir };
  } finally {
    rm(path.join(root, '.upgrade-tmp'));
  }
}

function pruneBackups(backupDir, keep, except) {
  const all = listBackups(backupDir);
  for (const b of all.slice(keep)) if (b.id !== except) rm(b.dir);
}

/* ------------------------------------ Rollback ---------------------------------- */

function restore(manifest, dir, { root, dbPath, prot, keepData }) {
  clearCode(root, prot);
  copyCode(path.join(dir, 'code'), root, prot);
  if (manifest.nodeModules && exists(path.join(dir, 'node_modules.old'))) {
    if (exists(path.join(root, 'node_modules'))) { rm(path.join(dir, 'node_modules.new')); fs.renameSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules.new')); }
    fs.renameSync(path.join(dir, 'node_modules.old'), path.join(root, 'node_modules'));
    manifest.nodeModules = false;
  }
  if (!keepData && manifest.hasDb && exists(path.join(dir, 'db', 'idp.db'))) restoreDb(path.join(dir, 'db', 'idp.db'), dbPath);
}

/** Puts an earlier version back. `id` is a backup's id or 'latest'. Unless keepData, the database goes back to how it was before that upgrade. */
async function rollback(opts) {
  const root = path.resolve(opts.root);
  const backupDir = path.resolve(opts.backupDir || path.join(root, 'upgrade-backups'));
  const log = opts.log || (() => {});
  const all = listBackups(backupDir);
  const wanted = !opts.id || opts.id === 'latest' ? all.find((b) => b.state === 'complete') : all.find((b) => b.id === opts.id);
  if (!wanted) throw new UpgradeError(opts.id && opts.id !== 'latest' ? `No backup named ${opts.id}. See: node scripts/upgrade.js list` : 'There is no completed upgrade to roll back.');
  if (wanted.state === 'rolled-back') throw new UpgradeError('That upgrade was already rolled back.');
  const dbPath = opts.dbPath;
  refuseIfRunning({ dbPath, force: opts.force });
  const summary = { backup: wanted.id, from: wanted.toVersion, to: wanted.fromVersion, keepData: Boolean(opts.keepData), restoresDb: Boolean(wanted.hasDb) && !opts.keepData };
  if (opts.dryRun) return { ...summary, dryRun: true };
  if (opts.confirm && !(await opts.confirm(summary))) throw new UpgradeError('Cancelled. Nothing was changed.');
  const prot = protectedPaths({ root, dbPath, backupDir });
  if (wanted.hasDb && dbPath && exists(dbPath)) {
    log('Keeping a copy of the database as it is now...');
    snapshotDb(dbPath, path.join(wanted.dir, 'db', 'before-rollback.db'));
  }
  log('Restoring the previous version...');
  const manifest = { ...wanted };
  delete manifest.dir;
  restore(manifest, wanted.dir, { root, dbPath, prot, keepData: Boolean(opts.keepData) });
  manifest.state = 'rolled-back';
  manifest.rolledBackAt = new Date().toISOString();
  writeManifest(wanted.dir, manifest);
  return summary;
}

module.exports = { upgrade, rollback, listBackups, compareVersions, locate, UpgradeError, DEFAULT_KEEP };
