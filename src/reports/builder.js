const functions = require('./functions');

// The low-code report builder. A builder report is a definition, made in the console without any code: one data source, the
// filters that keep some of its rows, and either the rows (chosen columns) or groups with summaries (count, distinct, sum, average,
// minimum, maximum), shown as a table or a chart. It reads the same data as a script report, through the same functions, so it
// shows the person running it no more than they may see, and it changes nothing.

const TEXT = 'text';
const NUMBER = 'number';
const DATE = 'date';
const BOOLEAN = 'boolean';
const LIST = 'list';

const MAX_FILTERS = 10;
const MAX_COLUMNS = 12;
const MAX_MEASURES = 4;
const MAX_GROUPS = 500;
const LIMIT = { min: 1, max: 1000, default: 100 };
const DAYS = { min: 1, max: 365, default: 7 };
const CHART_TYPES = ['table', 'bar', 'line', 'pie'];
const MEASURE_OPS = ['count', 'distinct', 'sum', 'avg', 'min', 'max'];
const BUCKETS = ['day', 'month'];

// Each source: the report function it reads, the permission its data needs, the options it takes, and its fields.
const SOURCES = {
  users: {
    label: 'Users', fn: 'report.users', permission: 'users.view', options: ['active'],
    fields: [
      ['username', TEXT, 'Username'], ['display_name', TEXT, 'Display name'], ['first_name', TEXT, 'First name'], ['last_name', TEXT, 'Last name'],
      ['email', TEXT, 'Email'], ['employee_id', TEXT, 'Employee ID'], ['department', TEXT, 'Department'], ['title', TEXT, 'Title'],
      ['company', TEXT, 'Company'], ['manager', TEXT, 'Manager'], ['source', TEXT, 'Source (local or directory)'], ['active', BOOLEAN, 'Active'],
      ['mfa_required', BOOLEAN, 'Second factor required'], ['groups', LIST, 'Groups'], ['password_changed_at', DATE, 'Password changed'],
      ['created_at', DATE, 'Created'], ['last_sign_in', DATE, 'Last sign-in (needs the audit log permission)'],
    ],
  },
  groups: {
    label: 'Groups', fn: 'report.groups', permission: 'groups.view', options: [],
    fields: [['name', TEXT, 'Name'], ['description', TEXT, 'Description'], ['source', TEXT, 'Source'], ['members', NUMBER, 'Members']],
  },
  signIns: {
    label: 'Sign-ins', fn: 'report.signIns', permission: 'audit.view', options: ['days', 'type', 'outcome'],
    fields: [
      ['time', DATE, 'When'], ['type', TEXT, 'Type'], ['outcome', TEXT, 'Outcome'], ['reason', TEXT, 'Reason'], ['username', TEXT, 'Username'],
      ['factor', TEXT, 'Factor'], ['ip', TEXT, 'IP address'], ['country', TEXT, 'Country'], ['city', TEXT, 'City'], ['browser', TEXT, 'Browser'],
      ['os', TEXT, 'Operating system'], ['device_type', TEXT, 'Device type'], ['risk_level', TEXT, 'Risk level'], ['risk_score', NUMBER, 'Risk score'],
    ],
  },
  audit: {
    label: 'Audit log', fn: 'report.audit', permission: 'audit.view', options: ['days', 'category', 'outcome'],
    fields: [
      ['time', DATE, 'When'], ['category', TEXT, 'Category'], ['action', TEXT, 'Action'], ['outcome', TEXT, 'Outcome'], ['actor', TEXT, 'Actor'],
      ['target_type', TEXT, 'Target type'], ['target', TEXT, 'Target'], ['ip', TEXT, 'IP address'],
    ],
  },
};

// Filter operators by field type, with the label the console shows and whether they take a value.
const OPS = {
  [TEXT]: [['eq', 'is', true], ['ne', 'is not', true], ['contains', 'contains', true], ['starts', 'starts with', true], ['empty', 'is empty', false], ['notempty', 'is not empty', false]],
  [NUMBER]: [['eq', '=', true], ['ne', '≠', true], ['gt', '>', true], ['gte', '≥', true], ['lt', '<', true], ['lte', '≤', true]],
  [DATE]: [['eq', 'on', true], ['gte', 'on or after', true], ['gt', 'after', true], ['lt', 'before', true], ['lte', 'on or before', true], ['empty', 'is empty', false], ['notempty', 'is not empty', false]],
  [BOOLEAN]: [['is', 'is', true]],
  [LIST]: [['contains', 'includes', true], ['empty', 'is empty', false], ['notempty', 'is not empty', false]],
};
const opsFor = (type) => OPS[type] || [];

