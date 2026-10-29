const net = require('net');
const db = require('./db');
const roles = require('./roles');
const { effectiveGroupsOf } = require('./group-membership');
const mfaRemember = require('./mfa-remember');
const userService = require('./user-service');
const auditLog = require('./audit');

// Compromised-account policies. When an account is believed compromised, an administrator locks it down: the steps below run
// (the built-in "Compromised account lockdown" integration performs them, so developers can change the procedure). Which steps
// run is set by policy. The Everyone policy sets the default for every account; if there is none, the built-in default applies
// (every step but the network restriction). A role or group policy adds steps on top, so the strictest value of each step wins,
// and every network list it sets must also be matched by the address a person signs in from.
//
// While an account is in lockdown (account_lockdowns), sign-in is refused from outside its networks, and ending the lockdown
// turns the account back on if the lockdown locked it.

const STEPS = [
  { key: 'end_sessions', label: 'Sign out everywhere', detail: 'Signs the person out of every browser and ends their OAuth and OpenID Connect tokens.' },
  { key: 'reset_password', label: 'Replace the password', detail: 'Sets a random password nobody knows. Sign-in needs account recovery or an administrator.' },
  { key: 'rotate_mfa', label: 'Remove sign-in methods', detail: 'Removes the authenticator and every other sign-in method. They set them up again at sign-in.' },
  { key: 'forget_remembered', label: 'Forget remembered browsers', detail: 'Every browser asks for the second factor again.' },
  { key: 'lock_account', label: 'Lock the account', detail: 'Turns the account off until an administrator ends the lockdown.' },
  { key: 'add_to_group', label: 'Add to a group', detail: 'Adds the person to the group chosen here, such as a group that limits what they can reach.', needs_group: true },
  { key: 'notify_user', label: 'Tell the person', detail: 'Emails them that the account was locked down. The email holds no password or code.' },
];
const STEP_KEYS = STEPS.map((s) => s.key);
const DEFAULT_NAME = 'Built-in default';
const MAX_NETWORKS = 100;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
// The built-in integration that performs a lockdown (integrations/builtin.js).
const LOCKDOWN_INTEGRATION = 'compromised-account-lockdown';

// Every step is on by default except adding to a group, which needs a group chosen.
const DEFAULT_ROW = Object.fromEntries([...STEP_KEYS.map((k) => [k, k === 'add_to_group' ? 0 : 1]), ['add_to_group_id', null], ['restrict_networks', '']]);

/* ------------------------------ Networks ------------------------------- */

/**
 * Reads a list of addresses and networks, one per line or separated by commas or spaces ("10.0.0.0/8", "2001:db8::/32", "192.0.2.7").
 * Returns { networks: ['10.0.0.0/8', ...], errors }.
 */
function parseNetworks(text) {
  const errors = [];
  const networks = [];
  for (const item of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const [addr, bits, extra] = item.split('/');
    const family = net.isIPv4(addr) ? 4 : net.isIPv6(addr) ? 6 : 0;
    const max = family === 6 ? 128 : 32;
    const ok = family && extra === undefined && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= max));
    if (!ok) errors.push(`"${item}" is not an address or a network such as 10.0.0.0/8 or 2001:db8::/32.`);
    else networks.push(bits === undefined ? addr : `${addr}/${Number(bits)}`);
  }
  if (networks.length > MAX_NETWORKS) errors.push(`At most ${MAX_NETWORKS} addresses or networks can be listed.`);
  return { networks: [...new Set(networks)], errors };
}

// Stored and returned as a list of lists; anything unreadable allows nothing extra.
const parseList = (text) => parseNetworks(text).networks;

/** True when `ip` is inside at least one of the addresses or networks in `list`. Mapped IPv4 addresses are compared as IPv4. */
function inList(ip, list) {
  const address = String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  const family = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
  if (!family) return false;
  const blocks = new net.BlockList();
  for (const item of list) {
    const [addr, bits] = item.split('/');
    const f = net.isIPv4(addr) ? 'ipv4' : 'ipv6';
    if (f !== family) continue;
    blocks.addSubnet(addr, bits === undefined ? (f === 'ipv4' ? 32 : 128) : Number(bits), f);
  }
  return blocks.check(address, family);
}

/** Whether sign-in from `ip` is allowed under a lockdown: every restricted list must match. No restriction allows everything. */
function allowedFrom(lockdown, ip) {
  const lists = JSON.parse(lockdown.networks || '[]');
  return lists.every((list) => list.length === 0 || inList(ip, list));
}

