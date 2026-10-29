const db = require('./db');

// Administrator-defined user attributes. A definition gives an attribute a type, so a value is checked when it is saved
// and the console can show a proper input. Attributes without a definition keep working as free-form name=value pairs.
const TYPES = ['text', 'number', 'bool', 'date', 'enum'];
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_VALUE = 1024;

const view = (r) => ({ name: r.name, label: r.label, type: r.type, options: JSON.parse(r.options), required: !!r.required, default_value: r.default_value });

const list = () => db.all('SELECT * FROM attribute_defs ORDER BY name COLLATE NOCASE').map(view);
const find = (name) => { const r = db.get('SELECT * FROM attribute_defs WHERE name = ?', name); return r && view(r); };

// Returns { data, errors } for a submitted definition. The name is fixed once created, so `existing` skips its checks.
function parseDef(body, existing = null) {
  const errors = [];
  const name = existing ? existing.name : String(body.name || '').trim();
  if (!existing) {
    if (!NAME_RE.test(name)) errors.push('Name must start with a letter and use only letters, digits, ".", "_" or "-" (64 characters at most).');
    else if (db.get('SELECT 1 FROM attribute_defs WHERE name = ?', name)) errors.push('That attribute already exists.');
  }
  const type = TYPES.includes(body.type) ? body.type : null;
  if (!type) errors.push(`Type must be one of: ${TYPES.join(', ')}.`);
  const options = type === 'enum'
    ? [...new Set((Array.isArray(body.options) ? body.options : String(body.options || '').split(/\r?\n/)).map((o) => String(o).trim()).filter(Boolean))]
    : [];
  if (type === 'enum' && !options.length) errors.push('List at least one allowed value.');
  const def = { name, label: String(body.label || '').trim() || name, type, options, required: !!body.required, default_value: String(body.default_value ?? '').trim() };
  if (type && def.default_value) errors.push(...check(def, def.default_value).map((e) => `Default value: ${e}`));
  return { data: def, errors };
}

// Errors for one value against a definition; an empty value is checked by the caller (required).
function check(def, value) {
  if (value.length > MAX_VALUE) return [`${def.label} is too long.`];
  if (def.type === 'number' && !(value.trim() !== '' && Number.isFinite(Number(value)))) return [`${def.label} must be a number.`];
  if (def.type === 'bool' && !['true', 'false'].includes(value)) return [`${def.label} must be true or false.`];
  if (def.type === 'date' && !(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) return [`${def.label} must be a date (YYYY-MM-DD).`];
  if (def.type === 'enum' && !def.options.includes(value)) return [`${def.label} must be one of: ${def.options.join(', ')}.`];
  return [];
}

// Applies defaults (when `isNew`) and validates values for the defined attributes. `values` is { name: string } for the
// names the caller supplied; names not present are left alone on an update. Returns { values, errors }.
function resolve(values, { isNew }) {
  const errors = [];
  const out = {};
  for (const def of list()) {
    let v = values && Object.hasOwn(values, def.name) ? String(values[def.name] ?? '').trim() : undefined;
    if (v === undefined && !isNew) continue;
    if (!v && isNew && def.default_value) v = def.default_value;
    if (!v) {
      if (def.required) errors.push(`${def.label} is required.`);
      out[def.name] = '';
    } else {
      const bad = check(def, v);
      errors.push(...bad);
      out[def.name] = v;
    }
  }
  return { values: out, errors };
}

const valuesOf = (userId) => Object.fromEntries(db.all(
  'SELECT a.name, a.value FROM user_attributes a JOIN attribute_defs d ON d.name = a.name WHERE a.user_id = ?', userId).map((r) => [r.name, r.value]));

module.exports = { TYPES, list, find, parseDef, resolve, valuesOf };
