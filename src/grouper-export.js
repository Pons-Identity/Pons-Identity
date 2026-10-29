const db = require('./db');
const appSettings = require('./app-settings');

// Builds an import bundle for Internet2 Grouper from the built-in groups: CSV files, a Grouper Shell (GSH) script
// that recreates them, and a README. Everything here is read-only and pure apart from the database reads, so
// the admin can review the bundle before running anything against Grouper.

const SUBJECT_FIELDS = {
  username: 'Username',
  employee_id: 'Employee / ID number',
  email: 'Email address',
  upn: 'User principal name',
  guid: 'GUID',
};
const PRIVILEGE_MAP = { admin: 'ADMIN', update: 'UPDATE', read: 'READ', view: 'VIEW', optin: 'OPTIN', optout: 'OPTOUT' };
const COMPOSITE_MAP = { union: 'UNION', intersect: 'INTERSECTION', minus: 'COMPLEMENT' };
const STEM_PATTERN = /^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)*$/;

function parseOptions(raw = {}) {
  const subjectField = raw.subjectField || 'username';
  const rootStem = raw.rootStem === undefined ? 'simpleidp' : String(raw.rootStem).trim();
  const errors = [];
  if (!SUBJECT_FIELDS[subjectField]) errors.push(`Subject field must be one of: ${Object.keys(SUBJECT_FIELDS).join(', ')}.`);
  if (!STEM_PATTERN.test(rootStem)) errors.push('The folder for ungrouped names may use letters, numbers, . _ - and : between folder levels.');
  return { options: { subjectField, rootStem }, errors };
}

function buildModel(rawOptions) {
  const { options, errors } = parseOptions(rawOptions);
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { errors });
  const { subjectField, rootStem } = options;

  const warnings = [];
  const unresolved = [];
  const groups = [];
  const byId = new Map(); // group id -> Grouper name (null when it cannot be exported)
  const taken = new Map(); // lower-cased Grouper name -> local group name

  const all = db.all('SELECT * FROM groups ORDER BY name');
  for (const g of all) {
    if (g.source === 'directory') {
      byId.set(g.id, null);
      warnings.push(`Skipped "${g.name}": it comes from an external directory, so Grouper has no copy of it to reference.`);
      continue;
    }
    if (g.source === 'grouper') { // already lives in Grouper under this name
      byId.set(g.id, g.name);
      continue;
    }
    const name = g.name.includes(':') ? g.name : `${rootStem}:${g.name}`;
    const segments = name.split(':');
    if (segments.some((s) => !s.trim())) {
      byId.set(g.id, null);
      warnings.push(`Skipped "${g.name}": a Grouper name cannot have an empty folder level.`);
      continue;
    }
    const clash = taken.get(name.toLowerCase());
    if (clash) {
      byId.set(g.id, null);
      warnings.push(`Skipped "${g.name}": it maps to the Grouper name "${name}", already used by "${clash}".`);
      continue;
    }
    taken.set(name.toLowerCase(), g.name);
    byId.set(g.id, name);
    groups.push({ id: g.id, name, local_name: g.name, extension: segments[segments.length - 1], description: g.description || '' });
  }
  const exported = new Set(groups.map((g) => g.id));
  const nameOf = (id) => byId.get(id) || null;

  const stems = [...new Set(groups.flatMap((g) => {
    const parts = g.name.split(':').slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join(':'));
  }))].sort((a, b) => a.split(':').length - b.split(':').length || a.localeCompare(b));

  const subjectOf = (u) => String(u[subjectField] || '').trim();
  const skippedUsers = new Set();
  const memberships = [];
  for (const m of db.all(`SELECT m.group_id, m.start_at, m.end_at, u.id AS user_id, u.username, u.employee_id, u.email, u.upn, u.guid
                          FROM group_members m JOIN users u ON u.id = m.user_id ORDER BY m.group_id, u.username`)) {
    if (!exported.has(m.group_id)) continue;
    const subject = subjectOf(m);
    if (!subject) {
      unresolved.push({ group: nameOf(m.group_id), username: m.username, reason: `no ${SUBJECT_FIELDS[subjectField].toLowerCase()} on file` });
      skippedUsers.add(m.user_id);
      continue;
    }
    memberships.push({ group: nameOf(m.group_id), subject, username: m.username, start_at: m.start_at, end_at: m.end_at });
  }

  const includes = [];
  for (const i of db.all('SELECT group_id, member_group_id FROM group_includes')) {
    if (!exported.has(i.group_id)) continue;
    const child = nameOf(i.member_group_id);
    if (!child) {
      warnings.push(`Nested group dropped: "${nameOf(i.group_id)}" nests a group that could not be exported.`);
      continue;
    }
    includes.push({ group: nameOf(i.group_id), member_group: child });
  }

  const composites = [];
  for (const c of db.all('SELECT group_id, op, left_id, right_id FROM group_composites')) {
    if (!exported.has(c.group_id)) continue;
    const left = nameOf(c.left_id);
    const right = nameOf(c.right_id);
    if (!left || !right) {
      warnings.push(`Composite dropped: "${nameOf(c.group_id)}" uses a factor group that could not be exported.`);
      continue;
    }
    composites.push({ group: nameOf(c.group_id), op: c.op, grouper_op: COMPOSITE_MAP[c.op], left, right });
  }

  const privileges = [];
  for (const a of db.all(`SELECT a.group_id, a.subject_type, a.subject_id, a.privilege FROM group_admins a ORDER BY a.group_id, a.id`)) {
    if (!exported.has(a.group_id)) continue;
    if (a.subject_type === 'everyone') { // Grouper's built-in "all subjects" entity
      privileges.push({ group: nameOf(a.group_id), subject_type: 'everyone', subject: 'GrouperAll', privilege: a.privilege, grouper_privilege: PRIVILEGE_MAP[a.privilege] });
    } else if (a.subject_type === 'group') {
      const subject = nameOf(a.subject_id);
      if (!subject) {
        warnings.push(`Privilege dropped: "${nameOf(a.group_id)}" grants ${a.privilege} to a group that could not be exported.`);
        continue;
      }
      privileges.push({ group: nameOf(a.group_id), subject_type: 'group', subject, privilege: a.privilege, grouper_privilege: PRIVILEGE_MAP[a.privilege] });
    } else {
      const u = db.get('SELECT username, employee_id, email, upn, guid FROM users WHERE id = ?', a.subject_id);
      const subject = u && subjectOf(u);
      if (!subject) {
        unresolved.push({ group: nameOf(a.group_id), username: u ? u.username : `user #${a.subject_id}`, reason: `${a.privilege} privilege: no ${SUBJECT_FIELDS[subjectField].toLowerCase()} on file` });
        continue;
      }
      privileges.push({ group: nameOf(a.group_id), subject_type: 'user', subject, privilege: a.privilege, grouper_privilege: PRIVILEGE_MAP[a.privilege] });
    }
  }

  // The same subject ID on two people would silently merge them in Grouper; surface it.
  const seen = new Map();
  for (const u of db.all(`SELECT username, ${subjectField} AS s FROM users WHERE ${subjectField} != ''`)) {
    const key = String(u.s).toLowerCase();
    if (seen.has(key)) warnings.push(`Two people share the ${SUBJECT_FIELDS[subjectField].toLowerCase()} "${u.s}" (${seen.get(key)}, ${u.username}); Grouper will treat them as one subject.`);
    else seen.set(key, u.username);
  }

  return {
    options, stems, groups, memberships, includes, composites, privileges, warnings, unresolved,
    counts: {
      groups: groups.length, stems: stems.length, memberships: memberships.length, nested: includes.length,
      composites: composites.length, privileges: privileges.length, unresolved: unresolved.length, warnings: warnings.length,
    },
  };
}

