const crypto = require('crypto');
const db = require('../db');
const auditLog = require('../audit');
const gm = require('../group-membership');
const ieGroups = require('../group-include-exclude');
const { audit: auditGroup } = require('../group-audit');
const { groupErrors } = require('../group-naming');
const { USER_FIELDS } = require('../admin-data');
const userService = require('../user-service');
const sps = require('../sps');
const apps = require('../apps');
const { hashPassword } = require('../crypto');
const appSettings = require('../app-settings');
const common = require('./common');
const shib = require('./shibboleth');
const okta = require('./okta');
const ms = require('./microsoft');

// Migration from other identity providers: the administrator uploads what they exported, we say what we found (preview), and
// only after they agree is anything written (apply). Uploaded files and previews live in memory for a short while, per person,
// and are never written to disk.

// What each source asks for: one slot per file, so a file's meaning comes from the slot it was uploaded to. `needed` slots are
// what a useful import starts from; `many` slots take several files (metadata often comes as one file per service provider).
// `docs` is the help article that explains where to find each file.
const SOURCES = [
  { id: 'shibboleth', label: 'Shibboleth IdP', docs: 'migrate-from-shibboleth', slots: [
    { kind: 'saml-metadata', label: 'Service provider metadata', needed: true, many: true,
      help: 'Describes each service provider: its entity ID, where it receives sign-ins, and its signing certificate.',
      where: 'conf/metadata-providers.xml lists the metadata files and web addresses this IdP trusts. For a web address, open it in your browser and save the page as an .xml file.' },
    { kind: 'shib-attribute-resolver', label: 'Attribute resolver', help: 'Names each attribute the IdP can release, and the SAML name it is sent under.',
      where: 'conf/attribute-resolver.xml' },
    { kind: 'shib-attribute-filter', label: 'Attribute filter', help: 'Says which attributes each service provider receives.',
      where: 'conf/attribute-filter.xml' },
    { kind: 'shib-relying-party', label: 'Relying party settings', help: 'Signing and encryption choices for particular service providers (IdP 3 and later).',
      where: 'conf/relying-party.xml' },
    { kind: 'shib-properties', label: 'IdP and LDAP properties', many: true, help: 'The IdP entity ID and the directory people sign in against. Used for notes; nothing is copied from it.',
      where: 'conf/idp.properties, and conf/ldap.properties for the directory settings.' },
  ] },
  { id: 'okta', label: 'Okta', docs: 'migrate-from-okta', slots: [
    { kind: 'okta-users', label: 'Users', needed: true, help: 'Every user, with their login, name, email and status.',
      where: 'Admin console: Directory, then People, then More actions, then Export (CSV). Or the JSON from GET /api/v1/users.' },
    { kind: 'okta-groups', label: 'Groups', help: 'Groups, and their members if the file lists them.',
      where: 'The JSON from GET /api/v1/groups. Join the pages into one list first (see the guide).' },
    { kind: 'okta-apps', label: 'Applications', help: 'Your applications and how each one signs people in.',
      where: 'The JSON from GET /api/v1/apps. Join the pages into one list first (see the guide).' },
  ] },
  { id: 'microsoft', label: 'Microsoft (Entra ID, AD FS, Active Directory)', docs: 'migrate-from-microsoft', slots: [
    { kind: 'ms-users', label: 'Users', needed: true, many: true, help: 'Every user, with their sign-in name, email and details. Entra and Active Directory both work here.',
      where: 'Entra admin center: Users, then Bulk operations, then Bulk download (CSV). For Active Directory, see the guide for the PowerShell command.' },
    { kind: 'ms-groups', label: 'Groups', many: true, help: 'Groups, their members, and the groups nested inside them.',
      where: 'The JSON from Microsoft Graph (GET /v1.0/groups?$expand=members), or the Active Directory export from the guide.' },
    { kind: 'entra-service-principals', label: 'Enterprise applications', help: 'The applications that sign people in with Entra ID.',
      where: 'The JSON from Microsoft Graph (GET /v1.0/servicePrincipals).' },
    { kind: 'entra-applications', label: 'App registrations', help: 'Applications registered in Entra ID, with their redirect URIs.',
      where: 'The JSON from Microsoft Graph (GET /v1.0/applications).' },
    { kind: 'adfs-trusts', label: 'AD FS relying party trusts', help: 'The applications AD FS signs people in for.',
      where: 'On the AD FS server, in PowerShell: Get-AdfsRelyingPartyTrust | ConvertTo-Json -Depth 5 | Out-File adfs-trusts.json' },
  ] },
];
const SLOT_OF = new Map(SOURCES.flatMap((s) => s.slots.map((slot) => [slot.kind, { ...slot, source: s.id }])));
const KIND_LABELS = Object.fromEntries([...SLOT_OF].map(([kind, slot]) => [kind, slot.label]));

