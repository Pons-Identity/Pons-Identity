const db = require('./db');

// Effective membership of built-in groups: direct members inside their start/end window, members of nested
// groups (group_includes), or the set operation of a composite group's two factors. A group with include and
// exclude groups then gains the include group's members and loses the exclude group's. Cycles contribute nothing.

const nowSec = () => Math.floor(Date.now() / 1000);

function loadGraph() {
  const includes = new Map();
  for (const r of db.all('SELECT group_id, member_group_id FROM group_includes')) {
    if (!includes.has(r.group_id)) includes.set(r.group_id, []);
    includes.get(r.group_id).push(r.member_group_id);
  }
  const composites = new Map(db.all('SELECT group_id, op, left_id, right_id FROM group_composites').map((c) => [c.group_id, c]));
  const pairs = new Map(db.all('SELECT group_id, include_id, exclude_id FROM group_include_exclude').map((p) => [p.group_id, p]));
  return { includes, composites, pairs };
}

const directSql = `SELECT user_id FROM group_members WHERE group_id = ?
                   AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at > ?)`;

const directMembers = (groupId, now) => db.all(directSql, groupId, now, now).map((r) => r.user_id);

// The groups a group's membership is built from, in the order they combine: a composite's two factors, or else its nested
// groups; then its include and exclude groups, if it has them.
function inputsOf(groupId, graph) {
  const comp = graph.composites.get(groupId);
  const pair = graph.pairs.get(groupId);
  const base = comp ? [comp.left_id, comp.right_id] : (graph.includes.get(groupId) || []);
  return pair ? [...base, pair.include_id, pair.exclude_id] : base;
}

// The sequence a group's membership is computed in: every group it depends on, each after the groups that feed it, so basis
// groups come first and the group itself last. Groups in a loop never reach the front of the sequence; they contribute no one.
// Groups already in `memo` are taken as done.
function sequenceOf(groupId, graph, memo = new Map()) {
  const nodes = new Set();
  const stack = [groupId];
  while (stack.length) {
    const id = stack.pop();
    if (nodes.has(id) || memo.has(id)) continue;
    nodes.add(id);
    stack.push(...inputsOf(id, graph));
  }
  const waiting = new Map();
  const feeds = new Map();
  for (const id of nodes) {
    const inputs = [...new Set(inputsOf(id, graph))].filter((i) => nodes.has(i));
    waiting.set(id, inputs.length);
    for (const i of inputs) feeds.set(i, [...(feeds.get(i) || []), id]);
  }
  const order = [];
  const ready = [...nodes].filter((id) => waiting.get(id) === 0);
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const next of feeds.get(id) || []) {
      waiting.set(next, waiting.get(next) - 1);
      if (waiting.get(next) === 0) ready.push(next);
    }
  }
  return order;
}

// Who a group's membership is made of, computed from the inputs already in `memo`.
function memberSetOf(groupId, now, graph, memo) {
  const of = (id) => memo.get(id) || new Set();
  const comp = graph.composites.get(groupId);
  let result;
  if (comp) {
    const left = of(comp.left_id);
    const right = of(comp.right_id);
    if (comp.op === 'union') result = new Set([...left, ...right]);
    else if (comp.op === 'intersect') result = new Set([...left].filter((u) => right.has(u)));
    else result = new Set([...left].filter((u) => !right.has(u)));
  } else {
    result = new Set((graph.direct || directMembers)(groupId, now));
    for (const child of graph.includes.get(groupId) || []) for (const u of of(child)) result.add(u);
  }
  const pair = graph.pairs.get(groupId);
  if (pair) {
    for (const u of of(pair.include_id)) result.add(u);
    // Excluded people are out whatever else would put them in, as in Grouper.
    for (const u of of(pair.exclude_id)) result.delete(u);
  }
  return result;
}

