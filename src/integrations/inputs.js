// The inputs an integration or a function declares: a table of rows, each giving the name the caller uses (a key of the input
// object) and the variable the code reads that value from. Stored as JSON, as [{ name, variable }]. No dependencies, so the
// worker thread (worker.js) can use it too.
//
// Values are the other table: the value an input is given when an administrator runs it, when a schedule starts it, or when an
// event does. A row is { name, type, value } (a typed value, see TYPES) or, for an event, { name, from } (a field of the event).

const MAX_INPUTS = 20;
const NAME_MAX = 64;
const VARIABLE_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// Names the code already has. A row may not take one, or it would hide what the code needs.
const RESERVED = new Set(['args', 'input', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'globalThis', 'vars', 'idp', 'http',
  'mail', 'sms', 'csv', 'util', 'report', 'fn', 'sleep', 'log', 'console', 'trigger', 'integration']);
// How a typed value is written: text is kept as typed; number is a number; yes or no is true or false; JSON is any JSON value.
const TYPES = ['text', 'number', 'yes_no', 'json'];
const YES = ['yes', 'true', 'on', '1'];
const NO = ['no', 'false', 'off', '0'];

/** Checks a submitted table. Returns { inputs, errors }; inputs is the cleaned list, errors is empty when it can be used. */
function parse(raw) {
  if (raw === undefined || raw === null) return { inputs: [], errors: [] };
  if (!Array.isArray(raw)) return { inputs: [], errors: ['The inputs are not valid.'] };
  const errors = [];
  if (raw.length > MAX_INPUTS) errors.push(`At most ${MAX_INPUTS} inputs are allowed.`);
  const inputs = raw.map((row) => ({
    name: typeof row?.name === 'string' ? row.name.trim() : '',
    variable: typeof row?.variable === 'string' ? row.variable.trim() : '',
  }));
  const names = new Set();
  const variables = new Set();
  for (const { name, variable } of inputs) {
    if (!name || name.length > NAME_MAX) errors.push(`Each input needs a name, up to ${NAME_MAX} characters.`);
    else if (names.has(name)) errors.push(`The input ${name} is listed twice.`);
    names.add(name);
    if (!VARIABLE_RE.test(variable) || RESERVED.has(variable)) {
      errors.push(`${variable || 'A variable'} is not a name the code can use for ${name || 'an input'}. Start with a letter, _ or $, then letters, digits, _ or $, and do not use a name the script already has.`);
    } else if (variables.has(variable)) errors.push(`The variable ${variable} is used twice.`);
    variables.add(variable);
  }
  return { inputs, errors };
}

/**
 * The typed value of a value box's text: { value } or { error }. Blank means the value is not set, so it is null.
 */
function typed(type, text) {
  const s = text === undefined || text === null ? '' : String(text);
  if (!s.trim()) return { value: null };
  if (type === 'number') return Number.isFinite(Number(s)) ? { value: Number(s) } : { error: `"${s.trim()}" is not a number.` };
  if (type === 'yes_no') {
    const t = s.trim().toLowerCase();
    if (YES.includes(t)) return { value: true };
    if (NO.includes(t)) return { value: false };
    return { error: `"${s.trim()}" is not yes or no.` };
  }
  if (type === 'json') {
    try { return { value: JSON.parse(s) }; } catch { return { error: `"${s.trim()}" is not valid JSON.` }; }
  }
  return { value: s };
}

/**
 * Checks a submitted table of values. `allowFrom` is for event triggers, whose rows may take a field of the event instead of a value.
 * Returns { rows, errors } where rows are cleaned: { name, type, value } (and `from` when allowed).
 */
function parseValues(raw, { allowFrom = false } = {}) {
  if (raw === undefined || raw === null) return { rows: [], errors: [] };
  if (!Array.isArray(raw)) return { rows: [], errors: ['The input values are not valid.'] };
  const errors = [];
  if (raw.length > MAX_INPUTS) errors.push(`At most ${MAX_INPUTS} inputs are allowed.`);
  const rows = raw.map((row) => ({
    name: typeof row?.name === 'string' ? row.name.trim() : '',
    type: typeof row?.type === 'string' ? row.type : 'text',
    value: typeof row?.value === 'string' ? row.value : '',
    from: allowFrom && typeof row?.from === 'string' ? row.from.trim() : '',
  }));
  const names = new Set();
  for (const { name, type, value, from } of rows) {
    if (!name || name.length > NAME_MAX) errors.push(`Each input needs a name, up to ${NAME_MAX} characters.`);
    else if (names.has(name)) errors.push(`The input ${name} is listed twice.`);
    names.add(name);
    if (!TYPES.includes(type)) errors.push(`The type of ${name || 'an input'} must be text, number, yes or no, or JSON.`);
    else if (!from) {
      const check = typed(type, value);
      if (check.error) errors.push(`${name || 'An input'}: ${check.error}`);
    }
  }
  return { rows: rows.map(({ name, type, value, from }) => (allowFrom ? { name, type, value, from } : { name, type, value })), errors };
}

/** What a field path (such as "user.email") holds in an object, or null. */
const valueAt = (object, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), object) ?? null;

/**
 * The input object a run gets from value rows. A row's value is typed; a row with `from` takes that field of `event` instead.
 * A value that does not check (it was saved before a fix, say) is passed as null rather than failing the run.
 */
function valuesToInput(rows, event = null) {
  const input = {};
  for (const { name, type, value, from } of rows) {
    input[name] = from ? valueAt(event || {}, from) : typed(type, value).value ?? null;
  }
  return input;
}

/**
 * The source of `script` as an async function. `params` is its parameter list. `prelude` declares the variables on the
 * 'use strict' line, so the script's own line numbers do not move.
 */
function wrap(script, { params = '', prelude = '' } = {}) {
  return `(async function (${params}) {\n'use strict';${prelude}\n${script}\n})`;
}

/** The declarations that give each row's variable its value. `source` is the expression that holds the input object. */
function bindings(inputs, source) {
  return inputs.map(({ name, variable }) => ` const ${variable} = (${source})[${JSON.stringify(name)}];`).join('');
}

/** parseValues for an event trigger, whose rows may take a field of the event. */
const parseValuesFrom = (raw) => parseValues(raw, { allowFrom: true });

module.exports = { parse, parseValues, parseValuesFrom, valuesToInput, valueAt, typed, wrap, bindings, TYPES, MAX_INPUTS, NAME_MAX };
