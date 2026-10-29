const db = require('./db');
const roles = require('./roles');
const { hashPassword } = require('./crypto');
const userService = require('./user-service');
const { isSubset } = require('./permissions');
const appSettings = require('./app-settings');
const { effectiveGroupsOf } = require('./group-membership');

// A guest is an account that one person (the host) has invited. It signs in like anyone else but holds no permissions
// unless the host gives it roles, and then only what the host holds themselves (roles.permissionsOf applies the cap).
// Guests cannot host guests.

const DEFAULT_GUEST_LIMIT = 25;
const MAX_GUEST_LIMIT = 1000;

// Only members of the groups an administrator chose (settings 'guests') may host, each group with the most guests its members may have.
// With none chosen, nobody may. A person in several chosen groups gets the largest of their limits.
const DEFAULT_MAX_DAYS = 14;
function settings() {
  const saved = appSettings.read('guests') || {};
  // Settings saved before limits existed listed just the groups; they get the default limit.
  const hostGroups = saved.hostGroups || (saved.hostGroupIds || []).map((id) => ({ id, maxGuests: DEFAULT_GUEST_LIMIT }));
  return { hostGroups, maxDays: saved.maxDays ?? DEFAULT_MAX_DAYS };
}
function parseSettings(body) {
  const errors = [];
  const seen = new Set();
  const hostGroups = [];
  for (const g of Array.isArray(body.hostGroups) ? body.hostGroups : []) {
    const id = Number(g && g.id);
    const maxGuests = Number(g && g.maxGuests === undefined ? DEFAULT_GUEST_LIMIT : g && g.maxGuests);
    if (!Number.isInteger(id) || !db.get('SELECT 1 FROM groups WHERE id = ?', id)) { errors.push('One of the chosen groups does not exist.'); continue; }
    if (!Number.isInteger(maxGuests) || maxGuests < 1 || maxGuests > MAX_GUEST_LIMIT) {
      errors.push(`The number of guests for "${db.get('SELECT name FROM groups WHERE id = ?', id).name}" must be between 1 and ${MAX_GUEST_LIMIT}.`);
    }
    if (!seen.has(id)) hostGroups.push({ id, maxGuests });
    seen.add(id);
  }
  const maxDays = Number(body.maxDays === undefined ? DEFAULT_MAX_DAYS : body.maxDays);
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 3650) errors.push('The longest a guest may be given must be between 1 and 3650 days.');
  return { data: { hostGroups, maxDays }, errors };
}
const saveSettings = (data) => appSettings.write('guests', data);

// How many guests this person may have: 0 unless they are an active account that is not a guest and is in (directly or through
// nesting) a chosen group, then the largest limit among those groups.
function guestLimit(user) {
  if (!user || !user.active || user.host_id) return 0;
  const limits = new Map(settings().hostGroups.map((g) => [g.id, g.maxGuests]));
  return Math.max(0, ...effectiveGroupsOf(user.id).map((g) => limits.get(g.id) || 0));
}
const canHost = (user) => guestLimit(user) > 0;

const hostOf = (userId) => db.get('SELECT h.* FROM users u JOIN users h ON h.id = u.host_id WHERE u.id = ?', userId) || null;
const isGuest = (user) => Boolean(user && user.host_id);
// A guest with no expiry (which only an account from before expiry existed can be) counts as expired.
const expired = (user, now = Date.now()) => Boolean(user && user.host_id && !(Date.parse(user.expires_at) > now));

// Why an expiry cannot be used, or null: it must be a date in the future and within the longest an administrator allows.
function expiryError(value, now = Date.now()) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) return 'Choose when the guest account expires.';
  if (t <= now) return 'The expiry must be in the future.';
  const max = settings().maxDays;
  if (t > now + max * 86400000) return `A guest account can last at most ${max} days.`;
  return null;
}
const guestsOf = (hostId) => db.all('SELECT * FROM users WHERE host_id = ? ORDER BY username', hostId);

// The roles a host may give a guest: those whose permissions the host holds in full.
function assignableRoles(hostId) {
  const mine = roles.permissionsOf(hostId);
  return db.all('SELECT id, key, name, description FROM roles ORDER BY name')
    .filter((r) => isSubset(roles.rolePermissions(r), mine));
}

function roleErrors(hostId, roleIds) {
  const ok = new Set(assignableRoles(hostId).map((r) => r.id));
  return roleIds.filter((id) => !ok.has(id)).map((id) => {
    const r = db.get('SELECT name FROM roles WHERE id = ?', id);
    return r ? `You cannot give a guest the "${r.name}" role because it carries permissions you do not have.` : 'No such role.';
  });
}

function setRoles(guestId, roleIds) {
  db.run('DELETE FROM user_roles WHERE user_id = ?', guestId);
  for (const id of roleIds) db.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', guestId, id);
}

// A guest's view: what they are, and what they can actually do right now.
function view(g) {
  return {
    id: g.id, username: g.username, display_name: g.display_name, email: g.email, active: Boolean(g.active),
    created_at: g.created_at, expires_at: g.expires_at, expired: expired(g), role_ids: roles.roleIds(g.id), permissions: [...roles.permissionsOf(g.id)].sort(),
  };
}

// Makes a guest of `host`; `spec` is { fields (USER_FIELDS), password, roleIds, expiresAt }. Returns the new id.
function create(host, spec, by) {
  return db.tx(() => userService.insertUser(
    { fields: spec.fields, active: true, passwordHash: hashPassword(spec.password), emails: spec.email ? [{ email: spec.email, primary: true }] : [] },
    { by, via: 'admin' },
    (id) => {
      db.run('UPDATE users SET host_id = ?, expires_at = ? WHERE id = ?', host.id, new Date(spec.expiresAt).toISOString(), id);
      setRoles(id, spec.roleIds);
    }));
}

// Turns off every guest whose time is up and ends their sessions, so sign-in methods that only look at `active` (CAS, tokens, the
// console) stop too. Returns how many were turned off. Extending an expired guest turns them back on (routes/guests.js).
function expireGuests(now = Date.now()) {
  const due = db.all('SELECT id, host_id, expires_at FROM users WHERE host_id IS NOT NULL AND active = 1').filter((u) => expired(u, now));
  for (const u of due) {
    db.run('UPDATE users SET active = 0 WHERE id = ?', u.id);
    userService.revokeSessions(u.id);
  }
  return due.length;
}

function startExpiryJob(intervalMs = 60000) {
  const tick = () => {
    try { expireGuests(); } catch (err) { console.error('Guest expiry failed:', err.message); }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { expireGuests, startExpiryJob, expired, expiryError, settings, parseSettings, saveSettings, canHost, guestLimit, DEFAULT_GUEST_LIMIT, hostOf, isGuest, guestsOf, assignableRoles, roleErrors, setRoles, view, create };