// Set of user ids that are effective members of the group. A graph may carry its own `direct` lookup (see groupsOfDraft).
// Computed in sequence (see sequenceOf), so every group is worked out once, after the groups feeding it.
function effectiveMembers(groupId, now = nowSec(), graph = loadGraph(), memo = new Map()) {
  if (!memo.has(groupId)) {
    for (const id of sequenceOf(groupId, graph, memo)) memo.set(id, memberSetOf(id, now, graph, memo));
    // A group that depends on a loop is not in the sequence; a loop is worked out by walking it, which lets back edges contribute no one.
    if (!memo.has(groupId)) walkLoop(groupId, now, graph, memo, new Set());
  }
  return memo.get(groupId);
}

// Works out a group the sequence could not reach, by walking its inputs first. A group already being walked is a loop back to
// itself, and contributes no one.
function walkLoop(groupId, now, graph, memo, visiting) {
  if (memo.has(groupId)) return memo.get(groupId);
  if (visiting.has(groupId)) return new Set();
  visiting.add(groupId);
  for (const input of inputsOf(groupId, graph)) walkLoop(input, now, graph, memo, visiting);
  visiting.delete(groupId);
  const set = memberSetOf(groupId, now, graph, memo);
  memo.set(groupId, set);
  return set;
}

// Groups (id, name, source) the user belongs to, directly or indirectly.
function effectiveGroupsOf(userId, now = nowSec()) {
  userId = Number(userId);
  const graph = loadGraph();
  const memo = new Map();
  return db.all('SELECT id, name, source FROM groups ORDER BY name')
    .filter((g) => effectiveMembers(g.id, now, graph, memo).has(userId));
}

// How people come to be effective members of a group, for showing them: Map(userId -> { direct, via: [{ id, name }], composite }).
// `direct` means a membership row of their own (an open-ended or in-window one); `via` lists the nested groups, or the factors of a
// composite, they are in because of. A person can be both.
function explainMembers(groupId, now = nowSec(), graph = loadGraph(), memo = new Map()) {
  groupId = Number(groupId);
  const names = new Map(db.all('SELECT id, name FROM groups').map((g) => [g.id, g.name]));
  const out = new Map();
  const note = (u) => { if (!out.has(u)) out.set(u, { direct: false, via: [], composite: null }); return out.get(u); };
  const ref = (id) => ({ id, name: names.get(id) || String(id) });
  const eff = (id) => effectiveMembers(id, now, graph, memo);
  const comp = graph.composites.get(groupId);
  if (comp) {
    const left = eff(comp.left_id);
    const right = eff(comp.right_id);
    for (const u of eff(groupId)) {
      const e = note(u);
      e.composite = comp.op;
      const factors = comp.op === 'union' ? [left.has(u) && comp.left_id, right.has(u) && comp.right_id] : comp.op === 'intersect' ? [comp.left_id, comp.right_id] : [comp.left_id];
      e.via = factors.filter(Boolean).map(ref);
    }
  } else {
    for (const u of (graph.direct || directMembers)(groupId, now)) note(u).direct = true;
    for (const child of graph.includes.get(groupId) || []) for (const u of eff(child)) note(u).via.push(ref(child));
  }
  const pair = graph.pairs.get(groupId);
  if (pair) {
    for (const u of eff(pair.include_id)) note(u).via.push(ref(pair.include_id));
    // Drop anyone the exclude group removes, including direct members.
    const members = eff(groupId);
    for (const u of [...out.keys()]) if (!members.has(u)) out.delete(u);
  }
  return out;
}

/** "Direct", "Indirect" or "Direct, Indirect": the plain-words answer to how someone ended up in a group. */
const howLabel = (e) => (e.direct && e.via.length ? 'Direct, Indirect' : e.direct ? 'Direct' : 'Indirect');

