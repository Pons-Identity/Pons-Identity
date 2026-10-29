const db = require('./db');
const roles = require('./roles');
const gm = require('./group-membership');
const policies = require('./policies');
const appPolicies = require('./app-policies');
const compromise = require('./compromise');
const passwordRules = require('./password-rules');
const factors = require('./factors');
const sps = require('./sps');
const apps = require('./apps');
const groupCalc = require('./group-calculator');
const { Graph, detail } = require('./calculator-graph');

// The Policy calculator says which policies are enforced in a scenario, and what they add up to:
//   a person                the sign-in policies (global, by role, by group), the password rules, and the compromised-account policies
//                           that apply to them, and for each rule which policies set the value that wins;
//   an application          who may use it and the application policies that cover it (the global policy is named too, since it applies
//                           to everyone who signs in);
//   a person and an application  all of that together, ending in what would happen if that person tried to use that application.
// Every answer comes as text and as a diagram (Mermaid text and the nodes and links the console draws it from), made from the same facts.
// It reads the same functions that enforce the policies at sign-in, so it cannot drift from what really happens.

const { quoted, who } = groupCalc;
const KINDS = { app: 'application', sp: 'SAML service provider' };
const PROTOCOLS = { cas: 'CAS', oidc: 'OpenID Connect', oauth2: 'OAuth 2.0', saml: 'SAML' };
const RISK_TEXT = { allow: 'Allow', require_mfa: 'Require a second factor', phishing_resistant: 'Require a phishing-resistant factor', webauthn_only: 'Security keys only', block: 'Block' };

const unique = (list) => [...new Set(list)];
const names = (rows) => unique(rows.map((r) => r.name));
const factorNames = (list) => list.map(appPolicies.nameOf).join(', ');
const hoursText = (h) => (h === 0 ? 'always ask' : `${h} ${h === 1 ? 'hour' : 'hours'}`);

/* -------------------------------------------------------------------------- */
/*  The person                                                                  */
/* -------------------------------------------------------------------------- */

/** Roles the person holds, and how: assigned in the console, or granted by a Grouper group that is mapped to the role. */
function rolesHeld(userId, memberships) {
  const out = new Map();
  const note = (role, how) => { if (!out.has(role.id)) out.set(role.id, { id: role.id, name: role.name, how: [] }); out.get(role.id).how.push(how); };
  for (const id of roles.roleIds(userId)) {
    const role = db.get('SELECT id, name FROM roles WHERE id = ?', id);
    if (role) note(role, 'assigned in the console');
  }
  const grouper = new Map(memberships.filter((g) => g.source === 'grouper').map((g) => [g.name.toLowerCase(), g]));
  if (grouper.size) {
    for (const m of db.all('SELECT m.group_name, r.id, r.name FROM grouper_role_map m JOIN roles r ON r.id = m.role_id')) {
      const g = grouper.get(m.group_name.toLowerCase());
      if (g && roles.roleIdsGrantedBy([g]).includes(m.id)) note(m, `granted through the Grouper group ${quoted(g.name)}`);
    }
  }
  return [...out.values()];
}

/** The rules a sign-in policy row sets, as short phrases. */
function ruleSummary(row) {
  const out = [];
  if (row.block_sign_in) out.push('blocks sign-in');
  if (row.require_phishing_resistant) out.push('requires a phishing-resistant factor');
  else if (row.require_mfa) out.push('requires a second factor');
  if (row.allowed_factors) out.push(`allows only ${factorNames(row.allowed_factors.split(','))}`);
  if (row.disable_password_recovery) out.push('turns off password recovery');
  if (row.risk_medium_action) out.push(`medium risk: ${RISK_TEXT[row.risk_medium_action] || row.risk_medium_action}`);
  if (row.risk_high_action) out.push(`high risk: ${RISK_TEXT[row.risk_high_action] || row.risk_high_action}`);
  if (row.remember_mfa_hours != null) out.push(`remembers a second factor: ${hoursText(row.remember_mfa_hours)}`);
  if (row.password_policy_id != null) out.push(`password policy ${quoted(db.get('SELECT name FROM password_policies WHERE id = ?', row.password_policy_id)?.name || row.password_policy_id)}`);
  if (row.inlinePassword) out.push('sets the global password rules');
  return out;
}

