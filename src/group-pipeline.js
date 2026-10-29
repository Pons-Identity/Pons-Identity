const db = require('./db');
const gm = require('./group-membership');
const { ownerOf, pairOf } = require('./group-include-exclude');

// Where a group sits in the pipeline that builds application groups, as in Grouper:
//   basis        fed by no other group: its members come from a system of record (direct members, a query, or a
//                provisioned source), and it feeds another group
//   reference    fed by other groups, and feeds another group: an intermediate step
//   application  feeds no other group: the end of the pipeline, which applications read
const ROLE_LABELS = { basis: 'Basis', reference: 'Reference', application: 'Application' };

/** The role of each group, as a Map from group id to 'basis', 'reference' or 'application'. */
function rolesOf(graph = gm.loadGraph(), groups = db.all('SELECT id FROM groups')) {
  const fed = new Set();
  for (const { id } of groups) for (const input of gm.inputsOf(id, graph)) fed.add(input);
  return new Map(groups.map(({ id }) => {
    let role = 'application';
    if (fed.has(id)) role = gm.inputsOf(id, graph).length === 0 ? 'basis' : 'reference';
    return [id, role];
  }));
}

/**
 * The sequence that builds a group's membership, for showing: each step is a group in the order it is computed, with its
 * role, how many people it has, and what feeds it. The last step is the group itself.
 */
function pipelineOf(groupId) {
  const graph = gm.loadGraph();
  const roles = rolesOf(graph);
  const memo = new Map();
  const now = Math.floor(Date.now() / 1000);
  gm.effectiveMembers(groupId, now, graph, memo);
  const names = new Map(db.all('SELECT id, name FROM groups').map((g) => [g.id, g.name]));
  const ref = (id) => ({ id, name: names.get(id) || String(id), role: roles.get(id) });
  const hasDirect = (id) => Boolean(db.get('SELECT 1 FROM group_members WHERE group_id = ? LIMIT 1', id));

  const steps = gm.sequenceOf(groupId, graph).map((id) => {
    const comp = graph.composites.get(id);
    const pair = graph.pairs.get(id);
    const inputs = [];
    if (comp) {
      inputs.push({ relation: 'left', group: ref(comp.left_id) }, { relation: 'right', group: ref(comp.right_id) });
    } else {
      if (hasDirect(id)) inputs.push({ relation: 'direct' });
      for (const child of graph.includes.get(id) || []) inputs.push({ relation: 'nested', group: ref(child) });
      const rule = db.get('SELECT filter FROM group_rules WHERE group_id = ?', id);
      if (rule) inputs.push({ relation: 'query', filter: rule.filter });
    }
    if (pair) inputs.push({ relation: 'include', group: ref(pair.include_id) }, { relation: 'exclude', group: ref(pair.exclude_id) });
    return { ...ref(id), count: memo.get(id).size, op: comp ? comp.op : null, inputs };
  });
  // An include or exclude group belongs to the group it serves, and does not need pairs of its own.
  const owner = ownerOf(groupId);
  const kind = owner && pairOf(owner.id).include_id === Number(groupId) ? 'include' : 'exclude';
  return { role: roles.get(Number(groupId)), steps, part_of: owner ? { id: owner.id, name: owner.name, kind } : null };
}

module.exports = { ROLE_LABELS, rolesOf, pipelineOf };
