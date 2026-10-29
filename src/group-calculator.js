const db = require('./db');
const gm = require('./group-membership');
const { rolesOf, ROLE_LABELS } = require('./group-pipeline');
const { ownerOf } = require('./group-include-exclude');
const { Graph } = require('./calculator-graph');

// The Group calculator explains group membership in two directions:
//   membership    how a person comes to be in a group: every route they took (a membership row of their own, a query, a nested group, a
//                 factor of a composite, an include group), and, if they are not in it, what keeps them out;
//   construction  how a group is built: its direct members, query, nested groups, composite factors, and include and exclude groups,
//                 and the groups those are built from in turn.
// Each answer comes as text and as a diagram (Mermaid text and the nodes and links the console draws it from). Both are made from the
// same facts, so they never disagree.

const nowSec = () => Math.floor(Date.now() / 1000);
const MAX_ROUTES = 50;
const MAX_NODES = 300;
const SOURCE_NAMES = { local: 'managed here', grouper: 'Grouper', directory: 'external directory' };
const OP_NAMES = { union: 'union', intersect: 'intersection', minus: 'difference' };
const OP_WORDS = { union: 'in either', intersect: 'in both', minus: 'in the first and not in the second' };

const quoted = (name) => `"${name}"`;
const when = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Everything the calculator needs to look at one moment: the group graph, a membership cache and group names and sources. */
function context(now = nowSec()) {
  const graph = gm.loadGraph();
  const memo = new Map();
  const groups = new Map(db.all('SELECT id, name, source, description FROM groups').map((g) => [g.id, g]));
  return { now, graph, memo, groups, roles: rolesOf(graph, [...groups.keys()].map((id) => ({ id }))), nodes: new Map() };
}

const groupRef = (ctx, id) => {
  const g = ctx.groups.get(id);
  return { id, name: g ? g.name : String(id), source: g ? g.source : 'local', role: ctx.roles.get(id) || 'application' };
};

/* -------------------------------------------------------------------------- */
/*  Membership: how one person comes to be in a group                          */
/* -------------------------------------------------------------------------- */

/** The person's own membership row in a group, with whether it is in force now. Null when there is none. */
function directInfo(ctx, groupId, userId) {
  const row = db.get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);
  if (!row) return null;
  const notStarted = row.start_at !== null && row.start_at > ctx.now;
  const expired = row.end_at !== null && row.end_at <= ctx.now;
  const rule = row.via_rule ? db.get('SELECT filter, mode FROM group_rules WHERE group_id = ?', groupId) : null;
  return {
    active: !notStarted && !expired, state: notStarted ? 'not_started' : expired ? 'expired' : 'active',
    start_at: row.start_at, end_at: row.end_at, by_rule: Boolean(row.via_rule), rule: rule ? { filter: rule.filter, mode: rule.mode } : null,
    pinned: Boolean(row.pinned), by_source: Boolean(row.via_grouper),
  };
}

/**
 * Works out, for one group and one person, which of the group's inputs put the person in it. The result is a tree that follows the
 * group's own structure: a standard group has `direct` and `nested`; a composite has `composite`; either may have `include` and `exclude`.
 * Each node says whether the person is a member (`member`), whether they would be but for the exclude group (`excluded`), and, for
 * groups in a loop, `loop`. A node reached twice is the same object, so the result is a graph.
 */
function explainNode(ctx, userId, groupId, trail = []) {
  if (ctx.nodes.has(groupId)) return ctx.nodes.get(groupId);
  const ref = groupRef(ctx, groupId);
  if (trail.includes(groupId)) return { ...ref, member: false, loop: true };
  const next = [...trail, groupId];
  const sub = (id) => explainNode(ctx, userId, id, next);
  const node = { ...ref, member: gm.effectiveMembers(groupId, ctx.now, ctx.graph, ctx.memo).has(userId), excluded: false };

  const comp = ctx.graph.composites.get(groupId);
  let base;
  if (comp) {
    node.composite = { op: comp.op, left: sub(comp.left_id), right: sub(comp.right_id) };
    const { left, right } = node.composite;
    base = comp.op === 'union' ? left.member || right.member : comp.op === 'intersect' ? left.member && right.member : left.member && !right.member;
  } else {
    node.direct = directInfo(ctx, groupId, userId);
    node.nested = (ctx.graph.includes.get(groupId) || []).map(sub);
    base = Boolean(node.direct?.active) || node.nested.some((n) => n.member);
  }
  const pair = ctx.graph.pairs.get(groupId);
  if (pair) {
    node.include = sub(pair.include_id);
    node.exclude = sub(pair.exclude_id);
    node.excluded = Boolean(node.exclude.member && (base || node.include.member));
  }
  ctx.nodes.set(groupId, node);
  return node;
}

