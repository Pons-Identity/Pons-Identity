const db = require('../db');
const engine = require('./engine');
const inputs = require('./inputs');

// Functions an administrator writes once and any integration can call as `await fn.name({ ... })`. A function is compiled into
// the run of the integration that calls it, so it has that integration's scopes, variables and call limits, and it can call
// other functions. Its inputs are a table: each row is a key of the object the caller passes, and the variable the code reads
// that value from. It returns one value, which goes back to the caller.

const MAX_FUNCTIONS = 100;
const MAX_TOTAL = 256 * 1024;
const DESCRIPTION_MAX = 300;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const view = (r) => ({
  name: r.name, description: r.description, script: r.script, inputs: JSON.parse(r.inputs || '[]'),
  created_at: r.created_at, created_by: r.created_by, updated_at: r.updated_at,
});
const list = () => db.all('SELECT * FROM integration_functions ORDER BY name COLLATE NOCASE').map(view);

/** Every function's source and inputs by name, for handing to a run. */
const sources = () => Object.fromEntries(db.all('SELECT name, script, inputs FROM integration_functions')
  .map((r) => [r.name, { script: r.script, inputs: JSON.parse(r.inputs || '[]') }]));

/** Checks a submitted function against the others already saved. Returns { errors }, empty when it can be saved. */
function check(name, body) {
  const errors = [];
  if (!NAME_RE.test(name)) errors.push('A function name starts with a letter or underscore and has up to 64 letters, digits or underscores.');
  else if (name in Object.prototype) errors.push(`${name} is a reserved name. Choose another.`);
  const table = inputs.parse(body.inputs);
  errors.push(...table.errors);
  const script = typeof body.script === 'string' ? body.script : '';
  if (!script.trim()) errors.push('Write the function.');
  else if (script.length > engine.MAX_SCRIPT) errors.push(`A function can be at most ${engine.MAX_SCRIPT} characters.`);
  else if (!table.errors.length) {
    const problem = engine.check(script, { params: 'args', prelude: inputs.bindings(table.inputs, 'args ?? {}') });
    if (problem) errors.push(`Script error${problem.line ? ` on line ${problem.line}` : ''}: ${problem.message}`);
  }
  const others = db.all('SELECT name, script FROM integration_functions WHERE name != ?', name);
  if (others.length >= MAX_FUNCTIONS) errors.push(`At most ${MAX_FUNCTIONS} functions are allowed.`);
  if (others.reduce((n, f) => n + f.script.length, script.length) > MAX_TOTAL) errors.push(`All the functions together can be at most ${MAX_TOTAL / 1024} KB.`);
  return { errors };
}

/**
 * Creates or replaces a function by name. Returns { errors } or { function, created }. A function's name is its identity, so
 * renaming one means saving it under the new name and deleting the old.
 */
function save(name, body, by) {
  const { errors } = check(name, body);
  if (errors.length) return { errors };
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, DESCRIPTION_MAX) : '';
  const script = body.script;
  const table = JSON.stringify(inputs.parse(body.inputs).inputs);
  const existed = Boolean(db.get('SELECT 1 FROM integration_functions WHERE name = ?', name));
  const now = new Date().toISOString();
  db.run(`INSERT INTO integration_functions (name, description, script, inputs, created_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(name) DO UPDATE SET description = excluded.description, script = excluded.script, inputs = excluded.inputs, updated_at = excluded.updated_at`,
  name, description, script, table, now, by, now);
  return { function: view(db.get('SELECT * FROM integration_functions WHERE name = ?', name)), created: !existed };
}

const remove = (name) => db.run('DELETE FROM integration_functions WHERE name = ?', name).changes > 0;

module.exports = { list, sources, save, remove, MAX_FUNCTIONS };