const MAX_FILE = 25 * 1024 * 1024;
const MAX_OWNER_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 50;
const KEEP_MS = 60 * 60 * 1000;
const LIST_CAP = 1000;

const staged = new Map(); // owner -> Map(fileId -> { name, text, bytes, at })
const plans = new Map(); // `${owner}/${planId}` -> { bundle, at, source, fileIds }

const prune = () => {
  const cut = Date.now() - KEEP_MS;
  for (const [o, files] of staged) { for (const [id, f] of files) if (f.at < cut) files.delete(id); if (!files.size) staged.delete(o); }
  for (const [k, p] of plans) if (p.at < cut) plans.delete(k);
};

// PowerShell writes UTF-16 files by default; everything else is UTF-8.
function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

/** Keeps one uploaded file, for the slot `kind`, for a later preview. Returns { id } or { error }. */
function stage(owner, name, buf, kind) {
  prune();
  if (!SLOT_OF.has(kind)) return { error: 'Choose which file this is before uploading it.' };
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'The file is empty.' };
  if (buf.length > MAX_FILE) return { error: `Files can be at most ${MAX_FILE / 1024 / 1024} MB.` };
  const files = staged.get(owner) || new Map();
  if (files.size >= MAX_FILES) return { error: `At most ${MAX_FILES} files at a time.` };
  if ([...files.values()].reduce((n, f) => n + f.bytes, 0) + buf.length > MAX_OWNER_BYTES) return { error: 'Too much uploaded at once. Import in smaller batches.' };
  // A slot that takes one file keeps only the latest upload.
  if (!SLOT_OF.get(kind).many) for (const [id, f] of files) if (f.kind === kind) files.delete(id);
  const id = crypto.randomBytes(8).toString('hex');
  files.set(id, { name: String(name || 'file').replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 200), kind, text: decode(buf), bytes: buf.length, at: Date.now() });
  staged.set(owner, files);
  return { id };
}

const staging = (owner) => [...(staged.get(owner) || new Map())].map(([id, f]) => ({ id, name: f.name, bytes: f.bytes, kind: f.kind, source: SLOT_OF.get(f.kind).source }));
const unstage = (owner, id) => { const f = staged.get(owner); if (f) f.delete(id); };

function readFile(kind, f, bundle, ctx, opts) {
  switch (kind) {
    case 'saml-metadata': return shib.metadata(f.text, bundle, f.name);
    case 'shib-attribute-filter': return shib.filter(f.text, ctx);
    case 'shib-attribute-resolver': return shib.resolver(f.text, ctx);
    case 'shib-relying-party': return shib.relyingParty(f.text, ctx);
    case 'shib-properties': return shib.properties(f.text, bundle, f.name);
    case 'okta-users': return okta.users(f.text, bundle, opts);
    case 'okta-groups': return okta.groups(f.text, bundle);
    case 'okta-apps': return okta.apps(f.text, bundle);
    case 'ms-users': return ms.users(f.text, bundle, opts);
    case 'ms-groups': return ms.groups(f.text, bundle);
    case 'entra-service-principals': return ms.servicePrincipals(f.text, bundle);
    case 'entra-applications': return ms.applications(f.text, bundle);
    case 'adfs-trusts': return ms.adfsTrusts(f.text, bundle);
    default: return undefined;
  }
}