/* ------------------------------ Policies ------------------------------- */

const everyonePolicy = () => db.get('SELECT * FROM compromise_policies WHERE everyone = 1');

const groupIdsOf = (policyId) => db.all('SELECT group_id FROM compromise_policy_groups WHERE policy_id = ? ORDER BY group_id', policyId).map((r) => r.group_id);

/** Compromise policies for a role or group the person has, nested groups included. */
function policiesFor(userId) {
  const roleIds = new Set(roles.effectiveRoleIds(userId));
  const groupIds = new Set(effectiveGroupsOf(userId).map((g) => g.id));
  return db.all('SELECT * FROM compromise_policies WHERE everyone = 0 ORDER BY name COLLATE NOCASE')
    .map((p) => ({ ...p, group_ids: groupIdsOf(p.id) }))
    .filter((p) => (p.role_id !== null && roleIds.has(p.role_id)) || p.group_ids.some((g) => groupIds.has(g)));
}

/**
 * The procedure that applies to a person: which steps run, the network lists sign-in must match, and the policies it came from.
 */
function effectiveFor(userId) {
  const base = everyonePolicy() || { ...DEFAULT_ROW, name: DEFAULT_NAME };
  const applied = policiesFor(userId);
  const rows = [base, ...applied];
  // Each policy that adds to a group names its own; the person is added to all of them.
  const groupIds = [...new Set(rows.filter((r) => r.add_to_group && r.add_to_group_id).map((r) => r.add_to_group_id))];
  const groups = groupIds.map((id) => db.get('SELECT id, name FROM groups WHERE id = ?', id)).filter(Boolean);
  return {
    steps: Object.fromEntries(STEP_KEYS.map((k) => [k, k === 'add_to_group' ? groups.length > 0 : rows.some((r) => r[k])])),
    groups,
    networks: rows.map((r) => parseList(r.restrict_networks)).filter((l) => l.length),
    sources: [base.name, ...applied.map((p) => p.name)],
  };
}

const policyView = (p) => {
  const groups = p.everyone || p.role_id !== null ? [] : db.all('SELECT g.id, g.name FROM compromise_policy_groups pg JOIN groups g ON g.id = pg.group_id WHERE pg.policy_id = ? ORDER BY g.name', p.id);
  return {
  id: p.id,
  name: p.name,
  description: p.description,
  subject_type: p.everyone ? 'everyone' : p.role_id !== null ? 'role' : 'group',
  subject_id: p.role_id ?? groups[0]?.id ?? null,
  subject_name: p.role_name ?? (groups.length ? groups.map((g) => g.name).join(', ') : null),
  group_ids: groups.map((g) => g.id),
  groups,
  ...Object.fromEntries(STEP_KEYS.map((k) => [k, Boolean(p[k])])),
  add_to_group_id: p.add_to_group_id ?? null,
  add_to_group_name: p.add_to_group_name ?? null,
  restrict_networks: parseList(p.restrict_networks),
  };
};

const POLICY_SQL = `SELECT c.*, r.name AS role_name, ag.name AS add_to_group_name FROM compromise_policies c
                    LEFT JOIN roles r ON r.id = c.role_id LEFT JOIN groups ag ON ag.id = c.add_to_group_id`;
const policyById = (id) => db.get(`${POLICY_SQL} WHERE c.id = ?`, Number(id));
const listPolicies = () => db.all(`${POLICY_SQL} ORDER BY c.everyone DESC, c.name COLLATE NOCASE`).map(policyView);