// One way of arriving in a group: `chain` runs from where the person came from to the group asked about, each step naming the group
// entered and how; `notes` are further conditions that held on the way (the other side of an intersection, a difference).
const OPENING = {
  direct: (g) => `direct member of ${quoted(g.name)}`,
  pinned: (g) => `pinned in ${quoted(g.name)}`,
  query: (g) => `added by the query of ${quoted(g.name)}`,
  source: (g) => `provided by ${SOURCE_NAMES[g.source] || g.source} to ${quoted(g.name)}`,
};
const ENTERING = {
  nested: (g) => `nested in ${quoted(g.name)}`,
  left: (g, op) => `first group of the ${OP_NAMES[op]} ${quoted(g.name)}`,
  right: (g, op) => `second group of the ${OP_NAMES[op]} ${quoted(g.name)}`,
  include: (g) => `include group of ${quoted(g.name)}`,
};
const describeStep = (step) => (OPENING[step.relation] || ENTERING[step.relation])(step.group, step.op);

function openingRelation(node) {
  if (node.direct.by_rule) return 'query';
  if (node.direct.by_source || node.source !== 'local') return 'source';
  return node.direct.pinned ? 'pinned' : 'direct';
}

/** Every route that makes the person a member of the node's group, as { chain: [{ group, relation, op }], notes: [] }. */
function routesOf(node, seen = new Set()) {
  if (!node.member || node.loop || seen.has(node.id)) return [];
  const here = new Set(seen).add(node.id);
  const step = (relation) => ({ group: { id: node.id, name: node.name }, relation, op: node.composite?.op });
  const out = [];
  const through = (child, relation, notes = []) => {
    for (const r of routesOf(child, here)) out.push({ chain: [...r.chain, step(relation)], notes: [...r.notes, ...notes] });
  };

  if (node.composite) {
    const { op, left, right } = node.composite;
    if (op === 'union') {
      if (left.member) through(left, 'left');
      if (right.member) through(right, 'right');
    } else if (op === 'intersect') {
      const other = routesOf(right, here)[0];
      through(left, 'left', [`and also in ${quoted(right.name)}${other ? `, as ${describeRoute(other)}` : ''}`]);
    } else {
      through(left, 'left', [`and not in ${quoted(right.name)}`]);
    }
  } else {
    if (node.direct?.active) out.push({ chain: [step(openingRelation(node))], notes: node.direct.end_at ? [`until ${when(node.direct.end_at)}`] : [] });
    for (const child of node.nested) if (child.member) through(child, 'nested');
  }
  if (node.include?.member) through(node.include, 'include');
  return out.slice(0, MAX_ROUTES);
}

/** A route on one line: `direct member of "A" → nested in "B"`. */
const describeRoute = (route) => route.chain.map(describeStep).join(' → ');

