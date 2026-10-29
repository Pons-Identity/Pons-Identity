#!/usr/bin/env node
// In-place upgrade of Pons Identity from a downloaded release, with backup and rollback. See README, "Upgrading".
const path = require('path');
const readline = require('readline');
const { upgrade, rollback, listBackups, UpgradeError } = require('../src/upgrade');
const startup = require('../src/settings');

const root = path.join(__dirname, '..');
const USAGE = `Usage:
  node scripts/upgrade.js [upgrade] [<release>]    Upgrade from <release>: an unpacked folder, a .zip/.tar.gz, or a folder
                                                   such as ~/Downloads (the newest Pons Identity release in it is used).
                                                   With no <release>, ~/Downloads is searched.
  node scripts/upgrade.js rollback [<id>|latest]   Put an earlier version back, with the database as it was before it.
  node scripts/upgrade.js list                     Show the backups.

Options:
  --yes, -y           Do not ask for confirmation.
  --dry-run           Say what would happen; change nothing.
  --force             Go ahead although the server seems to be running, or the version is not newer.
  --allow-downgrade   Install an older release.
  --skip-install      Keep the installed dependencies.
  --skip-build        Keep the current web console instead of building the release's.
  --keep-data         (rollback) Restore the code only; keep the database as it is now.
  --backup-dir <dir>  Where backups go (default: upgrade-backups/ next to the code).
  --keep <n>          How many backups to keep (default 5).

Stop the server before upgrading. Upgrading needs network access only when the dependencies or the web console must be built.`;

function parse(argv) {
  const o = { positional: [] };
  const flags = { '--yes': 'yes', '-y': 'yes', '--dry-run': 'dryRun', '--force': 'force', '--allow-downgrade': 'allowDowngrade', '--skip-install': 'skipInstall', '--skip-build': 'skipBuild', '--keep-data': 'keepData', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) o[flags[a]] = true;
    else if (a === '--backup-dir') o.backupDir = argv[++i];
    else if (a === '--keep') o.keep = Number(argv[++i]);
    else if (a.startsWith('-')) throw new UpgradeError(`Unknown option ${a}.\n\n${USAGE}`);
    else o.positional.push(a);
  }
  return o;
}

const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
});

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) return console.log(USAGE);
  let [cmd, ...rest] = o.positional;
  if (!['upgrade', 'rollback', 'list'].includes(cmd)) { rest = o.positional; cmd = 'upgrade'; }
  const common = { root, dbPath: startup.dbPath, backupDir: o.backupDir, log: (m) => console.log(m), force: o.force, dryRun: o.dryRun, keep: o.keep };
  const confirm = (text) => async (s) => {
    if (o.yes) return true;
    if (!process.stdin.isTTY) throw new UpgradeError('Not a terminal: pass --yes to go ahead without asking.');
    console.log(text(s));
    return ask('Continue? [y/N] ');
  };

  if (cmd === 'list') {
    const rows = listBackups(path.resolve(o.backupDir || path.join(root, 'upgrade-backups')));
    if (!rows.length) return console.log('No backups yet.');
    for (const b of rows) console.log(`${b.id}\n    ${b.fromVersion} -> ${b.toVersion}   ${b.state}   ${b.createdAt}${b.error ? `\n    ${b.error.split('\n')[0]}` : ''}`);
    return undefined;
  }

  if (cmd === 'rollback') {
    const r = await rollback({ ...common, id: rest[0], keepData: o.keepData, confirm: confirm((s) => `\nRoll back ${s.from} to ${s.to} (backup ${s.backup}).\n${s.restoresDb
      ? 'The database goes back to how it was before the upgrade: anything changed since then is lost (a copy of the current database is kept in the backup).'
      : 'The database is left as it is.'}\n`) });
    console.log(r.dryRun ? `Would roll back ${r.from} to ${r.to}.` : `\nRolled back to ${r.to}. Start Pons Identity again.`);
    return undefined;
  }

  const r = await upgrade({ ...common, source: rest[0], allowDowngrade: o.allowDowngrade, skipInstall: o.skipInstall, skipBuild: o.skipBuild,
    confirm: confirm((s) => `\nUpgrade ${s.from} -> ${s.to}\n  from ${s.source}\n${s.plan.map((p) => `  - ${p}`).join('\n')}\n`) });
  if (r.dryRun) { console.log(`\nWould upgrade ${r.from} -> ${r.to} from ${r.source}:\n${r.plan.map((p) => `  - ${p}`).join('\n')}`); return undefined; }
  console.log(`\nUpgraded ${r.from} -> ${r.to}. Start Pons Identity again.\nBackup: ${r.backupDir}\nTo undo: node scripts/upgrade.js rollback ${r.backup}`);
  return undefined;
}

main().catch((e) => {
  console.error(e instanceof UpgradeError ? `\n${e.message}` : e);
  process.exit(1);
});