/** Checks a policy as the console submits it. Returns { errors, data } where data holds the columns to store. */
function parsePolicy(body, existing = null) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX) errors.push(`Name the policy (up to ${NAME_MAX} characters).`);
  else if (db.get('SELECT 1 FROM compromise_policies WHERE name = ? COLLATE NOCASE AND id != ?', name, existing ? existing.id : 0)) {
    errors.push('Another compromised account policy already has that name.');
  }
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > DESCRIPTION_MAX) errors.push(`The description can be at most ${DESCRIPTION_MAX} characters.`);

  const type = body.subject_type;
  let roleId = null; let groupIds = [];
  if (type === 'role') {
    roleId = Number(body.subject_id);
    if (!db.get('SELECT 1 FROM roles WHERE id = ?', roleId)) errors.push('Choose a role for this policy.');
  } else if (type === 'group') {
    // `group_ids` is the list; a lone `subject_id` still works.
    const asked = Array.isArray(body.group_ids) ? body.group_ids : [body.subject_id];
    groupIds = [...new Set(asked.map(Number))];
    if (!groupIds.length || !groupIds.every((id) => db.get('SELECT 1 FROM groups WHERE id = ?', id))) {
      errors.push('Choose at least one group for this policy.');
      groupIds = [];
    }
  } else if (type !== 'everyone') errors.push('Choose who the policy applies to.');
  if (type === 'everyone' && db.get('SELECT 1 FROM compromise_policies WHERE everyone = 1 AND id != ?', existing ? existing.id : 0)) {
    errors.push('There is already a policy for everyone. Edit it instead.');
  }
  if (type === 'role' && roleId && db.get('SELECT 1 FROM compromise_policies WHERE role_id = ? AND id != ?', roleId, existing ? existing.id : 0)) {
    errors.push('Another compromised account policy already applies to that role.');
  }

  const networks = parseNetworks(Array.isArray(body.restrict_networks) ? body.restrict_networks.join('\n') : body.restrict_networks);
  errors.push(...networks.errors);
  const data = { name, description, everyone: type === 'everyone' ? 1 : 0, role_id: roleId, groupIds, restrict_networks: networks.networks.join('\n') };
  // A step the request leaves out is on for the Everyone policy (the default) and off for a role or group policy, which only adds steps.
  // Adding to a group is never on unless asked for, because it cannot run without a group.
  for (const k of STEP_KEYS) data[k] = (body[k] === undefined ? type === 'everyone' && k !== 'add_to_group' : body[k] === true) ? 1 : 0;
  const target = body.add_to_group_id === undefined || body.add_to_group_id === null || body.add_to_group_id === '' ? null : Number(body.add_to_group_id);
  data.add_to_group_id = null;
  if (data.add_to_group) {
    const g = target && db.get('SELECT id, source FROM groups WHERE id = ?', target);
    if (!g) errors.push('Choose the group to add people to, or turn off "Add to a group".');
    else if (g.source !== 'local') errors.push('Choose a group managed in the console. Groups provisioned by another system cannot be changed here.');
    else data.add_to_group_id = g.id;
  }
  return { errors, data };
}

const POLICY_COLUMNS = ['name', 'description', 'everyone', 'role_id', ...STEP_KEYS, 'add_to_group_id', 'restrict_networks'];

function savePolicy(data, id = null) {
  const cols = POLICY_COLUMNS;
  return db.tx(() => {
    let policyId = id;
    if (id === null) {
      policyId = Number(db.run(`INSERT INTO compromise_policies (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => data[c])).lastInsertRowid);
    } else {
      db.run(`UPDATE compromise_policies SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => data[c]), Number(id));
      policyId = Number(id);
    }
    // Add before removing, so the policy is never without a group part way through (which would delete it).
    for (const g of data.groupIds) db.run('INSERT OR IGNORE INTO compromise_policy_groups (policy_id, group_id) VALUES (?, ?)', policyId, g);
    db.run(`DELETE FROM compromise_policy_groups WHERE policy_id = ? AND group_id NOT IN (${data.groupIds.map(() => '?').join(',') || 'NULL'})`, policyId, ...data.groupIds);
    return policyId;
  });
}

const deletePolicy = (id) => db.run('DELETE FROM compromise_policies WHERE id = ?', Number(id)).changes > 0;

/* ------------------------------ Lockdowns ------------------------------ */

const lockdownRow = (userId) => db.get('SELECT * FROM account_lockdowns WHERE user_id = ?', Number(userId));

const lockdownView = (row) => (row ? {
  started_at: row.started_at,
  started_by: row.started_by,
  policy_names: JSON.parse(row.policy_names || '[]'),
  networks: JSON.parse(row.networks || '[]'),
  locked_account: Boolean(row.locked_account),
} : null);

/** The lockdown in force for a person, or null. */
const lockdownFor = (userId) => lockdownRow(userId) || null;

/** What the person's page shows: the procedure that applies, and the lockdown in force if any. */
function userView(userId) {
  const plan = effectiveFor(userId);
  return {
    plan: {
      steps: STEPS.filter((s) => plan.steps[s.key]).map(({ key, label, detail }) => ({ key, label, detail })),
      networks: plan.networks,
      sources: plan.sources,
    },
    lockdown: lockdownView(lockdownRow(userId)),
  };
}

/**
 * Removes every sign-in method the person has (the authenticator and any other factor) and requires them to set one up at their
 * next sign-in. Returns how many were removed.
 */
