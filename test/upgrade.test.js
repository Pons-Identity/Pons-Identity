const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { upgrade, rollback, listBackups, compareVersions } = require('../src/upgrade');
const { extract } = require('../src/upgrade/archive');
const { zip } = require('../src/zip');

const repo = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-upgrade-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const app = path.join(tmp, 'app');
const dbPath = path.join(app, 'data', 'idp.db');
const downloads = path.join(tmp, 'Downloads');

// A small install: the real code (so the new version can really start), this repo's dependencies, and a database with a row in it.
function lay(dest, version, { obsolete = false, tweak } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const d of ['src', 'views']) fs.cpSync(path.join(repo, d), path.join(dest, d), { recursive: true });
  for (const f of ['package-lock.json']) fs.copyFileSync(path.join(repo, f), path.join(dest, f));
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2));
  if (obsolete) fs.writeFileSync(path.join(dest, 'src', 'obsolete.js'), 'module.exports = 1;\n');
  if (tweak) tweak(dest);
}
const tables = () => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name); } finally { db.close(); } };
const marker = () => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare("SELECT value FROM settings WHERE key = 'marker'").get(); } finally { db.close(); } };
const version = () => JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version;
const addProbe = (dest) => {
  const f = path.join(dest, 'src', 'db.js');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('module.exports = {', 'db.exec("CREATE TABLE IF NOT EXISTS upgrade_probe (x TEXT)");\nmodule.exports = {'));
};
const opts = (extra = {}) => ({ root: app, dbPath, source: downloads, log: () => {}, ...extra });

test('set up an installed 1.0.0 with a database', () => {
  lay(app, '1.0.0', { obsolete: true });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(app, 'node_modules'));
  fs.writeFileSync(path.join(app, 'config.json'), '{"port":3999}\n');
  fs.mkdirSync(path.join(app, 'data'));
  execFileSync(process.execPath, ['-e', "require(process.argv[1] + '/src/db').run(\"INSERT INTO settings (key, value) VALUES ('marker', '\\\"before\\\"')\")", app], { env: { ...process.env, DB_PATH: dbPath }, cwd: app });
  assert.equal(marker().value, '"before"');
  assert.ok(!tables().includes('upgrade_probe'));
});

test('versions compare the way releases do', () => {
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0-rc.1'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
});

test('a dry run says what it would do and changes nothing', async () => {
  fs.mkdirSync(downloads, { recursive: true });
  lay(path.join(downloads, 'simple-idp-1.1.0'), '1.1.0', { tweak: addProbe });
  const r = await upgrade(opts({ dryRun: true }));
  assert.equal(r.dryRun, true);
  assert.equal(r.to, '1.1.0');
  assert.equal(version(), '1.0.0');
  assert.ok(r.plan.some((p) => /keep the installed dependencies/.test(p)));
  assert.equal(listBackups(path.join(app, 'upgrade-backups')).length, 0);
});

test('upgrades from the newest release in a downloads folder: code replaced, data and config untouched, schema migrated', async () => {
  const r = await upgrade(opts());
  assert.equal(r.from, '1.0.0');
  assert.equal(r.to, '1.1.0');
  assert.equal(version(), '1.1.0');
  assert.ok(tables().includes('upgrade_probe'), 'the new code migrated the schema');
  assert.equal(marker().value, '"before"', 'data survived');
  assert.ok(!fs.existsSync(path.join(app, 'src', 'obsolete.js')), 'files the release no longer has are removed');
  assert.equal(fs.readFileSync(path.join(app, 'config.json'), 'utf8'), '{"port":3999}\n');
  assert.ok(fs.lstatSync(path.join(app, 'node_modules')).isSymbolicLink(), 'node_modules was not touched');
  const [b] = listBackups(path.join(app, 'upgrade-backups'));
  assert.equal(b.state, 'complete');
  assert.ok(fs.existsSync(path.join(b.dir, 'db', 'idp.db')));
  assert.ok(fs.existsSync(path.join(b.dir, 'code', 'src', 'obsolete.js')));
  assert.ok(!fs.existsSync(path.join(app, '.upgrade-tmp')), 'staging is cleaned up');
});

test('the same or an older version is refused unless told otherwise', async () => {
  await assert.rejects(() => upgrade(opts()), /already installed/);
  lay(path.join(tmp, 'older'), '0.9.0');
  await assert.rejects(() => upgrade(opts({ source: path.join(tmp, 'older') })), /older than the one installed/);
});

test('it will not touch an install whose server is running', async () => {
  fs.writeFileSync(path.join(app, 'data', 'server.pid'), String(process.pid));
  lay(path.join(tmp, 'next'), '1.2.0');
  await assert.rejects(() => upgrade(opts({ source: path.join(tmp, 'next') })), /appears to be running/);
  await assert.rejects(() => rollback({ root: app, dbPath, log: () => {} }), /appears to be running/);
  fs.rmSync(path.join(app, 'data', 'server.pid'));
});