/** Why the person is not in the node's group: short sentences, outermost first. */
function whyNot(node, depth = 0, seen = new Set()) {
  if (node.member || seen.has(node.id)) return [];
  seen.add(node.id);
  const out = [];
  const say = (text) => out.push({ depth, text });
  const below = (child) => out.push(...whyNot(child, depth + 1, seen));
  if (node.loop) { say(`${quoted(node.name)} depends on itself, so it adds no one.`); return out; }
  if (node.composite) {
    const { op, left, right } = node.composite;
    if (op === 'union') say(`not in either side of the union ${quoted(node.name)}.`);
    else if (op === 'intersect') say(`the intersection ${quoted(node.name)} needs both sides, and ${[!left.member && quoted(left.name), !right.member && quoted(right.name)].filter(Boolean).join(' and ')} ${left.member || right.member ? 'is' : 'are'} missing.`);
    else if (!left.member) say(`not in ${quoted(left.name)}, the group the difference ${quoted(node.name)} starts from.`);
    else say(`in ${quoted(left.name)} but also in ${quoted(right.name)}, which the difference ${quoted(node.name)} removes.`);
    for (const side of [left, right]) if (!side.member && !(op === 'minus' && side === right)) below(side);
  } else {
    if (!node.direct) say(`no membership of their own in ${quoted(node.name)}.`);
    else if (node.direct.state === 'expired') say(`their membership in ${quoted(node.name)} ended ${when(node.direct.end_at)}.`);
    else if (node.direct.state === 'not_started') say(`their membership in ${quoted(node.name)} starts ${when(node.direct.start_at)}.`);
    if (node.nested.length) say(`not in any nested group of ${quoted(node.name)} (${node.nested.map((n) => quoted(n.name)).join(', ')}).`);
    for (const child of node.nested) below(child);
  }
  if (node.excluded) say(`${quoted(node.name)} removes them: they are in its exclude group ${quoted(node.exclude.name)}.`);
  return out;
}

/* ------------------------------- Rendering -------------------------------- */

// Lays out { label, children } as an indented tree with line-drawing characters.
function treeLines(tree, prefix = '', last = true, root = true) {
  const lines = [root ? tree.label : `${prefix}${last ? '└─ ' : '├─ '}${tree.label}`];
  const childPrefix = root ? '' : prefix + (last ? '   ' : '│  ');
  (tree.children || []).forEach((c, i) => lines.push(...treeLines(c, childPrefix, i === tree.children.length - 1, false)));
  return lines;
}

const tag = (n) => `[${ROLE_LABELS[n.role] || n.role}${n.source !== 'local' ? `, ${SOURCE_NAMES[n.source] || n.source}` : ''}]`;

function directText(d) {
  if (!d) return 'no membership of their own';
  const how = d.by_rule ? `added by the group's query ${d.rule ? d.rule.filter : ''}`.trim() : d.pinned ? 'pinned' : d.by_source ? 'provided by the source system' : 'added directly';
  if (d.state === 'expired') return `${how}, but it ended ${when(d.end_at)}`;
  if (d.state === 'not_started') return `${how}, starting ${when(d.start_at)}`;
  return `${how}${d.start_at ? `, since ${when(d.start_at)}` : ''}${d.end_at ? `, until ${when(d.end_at)}` : ''}`;
}

/** The node as a tree for the text output: what each input of every group contributes for this person. */
function membershipTree(node, prefix = '', shown = new Set()) {
  const mark = node.member ? '✓' : '✗';
  const head = `${prefix}${mark} ${node.name} ${tag(node)} ${node.loop ? '(loops back to itself)' : node.member ? 'member' : 'not a member'}`;
  if (shown.has(node.id) || node.loop) return { label: shown.has(node.id) ? `${head} (shown above)` : head, children: [] };
  shown.add(node.id);
  const children = [];
  if (node.composite) {
    const { op, left, right } = node.composite;
    children.push(membershipTree(left, `First group of the ${OP_NAMES[op]} (${OP_WORDS[op]}): `, shown));
    children.push(membershipTree(right, `Second group: `, shown));
  } else {
    children.push({ label: `Own membership: ${directText(node.direct)}`, children: [] });
    for (const child of node.nested) children.push(membershipTree(child, 'Nested group: ', shown));
  }
  if (node.include) {
    children.push(membershipTree(node.include, 'Include group: ', shown));
    children.push(membershipTree(node.exclude, 'Exclude group: ', shown));
    if (node.excluded) children.push({ label: 'Removed by the exclude group, whatever else would put them in', children: [] });
  }
  return { label: head, children };
}

