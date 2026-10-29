const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const auditLog = require('./audit');
const { buildModel, SUBJECT_FIELDS } = require('./grouper-export');
const gm = require('./group-membership');
const { baseUrl } = require('./config');

// A read-only feed of the built-in groups for Grouper's loader to pull while Pons Identity is still the source of
// truth. It serves *effective* memberships (nested groups and composites already resolved, expired members left
// out), because a loader-managed group's members come only from the feed. Bearer-token API, no cookies or CSRF.

const BASE = '/feed/grouper/v1';
const KEY = 'grouper_feed';
const SUBJECT_COLUMNS = ['subject_id', 'subject_identifier', 'subject_id_or_identifier'];
const DEFAULTS = { tokenHash: '', tokenCreatedAt: '', lastFetchAt: '', subjectField: 'username', rootStem: 'simpleidp', subjectColumn: 'subject_id', subjectSourceId: '' };

const config = () => {
  const row = db.get('SELECT value FROM settings WHERE key = ?', KEY);
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  return { ...DEFAULTS, ...saved };
};
const saveConfig = (cfg) => db.run(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(cfg));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function newToken() {
  const token = `gft_${crypto.randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}
function tokenMatches(presented, hash) {
  if (!presented || !hash) return false;
  const a = Buffer.from(sha256(presented));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Validates the options an administrator can change. */
function parseOptions(raw = {}, current = config()) {
  const subjectField = raw.subjectField ?? current.subjectField;
  const rootStem = raw.rootStem === undefined ? current.rootStem : String(raw.rootStem).trim();
  const subjectColumn = raw.subjectColumn ?? current.subjectColumn;
  const subjectSourceId = raw.subjectSourceId === undefined ? current.subjectSourceId : String(raw.subjectSourceId).trim();
  const errors = [];
  if (!SUBJECT_FIELDS[subjectField]) errors.push(`People are identified by one of: ${Object.keys(SUBJECT_FIELDS).join(', ')}.`);
  if (!/^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)*$/.test(rootStem)) errors.push('The folder for ungrouped names may use letters, numbers, . _ - and : between folder levels.');
  if (!SUBJECT_COLUMNS.includes(subjectColumn)) errors.push(`The subject column must be one of: ${SUBJECT_COLUMNS.join(', ')}.`);
  if (subjectSourceId && !/^[A-Za-z0-9_.:-]{1,64}$/.test(subjectSourceId)) errors.push('The subject source ID may only use letters, numbers and . _ : -');
  return { options: { subjectField, rootStem, subjectColumn, subjectSourceId }, errors };
}

/** Rows for the feed: { groups, memberships, skipped } where skipped counts people with no value for the subject field. */
function buildFeed(cfg = config()) {
  const model = buildModel({ subjectField: cfg.subjectField, rootStem: cfg.rootStem });
  const users = new Map(db.all(`SELECT id, ${cfg.subjectField} AS subject FROM users`).map((u) => [u.id, String(u.subject || '').trim()]));
  const graph = gm.loadGraph();
  const memo = new Map();
  const groups = [];
  const memberships = [];
  const skippedUsers = new Set();
  for (const g of model.groups) {
    groups.push({ group_name: g.name, group_display_name: g.name, group_description: g.description });
    const seen = new Set();
    for (const uid of gm.effectiveMembers(g.id, undefined, graph, memo)) {
      const subject = users.get(uid);
      if (!subject) { skippedUsers.add(uid); continue; }
      if (seen.has(subject)) continue;
      seen.add(subject);
      memberships.push({ group_name: g.name, [cfg.subjectColumn]: subject, ...(cfg.subjectSourceId ? { subject_source_id: cfg.subjectSourceId } : {}) });
    }
  }
  memberships.sort((a, b) => a.group_name.localeCompare(b.group_name) || String(a[cfg.subjectColumn]).localeCompare(String(b[cfg.subjectColumn])));
  return { groups, memberships, skipped: skippedUsers.size };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (columns, rows) => `${[columns, ...rows.map((r) => columns.map((c) => r[c]))].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

const view = (cfg = config()) => ({
  tokenSet: Boolean(cfg.tokenHash),
  tokenCreatedAt: cfg.tokenCreatedAt,
  lastFetchAt: cfg.lastFetchAt,
  subjectField: cfg.subjectField,
  rootStem: cfg.rootStem,
  subjectColumn: cfg.subjectColumn,
  subjectSourceId: cfg.subjectSourceId,
  urls: { memberships: `${baseUrl}${BASE}/memberships.csv`, groups: `${baseUrl}${BASE}/groups.csv`, base: `${baseUrl}${BASE}` },
});

const router = express.Router();

router.use((req, res, next) => {
  const cfg = config();
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!m || !tokenMatches(m[1], cfg.tokenHash)) {
    res.set('WWW-Authenticate', 'Bearer realm="Pons Identity feed"');
    auditLog.user('token.auth_failure', { outcome: 'failure', actor: { type: 'anonymous', name: 'grouper-feed' }, detail: { api: 'grouper-feed', method: req.method, path: req.originalUrl.split('?')[0], tokenPresented: Boolean(m) } });
    return res.status(401).json({ error: 'A valid bearer token is required.' });
  }
  res.set({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  req.feedConfig = cfg;
  return next();
});

function serve(kind, format) {
  return (req, res) => {
    const cfg = req.feedConfig;
    saveConfig({ ...cfg, lastFetchAt: new Date().toISOString() });
    const feed = buildFeed(cfg);
    const rows = feed[kind];
    res.set('x-feed-rows', String(rows.length));
    if (format === 'json') return res.json(rows);
    const columns = kind === 'groups'
      ? ['group_name', 'group_display_name', 'group_description']
      : ['group_name', cfg.subjectColumn, ...(cfg.subjectSourceId ? ['subject_source_id'] : [])];
    return res.type('text/csv; charset=utf-8').send(toCsv(columns, rows));
  };
}
router.get('/memberships.csv', serve('memberships', 'csv'));
router.get('/memberships.json', serve('memberships', 'json'));
router.get('/groups.csv', serve('groups', 'csv'));
router.get('/groups.json', serve('groups', 'json'));

module.exports = { router, BASE, config, saveConfig, newToken, tokenMatches, parseOptions, buildFeed, view, SUBJECT_COLUMNS };