// How much a read added, counting what the readers keep outside the bundle, so a file that yielded nothing can be reported.
const yielded = (bundle, ctx) => bundle.users.length + bundle.groups.length + bundle.sps.length + bundle.apps.length + bundle.notes.length
  + ctx.definitions.size + ctx.policies.length + ctx.overrides.size + Number(ctx.complex) + Number(ctx.valueRules);

/** Joins what the files said: one record per user and group, memberships resolved to usernames. */
function assemble(bundle, opts) {
  const users = new Map();
  for (const u of bundle.users) {
    const have = users.get(u.username);
    if (have) { for (const [k, v] of Object.entries(u)) if (v !== '' && have[k] === undefined) have[k] = v; have.groups = [...new Set([...(have.groups || []), ...(u.groups || [])])]; } else users.set(u.username, { ...u, groups: [...(u.groups || [])] });
  }
  const index = new Map();
  for (const u of users.values()) for (const k of [u.username, u.email, u.upn, u.sam_account_name, u.distinguished_name]) if (k) index.set(String(k).toLowerCase(), u.username);
  const resolve = (key) => {
    const k = String(key).toLowerCase();
    if (index.has(k)) return index.get(k);
    const cn = /^cn=([^,]+),/i.exec(k);
    if (cn && index.has(cn[1])) return index.get(cn[1]);
    return opts.usernameFrom === 'local' ? k.split('@')[0] : k;
  };

  const groups = new Map();
  const group = (name) => { const key = name.toLowerCase(); if (!groups.has(key)) groups.set(key, { name, description: '', members: new Set(), parents: new Set(), dn: '' }); return groups.get(key); };
  for (const g of bundle.groups) {
    const x = group(g.name);
    if (g.description && !x.description) x.description = g.description;
    if (g.dn && !x.dn) x.dn = g.dn;
    for (const m of g.members) x.members.add(resolve(m));
    for (const p of g.parents) x.parents.add(p);
  }
  for (const u of users.values()) for (const name of u.groups) group(name).members.add(u.username);
  // A parent given as a distinguished name (AD's MemberOf) is the group that has it.
  const byDn = new Map([...groups.values()].filter((g) => g.dn).map((g) => [g.dn.toLowerCase(), g.name]));
  for (const g of groups.values()) g.parents = new Set([...g.parents].map((p) => byDn.get(String(p).toLowerCase()) || (/^cn=/i.test(p) ? (/^cn=([^,]+),/i.exec(p) || [])[1] : p)).filter(Boolean));
  return { users: [...users.values()], groups: [...groups.values()].map((g) => ({ ...g, members: [...g.members], parents: [...g.parents] })) };
}

/**
 * Reads the staged files of one source into a plan. Nothing is written. `options.usernameFrom` is 'full' (the whole login or
 * principal name) or 'local' (the part before the @).
 */