const routeLines = (routes) => routes.map((r, i) => `  ${i + 1}. ${describeRoute(r)}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);

// Adds the person's route into a group to a diagram: the person, and each group that took part, with the edges that carried them.
// Groups the person is not in are drawn muted, with dotted edges. Returns the node id of the group.
function addMembershipToGraph(graph, userId, node, { contributingOnly = false, seen = new Set() } = {}) {
  const id = `g${node.id}`;
  if (seen.has(node.id)) return id;
  seen.add(node.id);
  graph.node(id, { label: node.name, cls: node.member ? node.role : 'muted', details: `${ROLE_LABELS[node.role] || node.role} group${node.member ? '' : ' (not a member)'}`, link: `/admin/groups/${node.id}` });
  const feed = (child, label, extra = {}) => {
    if (contributingOnly && !child.member) return;
    const from = addMembershipToGraph(graph, userId, child, { contributingOnly, seen });
    graph.edge(from, id, { label, style: child.member && !extra.dotted ? 'solid' : 'dotted', tone: extra.tone });
  };
  if (node.composite) {
    const { op, left, right } = node.composite;
    feed(left, `${OP_NAMES[op]}, first`);
    feed(right, op === 'minus' ? 'minus' : `${OP_NAMES[op]}, second`, op === 'minus' ? { dotted: true, tone: right.member ? 'bad' : undefined } : {});
  } else {
    const d = node.direct;
    if (d && (d.active || !contributingOnly)) {
      const label = d.state !== 'active' ? (d.state === 'expired' ? 'membership ended' : 'membership not started') : d.by_rule ? 'matched query' : d.by_source ? 'provided by source' : d.pinned ? 'pinned' : 'direct member';
      graph.edge(`u${userId}`, id, { label, style: d.active ? 'solid' : 'dotted' });
    }
    for (const child of node.nested) feed(child, 'nested in');
  }
  if (node.include) {
    feed(node.include, 'include group');
    feed(node.exclude, 'excludes', { dotted: true, tone: node.exclude.member ? 'bad' : undefined });
  }
  return id;
}

/** How one person comes to be in one group: { member, routes, why_not, text lines, graph }. Used by the policy calculator too. */
function membership(userId, groupId, ctx = context()) {
  const node = explainNode(ctx, userId, groupId);
  const routes = routesOf(node);
  return { ctx, node, member: node.member, routes, why_not: node.member ? [] : whyNot(node) };
}

/* -------------------------------------------------------------------------- */
/*  Construction: how a group is built                                         */
/* -------------------------------------------------------------------------- */

function sourceInfo(ctx, groupId) {
  const now = ctx.now;
  const total = db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', groupId).n;
  const active = db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at > ?)', groupId, now, now).n;
  const byRule = db.get('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND via_rule = 1', groupId).n;
  const rule = db.get('SELECT filter, mode, last_run_at FROM group_rules WHERE group_id = ?', groupId) || null;
  return { total, active, by_rule: byRule, rule };
}

/**
 * The structure of a group: what feeds it, and what feeds those, down to the groups with members of their own. A group reached a
 * second time is marked `repeat` and not opened again. Inputs are { relation, group } with relation one of `direct`, `query`,
 * `source`, `nested`, `left`, `right`, `include`, `exclude`.
 */
function constructionOf(ctx, groupId, state = { opened: new Map(), count: 0 }, trail = []) {
  const ref = groupRef(ctx, groupId);
  const members = gm.effectiveMembers(groupId, ctx.now, ctx.graph, ctx.memo).size;
  const node = { ...ref, count: members, inputs: [] };
  if (trail.includes(groupId)) return { ...node, loop: true };
  if (state.opened.has(groupId)) return { ...node, repeat: true };
  state.opened.set(groupId, node);
  state.count += 1;
  const open = (id) => (state.count >= MAX_NODES ? { ...groupRef(ctx, id), count: 0, inputs: [], cut: true } : constructionOf(ctx, id, state, [...trail, groupId]));

  const comp = ctx.graph.composites.get(groupId);
  if (comp) {
    node.op = comp.op;
    node.inputs.push({ relation: 'left', group: open(comp.left_id) }, { relation: 'right', group: open(comp.right_id) });
  } else {
    const info = sourceInfo(ctx, groupId);
    node.direct = info;
    node.rule = info.rule;
    const own = info.active - info.by_rule;
    if (ctx.groups.get(groupId)?.source !== 'local') node.inputs.push({ relation: 'source', people: info.active });
    else if (own > 0) node.inputs.push({ relation: 'direct', people: own });
    if (info.rule) node.inputs.push({ relation: 'query', filter: info.rule.filter, mode: info.rule.mode, people: info.by_rule });
    for (const child of ctx.graph.includes.get(groupId) || []) node.inputs.push({ relation: 'nested', group: open(child) });
  }
  const pair = ctx.graph.pairs.get(groupId);
  if (pair) node.inputs.push({ relation: 'include', group: open(pair.include_id) }, { relation: 'exclude', group: open(pair.exclude_id) });
  return node;
}

const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

function constructionTree(node, prefix = '', shown = new Set()) {
  const op = node.op ? ` — ${OP_NAMES[node.op]}` : '';
  const head = `${prefix}${node.name} ${tag(node)}${op}, ${people(node.count)}`;
  if (node.loop) return { label: `${head} (loops back to a group above; adds no one)`, children: [] };
  if (node.cut) return { label: `${head} (not expanded: the diagram is limited to ${MAX_NODES} groups)`, children: [] };
  if (node.repeat) return { label: `${head} (built as shown above)`, children: [] };
  const children = node.inputs.map((i) => {
    switch (i.relation) {
      case 'direct': return { label: `Direct members: ${people(i.people)}`, children: [] };
      case 'source': return { label: `Provided by ${SOURCE_NAMES[node.source] || node.source}: ${people(i.people)}`, children: [] };
      case 'query': return { label: `${i.mode === 'ongoing' ? 'Ongoing' : 'Snapshot'} query ${i.filter}: ${people(i.people)} added by it`, children: [] };
      case 'nested': return constructionTree(i.group, 'Nested group: ', shown);
      case 'left': return constructionTree(i.group, `First group (${OP_WORDS[node.op]}): `, shown);
      case 'right': return constructionTree(i.group, 'Second group: ', shown);
      case 'include': return constructionTree(i.group, 'Include group: ', shown);
      default: return constructionTree(i.group, 'Exclude group (removes its members): ', shown);
    }
  });
  if (!children.length) children.push({ label: 'Nothing feeds it yet: no members, query or nested groups', children: [] });
  return { label: head, children };
}

/** Adds a group's structure to a diagram, inputs pointing at the group they feed. */
function addConstructionToGraph(graph, node, seen = new Set()) {
  const id = `g${node.id}`;
  const label = `${node.name}${node.op ? ` (${OP_NAMES[node.op]})` : ''} · ${people(node.count)}`;
  graph.node(id, { label, kind: node.op ? 'rule' : 'plain', cls: node.role, details: `${ROLE_LABELS[node.role]} group, ${SOURCE_NAMES[node.source] || node.source}`, link: `/admin/groups/${node.id}` });
  if (seen.has(node.id) || node.repeat || node.loop || node.cut) {
    return id;
  }
  seen.add(node.id);
  for (const i of node.inputs) {
    if (i.group) {
      const from = addConstructionToGraph(graph, i.group, seen);
      const label = { nested: 'nested in', left: node.op ? `${OP_NAMES[node.op]}, first` : 'first', right: node.op === 'minus' ? 'minus' : `${OP_NAMES[node.op]}, second`, include: 'include group', exclude: 'excludes' }[i.relation];
      graph.edge(from, id, { label, style: i.relation === 'exclude' || (i.relation === 'right' && node.op === 'minus') ? 'dotted' : 'solid', tone: i.relation === 'exclude' ? 'bad' : undefined });
    } else if (i.relation === 'query') {
      const q = `q${node.id}`;
      graph.node(q, { label: `Query ${i.filter}`, cls: 'muted', details: `${i.mode} query, ${people(i.people)} added` });
      graph.edge(q, id, { label: i.mode });
    } else {
      const d = `d${node.id}`;
      graph.node(d, { label: i.relation === 'source' ? `${SOURCE_NAMES[node.source] || node.source} · ${people(i.people)}` : `Direct members · ${people(i.people)}`, cls: 'muted' });
      graph.edge(d, id, { label: i.relation === 'source' ? 'provided' : 'added' });
    }
  }
  return id;
}

/** Where a group is used: groups built from it, the policies and applications that name it, and roles it grants. Plain sentences. */
function usedBy(ctx, groupId) {
  const lines = [];
  for (const [parent, children] of ctx.graph.includes) if (children.includes(groupId)) lines.push({ kind: 'group', id: parent, text: `Nested in ${quoted(ctx.groups.get(parent)?.name)}` });
  for (const [parent, c] of ctx.graph.composites) {
    if (c.left_id === groupId) lines.push({ kind: 'group', id: parent, text: `First group of the ${OP_NAMES[c.op]} ${quoted(ctx.groups.get(parent)?.name)}` });
    if (c.right_id === groupId) lines.push({ kind: 'group', id: parent, text: `Second group of the ${OP_NAMES[c.op]} ${quoted(ctx.groups.get(parent)?.name)}` });
  }
  const owner = ownerOf(groupId);
  if (owner) lines.push({ kind: 'group', id: owner.id, text: `The include or exclude group of ${quoted(owner.name)}` });
  for (const p of db.all('SELECT p.name FROM policies p JOIN policy_groups pg ON pg.policy_id = p.id WHERE pg.group_id = ?', groupId)) lines.push({ kind: 'policy', text: `Sign-in policy ${quoted(p.name)} applies to its members` });
  for (const p of db.all('SELECT p.name FROM compromise_policies p JOIN compromise_policy_groups pg ON pg.policy_id = p.id WHERE pg.group_id = ?', groupId)) lines.push({ kind: 'policy', text: `Compromised account policy ${quoted(p.name)} applies to its members` });
  for (const a of db.all('SELECT a.name FROM app_access_groups x JOIN apps a ON a.id = x.app_id WHERE x.group_id = ?', groupId)) lines.push({ kind: 'app', text: `Members may use the application ${quoted(a.name)}` });
  for (const s of db.all('SELECT s.name FROM sp_access_groups x JOIN service_providers s ON s.id = x.sp_id WHERE x.group_id = ?', groupId)) lines.push({ kind: 'app', text: `Members may use the service provider ${quoted(s.name)}` });
  for (const r of db.all('SELECT r.name FROM grouper_role_map m JOIN roles r ON r.id = m.role_id JOIN groups g ON g.name = m.group_name COLLATE NOCASE WHERE g.id = ?', groupId)) lines.push({ kind: 'role', text: `Members hold the role ${quoted(r.name)}` });
  return lines;
}

/* -------------------------------------------------------------------------- */
/*  The calculator                                                             */
/* -------------------------------------------------------------------------- */

const userRef = (userId) => {
  const u = db.get('SELECT id, username, display_name FROM users WHERE id = ?', userId);
  return u && { id: u.id, username: u.username, display_name: u.display_name };
};
const who = (u) => `${u.username}${u.display_name && u.display_name !== u.username ? ` (${u.display_name})` : ''}`;

/**
 * Runs the calculator. Give a person, a group, or both:
 *   person and group  how that person comes to be in that group (or why not);
 *   person alone      every group they are in and the routes that put them there;
 *   group alone       how the group is built.
 * Returns { mode, user, group, text, mermaid, mermaid_vertical, graph } or { error }.
 */
function calculate({ userId = null, groupId = null, now = nowSec() } = {}) {
  const user = userId ? userRef(Number(userId)) : null;
  if (userId && !user) return { error: 'No such person.' };
  const ctx = context(now);
  const group = groupId ? ctx.groups.get(Number(groupId)) : null;
  if (groupId && !group) return { error: 'No such group.' };
  if (!user && !group) return { error: 'Choose a person, a group, or both.' };

  const graph = new Graph({ limit: MAX_NODES + 50 });
  const out = [];

  if (user && group) {
    const m = membership(user.id, group.id, ctx);
    graph.node(`u${user.id}`, { label: who(user), kind: 'user', cls: 'user', link: `/admin/users/${user.id}` });
    addMembershipToGraph(graph, user.id, m.node);
    out.push(`GROUP CALCULATOR — ${user.username} and ${quoted(group.name)}`, '');
    out.push(m.member ? `${who(user)} IS a member of ${quoted(group.name)}, by ${m.routes.length} ${m.routes.length === 1 ? 'route' : 'routes'}.` : `${who(user)} is NOT a member of ${quoted(group.name)}.`, '');
    if (m.member) out.push('ROUTES (each one alone is enough)', ...routeLines(m.routes), '');
    else out.push('WHY NOT', ...m.why_not.map((w) => `${'  '.repeat(w.depth + 1)}- ${w.text}`), '');
    out.push(`HOW ${quoted(group.name).toUpperCase()} WAS WORKED OUT FOR ${user.username.toUpperCase()}`, ...treeLines(membershipTree(m.node)).map((l) => `  ${l}`));
    return finish('membership', { user, group: groupRef(ctx, group.id), member: m.member, routes: m.routes.map(routeView) }, out, graph);
  }

  if (user) {
    const mine = gm.effectiveGroupsOf(user.id, now);
    graph.node(`u${user.id}`, { label: who(user), kind: 'user', cls: 'user', link: `/admin/users/${user.id}` });
    out.push(`GROUP CALCULATOR — all groups of ${user.username}`, '', `${who(user)} is in ${mine.length} ${mine.length === 1 ? 'group' : 'groups'}.`, '');
    const summary = [];
    for (const g of mine) {
      const m = membership(user.id, g.id, ctx);
      addMembershipToGraph(graph, user.id, m.node, { contributingOnly: true });
      summary.push({ group: groupRef(ctx, g.id), routes: m.routes.map(routeView) });
      out.push(`${g.name} ${tag(groupRef(ctx, g.id))} — ${m.routes.length} ${m.routes.length === 1 ? 'route' : 'routes'}`, ...routeLines(m.routes), '');
    }
    return finish('user', { user, groups: summary }, out, graph);
  }

  const tree = constructionOf(ctx, group.id);
  addConstructionToGraph(graph, tree);
  const used = usedBy(ctx, group.id);
  const parents = [...new Map(used.filter((u) => u.kind === 'group').map((u) => [u.id, u])).values()];
  for (const p of parents) {
    graph.node(`g${p.id}`, { label: ctx.groups.get(p.id).name, cls: ctx.roles.get(p.id), link: `/admin/groups/${p.id}` });
    graph.edge(`g${group.id}`, `g${p.id}`, { label: 'used by', style: 'dotted' });
  }
  out.push(`GROUP CALCULATOR — how ${quoted(group.name)} is built`, '', ...treeLines(constructionTree(tree)).map((l) => `  ${l}`), '');
  const distinct = new Set();
  const walk = (n) => { if (n.repeat || n.loop || distinct.has(n.id)) return; distinct.add(n.id); n.inputs.forEach((i) => i.group && walk(i.group)); };
  walk(tree);
  out.push(`${distinct.size} ${distinct.size === 1 ? 'group takes' : 'groups take'} part in building it, ${people(tree.count)} in the end.`, '');
  out.push('USED BY', ...(used.length ? used.map((u) => `  - ${u.text}`) : ['  Nothing uses this group yet.']));
  return finish('group', { group: groupRef(ctx, group.id), construction: tree, used_by: used }, out, graph);
}

const routeView = (r) => ({ steps: r.chain.map((s) => ({ group: s.group, relation: s.relation, text: describeStep(s) })), notes: r.notes, text: describeRoute(r) });

function finish(mode, data, lines, graph) {
  return { mode, ...data, text: lines.join('\n'), mermaid: graph.toMermaid(), mermaid_vertical: graph.toMermaid('TD'), graph: graph.toJSON() };
}

module.exports = {
  calculate, context, membership, explainNode, routesOf, describeRoute, addMembershipToGraph, treeLines, routeLines, routeView, tag, who, quoted, SOURCE_NAMES,
};
