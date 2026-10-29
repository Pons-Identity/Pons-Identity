const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { execFile } = require('child_process');
const startup = require('../settings');
const appSettings = require('../app-settings');
const exporter = require('../export');
const { isPrivateAddress } = require('../safe-fetch');

// Version control for integrations: their settings, scripts, functions and variables, written as plain files into a Git
// repository the server keeps beside its database, so changes can be committed with a message and pushed to a remote
// (GitHub, GitLab, Gitea...). The files are generated from the database each time; nothing is read back from the repository.
//
// It runs the `git` program rather than speaking the protocol itself. Every call is an argument list (no shell), takes no
// global or system configuration, allows only https remotes, runs no hooks and never asks anything on a terminal. The access
// token is given to Git through a throwaway askpass script and its environment, never on a command line or in a URL, never
// written into the repository's configuration, and not stored here at all: the person types it for each push.

class GitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KEY = 'integrations_git';
const DEFAULT_BRANCH = 'main';
const dir = () => process.env.INTEGRATIONS_GIT_DIR || (startup.dbPath === ':memory:'
  ? path.join(os.tmpdir(), `simpleidp-integrations-git-${process.pid}`)
  : path.join(path.dirname(startup.dbPath), 'integrations-git'));
const gitBin = () => process.env.GIT_BIN || 'git';

const saved = () => ({ remoteUrl: '', branch: DEFAULT_BRANCH, ...(appSettings.read(KEY) || {}) });

/* ------------------------------- Validation ------------------------------- */

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

function cleanBranch(v) {
  const b = typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_BRANCH;
  if (!BRANCH_RE.test(b) || b.includes('..') || b.includes('//') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock') || /\/\./.test(b)) {
    throw new GitError(400, 'Branch names use letters, digits and . _ - / only, and cannot start with a dash or contain "..".');
  }
  return b;
}

/** The remote as a plain https URL, or throws. Credentials do not belong in it: the token has its own field. */
async function cleanRemote(v, { resolve = true } = {}) {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw) throw new GitError(400, 'Enter the remote URL (https).');
  if (raw.length > 500 || /[\s\u0000-\u001f\\]/.test(raw)) throw new GitError(400, 'The remote URL is not valid.');
  let u;
  try { u = new URL(raw); } catch { throw new GitError(400, 'The remote URL is not valid.'); }
  if (u.protocol !== 'https:') throw new GitError(400, 'Only https remote URLs are supported.');
  if (u.username || u.password) throw new GitError(400, 'Leave the user name and password out of the URL; put the access token in its own field.');
  if (u.search || u.hash) throw new GitError(400, 'The remote URL cannot have a query or fragment.');
  if (resolve && process.env.ALLOW_PRIVATE_FETCH !== 'true') {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addrs;
    try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch { throw new GitError(400, `Could not find ${u.hostname}.`); }
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new GitError(400, `${u.hostname} is not a public address, so it cannot be used as a remote.`);
  }
  return u.toString();
}

function cleanMessage(v) {
  const m = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '';
  if (!m) throw new GitError(400, 'Write a commit message.');
  if (m.length > 2000 || m.includes('\u0000')) throw new GitError(400, 'The commit message is too long or has characters Git cannot store.');
  return m;
}

/* --------------------------------- Running git ---------------------------- */

let queue = Promise.resolve();
/** Git calls take turns: two at once would fight over the repository's lock. */
const exclusive = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

const redact = (text, secrets) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join('[token]').split(Buffer.from(s).toString('base64')).join('[token]'), String(text));

function git(args, { cwd = dir(), env = {}, timeout = 30000, secrets = [], input } = {}) {
  const safe = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
    '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false'];
  return new Promise((resolve, reject) => {
    const child = execFile(gitBin(), [...safe, ...args], {
      cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: {
        PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '', SSH_ASKPASS: '', ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}), ...env,
      },
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new GitError(501, 'Git is not installed on the server, so integrations cannot be committed. Install git and try again.'));
        const text = redact((stderr || err.message || '').trim(), secrets).split('\n').filter((l) => !/^hint:/.test(l)).join('\n').trim();
        return reject(new GitError(err.killed ? 504 : 502, err.killed ? 'Git took too long and was stopped.' : text.slice(0, 1500) || 'Git failed.'));
      }
      resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const isRepo = () => fs.existsSync(path.join(dir(), '.git', 'HEAD'));