function preview(owner, { source, options = {} }) {
  prune();
  if (!SOURCES.some((s) => s.id === source)) return { errors: ['Choose where you are moving from.'] };
  const chosen = [...(staged.get(owner) || new Map())].filter(([, f]) => SLOT_OF.get(f.kind).source === source);
  if (!chosen.length) return { errors: ['Upload at least one file first.'] };
  const opts = { usernameFrom: options.usernameFrom === 'local' ? 'local' : 'full' };
  const bundle = common.emptyBundle();
  const ctx = shib.newContext();
  const seen = [];
  for (const [, f] of chosen) {
    const slot = SLOT_OF.get(f.kind);
    seen.push({ name: f.name, kind: f.kind, label: slot.label });
    const before = yielded(bundle, ctx);
    try { readFile(f.kind, f, bundle, ctx, opts); } catch (e) { bundle.notes.push(`${f.name}: could not be read (${e.message}).`); continue; }
    if (yielded(bundle, ctx) === before) bundle.notes.push(`${f.name}: nothing in it matched ${slot.label.toLowerCase()}. Check that it is the right file for this slot.`);
  }
  shib.finish(bundle, ctx);
  const merged = assemble(bundle, opts);
  const full = { ...bundle, ...merged };
  const planId = crypto.randomBytes(8).toString('hex');
  plans.set(`${owner}/${planId}`, { bundle: full, at: Date.now(), source, fileIds: chosen.map(([id]) => id) });

  const cap = (list) => list.slice(0, LIST_CAP);
  return {
    planId, source, files: seen, notes: bundle.notes, opts,
    counts: { users: merged.users.length, groups: merged.groups.length, sps: bundle.sps.length, apps: bundle.apps.length },
    users: cap(merged.users.map((u) => ({ username: u.username, email: u.email || '', display_name: u.display_name || `${u.first_name || ''} ${u.last_name || ''}`.trim(), active: u.active !== false, exists: Boolean(db.get('SELECT 1 FROM users WHERE username = ?', u.username)) }))),
    groups: cap(merged.groups.map((g) => ({ name: g.name, members: g.members.length, parents: g.parents, exists: Boolean(db.get('SELECT 1 FROM groups WHERE name = ?', g.name)) }))),
    sps: cap(bundle.sps.map((s) => ({ name: s.name, entityId: s.entityId, acs: s.acsUrls, attributes: (s.maps || []).length, exists: Boolean(s.entityId && db.get('SELECT 1 FROM service_providers WHERE sp_entity_id = ?', s.entityId)) }))),
    apps: cap(bundle.apps.map((a) => ({ name: a.name, protocol: a.protocol, redirectUris: a.redirectUris }))),
    truncated: Math.max(merged.users.length, merged.groups.length, bundle.sps.length, bundle.apps.length) > LIST_CAP,
  };
}

const unusableHash = () => hashPassword(crypto.randomBytes(24).toString('base64url'));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function importUsers(list, report, { actorName }) {
  const hash = unusableHash(); // nobody knows it: people set a password through recovery, or an administrator sets one
  const ids = new Map();
  for (const u of list) {
    const row = (status, message = '') => report.details.push({ kind: 'user', name: u.username, status, message });
    const have = db.get('SELECT id FROM users WHERE username = ?', u.username);
    if (have) { ids.set(u.username, have.id); report.counts.users.skipped++; row('skipped', 'A user with this username already exists.'); continue; }
    if (!/^\S{1,254}$/.test(u.username) || /[\u0000-\u001f]/.test(u.username)) { report.counts.users.failed++; row('failed', 'The username is not usable (spaces or control characters).'); continue; }
    const fields = Object.fromEntries(USER_FIELDS.map((k) => [k, u[k] || '']));
    fields.username = u.username;
    fields.display_name = fields.display_name || `${fields.first_name} ${fields.last_name}`.trim() || u.username;
    let message = '';
    let emails = [];
    if (u.email) {
      const r = EMAIL_RE.test(u.email) ? userService.readEmails({}, u.email) : { errors: [`"${u.email}" is not a valid email address.`], emails: [] };
      if (r.errors.length) message = `Created without an email address: ${r.errors[0]}`; else emails = r.emails;
      fields.email = emails.length ? u.email : '';
    }
    try {
      ids.set(u.username, userService.insertUser({ fields, passwordHash: hash, emails, active: u.active !== false }, { by: null, via: 'admin' }));
      report.counts.users.created++; row('created', message);
    } catch (e) { report.counts.users.failed++; row('failed', e.message); }
  }
  return ids;
}