// Every group the user is in, with how: [{ id, name, source, direct, via: [{ id, name }], how }].
function membershipsOf(userId, now = nowSec()) {
  userId = Number(userId);
  const graph = loadGraph();
  const memo = new Map();
  const names = new Map(db.all('SELECT id, name FROM groups').map((g) => [g.id, g.name]));
  const ref = (id) => ({ id, name: names.get(id) || String(id) });
  const direct = new Set(db.all(`SELECT group_id FROM group_members WHERE user_id = ? AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at > ?)`, userId, now, now).map((r) => r.group_id));
  const has = (id) => effectiveMembers(id, now, graph, memo).has(userId);
  return effectiveGroupsOfWith(userId, now, graph, memo).map((g) => {
    const comp = graph.composites.get(g.id);
    const pair = graph.pairs.get(g.id);
    const e = { direct: !comp && direct.has(g.id), via: [] };
    if (comp) {
      e.via = (comp.op === 'union' ? [comp.left_id, comp.right_id].filter(has) : comp.op === 'intersect' ? [comp.left_id, comp.right_id] : [comp.left_id]).map(ref);
    } else {
      e.via = (graph.includes.get(g.id) || []).filter(has).map(ref);
    }
    if (pair && has(pair.include_id)) e.via.push(ref(pair.include_id));
    return { ...g, direct: e.direct, via: e.via, how: howLabel(e) };
  });
}

function effectiveGroupsOfWith(userId, now, graph, memo) {
  return db.all('SELECT id, name, source FROM groups ORDER BY name').filter((g) => effectiveMembers(g.id, now, graph, memo).has(userId));
}

// Groups (id, name, source) a person would belong to if they were given `groupIds` directly. The person does not exist yet, so a
// placeholder member stands in for them and nesting and composites resolve as they will once the account is saved.
const DRAFT_MEMBER = -1;
function groupsOfDraft(groupIds, now = nowSec()) {
  const graph = { ...loadGraph(), direct: (groupId) => (groupIds.includes(groupId) ? [DRAFT_MEMBER] : []) };
  const memo = new Map();
  return db.all('SELECT id, name, source FROM groups ORDER BY name')
    .filter((g) => effectiveMembers(g.id, now, graph, memo).has(DRAFT_MEMBER));
}

const isEffectiveMember = (groupId, userId, now = nowSec()) => effectiveMembers(Number(groupId), now).has(Number(userId));

// Makes the user a direct member. A lapsed or not-yet-started row is renewed as open-ended (re-adding someone whose
// membership ended should work); a current row, and any end date it carries, is left alone. True if anything changed.
function addDirect(groupId, userId, now = nowSec()) {
  return db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)
                 ON CONFLICT(group_id, user_id) DO UPDATE SET start_at = NULL, end_at = NULL
                 WHERE (end_at IS NOT NULL AND end_at <= ?) OR (start_at IS NOT NULL AND start_at > ?)`,
  Number(groupId), Number(userId), now, now).changes > 0;
}

// Every group that depends on `groupId`, directly or through others: each takes it as a member group, a composite factor or
// an include or exclude group. Adding one of them as a member of `groupId` would create a loop.
function containersOf(groupId) {
  const graph = loadGraph();
  const above = new Map();
  const link = (input, group) => above.set(input, [...(above.get(input) || []), group]);
  for (const [group, children] of graph.includes) for (const child of children) link(child, group);
  for (const [group, c] of graph.composites) { link(c.left_id, group); link(c.right_id, group); }
  for (const [group, p] of graph.pairs) { link(p.include_id, group); link(p.exclude_id, group); }
  const found = new Set();
  const stack = [Number(groupId)];
  while (stack.length) {
    for (const group of above.get(stack.pop()) || []) {
      if (!found.has(group)) { found.add(group); stack.push(group); }
    }
  }
  return found;
}

// Would adding `childId` under `parentId` (as a nested group or composite factor) create a cycle?
function wouldCycle(parentId, childId) {
  if (parentId === childId) return true;
  const { includes, composites, pairs } = loadGraph();
  const seen = new Set();
  const stack = [childId];
  while (stack.length) {
    const id = stack.pop();
    if (id === parentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(includes.get(id) || []));
    const c = composites.get(id);
    if (c) stack.push(c.left_id, c.right_id);
    const p = pairs.get(id);
    if (p) stack.push(p.include_id, p.exclude_id);
  }
  return false;
}

module.exports = { addDirect, loadGraph, inputsOf, sequenceOf, effectiveMembers, explainMembers, howLabel, membershipsOf, effectiveGroupsOf, groupsOfDraft, isEffectiveMember, wouldCycle, containersOf };
