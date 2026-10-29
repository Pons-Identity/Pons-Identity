const db = require('./db');
const search = require('./search');
const { LdapFilterError } = require('./ldap-filter');
const { audit } = require('./group-audit');
const auditLog = require('./audit');
const appSettings = require('./app-settings');

// LDAP queries as group membership. A rule is an RFC 4515 filter over the people in this IdP (the same one the people search takes).
//   snapshot  the query runs when an administrator asks; matching people become ordinary direct members and nothing is tracked after.
//   ongoing   the query is re-run every few minutes and after people change; people it added (via_rule = 1) are removed again when
//             they stop matching. Someone added by hand stays even if they stop matching: only the query's own additions come and go.
// Only local groups that are not composites can carry a rule, since their membership is a list this code is free to edit.

const MODES = ['snapshot', 'ongoing'];
const nowSec = () => Math.floor(Date.now() / 1000);

const ruleOf = (groupId) => db.get('SELECT * FROM group_rules WHERE group_id = ?', Number(groupId)) || null;

const view = (r) => r && ({
  filter: r.filter, mode: r.mode, last_run_at: r.last_run_at, last_added: r.last_added, last_removed: r.last_removed,
  last_matched: r.last_matched, last_error: r.last_error, set_by: r.set_by, set_at: r.set_at,
  members_by_rule: db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND via_rule = 1', r.group_id).n,
});

/** Why this group cannot have a rule, or null. */
function unsuitable(group) {
  if (!group) return 'No such group.';
  if (group.source !== 'local') return `Only groups managed here can use a query; this one is managed outside ${appSettings.productName()}.`;
  if (db.get('SELECT 1 FROM group_composites WHERE group_id = ?', group.id)) return 'A composite group takes its members from two other groups; it cannot also use a query.';
  return null;
}

