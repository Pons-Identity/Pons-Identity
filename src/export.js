const db = require('./db');
const { baseUrl } = require('./config');
const pkg = require('../package.json');

// Data export for the console: configuration, users, groups (with their folders and nesting) and integrations, as one JSON
// document or a zip of one file per part. It is a way out and a way to review, not a backup: password hashes, second-factor
// secrets, private keys, client secrets, tokens and the values of secret variables are never included, so an export can be
// handed to someone without handing over the ability to sign in.

const FORMAT = 'simpleidp-export';
const VERSION = 1;
const PARTS = ['config', 'users', 'groups', 'integrations'];

// Settings that are keys or bookkeeping rather than configuration.
const SKIP_SETTINGS = new Set(['session_secret', 'oidc_signing_key', 'sftp_host_key', 'federation_keys', 'federation_sp_keys', 'builtin_roles_seeded',
  'grouper_activity', 'grouper_push_last', 'integration_builtins', 'geoip', 'setup']);
const SECRET_KEY = /(secret|password|passphrase|token|private|credential|apikey|api_key|accesskey|access_key|signingkey|bindpw|^key$|integrationkey|ikey|skey|pem$)/i;
const REDACTED = '[not exported]';

/** A copy of a value with anything that looks like a secret replaced. Strings that parse as JSON are looked into too. */
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && x ? REDACTED : scrub(x)]));
  return v;
}
const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const omit = (row, ...keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k) && !SECRET_KEY.test(k) && !/_hash$/.test(k)));
const groupName = (id) => { const g = db.get('SELECT name FROM groups WHERE id = ?', id); return g ? g.name : null; };

function config() {
  const settings = {};
  for (const r of db.all('SELECT key, value FROM settings ORDER BY key')) if (!SKIP_SETTINGS.has(r.key)) settings[r.key] = scrub(parse(r.value, r.value));
  const roleName = (id) => { const r = db.get('SELECT key FROM roles WHERE id = ?', id); return r ? r.key : null; };
  return {
    settings,
    roles: db.all('SELECT * FROM roles ORDER BY id').map((r) => ({ key: r.key, name: r.name, description: r.description,
      permissions: db.all('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission', r.id).map((p) => p.permission) })),
    attribute_defs: db.all('SELECT * FROM attribute_defs ORDER BY name'),
    password_policies: db.all('SELECT * FROM password_policies ORDER BY name').map((p) => omit(p, 'id')),
    policies: db.all('SELECT * FROM policies ORDER BY name').map((p) => ({ ...omit(p, 'id', 'role_id'), role: p.role_id ? roleName(p.role_id) : null, groups: db.all('SELECT group_id FROM policy_groups WHERE policy_id = ?', p.id).map((g) => groupName(g.group_id)).filter(Boolean).sort() })),
    compromise_policies: db.all('SELECT * FROM compromise_policies ORDER BY name').map((p) => ({ ...omit(p, 'id', 'role_id', 'add_to_group_id'), role: p.role_id ? roleName(p.role_id) : null, groups: db.all('SELECT group_id FROM compromise_policy_groups WHERE policy_id = ?', p.id).map((g) => groupName(g.group_id)).filter(Boolean).sort() })),
    service_providers: db.all('SELECT * FROM service_providers ORDER BY name').map((s) => ({
      ...omit(s, 'private_key_pem', 'cert_pem'), acs_urls: parse(s.acs_urls, []), transform_temp_attrs: parse(s.transform_temp_attrs, []),
      attribute_map: db.all('SELECT idp_attribute, saml_name FROM sp_attribute_map WHERE sp_id = ? ORDER BY id', s.id),
      static_attributes: db.all('SELECT name, value FROM sp_static_attributes WHERE sp_id = ? ORDER BY id', s.id),
      role_attributes: db.all('SELECT saml_name, group_id, role_value FROM sp_role_attributes WHERE sp_id = ? ORDER BY id', s.id).map((r) => ({ saml_name: r.saml_name, group: groupName(r.group_id), role_value: r.role_value })),
      access_groups: db.all('SELECT group_id FROM sp_access_groups WHERE sp_id = ?', s.id).map((g) => groupName(g.group_id)).filter(Boolean),
    })),
    apps: db.all('SELECT * FROM apps ORDER BY name').map((a) => ({
      ...omit(a), redirect_uris: parse(a.redirect_uris, []), post_logout_uris: parse(a.post_logout_uris, []), grant_types: parse(a.grant_types, []), scopes: parse(a.scopes, []),
      confidential: Boolean(a.client_secret_hash),
      attribute_map: db.all('SELECT idp_attribute, claim_name FROM app_attribute_map WHERE app_id = ? ORDER BY id', a.id),
      access_groups: db.all('SELECT group_id FROM app_access_groups WHERE app_id = ?', a.id).map((g) => groupName(g.group_id)).filter(Boolean),
    })),
    directories: db.all('SELECT * FROM directories ORDER BY name').map((d) => ({ ...omit(d, 'id', 'config'), config: scrub(parse(d.config, {})) })),
  };
}

function users() {
  const rolesOf = db.db.prepare('SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.key');
  const groupsOf = db.db.prepare('SELECT g.name, m.start_at, m.end_at FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name');
  const attrs = db.db.prepare('SELECT name, value FROM user_attributes WHERE user_id = ? ORDER BY name');
  const emails = db.db.prepare('SELECT email, is_primary FROM user_emails WHERE user_id = ? ORDER BY is_primary DESC, id');
  const hidden = ['id', 'password_hash', 'totp_secret', 'totp_last_step', 'totp_enabled', 'password_changed_by', 'host_id'];
  return db.all('SELECT * FROM users ORDER BY username').map((u) => ({
    ...omit(u, ...hidden),
    emails: emails.all(u.id).map((e) => ({ email: e.email, primary: Boolean(e.is_primary) })),
    attributes: Object.fromEntries(attrs.all(u.id).map((a) => [a.name, a.value])),
    roles: rolesOf.all(u.id).map((r) => r.key),
    groups: groupsOf.all(u.id).map((g) => ({ name: g.name, start_at: g.start_at || null, end_at: g.end_at || null })),
  }));
}