const fieldsOf = (source) => SOURCES[source].fields.map(([key, type, label]) => ({ key, type, label }));
const fieldOf = (source, key) => fieldsOf(source).find((f) => f.key === key);
const MEASURE_LABEL = { count: 'Count', distinct: 'Distinct', sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum' };

/** What the console needs to build a report: sources, their fields and operators, and the choices. */
function catalog() {
  return {
    sources: Object.entries(SOURCES).map(([key, s]) => ({ key, label: s.label, permission: s.permission, options: s.options, fields: fieldsOf(key) })),
    operators: Object.fromEntries(Object.entries(OPS).map(([type, list]) => [type, list.map(([key, label, takesValue]) => ({ key, label, takesValue }))])),
    measures: MEASURE_OPS.map((op) => ({ key: op, label: MEASURE_LABEL[op], needsNumber: op === 'sum' || op === 'avg' || op === 'min' || op === 'max', needsField: op !== 'count' })),
    charts: CHART_TYPES,
    limits: { limit: LIMIT, days: DAYS, filters: MAX_FILTERS, columns: MAX_COLUMNS, measures: MAX_MEASURES, groups: MAX_GROUPS },
  };
}

/** Validates a definition. Returns { data, errors } where data is the cleaned definition. */
function parse(input) {
  const errors = [];
  const def = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const source = SOURCES[def.source] ? def.source : null;
  if (!source) errors.push(`Choose a data source: ${Object.keys(SOURCES).join(', ')}.`);
  const out = { source: source || 'users', options: {}, filters: [], group_by: null, bucket: 'day', measures: [], columns: [], sort: null, limit: LIMIT.default, view: 'table' };
  if (!source) return { data: out, errors };

  // Options the source takes (how far back the log reads, or which accounts).
  const opts = def.options && typeof def.options === 'object' ? def.options : {};
  if (SOURCES[source].options.includes('active') && opts.active !== undefined && opts.active !== null && opts.active !== 'all') {
    out.options.active = opts.active === true || opts.active === 'true' || opts.active === 'active';
  }
  if (SOURCES[source].options.includes('days')) {
    const days = opts.days === undefined ? DAYS.default : Number(opts.days);
    if (!Number.isInteger(days) || days < DAYS.min || days > DAYS.max) errors.push(`Days must be a whole number from ${DAYS.min} to ${DAYS.max}.`);
    else out.options.days = days;
  }
  for (const k of ['type', 'outcome', 'category']) if (SOURCES[source].options.includes(k) && typeof opts[k] === 'string' && opts[k].trim()) out.options[k] = opts[k].trim().slice(0, 100);

  // Filters: every one must hold.
  const filters = Array.isArray(def.filters) ? def.filters : [];
  if (filters.length > MAX_FILTERS) errors.push(`At most ${MAX_FILTERS} filters.`);
  for (const f of filters.slice(0, MAX_FILTERS)) {
    const field = fieldOf(source, f && f.field);
    if (!field) { errors.push(`Filter: "${f && f.field}" is not a field of this source.`); continue; }
    const op = opsFor(field.type).find(([k]) => k === f.op);
    if (!op) { errors.push(`Filter on ${field.label}: "${f.op}" does not apply to this kind of field.`); continue; }
    const value = f.value === undefined || f.value === null ? '' : String(f.value).trim().slice(0, 200);
    if (op[2] && value === '') { errors.push(`Filter on ${field.label}: enter a value.`); continue; }
    if (field.type === NUMBER && op[2] && !Number.isFinite(Number(value))) { errors.push(`Filter on ${field.label}: the value must be a number.`); continue; }
    if (field.type === DATE && op[2] && !/^\d{4}-\d{2}-\d{2}$/.test(value)) { errors.push(`Filter on ${field.label}: the date must look like 2026-10-01.`); continue; }
    if (field.type === BOOLEAN && !['true', 'false'].includes(value)) { errors.push(`Filter on ${field.label}: choose true or false.`); continue; }
    out.filters.push({ field: field.key, op: f.op, value });
  }

  // Either the rows (columns) or groups with measures.
  const groupBy = def.group_by === undefined || def.group_by === null || def.group_by === '' ? null : def.group_by;
  const measures = Array.isArray(def.measures) ? def.measures : [];
  if (groupBy !== null) {
    const field = fieldOf(source, groupBy);
    if (!field) errors.push(`Group by: "${groupBy}" is not a field of this source.`);
    else if (field.type === LIST) errors.push(`Group by: a list field such as ${field.label} cannot be grouped; use a filter instead.`);
    else out.group_by = field.key;
    if (field && field.type === DATE) {
      out.bucket = BUCKETS.includes(def.bucket) ? def.bucket : 'day';
    }
  }
  if (measures.length > MAX_MEASURES) errors.push(`At most ${MAX_MEASURES} measures.`);
  for (const m of measures.slice(0, MAX_MEASURES)) {
    if (!MEASURE_OPS.includes(m && m.op)) { errors.push(`Measure: "${m && m.op}" is not one of ${MEASURE_OPS.join(', ')}.`); continue; }
    if (m.op === 'count') { out.measures.push({ op: 'count' }); continue; }
    const field = fieldOf(source, m.field);
    if (!field) { errors.push(`Measure ${MEASURE_LABEL[m.op]}: "${m.field}" is not a field of this source.`); continue; }
    if (['sum', 'avg', 'min', 'max'].includes(m.op) && field.type !== NUMBER) { errors.push(`Measure ${MEASURE_LABEL[m.op]}: ${field.label} is not a number.`); continue; }
    out.measures.push({ op: m.op, field: field.key });
  }
  if (groupBy === null && out.measures.length) errors.push('Measures summarize groups: choose a field to group by, or remove the measures.');

  const view = CHART_TYPES.includes(def.view) ? def.view : 'table';
  out.view = view;
  if (view !== 'table') {
    if (out.group_by === null || !out.measures.length) errors.push(`A ${view} chart needs a field to group by and at least one measure.`);
    if (view === 'pie' && out.measures.length > 1) errors.push('A pie chart shows one measure: keep only one.');
  }

  // Rows mode: the columns to show.
  if (out.group_by === null && !out.measures.length) {
    const cols = Array.isArray(def.columns) ? def.columns : [];
    if (cols.length > MAX_COLUMNS) errors.push(`At most ${MAX_COLUMNS} columns.`);
    for (const c of cols.slice(0, MAX_COLUMNS)) {
      const field = fieldOf(source, c);
      if (!field) errors.push(`Column: "${c}" is not a field of this source.`);
      else out.columns.push(field.key);
    }
    if (!out.columns.length) out.columns = SOURCES[source].fields.slice(0, 5).map(([k]) => k);
  }

  // Sorting: by the group, or a measure (m0, m1 ...), or a column in rows mode.
  if (def.sort && typeof def.sort === 'object') {
    const dir = def.sort.dir === 'desc' ? 'desc' : 'asc';
    const by = String(def.sort.by || '');
    const measureIndex = /^m(\d+)$/.exec(by);
    if (by === 'group' || (measureIndex && Number(measureIndex[1]) < out.measures.length) || (out.group_by === null && out.columns.includes(by))) {
      out.sort = { by, dir };
    } else if (by) {
      errors.push(`Sort: "${by}" is not a column or a measure of this report.`);
    }
  }
  const limit = def.limit === undefined ? LIMIT.default : Number(def.limit);
  if (!Number.isInteger(limit) || limit < LIMIT.min || limit > LIMIT.max) errors.push(`The row limit must be a whole number from ${LIMIT.min} to ${LIMIT.max}.`);
  else out.limit = limit;
  return { data: out, errors };
}

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

// Does one row pass one filter? Dates compare by their day; numbers numerically; text is case-insensitive.
function passes(row, field, op, value) {
  const v = row[field.key];
  if (op === 'empty') return isEmpty(v);
  if (op === 'notempty') return !isEmpty(v);
  if (field.type === LIST) return op === 'contains' ? (Array.isArray(v) ? v.some((x) => String(x).toLowerCase() === value.toLowerCase()) : false) : true;
  if (field.type === BOOLEAN) return Boolean(v) === (value === 'true');
  if (field.type === NUMBER) {
    if (isEmpty(v)) return false;
    const a = Number(v); const b = Number(value);
    return { eq: a === b, ne: a !== b, gt: a > b, gte: a >= b, lt: a < b, lte: a <= b }[op];
  }
  if (field.type === DATE) {
    if (isEmpty(v)) return false;
    const day = String(v).slice(0, 10);
    return { eq: day === value, gt: day > value, gte: day >= value, lt: day < value, lte: day <= value }[op];
  }
  const s = String(v ?? '').toLowerCase();
  const w = value.toLowerCase();
  return { eq: s === w, ne: s !== w, contains: s.includes(w), starts: s.startsWith(w) }[op];
}

// The group a row belongs to, for a group field. Dates group by day or month; an empty value is its own group.
function groupKey(row, field, bucket) {
  const v = row[field.key];
  if (isEmpty(v)) return '(none)';
  if (field.type === DATE) return bucket === 'month' ? String(v).slice(0, 7) : String(v).slice(0, 10);
  if (field.type === BOOLEAN) return v ? 'yes' : 'no';
  return String(v);
}

function summarize(op, field, rows) {
  if (op === 'count') return rows.length;
  const values = field ? rows.map((r) => r[field.key]).filter((v) => !isEmpty(v)) : [];
  if (op === 'distinct') return new Set(values.map(String)).size;
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  if (op === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (op === 'avg') return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
  if (op === 'min') return Math.min(...nums);
  if (op === 'max') return Math.max(...nums);
  return null;
}

/**
 * Runs a definition for someone with `perms` (their permissions). Returns { columns, rows, chart, total, truncated }, or throws a
 * ReportError with a message for the person (no data source permission, a definition that does not parse).
 */
function run(input, { perms }) {
  const { data, errors } = parse(input);
  if (errors.length) throw new functions.ReportError(errors.join(' '));
  const source = SOURCES[data.source];
  if (!perms.has(source.permission)) throw new functions.ReportError(`${source.label} needs the "${source.permission}" permission, which you do not have.`);
  const all = functions.FUNCTIONS[source.fn]({ perms }, data.options);
  const fields = fieldsOf(data.source);
  const kept = all.filter((row) => data.filters.every((f) => passes(row, fields.find((x) => x.key === f.field), f.op, f.value)));

  if (data.group_by === null && !data.measures.length) {
    const columns = data.columns.map((key) => ({ key, label: fieldOf(data.source, key).label, type: fieldOf(data.source, key).type }));
    let rows = kept;
    if (data.sort) {
      const dir = data.sort.dir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => dir * String(a[data.sort.by] ?? '').localeCompare(String(b[data.sort.by] ?? ''), undefined, { numeric: true }));
    }
    const shown = rows.slice(0, data.limit).map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null])));
    return { columns, rows: shown, chart: null, total: kept.length, truncated: kept.length > shown.length };
  }

  // Grouped: one row per group, with the measures summarized over the group's rows.
  const groups = new Map();
  const field = data.group_by ? fieldOf(data.source, data.group_by) : null;
  for (const row of kept) {
    const key = field ? groupKey(row, fields.find((x) => x.key === data.group_by), data.bucket) : 'All';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  if (groups.size > MAX_GROUPS) throw new functions.ReportError(`These filters give ${groups.size} groups; the limit is ${MAX_GROUPS}. Filter more, or group by something with fewer values.`);
  const measureKeys = data.measures.map((m, i) => `m${i}`);
  const measureLabel = (m) => (m.op === 'count' ? 'Count' : `${MEASURE_LABEL[m.op]} of ${fieldOf(data.source, m.field).label.toLowerCase()}`);
  const columns = [
    ...(field ? [{ key: 'group', label: field.label, type: field.type === DATE ? TEXT : field.type }] : []),
    ...data.measures.map((m, i) => ({ key: measureKeys[i], label: measureLabel(m), type: NUMBER })),
  ];
  let rows = [...groups.entries()].map(([key, members]) => ({
    group: key,
    ...Object.fromEntries(data.measures.map((m, i) => [measureKeys[i], summarize(m.op, m.field ? fieldOf(data.source, m.field) : null, members)])),
  }));
  const primary = data.measures[0] ? measureKeys[0] : null;
  const sortBy = data.sort ? data.sort.by : (data.view === 'line' ? 'group' : (data.view === 'bar' || data.view === 'pie' ? primary : 'group'));
  const dir = data.sort ? (data.sort.dir === 'desc' ? -1 : 1) : (sortBy === primary ? -1 : 1);
  rows.sort((a, b) => {
    const x = a[sortBy === 'group' ? 'group' : sortBy]; const y = b[sortBy === 'group' ? 'group' : sortBy];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
  });
  const shown = rows.slice(0, data.limit);
  const chart = data.view === 'table' ? null : {
    type: data.view,
    labels: shown.map((r) => r.group),
    values: shown.map((r) => (typeof r[primary] === 'number' ? r[primary] : 0)),
    label: columns[columns.length - data.measures.length].label,
  };
  return { columns, rows: shown, chart, total: rows.length, truncated: rows.length > shown.length };
}

module.exports = { parse, run, catalog, SOURCES, MEASURE_LABEL, LIMIT, DAYS };