function resetAuthenticators(userId) {
  return db.tx(() => {
    db.run("UPDATE users SET totp_secret = '', totp_enabled = 0, totp_last_step = 0, mfa_enabled = 1 WHERE id = ?", Number(userId));
    return db.run('DELETE FROM user_factors WHERE user_id = ?', Number(userId)).changes;
  });
}

/**
 * Records (or replaces the networks of) a lockdown. `lock` turns the account off, unless it was already off, in which case the
 * lockdown does not take credit for it. Signs the person out too. Returns the lockdown view.
 */
function restrict(userId, { networks = [], lock = false, now = new Date().toISOString() } = {}) {
  return db.tx(() => {
    const user = db.get('SELECT id, active FROM users WHERE id = ?', Number(userId));
    const existing = lockdownRow(userId);
    const lockedAccount = existing ? existing.locked_account : 0;
    let locked = lockedAccount;
    if (lock && user.active) {
      db.run('UPDATE users SET active = 0 WHERE id = ?', user.id);
      locked = 1;
    }
    const lists = networks.filter((list) => list.length);
    const policyNames = JSON.stringify(effectiveFor(userId).sources);
    if (existing) {
      db.run('UPDATE account_lockdowns SET networks = ?, policy_names = ?, locked_account = ? WHERE user_id = ?', JSON.stringify(lists), policyNames, locked, user.id);
    } else {
      db.run('INSERT INTO account_lockdowns (user_id, started_at, started_by, policy_names, networks, locked_account) VALUES (?,?,?,?,?,?)',
        user.id, now, '', policyNames, JSON.stringify(lists), locked);
    }
    userService.revokeSessions(user.id);
    return lockdownView(lockdownRow(userId));
  });
}

/** Sets who started the lockdown. Kept apart so the caller can record the actor it knows (a console user or an integration). */
const setStartedBy = (userId, name) => db.run('UPDATE account_lockdowns SET started_by = ? WHERE user_id = ?', String(name || ''), Number(userId));

/**
 * Runs the built-in lockdown integration for one account and waits for it to end. `actor` is the audit actor (the console user, or the
 * API token); `via` says which door was used ('console' or 'user-api'). Writes one `user.lockdown` audit row for the call, which is what
 * the "account locked down" integration event listens for. Returns { ok, run, error }, or { error } when it cannot run.
 */
async function runLockdown(target, { actor, via }) {
  // Loaded here: integrations/host.js requires this module, so a top-level require would be circular.
  const integrations = require('./integrations');
  const row = db.get('SELECT * FROM integrations WHERE builtin = ?', LOCKDOWN_INTEGRATION);
  if (!row) return { error: 'The Compromised account lockdown integration is missing. Restore it under Integrations.' };
  if (!row.enabled) return { error: 'Turn on the Compromised account lockdown integration before locking down an account.' };
  const { outcome, run } = await integrations.execute(row, { input: { username: target.username }, trigger: via === 'user-api' ? 'api' : 'manual', actor: actor.name });
  setStartedBy(target.id, actor.name);
  const error = outcome.error ? outcome.error.message : null;
  auditLog.admin('user.lockdown', {
    actor, outcome: outcome.status === 'ok' ? 'success' : 'failure', target: { type: 'user', id: target.id, name: target.username },
    detail: { via, run: run.id, status: outcome.status, sources: effectiveFor(target.id).sources, ...(error ? { error } : {}) },
  });
  return { ok: outcome.status === 'ok', run, error };
}

/** Ends a lockdown. Turns the account back on if the lockdown was the thing that turned it off. Returns { reactivated }, or null if none. */
function endLockdown(userId) {
  const row = lockdownRow(userId);
  if (!row) return null;
  return db.tx(() => {
    if (row.locked_account) db.run('UPDATE users SET active = 1 WHERE id = ?', row.user_id);
    db.run('DELETE FROM account_lockdowns WHERE user_id = ?', row.user_id);
    return { reactivated: Boolean(row.locked_account) };
  });
}

module.exports = {
  STEPS, STEP_KEYS, LOCKDOWN_INTEGRATION, NAME_MAX, DESCRIPTION_MAX,
  parseNetworks, parseList, inList, allowedFrom,
  everyonePolicy, policiesFor, effectiveFor, listPolicies, policyById, policyView, parsePolicy, savePolicy, deletePolicy,
  lockdownFor, lockdownView, userView, resetAuthenticators, restrict, setStartedBy, runLockdown, endLockdown,
  forgetRemembered: (userId) => mfaRemember.forget(userId),
};