/* ------------------------------ Writing the files ------------------------- */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'unnamed';
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

const readme = () => `# ${appSettings.productName()} integrations

Written by ${appSettings.productName()} (Integrations → Git). Each integration, function and variable is a plain file, so changes show up as readable diffs.

- \`integrations/<name>/integration.json\` — settings: scopes, inputs, schedules, events, time limit, who may run it
- \`integrations/<name>/script.js\` — the script
- \`functions/<name>/function.json\` and \`function.js\` — functions the integrations call
- \`variables.json\` — variable names and descriptions; values of secret variables are never written

Webhook tokens, run history and secret values are not in this repository. ${appSettings.productName()} writes these files from its database;
editing them here does not change ${appSettings.productName()}.
`;

/** Files (relative path to text) for what is in the database now. */
function render() {
  const data = exporter.integrations();
  const files = { 'README.md': readme() };
  const used = new Set();
  const unique = (base, id) => { let s = base; if (used.has(s)) s = `${base}-${id}`; used.add(s); return s; };
  for (const i of data.integrations) {
    const { script, id, ...settings } = i;
    const d = `integrations/${unique(slug(i.name), id)}`;
    files[`${d}/integration.json`] = json(settings);
    files[`${d}/script.js`] = script.endsWith('\n') || !script ? script : `${script}\n`;
  }
  const fnUsed = new Set();
  for (const f of data.functions) {
    const { script, ...settings } = f;
    let s = slug(f.name);
    if (fnUsed.has(s)) s = `${s}-${fnUsed.size}`;
    fnUsed.add(s);
    files[`functions/${s}/function.json`] = json(settings);
    files[`functions/${s}/function.js`] = script.endsWith('\n') || !script ? script : `${script}\n`;
  }
  files['variables.json'] = json(data.variables.map((v) => ({ name: v.name, description: v.description, secret: v.secret, value: v.secret ? null : v.value })));
  return files;
}

/** Makes the working tree match the database: managed files are rewritten and those no longer wanted are removed. */
function write() {
  const root = dir();
  fs.mkdirSync(root, { recursive: true });
  for (const managed of ['integrations', 'functions']) fs.rmSync(path.join(root, managed), { recursive: true, force: true });
  for (const [rel, text] of Object.entries(render())) {
    const target = path.join(root, rel);
    if (!target.startsWith(root + path.sep)) continue; // slugs cannot climb out; this is the belt to that braces
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

/* --------------------------------- Operations ----------------------------- */

const parseStatus = (out) => out.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3).replace(/^"|"$/g, '') }));

async function lastCommit() {
  try {
    const [hash, subject, author, date] = (await git(['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%aI'])).trim().split('\x1f');
    return hash ? { hash, short: hash.slice(0, 7), subject, author, date } : null;
  } catch { return null; }
}

async function currentBranch() {
  try { return (await git(['symbolic-ref', '--short', 'HEAD'])).trim(); } catch { return ''; }
}