test('rollback restores the code and the database as they were', async () => {
  // Something changes after the upgrade; a rollback that keeps data leaves it, one that does not, loses it.
  const db = new DatabaseSync(dbPath);
  db.exec("INSERT INTO settings (key, value) VALUES ('after', '1')");
  db.close();
  const r = await rollback({ root: app, dbPath, log: () => {} });
  assert.equal(r.to, '1.0.0');
  assert.equal(version(), '1.0.0');
  assert.ok(fs.existsSync(path.join(app, 'src', 'obsolete.js')));
  assert.ok(!tables().includes('upgrade_probe'), 'the schema change is undone with the database');
  assert.equal(marker().value, '"before"');
  const [b] = listBackups(path.join(app, 'upgrade-backups'));
  assert.equal(b.state, 'rolled-back');
  assert.ok(fs.existsSync(path.join(b.dir, 'db', 'before-rollback.db')), 'the database as it was just before is kept');
  await assert.rejects(() => rollback({ root: app, dbPath, log: () => {} }), /no completed upgrade/);
});

test('a release that breaks the database step is rolled back automatically', async () => {
  lay(path.join(tmp, 'bad'), '2.0.0', { tweak: (d) => { const f = path.join(d, 'src', 'db.js'); fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8')}\nthis is not javascript (\n`); } });
  await assert.rejects(() => upgrade(opts({ source: path.join(tmp, 'bad') })), /previous version was restored/);
  assert.equal(version(), '1.0.0');
  assert.ok(fs.existsSync(path.join(app, 'src', 'obsolete.js')));
  assert.equal(marker().value, '"before"');
  assert.equal(listBackups(path.join(app, 'upgrade-backups'))[0].state, 'failed');
});

test('a release whose database change succeeds but whose start-up check fails is rolled back, database included', async () => {
  lay(path.join(tmp, 'late'), '2.1.0', { tweak: addProbe });
  await assert.rejects(() => upgrade(opts({ source: path.join(tmp, 'late'), verify: async () => { throw new Error('GET /api/session answered 500'); } })), /answered 500[\s\S]*restored/);
  assert.equal(version(), '1.0.0');
  assert.ok(!tables().includes('upgrade_probe'), 'the migrated schema was put back');
});

test('a downloaded .zip works, including the single wrapping folder GitHub adds', async () => {
  const rel = path.join(tmp, 'zipsrc');
  lay(rel, '3.0.0', { tweak: addProbe });
  const files = {};
  const walk = (d, p = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), `${p}${e.name}/`); else files[`pons-identity-main/${p}${e.name}`] = fs.readFileSync(path.join(d, e.name), 'utf8'); } };
  walk(rel);
  const dl = path.join(tmp, 'zipdl');
  fs.mkdirSync(dl);
  fs.writeFileSync(path.join(dl, 'pons-identity-main.zip'), zip(files));
  const r = await upgrade(opts({ source: path.join(dl, 'pons-identity-main.zip') }));
  assert.equal(r.to, '3.0.0');
  assert.equal(version(), '3.0.0');
  assert.ok(tables().includes('upgrade_probe'));
});

test('archives cannot write outside their folder or carry links', () => {
  const dest = path.join(tmp, 'x1');
  fs.writeFileSync(path.join(tmp, 'evil.zip'), zip({ '../escape.txt': 'no' }));
  assert.throws(() => extract(path.join(tmp, 'evil.zip'), dest), /unsafe path/);
  fs.writeFileSync(path.join(tmp, 'evil2.zip'), zip({ '/etc/passwd-ish': 'no' }));
  assert.throws(() => extract(path.join(tmp, 'evil2.zip'), path.join(tmp, 'x2')), /unsafe path/);
  assert.ok(!fs.existsSync(path.join(tmp, 'escape.txt')));
  fs.writeFileSync(path.join(tmp, 'junk.zip'), 'not an archive at all');
  assert.throws(() => extract(path.join(tmp, 'junk.zip'), path.join(tmp, 'x3')), /not a \.zip/);
});

test('a .tar.gz from GitHub (pax headers, wrapping folder) unpacks', (t) => {
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('no tar on this machine'); }
  const src = path.join(tmp, 'tarsrc', 'simple-idp-main');
  fs.mkdirSync(path.join(src, 'deep', 'er'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"simple-idp"}');
  fs.writeFileSync(path.join(src, 'deep', 'er', `${'long'.repeat(30)}.txt`), 'hello');
  fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(tmp, 'rel.tar.gz'), '-C', path.join(tmp, 'tarsrc'), 'simple-idp-main']);
  extract(path.join(tmp, 'rel.tar.gz'), path.join(tmp, 'tarout'));
  assert.equal(fs.readFileSync(path.join(tmp, 'tarout', 'simple-idp-main', 'deep', 'er', `${'long'.repeat(30)}.txt`), 'utf8'), 'hello');
  assert.ok(fs.statSync(path.join(tmp, 'tarout', 'simple-idp-main', 'run.sh')).mode & 0o100, 'executable bit kept');
});