/* ------------------------------ File formats ------------------------------ */

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header, rows) => `${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : '');

// A Groovy single-quoted string: no interpolation, so only backslash, quote and line breaks need care.
const q = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;

function toCsv(model) {
  return {
    'stems.csv': csv(['stem'], model.stems.map((s) => [s])),
    'groups.csv': csv(['grouper_name', 'extension', 'description', 'simpleidp_name'],
      model.groups.map((g) => [g.name, g.extension, g.description, g.local_name])),
    'memberships.csv': csv(['group', 'subject', 'username', 'start', 'end'],
      model.memberships.map((m) => [m.group, m.subject, m.username, iso(m.start_at), iso(m.end_at)])),
    'nested_groups.csv': csv(['group', 'member_group'], model.includes.map((i) => [i.group, i.member_group])),
    'composites.csv': csv(['group', 'type', 'left_factor', 'right_factor'],
      model.composites.map((c) => [c.group, c.grouper_op, c.left, c.right])),
    'privileges.csv': csv(['group', 'subject_type', 'subject', 'privilege'],
      model.privileges.map((p) => [p.group, p.subject_type, p.subject, p.grouper_privilege])),
    'unresolved.csv': csv(['group', 'username', 'reason'], model.unresolved.map((u) => [u.group, u.username, u.reason])),
  };
}

function toGsh(model) {
  const L = [];
  const windowed = model.memberships.filter((m) => m.start_at || m.end_at);
  L.push(
    `// Generated by ${appSettings.productName()}: recreates its built-in groups in Grouper.`,
    '// Written for the Grouper 2.5+ shell (Groovy). Review it, and run it against a test Grouper first.',
    '// It is safe to re-run: groups are saved, and members already present are left alone.',
    '// Run with:  bin/gsh import.gsh',
    '',
    'gs = GrouperSession.startRootSession()',
    'missing = []',
    'def subj(String id) {',
    '  def s = SubjectFinder.findByIdOrIdentifier(id, false)',
    '  if (s == null) missing << id',
    '  return s',
    '}',
    'def grp(String name) { return GroupFinder.findByName(gs, name, true) }',
  );
  if (windowed.length) {
    L.push(
      'def window(String groupName, def subject, Long start, Long end) {',
      '  def ms = grp(groupName).getImmediateMembership(Group.getDefaultList(), subject, true, true)',
      '  if (start != null) ms.setEnabledTime(new java.sql.Timestamp(start))',
      '  if (end != null) ms.setDisabledTime(new java.sql.Timestamp(end))',
      '  ms.update()',
      '}',
    );
  }
  L.push('', `// 1. Folders and groups (${model.groups.length})`);
  for (const g of model.groups) {
    L.push(`new GroupSave(gs).assignName(${q(g.name)}).assignDescription(${q(g.description)}).assignCreateParentStemsIfNotExist(true).save()`);
  }
  L.push('', `// 2. Direct members (${model.memberships.length})`);
  for (const m of model.memberships) {
    L.push(`s = subj(${q(m.subject)}); if (s != null) grp(${q(m.group)}).addMember(s, false)`);
  }
  if (windowed.length) {
    L.push('', `// 3. Membership start and end dates (${windowed.length})`);
    for (const m of windowed) {
      L.push(`s = subj(${q(m.subject)}); if (s != null) window(${q(m.group)}, s, ${m.start_at ? `${m.start_at * 1000}L` : 'null'}, ${m.end_at ? `${m.end_at * 1000}L` : 'null'})`);
    }
  }
  L.push('', `// 4. Nested groups (${model.includes.length})`);
  for (const i of model.includes) L.push(`grp(${q(i.group)}).addMember(grp(${q(i.member_group)}).toSubject(), false)`);
  L.push('', `// 5. Composite groups (${model.composites.length}); done after members so their factors exist`);
  for (const c of model.composites) {
    L.push(`grp(${q(c.group)}).addCompositeMember(CompositeType.${c.grouper_op}, grp(${q(c.left)}), grp(${q(c.right)}))`);
  }
  L.push('', `// 6. Delegated privileges (${model.privileges.length})`);
  for (const p of model.privileges) {
    const subject = { group: `grp(${q(p.subject)}).toSubject()`, everyone: 'SubjectFinder.findAllSubject()' }[p.subject_type] || `subj(${q(p.subject)})`;
    L.push(`s = ${subject}; if (s != null) grp(${q(p.group)}).grantPriv(s, AccessPrivilege.${p.grouper_privilege}, false)`);
  }
  L.push(
    '',
    'if (missing) println("Not found in Grouper (add them to its subject source, then re-run): " + missing.unique().join(", "))',
    `println("Done: ${model.groups.length} groups, ${model.memberships.length} members, ${model.includes.length} nested, ${model.composites.length} composites, ${model.privileges.length} privileges.")`,
    'GrouperSession.stopQuietly(gs)',
    '',
  );
  return L.join('\n');
}