function importGroups(list, report, userIds, { actorName }) {
  const ids = new Map();
  for (const g of list) {
    const row = (status, message = '') => report.details.push({ kind: 'group', name: g.name, status, message });
    const have = db.get('SELECT id, source FROM groups WHERE name = ?', g.name);
    let id;
    if (have) {
      if (have.source !== 'local') { report.counts.groups.skipped++; row('skipped', `A group with this name is managed outside ${appSettings.productName()}.`); continue; }
      id = have.id; report.counts.groups.skipped++; row('skipped', 'Already exists; members were added to it.');
    } else {
      const problems = [...groupErrors({ name: g.name, description: g.description }), ...[ieGroups.nameError(g.name)].filter(Boolean)];
      if (problems.length) { report.counts.groups.failed++; row('failed', problems[0]); continue; }
      id = Number(db.run('INSERT INTO groups (name, description) VALUES (?, ?)', g.name, g.description || '').lastInsertRowid);
      const made = ieGroups.create({ id, name: g.name, folder_id: null, source: 'local' }, actorName);
      if (made.error) { report.counts.groups.failed++; row('failed', made.error); continue; }
      auditGroup(actorName, { id, name: g.name }, 'group.create', 'imported');
      report.counts.groups.created++; row('created');
    }
    ids.set(g.name.toLowerCase(), id);
    if (db.get('SELECT 1 FROM group_composites WHERE group_id = ?', id)) continue;
    let added = 0;
    for (const m of g.members) {
      let uid = userIds.get(m);
      if (!uid) { const u = db.get('SELECT id FROM users WHERE username = ?', m); uid = u && u.id; }
      if (!uid) continue;
      if (gm.addDirect(id, uid)) added++;
    }
    if (added) auditGroup(actorName, { id, name: g.name }, 'member.add', `${added} imported`);
    report.counts.memberships += added;
    const missing = g.members.filter((m) => !userIds.get(m) && !db.get('SELECT 1 FROM users WHERE username = ?', m)).length;
    if (missing) report.details.push({ kind: 'group', name: g.name, status: 'warning', message: `${missing} member${missing === 1 ? '' : 's'} could not be matched to a user.` });
  }
  for (const g of list) {
    const child = ids.get(g.name.toLowerCase());
    for (const p of g.parents) {
      const parent = ids.get(p.toLowerCase()) || (db.get('SELECT id FROM groups WHERE name = ?', p) || {}).id;
      if (!child || !parent) continue;
      if (gm.wouldCycle(parent, child)) { report.details.push({ kind: 'group', name: g.name, status: 'warning', message: `Not nested in ${p}: that would make a loop.` }); continue; }
      if (db.run('INSERT OR IGNORE INTO group_includes (group_id, member_group_id) VALUES (?, ?)', parent, child).changes) {
        auditGroup(actorName, { id: parent, name: p }, 'include.add', g.name);
        report.counts.nested++;
      }
    }
  }
}

const NAMEID_SOURCES = ['email', 'username', 'upn'];

function importSps(list, report, { enable }) {
  for (const s of list) {
    const row = (status, message = '') => report.details.push({ kind: 'sp', name: s.name, status, message });
    if (!s.entityId) { report.counts.sps.failed++; row('failed', 'It has no entity ID (audience).'); continue; }
    if (db.get('SELECT 1 FROM service_providers WHERE sp_entity_id = ?', s.entityId)) { report.counts.sps.skipped++; row('skipped', 'An application with this entity ID already exists.'); continue; }
    const body = {
      name: s.name, sp_entity_id: s.entityId, acs_url: s.acsUrls, slo_url: s.sloUrl || '', nameid_format: s.nameidFormat || 'emailAddress',
      nameid_source: NAMEID_SOURCES.includes(s.nameidSource) ? s.nameidSource : 'email', signing_cert_pem: s.signingCert || '', encryption_cert_pem: s.encryptionCert || '',
      encrypt_assertion: s.encrypt ? 1 : 0, sign_response: s.signResponse ? 1 : 0, sign_assertion: s.signAssertion ? 1 : 0, default_relay_state: (s.relayState || '').slice(0, 80),
      access_mode: enable && !s.disabled ? 'all' : 'none', map_idp: (s.maps || []).map((m) => m.idp_attribute), map_saml: (s.maps || []).map((m) => m.saml_name),
      description: 'Imported by the migration tool.',
    };
    const { data, errors } = sps.parseForm(body);
    if (errors.length) { report.counts.sps.failed++; row('failed', errors[0]); continue; }
    try { sps.createSp(data); report.counts.sps.created++; row('created', data.access_mode === 'none' ? 'Created turned off until you enable access.' : ''); } catch (e) { report.counts.sps.failed++; row('failed', e.message); }
  }
}