function groups() {
  const folderPath = (id) => { const names = []; for (let f = id && db.get('SELECT * FROM group_folders WHERE id = ?', id); f; f = f.parent_id && db.get('SELECT * FROM group_folders WHERE id = ?', f.parent_id)) names.unshift(f.name); return names.join('/'); };
  const pairs = db.all('SELECT * FROM group_include_exclude');
  const owned = new Map();
  for (const p of pairs) { owned.set(p.include_id, 'include'); owned.set(p.exclude_id, 'exclude'); }
  const out = db.all('SELECT * FROM groups ORDER BY name').map((g) => {
    const composite = db.get('SELECT * FROM group_composites WHERE group_id = ?', g.id);
    const rule = db.get('SELECT filter, mode FROM group_rules WHERE group_id = ?', g.id);
    const pair = pairs.find((p) => p.group_id === g.id);
    return {
      name: g.name, description: g.description, source: g.source || 'local', folder: folderPath(g.folder_id), system_group: owned.get(g.id) || null,
      members: db.all('SELECT u.username, m.start_at, m.end_at FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.username', g.id)
        .map((m) => ({ username: m.username, start_at: m.start_at || null, end_at: m.end_at || null })),
      includes: db.all('SELECT member_group_id FROM group_includes WHERE group_id = ?', g.id).map((i) => groupName(i.member_group_id)).filter(Boolean).sort(),
      composite: composite ? { op: composite.op, left: groupName(composite.left_id), right: groupName(composite.right_id) } : null,
      include_exclude: pair ? { include: groupName(pair.include_id), exclude: groupName(pair.exclude_id) } : null,
      rule: rule || null,
    };
  });
  const folders = db.all('SELECT * FROM group_folders ORDER BY id').map((f) => ({ path: folderPath(f.id), description: f.description, position: f.position }));
  return { folders, groups: out };
}

/** Integrations, functions and variables, in the shape the Git tool writes as files. Secret values are left out; their names are kept. */
function integrations() {
  const list = db.all('SELECT * FROM integrations ORDER BY name').map((i) => ({
    id: i.id, name: i.name, description: i.description, enabled: Boolean(i.enabled), builtin: i.builtin || '', scopes: i.scopes.split(' ').filter(Boolean),
    timeout_seconds: i.timeout_seconds, inputs: parse(i.inputs, []), event_inputs: parse(i.event_inputs, []), events: i.events.split(' ').filter(Boolean),
    schedules: db.all('SELECT schedule FROM integration_schedules WHERE integration_id = ? ORDER BY id', i.id).map((s) => parse(s.schedule, {})),
    run_groups: db.all('SELECT g.name FROM integration_run_groups x JOIN groups g ON g.id = x.group_id WHERE x.integration_id = ? ORDER BY g.name', i.id).map((g) => g.name),
    file_dirs: parse(i.file_dirs, []), logging: parse(i.logging, null), api_enabled: Boolean(i.api_enabled), webhook: Boolean(i.webhook_token_hash), script: i.script,
  }));
  const fns = db.all('SELECT * FROM integration_functions ORDER BY name').map((f) => ({ name: f.name, description: f.description, inputs: parse(f.inputs, []), script: f.script }));
  const vars = db.all('SELECT * FROM integration_variables ORDER BY name').map((v) => ({ name: v.name, description: v.description, secret: Boolean(v.secret), value: v.secret ? '' : v.value }));
  return { integrations: list, functions: fns, variables: vars };
}

const PART = { config, users, groups, integrations };

/** The export document for the chosen parts, each of which the caller has already checked the person may see. */
function build(parts, by) {
  const chosen = PARTS.filter((p) => parts.includes(p));
  const doc = { format: FORMAT, version: VERSION, exported_at: new Date().toISOString(), exported_by: by || '', product_version: pkg.version, base_url: baseUrl, parts: chosen };
  for (const p of chosen) doc[p] = PART[p]();
  return doc;
}

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// A cell that a spreadsheet would run as a formula is prefixed so it opens as text.
const safeCell = (v) => { const s = csvCell(v); return /^[=+\-@\t\r]/.test(String(v ?? '')) ? csvCell(`'${v}`) : s; };

function usersCsv(list) {
  const cols = ['username', 'first_name', 'last_name', 'display_name', 'email', 'employee_id', 'department', 'title', 'phone', 'mobile', 'upn', 'sam_account_name', 'company', 'manager', 'office', 'city', 'state', 'country', 'active', 'groups', 'roles'];
  const rows = list.map((u) => cols.map((c) => (c === 'groups' ? u.groups.map((g) => g.name).join(';') : c === 'roles' ? u.roles.join(';') : c === 'active' ? (u.active ? 'true' : 'false') : u[c])).map(safeCell).join(','));
  return `${[cols.join(','), ...rows].join('\r\n')}\r\n`;
}

/** The parts as named files for a zip. */
function files(doc) {
  const out = { 'export.json': `${JSON.stringify(doc, null, 2)}\n` };
  for (const p of doc.parts) out[`${p}.json`] = `${JSON.stringify(doc[p], null, 2)}\n`;
  if (doc.users) out['users.csv'] = usersCsv(doc.users);
  return out;
}

module.exports = { build, files, usersCsv, PARTS, FORMAT, VERSION, config, users, groups, integrations };