/** Validates a filter and says who matches it. Returns { ok, error?, matches?, sample? }. */
function preview(filter) {
  const text = String(filter ?? '').trim();
  if (!text) return { ok: false, error: 'Write a query first.' };
  if (!text.startsWith('(')) return { ok: false, error: 'An LDAP query starts with "(", such as (department=Underwater Basket-Weaving).' };
  try {
    const people = search.peopleMatchingFilter(text);
    return { ok: true, matches: people.length, sample: people.slice(0, 10).map((p) => ({ username: p.username, display_name: p.display_name })) };
  } catch (e) {
    if (e instanceof LdapFilterError) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * Runs a group's rule now. Returns { matched, added, removed } or { error }. `by` names who asked ('system' for the timer).
 * A snapshot rule runs only when asked (force), an ongoing one whenever called.
 */
function run(groupId, { by = 'system', force = false } = {}) {
  const rule = ruleOf(groupId);
  const group = db.get('SELECT * FROM groups WHERE id = ?', Number(groupId));
  if (!rule || !group) return { error: 'This group has no query.' };
  if (rule.mode === 'snapshot' && !force) return { error: 'A snapshot query runs only when you ask.' };
  const bad = unsuitable(group);
  if (bad) return { error: bad };
  let people;
  try {
    people = search.peopleMatchingFilter(rule.filter);
  } catch (e) {
    if (!(e instanceof LdapFilterError)) throw e;
    db.run('UPDATE group_rules SET last_run_at = ?, last_error = ? WHERE group_id = ?', nowSec(), e.message, group.id);
    return { error: e.message };
  }
  const ongoing = rule.mode === 'ongoing';
  const matching = new Set(people.map((p) => p.id));
  const now = nowSec();
  const result = db.tx(() => {
    const existing = new Map(db.all('SELECT user_id, via_rule, start_at, end_at FROM group_members WHERE group_id = ?', group.id).map((m) => [m.user_id, m]));
    const added = []; const removed = [];
    for (const p of people) {
      const row = existing.get(p.id);
      const lapsed = row && ((row.end_at !== null && row.end_at <= now) || (row.start_at !== null && row.start_at > now));
      if (!row) {
        db.run('INSERT INTO group_members (group_id, user_id, via_rule) VALUES (?, ?, ?)', group.id, p.id, ongoing ? 1 : 0);
        added.push(p.username);
      } else if (lapsed && ongoing) {
        db.run('UPDATE group_members SET start_at = NULL, end_at = NULL, via_rule = 1 WHERE group_id = ? AND user_id = ?', group.id, p.id);
        added.push(p.username);
      }
    }
    if (ongoing) {
      const users = new Map(db.all('SELECT id, username FROM users').map((u) => [u.id, u.username]));
      for (const [uid, row] of existing) {
        if (row.via_rule && !matching.has(uid)) {
          db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', group.id, uid);
          removed.push(users.get(uid) || String(uid));
        }
      }
    }
    db.run('UPDATE group_rules SET last_run_at = ?, last_added = ?, last_removed = ?, last_matched = ?, last_error = ? WHERE group_id = ?',
      now, added.length, removed.length, matching.size, '', group.id);
    return { added, removed };
  });
  for (const u of result.added) audit(by, group, 'member.add', `${u} (matched the group's query)`);
  for (const u of result.removed) audit(by, group, 'member.remove', `${u} (no longer matches the group's query)`);
  return { matched: matching.size, added: result.added.length, removed: result.removed.length };
}

/** Validates a rule submitted by an administrator. Returns { errors } or { data }. */
function parse(body, group) {
  const bad = unsuitable(group);
  if (bad) return { errors: [bad] };
  const mode = MODES.includes(body.mode) ? body.mode : null;
  if (!mode) return { errors: ['Choose snapshot or ongoing.'] };
  const check = preview(body.filter);
  if (!check.ok) return { errors: [check.error] };
  return { data: { filter: String(body.filter).trim(), mode } };
}

/** Saves a rule. A change from ongoing to snapshot keeps the people the query had added, as ordinary members. */
function save(groupId, data, by) {
  const before = ruleOf(groupId);
  db.tx(() => {
    db.run(`INSERT INTO group_rules (group_id, filter, mode, set_by, set_at) VALUES (?,?,?,?,?)
            ON CONFLICT(group_id) DO UPDATE SET filter = excluded.filter, mode = excluded.mode, set_by = excluded.set_by, set_at = excluded.set_at, last_error = ''`,
    Number(groupId), data.filter, data.mode, by, nowSec());
    if (data.mode === 'snapshot') db.run('UPDATE group_members SET via_rule = 0 WHERE group_id = ?', Number(groupId));
  });
  return { created: !before };
}

/** Removes a rule. The people it added stay as ordinary members unless `keepMembers` is false, which removes them. */
function remove(groupId, { keepMembers = true } = {}) {
  return db.tx(() => {
    let dropped = 0;
    if (!keepMembers) dropped = db.run('DELETE FROM group_members WHERE group_id = ? AND via_rule = 1', Number(groupId)).changes;
    db.run('UPDATE group_members SET via_rule = 0 WHERE group_id = ?', Number(groupId));
    return { removed: db.run('DELETE FROM group_rules WHERE group_id = ?', Number(groupId)).changes > 0, dropped };
  });
}

/** Re-runs every ongoing rule. */
function runAllOngoing() {
  let changed = 0;
  for (const r of db.all("SELECT group_id FROM group_rules WHERE mode = 'ongoing'")) {
    try {
      const out = run(r.group_id);
      if (out.added || out.removed) changed += 1;
    } catch (e) { console.error(`Group query ${r.group_id} failed:`, e.message); }
  }
  return changed;
}

/** Runs ongoing queries now, every few minutes, and shortly after people change. Returns a function that stops it. */
function startJob({ intervalMs = 5 * 60 * 1000 } = {}) {
  let pending = null;
  const soon = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; try { runAllOngoing(); } catch (e) { console.error('Group queries failed:', e.message); } }, 3000);
    pending.unref();
  };
  // A person created, changed, imported or deleted can change who matches.
  auditLog.onRecord((row) => { if (/^(user\.|scim\.|directory_api\.|identity\.)/.test(row.action || '')) soon(); });
  const tick = () => { try { runAllOngoing(); } catch (e) { console.error('Group queries failed:', e.message); } };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); if (pending) clearTimeout(pending); };
}

module.exports = { MODES, ruleOf, view, unsuitable, preview, parse, save, run, remove, runAllOngoing, startJob };