/** Each sign-in policy that applies to the person, and why it does. */
function appliedSignIn(userId, memberships, held, ctx, global) {
  const heldIds = new Map(held.map((r) => [r.id, r]));
  return policies.policiesFor(userId).map((p) => {
    const state = global ? policies.overrideState(p, global) : { weakens: [], active: [], needsAcceptance: [] };
    const base = { row: p, id: p.id, name: p.name, rules: ruleSummary(p), override: state };
    if (p.role_id !== null) {
      const role = heldIds.get(p.role_id);
      return { ...base, subject: { type: 'role', id: p.role_id, name: role.name }, because: role.how.map((h) => `they hold the role ${quoted(role.name)} (${h})`), routes: [] };
    }
    // A policy may name several groups; it applies through each of them that the person is in.
    const through = db.all('SELECT g.id, g.name FROM policy_groups pg JOIN groups g ON g.id = pg.group_id WHERE pg.policy_id = ? ORDER BY g.name', p.id)
      .map((g) => ({ ...g, membership: groupCalc.membership(userId, g.id, ctx) })).filter((g) => g.membership.member);
    return {
      ...base, subject: { type: 'group', id: through[0]?.id, name: through.map((g) => g.name).join(', ') },
      because: through.flatMap((g) => g.membership.routes.map((r) => `they are in ${quoted(g.name)}: ${groupCalc.describeRoute(r)}`)),
      routes: through.flatMap((g) => g.membership.routes), memberships: through.map((g) => g.membership),
    };
  });
}

/**
 * The rules that win, one row each: what the rule comes to, and which policies set that value. A policy that the global policy
 * was overridden by (accepted explicitly) replaces it for that rule alone.
 */
function enforcedRules(applied, global, effective) {
  const overridden = new Set(applied.flatMap((p) => policies.overrideState(p.row, global).active));
  const rows = applied.map((p) => p.row);
  const rowsFor = (key) => (global && !overridden.has(key) ? [global, ...rows] : rows);
  const overrideNote = (key) => (overridden.has(key) ? `the global value is overridden by ${names(applied.filter((p) => policies.overrideState(p.row, global).active.includes(key)).map((p) => p.row)).join(', ')}` : '');
  const rule = (key, label, value, sources, extra = {}) => ({ key, label, value, sources: names(sources), note: extra.note ?? overrideNote(key), tone: extra.tone || null });

  const out = [];
  out.push(rule('block', 'Sign-in', effective.blockSignIn ? 'Blocked' : 'Allowed', rows.filter((p) => p.block_sign_in), { tone: effective.blockSignIn ? 'bad' : null }));
  out.push(rule('mfa', 'Second factor', effective.requireMfa ? 'Required' : 'Not required', [...rowsFor('phishing').filter((p) => p.require_phishing_resistant), ...rowsFor('mfa').filter((p) => p.require_mfa)]));
  out.push(rule('phishing', 'Phishing-resistant factor', effective.requirePhishingResistant ? 'Required' : 'Not required', rowsFor('phishing').filter((p) => p.require_phishing_resistant)));
  out.push(rule('factors', 'Factors allowed', effective.allowedFactors === null ? 'Any factor' : effective.allowedFactors.length ? factorNames(effective.allowedFactors) : 'None (the lists share no factor)', rowsFor('factors').filter((p) => p.allowed_factors), { tone: effective.allowedFactors && !effective.allowedFactors.length ? 'bad' : null }));
  out.push(rule('recovery', 'Password recovery', effective.disablePasswordRecovery ? 'Turned off' : 'Allowed', rowsFor('recovery').filter((p) => p.disable_password_recovery)));
  for (const [key, label, action] of [['risk_medium', 'Response to medium risk', effective.riskMediumAction], ['risk_high', 'Response to high risk', effective.riskHighAction]]) {
    out.push(rule(key, label, action ? RISK_TEXT[action] || action : 'No rule', rowsFor(key).filter((p) => action && p[`${key}_action`] === action)));
  }
  const hours = rowsFor('remember').filter((p) => p.remember_mfa_hours != null);
  out.push(rule('remember', 'Remember a second factor', hours.length ? hoursText(effective.rememberMfaHours) : 'Not remembered', hours.filter((p) => p.remember_mfa_hours === effective.rememberMfaHours)));
  const pw = rowsFor('password').filter((p) => p.password_policy_id != null || p.inlinePassword);
  const described = passwordRules.describe(effective.password, effective.minPasswordLength);
  out.push(rule('password', 'Password rules', described.requirements.join('; '), pw, pw.length ? {} : { note: 'only the built-in minimum applies' }));
  return out;
}