/** The modal's first view: whether there is a repository, what has changed since the last commit, and what is not pushed. */
function status() {
  return exclusive(async () => {
    const cfg = saved();
    let version = '';
    try { version = (await git(['--version'], { cwd: os.tmpdir() })).trim(); } catch (e) {
      if (e.status === 501) return { available: false, message: e.message, remoteUrl: cfg.remoteUrl, branch: cfg.branch };
      throw e;
    }
    const base = { available: true, version, remoteUrl: cfg.remoteUrl, branch: cfg.branch, initialized: false, changes: [], last: null, unpushed: 0 };
    if (!isRepo()) return { ...base, changes: Object.keys(render()).filter((p) => p !== 'README.md').map((p) => ({ status: 'A', path: p })) };
    write();
    const branch = await currentBranch();
    const changes = parseStatus(await git(['status', '--porcelain', '--untracked-files=all']));
    const last = await lastCommit();
    let unpushed = 0;
    if (last) {
      try { unpushed = Number((await git(['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`])).trim()); } catch { unpushed = Number((await git(['rev-list', '--count', 'HEAD'])).trim()) || 0; }
    }
    return { ...base, initialized: true, branch: branch || cfg.branch, changes, last, unpushed };
  });
}

/** Commits everything that changed. Starts the repository first if there is none. */
function commit({ message, branch, author }) {
  const msg = cleanMessage(message);
  const b = cleanBranch(branch);
  return exclusive(async () => {
    const env = {
      GIT_AUTHOR_NAME: author.name || 'Pons Identity', GIT_AUTHOR_EMAIL: author.email || 'simpleidp@localhost', GIT_COMMITTER_NAME: author.name || 'Pons Identity', GIT_COMMITTER_EMAIL: author.email || 'simpleidp@localhost',
    };
    const created = !isRepo();
    if (created) {
      fs.mkdirSync(dir(), { recursive: true });
      await git(['init', '--quiet']);
      await git(['symbolic-ref', 'HEAD', `refs/heads/${b}`]);
    }
    write();
    const here = await currentBranch();
    if (here !== b) await git(['checkout', '--quiet', '-B', b]);
    await git(['add', '-A']);
    if (!(await git(['status', '--porcelain'])).trim()) throw new GitError(409, 'Nothing to commit: the repository already matches your integrations.');
    const files = parseStatus(await git(['status', '--porcelain']));
    await git(['commit', '--quiet', '--no-verify', '-F', '-'], { env, input: msg });
    appSettings.write(KEY, { ...saved(), branch: b });
    return { created, branch: b, files: files.length, last: await lastCommit() };
  });
}

/** Pushes the branch to the remote. The token is used for this call only. */
function push({ remoteUrl, branch, token }) {
  const b = cleanBranch(branch);
  const secret = typeof token === 'string' ? token.trim() : '';
  if (secret.length > 1000 || /[\u0000-\u001f]/.test(secret)) throw new GitError(400, 'The access token is not valid.');
  return (async () => {
    const url = await cleanRemote(remoteUrl);
    return exclusive(async () => {
      if (!isRepo() || !(await lastCommit())) throw new GitError(409, 'Commit first: there is nothing to push yet.');
      if ((await currentBranch()) !== b) throw new GitError(409, `The repository is on ${(await currentBranch()) || 'no branch'}, not ${b}. Commit on ${b} first, or change the branch.`);
      const remotes = (await git(['remote'])).split('\n').filter(Boolean);
      if (remotes.includes('origin')) await git(['remote', 'set-url', 'origin', url]); else await git(['remote', 'add', 'origin', url]);
      appSettings.write(KEY, { remoteUrl: url, branch: b });
      let askDir = '';
      const env = {};
      if (secret) {
        askDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-askpass-'));
        const script = path.join(askDir, 'askpass.sh');
        fs.writeFileSync(script, '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\' "x-access-token" ;;\n  *) printf \'%s\' "$SIMPLEIDP_GIT_TOKEN" ;;\nesac\n', { mode: 0o700 });
        env.GIT_ASKPASS = script;
        env.SIMPLEIDP_GIT_TOKEN = secret;
      }
      try {
        const out = await git(['push', '--porcelain', 'origin', `HEAD:refs/heads/${b}`], { env, timeout: 120000, secrets: [secret] });
        return { remoteUrl: url, branch: b, output: redact(out, [secret]).trim().slice(0, 1000), last: await lastCommit() };
      } catch (e) {
        if (e instanceof GitError && /non-fast-forward|fetch first|rejected/i.test(e.message)) throw new GitError(409, `The remote has changes this repository does not. Pull or merge them there first; ${appSettings.productName()} never forces a push.`);
        if (e instanceof GitError && /Authentication failed|could not read Username|403|401/i.test(e.message)) throw new GitError(401, 'The remote refused the access token (or none was given). Check that the token can write to this repository.');
        throw e;
      } finally {
        if (askDir) fs.rmSync(askDir, { recursive: true, force: true });
      }
    });
  })();
}

module.exports = { status, commit, push, render, dir, GitError, cleanRemote, cleanBranch };