function importApps(list, report, { enable }) {
  for (const a of list) {
    const row = (status, message = '') => report.details.push({ kind: 'app', name: a.name, status, message });
    const grants = a.grantTypes && a.grantTypes.length ? a.grantTypes : ['authorization_code'];
    const body = {
      protocol: a.protocol, name: a.name, description: 'Imported by the migration tool.', redirect_uris: a.redirectUris, post_logout_uris: a.postLogoutUris || [],
      confidential: a.confidential, grant_types: grants.filter((g) => g !== 'client_credentials' || a.confidential), scopes: ['openid', 'profile', 'email', ...(grants.includes('refresh_token') ? ['offline_access'] : [])],
      access_mode: enable && !a.disabled ? 'all' : 'none', require_pkce: 1,
    };
    const { data, errors } = apps.parseForm(body);
    if (errors.length) { report.counts.apps.failed++; row('failed', errors[0]); continue; }
    try {
      const made = apps.createApp(data);
      const created = apps.getApp(made.id);
      report.counts.apps.created++;
      row('created', `New client ID ${created.client_id}${a.sourceClientId ? ` (was ${a.sourceClientId})` : ''}; update the application to use it.`);
      if (made.secret) report.secrets.push({ name: a.name, clientId: created.client_id, secret: made.secret });
    } catch (e) { report.counts.apps.failed++; row('failed', e.message); }
  }
}

/**
 * Writes a plan. `options`: users, groups, sps, apps (booleans, default on) and enableApps (default off: applications are
 * created turned off so nothing starts signing people in before an administrator has looked at it). Returns the report.
 */
function apply(owner, planId, options = {}, actor) {
  const key = `${owner}/${planId}`;
  const plan = plans.get(key);
  if (!plan) return { errors: ['That preview has expired. Run the preview again.'] };
  const b = plan.bundle;
  const on = (k) => options[k] === undefined || Boolean(options[k]);
  const report = {
    counts: { users: { created: 0, skipped: 0, failed: 0 }, groups: { created: 0, skipped: 0, failed: 0 }, sps: { created: 0, skipped: 0, failed: 0 }, apps: { created: 0, skipped: 0, failed: 0 }, memberships: 0, nested: 0 },
    details: [], secrets: [], notes: b.notes,
  };
  const actorName = actor ? actor.username : 'setup';
  db.tx(() => {
    const userIds = on('users') ? importUsers(b.users, report, { actorName }) : new Map();
    if (on('groups')) importGroups(b.groups, report, userIds, { actorName });
    if (on('sps')) importSps(b.sps, report, { enable: Boolean(options.enableApps) });
    if (on('apps')) importApps(b.apps, report, { enable: Boolean(options.enableApps) });
  });
  plans.delete(key);
  for (const id of plan.fileIds) unstage(owner, id); // what was imported is no longer waiting to be imported
  auditLog.admin('migration.apply', {
    actor: actor ? auditLog.who(actor) : { type: 'system', name: 'setup' },
    detail: { source: plan.source, counts: report.counts, enabled: Boolean(options.enableApps) },
  });
  report.total = report.counts;
  return report;
}

module.exports = { SOURCES, KIND_LABELS, stage, staging, unstage, preview, apply, MAX_FILE };
