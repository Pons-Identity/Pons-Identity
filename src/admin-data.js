const db = require('./db');
const { addDirect } = require('./group-membership');

// Helpers shared by the admin HTML routes (routes/admin.js) and the JSON API (routes/api.js).

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const toArr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const USER_FIELDS = ['username', 'first_name', 'last_name', 'display_name', 'email', 'employee_id', 'department', 'title', 'phone',
  // Active Directory style attributes
  'upn', 'sam_account_name', 'distinguished_name', 'mail_nickname', 'company', 'manager', 'office', 'mobile',
  'street_address', 'city', 'state', 'postal_code', 'country', 'description'];

function parseCustom(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out.filter(([k, v]) => k && v);
}

// Defined attributes are edited as typed fields, so the free-form text holds only the undefined ones.
const customText = (id) => db.all('SELECT name, value FROM user_attributes WHERE user_id = ? AND name NOT IN (SELECT name FROM attribute_defs) ORDER BY name', id)
  .map((r) => `${r.name}=${r.value}`).join('\n');

function readUser(body) {
  const d = Object.fromEntries(USER_FIELDS.map((f) => [f, str(body[f])]));
  d.mfa_enabled = body.mfa_enabled ? 1 : 0;
  d.active = body.active ? 1 : 0;
  if (!d.display_name) d.display_name = `${d.first_name} ${d.last_name}`.trim();
  return d;
}

function saveMemberships(userId, body) {
  // Grouper-provisioned groups are read-only here: keep their memberships and ignore them in the submitted list.
  // Memberships that stay are left as they are, so their start and end dates survive editing the user. Composite
  // groups take their members from their factors, so they are never given direct ones.
  const wanted = new Set(toArr(body.group_ids).map(Number));
  for (const m of db.all(`SELECT group_id FROM group_members WHERE user_id = ?
                          AND group_id IN (SELECT id FROM groups WHERE source = 'local')`, userId)) {
    if (!wanted.has(m.group_id)) db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', m.group_id, userId);
  }
  for (const g of wanted) {
    const eligible = db.get(`SELECT 1 FROM groups WHERE id = ? AND source = 'local'
                             AND id NOT IN (SELECT group_id FROM group_composites)`, g);
    if (eligible) addDirect(g, userId);
  }
}

function saveRoles(userId, body) {
  db.run('DELETE FROM user_roles WHERE user_id = ?', userId);
  for (const r of toArr(body.role_ids)) {
    db.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE id = ?', userId, Number(r));
  }
}

// `defined` holds the resolved values of defined attributes ({ name: value }, '' clears); defined attributes not in it
// keep what they have, and a defined name typed into the free-form text is ignored.
function saveCustom(userId, text, defined = {}) {
  db.run('DELETE FROM user_attributes WHERE user_id = ? AND name NOT IN (SELECT name FROM attribute_defs)', userId);
  for (const [k, v] of parseCustom(text)) {
    db.run('INSERT OR IGNORE INTO user_attributes (user_id, name, value) SELECT ?, ?, ? WHERE ? NOT IN (SELECT name FROM attribute_defs)', userId, k, v, k);
  }
  for (const [k, v] of Object.entries(defined)) {
    if (v) db.run('INSERT OR REPLACE INTO user_attributes (user_id, name, value) VALUES (?,?,?)', userId, k, v);
    else db.run('DELETE FROM user_attributes WHERE user_id = ? AND name = ?', userId, k);
  }
}

module.exports = { str, toArr, USER_FIELDS, customText, readUser, saveMemberships, saveRoles, saveCustom };