/** The lockdown steps that run for the person, and which compromised-account policies set each. */
function lockdownRules(userId) {
  const everyone = compromise.everyonePolicy();
  const baseName = everyone ? everyone.name : 'Built-in default';
  const applied = compromise.policiesFor(userId);
  const effective = compromise.effectiveFor(userId);
  const sources = (key) => [...(everyone ? (everyone[key] ? [baseName] : []) : [baseName]), ...applied.filter((p) => p[key]).map((p) => p.name)];
  const lists = [everyone, ...applied].filter(Boolean).map((p) => ({ name: p.name, networks: compromise.parseList(p.restrict_networks) })).filter((l) => l.networks.length);
  return {
    base: baseName, applied: applied.map((p) => ({ id: p.id, name: p.name, subject: p.role_id !== null ? 'role' : 'group', subject_id: p.role_id ?? p.group_ids[0], group_ids: p.group_ids })),
    steps: compromise.STEPS.map((s) => ({ key: s.key, label: s.label, on: Boolean(effective.steps[s.key]), sources: unique(sources(s.key)) })),
    networks: lists, effective,
  };
}

/* -------------------------------------------------------------------------- */
/*  The application                                                             */
/* -------------------------------------------------------------------------- */

function loadTarget(kind, id) {
  if (kind === 'sp') {
    const sp = sps.getSp(id);
    return sp && { kind, id: sp.id, name: sp.name, protocol: 'saml', access_mode: sp.access_mode, access_groups: sp.access_groups, link: `/admin/sps/${sp.id}`, hasAccess: (uid) => sps.userHasAccess(sp, uid) };
  }
  const app = apps.getApp(id);
  return app && { kind: 'app', id: app.id, name: app.name, protocol: app.protocol, access_mode: app.access_mode, access_groups: app.access_groups, link: `/admin/apps/${app.id}`, hasAccess: (uid) => apps.userHasAccess(app, uid) };
}

/** What the application policies that cover it come to, with the policies that set each rule. */
function appRules(target) {
  const rows = appPolicies.policiesCovering(target.kind, target.id);
  const reqs = appPolicies.requirementsFor(target.kind, target.id);
  if (!reqs) return { policies: [], reqs: null, rules: [] };
  return {
    policies: rows.map((r) => ({ id: r.id, name: r.name, rules: ruleSummary({ require_mfa: r.require_mfa, require_phishing_resistant: r.require_phishing_resistant, allowed_factors: r.allowed_factors }) })),
    reqs,
    rules: [
      { key: 'mfa', label: 'Second factor', value: reqs.requireMfa ? 'Required' : 'Not required', sources: names(rows.filter((r) => r.require_mfa || r.require_phishing_resistant || r.allowed_factors)) },
      { key: 'phishing', label: 'Phishing-resistant factor', value: reqs.requirePhishingResistant ? 'Required' : 'Not required', sources: names(rows.filter((r) => r.require_phishing_resistant)) },
      { key: 'factors', label: 'Factors allowed', value: reqs.allowedFactors === null ? 'Any factor' : reqs.allowedFactors.length ? factorNames(reqs.allowedFactors) : 'None (the lists share no factor)', sources: names(rows.filter((r) => r.allowed_factors)), tone: reqs.allowedFactors && !reqs.allowedFactors.length ? 'bad' : null },
    ],
  };
}