function toReadme(model, generatedAt) {
  const o = model.options;
  const lines = [
    `${appSettings.productName()} -> Grouper export`,
    `Generated ${generatedAt}`,
    '',
    `Subjects are identified by: ${SUBJECT_FIELDS[o.subjectField]}. Grouper must resolve this value through one of its subject sources.`,
    `Group names without a ":" were placed under the folder "${o.rootStem}". Names containing ":" became nested folders as written.`,
    '',
    'Contents',
    `  groups.csv          ${model.counts.groups} groups in ${model.counts.stems} folders (stems.csv)`,
    `  memberships.csv     ${model.counts.memberships} direct memberships, with optional start/end dates`,
    `  nested_groups.csv   ${model.counts.nested} groups nested inside another group`,
    `  composites.csv      ${model.counts.composites} composite groups (UNION, INTERSECTION, COMPLEMENT)`,
    `  privileges.csv      ${model.counts.privileges} delegated privileges (ADMIN, UPDATE, READ, VIEW, OPTIN, OPTOUT)`,
    `  unresolved.csv      ${model.counts.unresolved} entries that could not be exported (no ${SUBJECT_FIELDS[o.subjectField].toLowerCase()})`,
    '  import.gsh          Grouper Shell script that applies all of the above',
    '',
    'Not exported: the change history, and groups provisioned by an external directory.',
    'Groups that already come from Grouper are referenced by name and not recreated.',
    '',
    'Before you run it',
    '  1. Try it on a test Grouper. The script was generated, not run against your version of Grouper.',
    '  2. Make sure every person in memberships.csv exists in Grouper\'s subject source, or they are reported at the end.',
    '  3. Membership start/end dates need the Grouper daemon running to take effect.',
    '  4. Re-running is safe.',
  ];
  if (model.warnings.length) lines.push('', 'Warnings', ...model.warnings.map((w) => `  - ${w}`));
  return `${lines.join('\n')}\n`;
}

function buildBundle(rawOptions) {
  const model = buildModel(rawOptions);
  return { model, files: { 'README.txt': toReadme(model, new Date().toISOString()), 'import.gsh': toGsh(model), ...toCsv(model) } };
}

module.exports = { SUBJECT_FIELDS, parseOptions, buildModel, buildBundle, toCsv, toGsh };