/** Who may use the application, and for a person, the route that gives them access. */
function accessOf(target, user, ctx) {
  const groups = target.access_groups.map((id) => ctx.groups.get(id)).filter(Boolean).map((g) => ({ id: g.id, name: g.name }));
  const out = { mode: target.access_mode, groups, allowed: null, via: [] };
  if (target.access_mode === 'groups') {
    const members = new Set(groups.flatMap((g) => [...gm.effectiveMembers(g.id, ctx.now, ctx.graph, ctx.memo)]));
    out.people = members.size;
  }
  if (user) {
    out.allowed = target.hasAccess(user.id);
    if (target.access_mode === 'groups') out.via = groups.map((g) => ({ group: g, membership: groupCalc.membership(user.id, g.id, ctx) })).filter((v) => v.membership.member);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The calculator                                                              */
/* -------------------------------------------------------------------------- */

const ACCESS_TEXT = { all: 'everyone who can sign in', none: 'no one (access is turned off)', groups: 'members of the chosen groups' };

/**
 * Runs the calculator for a person, an application ({ kind: 'app' | 'sp', appId }), or both. Returns
 * { scenario, user, app, sign_in, lockdown, access, app_policies, outcome, text, mermaid, graph } or { error }.
 */
function calculate({ userId = null, kind = null, appId = null } = {}) {
  const user = userId ? db.get('SELECT id, username, display_name, active FROM users WHERE id = ?', Number(userId)) : null;
  if (userId && !user) return { error: 'No such person.' };
  if (kind && !KINDS[kind]) return { error: 'Choose an application or a SAML service provider.' };
  const target = kind && appId ? loadTarget(kind, String(appId)) : null;
  if (kind && !target) return { error: 'No such application.' };
  if (!user && !target) return { error: 'Choose a person, an application, or both.' };

  const ctx = groupCalc.context();
  const graph = new Graph({ direction: 'LR', limit: 250 });
  const text = [];
  const global = policies.globalPolicy();
  const result = { scenario: user && target ? 'user+app' : user ? 'user' : 'app', user: null, app: null };

  const title = user && target ? `${user.username} using ${quoted(target.name)}` : user ? `${user.username}` : `${quoted(target.name)}`;
  text.push(`POLICY CALCULATOR — ${title}`, '');

  /* The global policy is the one policy that needs no person: it applies to every account. */
  const globalId = 'pglobal';
  if (global) graph.node(globalId, { label: detail(global.name, ruleSummary(global).length ? ruleSummary(global) : ['sets no sign-in rules']), cls: 'global', details: ruleSummary(global).join('; ') || 'No sign-in rules', link: '/admin/policies/sign-in' });

  let signIn = null;
  let enforcedId = null;
  if (user) {
    const memberships = gm.membershipsOf(user.id, ctx.now);
    const held = rolesHeld(user.id, memberships);
    const applied = appliedSignIn(user.id, memberships, held, ctx, global);
    const effective = policies.effectivePolicy(user.id);
    const rules = enforcedRules(applied, global, effective);
    const lock = lockdownRules(user.id);
    signIn = { effective, rules, applied, held, memberships };
    result.user = { id: user.id, username: user.username, display_name: user.display_name, active: Boolean(user.active) };

    text.push('THE PERSON', `  ${who(user)}${user.active ? '' : ' — account is turned off'}`);
    text.push(`  Roles: ${held.length ? held.map((r) => `${r.name} (${r.how.join('; ')})`).join(', ') : 'none'}`);
    text.push(`  Groups: ${memberships.length ? memberships.map((g) => `${g.name} (${g.how.toLowerCase()}${g.via.length ? `, via ${g.via.map((v) => v.name).join(', ')}` : ''})`).join(', ') : 'none'}`, '');

    text.push(`SIGN-IN POLICIES THAT APPLY (${applied.length + (global ? 1 : 0)})`);
    if (global) text.push(`  • ${global.name} — applies to every account`, `      ${ruleSummary(global).join('; ') || 'sets no sign-in rules'}`);
    for (const p of applied) {
      text.push(`  • ${p.name} — for the ${p.subject.type} ${quoted(p.subject.name)}`, `      ${p.rules.join('; ') || 'sets no sign-in rules'}`);
      for (const b of p.because.slice(0, 5)) text.push(`      applies because ${b}`);
      if (p.because.length > 5) text.push(`      … and ${p.because.length - 5} more ${p.because.length - 5 === 1 ? 'route' : 'routes'}`);
      if (p.override.active.length) text.push(`      overrides the global policy on: ${p.override.active.map((k) => policies.OVERRIDE_RULES[k]).join(', ')} (accepted by an administrator)`);
      if (p.override.needsAcceptance.length) text.push(`      is weaker than the global policy on ${p.override.needsAcceptance.map((k) => policies.OVERRIDE_RULES[k]).join(', ')}, which was not accepted, so the global value still applies`);
    }
    if (!applied.length && !global) text.push('  None. No policy covers this person, so only the built-in password minimum applies.');
    text.push('');

    text.push('ENFORCED SIGN-IN RULES (the strictest value of each rule wins)');
    for (const r of rules) text.push(`  ${r.label.padEnd(26, '.')} ${r.value}${r.sources.length ? `   [${r.sources.join(', ')}]` : '   [no policy sets this]'}${r.note ? `   (${r.note})` : ''}`);
    text.push('');

    text.push('COMPROMISED-ACCOUNT LOCKDOWN (steps that run if this account is locked down)');
    for (const s of lock.steps) text.push(`  ${s.on ? '✓' : '✗'} ${s.label}${s.sources.length ? `   [${s.sources.join(', ')}]` : ''}`);
    text.push(`  Networks: ${lock.networks.length ? lock.networks.map((l) => `${l.name}: ${l.networks.join(', ')}`).join('; ') + ' (sign-in must match every list)' : 'no restriction'}`, '');
    result.lockdown = lock;

    /* The diagram: the person, how they reach each policy, and the rules that result. */
    const off = !user.active;
    graph.node(`u${user.id}`, {
      label: detail(who(user), [...(off ? ['⚠ account is turned off'] : []), `sign-in methods: ${factors.enrolled(db.get('SELECT * FROM users WHERE id = ?', user.id)).map((f) => f.label).join(', ') || 'password only'}`]),
      kind: 'user', cls: off ? 'bad' : 'user', details: off ? 'Account is turned off' : '', link: `/admin/users/${user.id}`,
    });
    enforcedId = 'enforced';
    const quiet = new Set(['Not required', 'Allowed', 'Any factor', 'No rule', 'Not remembered']);
    const yielded = rules.filter((r) => !quiet.has(r.value) && r.key !== 'password').map((r) => `${r.label}: ${r.value}`);
    yielded.push(`Password: at least ${effective.minPasswordLength} characters${rules.find((r) => r.key === 'password').sources.length ? ', plus policy rules' : ''}`);
    graph.node(enforcedId, { label: detail(effective.blockSignIn ? 'Enforced: sign-in BLOCKED' : 'Enforced sign-in rules', yielded), kind: 'rule', cls: effective.blockSignIn ? 'bad' : 'rule', details: rules.map((r) => `${r.label}: ${r.value}`).join('\n'), link: '/admin/policies/sign-in' });
    // What a policy contributed to the result: the rules for which it set the winning value.
    const setBy = (name) => { const mine = rules.filter((r) => r.sources.includes(name)).map((r) => r.label.toLowerCase()); return mine.length ? `sets ${mine.slice(0, 3).join(', ')}${mine.length > 3 ? ` +${mine.length - 3}` : ''}` : 'adds nothing (a stricter value wins)'; };
    if (global) { graph.edge(`u${user.id}`, globalId, { label: 'everyone', style: 'dotted' }); graph.edge(globalId, enforcedId, { label: setBy(global.name) }); }
    for (const p of applied) {
      const pid = `p${p.id}`;
      graph.node(pid, { label: detail(p.name, [...(p.rules.length ? p.rules : ['sets no sign-in rules']), ...(p.override.active.length ? [`overrides global: ${p.override.active.map((k) => policies.OVERRIDE_RULES[k].toLowerCase()).join(', ')}`] : [])]), cls: 'policy', details: p.rules.join('; '), link: '/admin/policies/sign-in' });
      if (p.subject.type === 'role') {
        const rid = `r${p.subject.id}`;
        graph.node(rid, { label: p.subject.name, kind: 'role', cls: 'role', link: '/admin/settings/roles' });
        graph.edge(`u${user.id}`, rid, { label: p.because.length && /Grouper/.test(p.because[0]) ? 'role via Grouper' : 'holds role' });
        graph.edge(rid, pid, { label: 'has policy' });
      } else {
        for (const m of p.memberships) {
          const gid = groupCalc.addMembershipToGraph(graph, user.id, m.node, { contributingOnly: true });
          graph.edge(gid, pid, { label: 'has policy' });
        }
      }
      graph.edge(pid, enforcedId, { label: p.override.active.length ? `overrides global; ${setBy(p.name)}` : setBy(p.name), style: p.override.active.length ? 'thick' : 'solid' });
    }
    for (const c of lock.applied) {
      const cid = `c${c.id}`;
      graph.node('lockdown', { label: detail('Lockdown if compromised', [...lock.steps.filter((s) => s.on).map((s) => s.label.toLowerCase()), ...(lock.networks.length ? [`sign-in only from ${lock.networks.flatMap((l) => l.networks).join(', ')}`] : [])]), kind: 'rule', cls: 'rule', link: '/admin/policies/compromised' });
      graph.node(cid, { label: detail(c.name, lock.steps.filter((s) => s.sources.includes(c.name)).map((s) => s.label.toLowerCase())), cls: 'policy', details: 'Compromised account policy', link: '/admin/policies/compromised' });
      let from;
      const sources = [];
      if (c.subject === 'group') {
        for (const gid of c.group_ids) {
          const m = groupCalc.membership(user.id, gid, ctx);
          if (m.member) sources.push(groupCalc.addMembershipToGraph(graph, user.id, m.node, { contributingOnly: true }));
        }
      } else {
        const from = `r${c.subject_id}`;
        graph.node(from, { label: db.get('SELECT name FROM roles WHERE id = ?', c.subject_id)?.name, kind: 'role', cls: 'role', link: '/admin/settings/roles' });
        graph.edge(`u${user.id}`, from, { label: 'holds role' });
        sources.push(from);
      }
      for (const from of sources) graph.edge(from, cid, { label: 'has policy' });
      graph.edge(cid, 'lockdown', { label: 'adds these steps' });
    }
  } else if (global) {
    text.push('SIGN-IN POLICIES THAT APPLY TO EVERYONE', `  • ${global.name} — ${ruleSummary(global).join('; ') || 'sets no sign-in rules'}`,
      '  Other sign-in policies depend on the person (their roles and groups). Choose a person to see them.', '');
  } else {
    text.push('SIGN-IN POLICIES THAT APPLY TO EVERYONE', '  None. Sign-in policies depend on the person (their roles and groups). Choose a person to see them.', '');
  }

  let access = null;
  let appPart = null;
  let outcome = null;
  if (target) {
    result.app = { kind: target.kind, id: target.id, name: target.name, protocol: target.protocol };
    access = accessOf(target, user, ctx);
    appPart = appRules(target);
    const appId_ = `a${target.kind}${target.id}`.replace(/[^A-Za-z0-9_]/g, '');
    graph.node(appId_, { label: detail(`${target.name} (${PROTOCOLS[target.protocol]})`, [`access: ${ACCESS_TEXT[access.mode] || access.mode}`, ...(appPart.reqs ? appPart.rules.filter((r) => r.value !== 'Not required' && r.value !== 'Any factor').map((r) => `${r.label}: ${r.value}`) : ['no application policy: a password is enough'])]), kind: 'app', cls: 'app', link: target.link });

    text.push(`THE ${KINDS[target.kind].toUpperCase()}`, `  ${target.name} (${PROTOCOLS[target.protocol]})`);
    text.push(`  Who may use it: ${ACCESS_TEXT[access.mode] || access.mode}${access.mode === 'groups' ? ` — ${access.groups.length ? access.groups.map((g) => quoted(g.name)).join(', ') : 'no groups chosen, so no one'}${access.people !== undefined ? ` (${access.people} ${access.people === 1 ? 'person' : 'people'} today)` : ''}` : ''}`);
    if (user) {
      text.push(`  ${user.username} ${access.allowed ? 'MAY' : 'may NOT'} use it${access.via.length ? ':' : '.'}`);
      for (const v of access.via) for (const r of v.membership.routes.slice(0, 5)) text.push(`      through ${quoted(v.group.name)}: ${groupCalc.describeRoute(r)}`);
    }
    text.push('');

    text.push(`APPLICATION POLICIES THAT COVER IT (${appPart.policies.length})`);
    if (!appPart.policies.length) text.push('  None. No application policy covers it, so a password alone is enough here (sign-in policies still apply).');
    for (const p of appPart.policies) text.push(`  • ${p.name} — ${p.rules.join('; ') || 'requires nothing beyond sign-in'}`);
    if (appPart.reqs) {
      text.push('', 'ENFORCED APPLICATION RULES (the strictest value of each rule wins)');
      for (const r of appPart.rules) text.push(`  ${r.label.padEnd(26, '.')} ${r.value}${r.sources.length ? `   [${r.sources.join(', ')}]` : '   [no policy sets this]'}`);
    }
    text.push('');

    // Access: groups that grant it, drawn from the person's routes when there is a person.
    if (access.mode === 'groups') {
      for (const g of access.groups) {
        const via = access.via.find((v) => v.group.id === g.id);
        const gid = via ? groupCalc.addMembershipToGraph(graph, user.id, via.membership.node, { contributingOnly: true }) : (graph.node(`g${g.id}`, { label: g.name, cls: user ? 'muted' : (ctx.roles.get(g.id) || 'application'), link: `/admin/groups/${g.id}` }), `g${g.id}`);
        graph.edge(gid, appId_, { label: 'grants access', style: user && !via ? 'dotted' : 'solid' });
      }
    } else if (user) {
      graph.edge(`u${user.id}`, appId_, { label: access.mode === 'all' ? 'open to everyone' : 'access turned off', style: access.allowed ? 'solid' : 'dotted', tone: access.allowed ? undefined : 'bad' });
    }
    for (const p of appPart.policies) {
      graph.node(`ap${p.id}`, { label: detail(p.name, p.rules.length ? p.rules : ['requires nothing beyond sign-in']), cls: 'policy', details: p.rules.join('; ') || 'Requires nothing beyond sign-in', link: '/admin/policies/applications' });
      graph.edge(`ap${p.id}`, appId_, { label: 'requires' });
    }
    if (!user && global) graph.edge(globalId, appId_, { label: 'applies to sign-in', style: 'dotted' });

    if (user) {
      /* The outcome, in the order sign-in checks things. */
      const reasons = [];
      let status = 'allowed';
      const eff = signIn.effective;
      if (!user.active) { status = 'refused'; reasons.push('The account is turned off.'); }
      if (eff.blockSignIn) { status = 'refused'; reasons.push(`A policy blocks sign-in (${signIn.rules[0].sources.join(', ')}).`); }
      if (!access.allowed) { status = 'refused'; reasons.push(access.mode === 'none' ? 'Access to this application is turned off.' : `Not a member of a group that may use it (${access.groups.map((g) => g.name).join(', ') || 'none chosen'}).`); }
      const dbUser = db.get('SELECT * FROM users WHERE id = ?', user.id);
      const enrolled = factors.enrolled(dbUser);
      let usable = [];
      if (appPart.reqs && status !== 'refused') {
        usable = factors.eligible(dbUser, { allowedFactors: appPart.reqs.allowedFactors, requirePhishingResistant: appPart.reqs.requirePhishingResistant });
        if (appPart.reqs.requireMfa && !usable.length) { status = 'refused'; reasons.push(`The application needs ${appPart.reqs.allowedFactors ? `one of: ${factorNames(appPart.reqs.allowedFactors)}` : appPart.reqs.requirePhishingResistant ? 'a phishing-resistant factor' : 'a second factor'}, and this person has no sign-in method that meets it.`); }
        else if (appPart.reqs.requireMfa) { status = 'step_up'; reasons.push(`Asked for a second factor first, unless they signed in with one that meets the rule. They can use: ${usable.map((f) => f.label).join(', ')}.`); }
      }
      if (status !== 'refused' && eff.requireMfa && !enrolled.length) reasons.push('Their sign-in policies require a second factor and they have none, so they are taken through setup at sign-in.');
      if (status === 'allowed') reasons.unshift(appPart.reqs ? 'Everything the application requires is already met by a password sign-in.' : 'Nothing stops them: access is open to them and no rule asks for more than their sign-in.');
      outcome = { status, reasons, usable_factors: usable.map((f) => f.label), enrolled_factors: enrolled.map((f) => f.label) };
      text.push('OUTCOME', `  ${status === 'refused' ? '✗ REFUSED' : status === 'step_up' ? '→ ALLOWED after a second factor' : '✓ ALLOWED'}`, ...reasons.map((r) => `  - ${r}`),
        `  Sign-in methods they have set up: ${enrolled.length ? enrolled.map((f) => f.label).join(', ') : 'none (password only)'}`);
      graph.node('outcome', { label: detail(status === 'refused' ? 'Refused' : status === 'step_up' ? 'Allowed after a second factor' : 'Allowed', reasons.map((r) => (r.length > 140 ? `${r.slice(0, 137)}…` : r))), kind: 'outcome', cls: status === 'refused' ? 'bad' : status === 'step_up' ? 'warn' : 'ok', details: reasons.join('\n') });
      graph.edge(appId_, 'outcome', { label: appPart.reqs ? 'access and requirements' : 'access' });
      if (enforcedId) graph.edge(enforcedId, 'outcome', { label: 'sign-in rules' });
    }
  }

  return {
    ...result, sign_in: signIn && { rules: signIn.rules, applied: signIn.applied.map(({ row, memberships, ...p }) => ({ ...p, routes: p.routes.map(groupCalc.routeView) })), roles: signIn.held, global: global ? { name: global.name, rules: ruleSummary(global) } : null },
    access: access && { ...access, via: access.via.map((v) => ({ group: v.group, routes: v.membership.routes.map(groupCalc.routeView) })) },
    app_policies: appPart && { policies: appPart.policies, rules: appPart.rules },
    outcome, text: text.join('\n'), mermaid: graph.toMermaid(), mermaid_vertical: graph.toMermaid('TD'), graph: graph.toJSON(),
  };
}

module.exports = { calculate, ruleSummary };
