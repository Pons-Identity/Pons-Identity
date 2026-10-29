import { useState } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, FormGroup, IconButton, MenuItem, Paper, Radio, RadioGroup, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import ReportChart from './ReportChart.jsx';

const BASE = '/admin/reports';
const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const VIEWS = [['table', 'Table'], ['bar', 'Bar chart'], ['line', 'Line chart'], ['pie', 'Pie chart']];
const EMPTY = { source: 'users', options: {}, filters: [], mode: 'rows', columns: [], group_by: '', bucket: 'day', measures: [], view: 'table', sort: { by: '', dir: 'asc' }, limit: 100 };

// Turns a saved definition into the form's shape (the mode is implied by whether there is a group).
const fromDefinition = (d) => ({
  ...EMPTY, ...d, options: d.options || {}, filters: d.filters || [], columns: d.columns || [], measures: d.measures || [],
  group_by: d.group_by || '', mode: d.group_by || (d.measures || []).length ? 'summary' : 'rows', sort: d.sort || { by: '', dir: 'asc' },
});

// The definition as the server expects it, with the choices that do not apply to the current mode left out.
function toDefinition(f) {
  const summary = f.mode === 'summary';
  return {
    source: f.source,
    options: f.options,
    filters: f.filters.filter((x) => x.field),
    group_by: summary && f.group_by ? f.group_by : null,
    bucket: summary ? f.bucket : undefined,
    measures: summary ? f.measures.filter((m) => m.op) : [],
    columns: summary ? [] : f.columns,
    view: summary ? f.view : 'table',
    sort: f.sort.by ? f.sort : null,
    limit: Number(f.limit) || 100,
  };
}

function Result({ result }) {
  if (result.status !== 'ok') return <Alert severity="error">{result.error?.message || 'The report could not be run.'}</Alert>;
  const r = result.result;
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {r.total} {r.total === 1 ? 'row' : 'rows'} matched{r.truncated ? `; showing the first ${r.rows.length}` : ''}.
      </Typography>
      {r.chart && <ReportChart chart={r.chart} />}
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 480 }}>
        <Table size="small" stickyHeader aria-label="Report results">
          <TableHead><TableRow>{r.columns.map((c) => <TableCell key={c.key}>{c.label}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {r.rows.length === 0 && <TableRow><TableCell colSpan={r.columns.length}><Typography color="text.secondary">Nothing matched.</Typography></TableCell></TableRow>}
            {r.rows.map((row, i) => (
              <TableRow key={i}>
                {r.columns.map((c) => <TableCell key={c.key}>{Array.isArray(row[c.key]) ? row[c.key].join(', ') : row[c.key] === null || row[c.key] === undefined ? '' : String(row[c.key])}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}

// Builds, previews, saves and deletes a builder report. No code: the choices are the source, filters, columns or groups, and the chart.
export default function BuilderEditor({ meta, report }) {
  const catalog = meta.builder;
  const navigate = useNavigate();
  const notify = useNotify();
  const can = useCan();
  const canManage = can('reports.manage');
  const [name, setName] = useState(report?.name || '');
  const [description, setDescription] = useState(report?.description || '');
  const [form, setForm] = useState(() => fromDefinition(report?.definition || EMPTY));
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const source = catalog.sources.find((s) => s.key === form.source);
  const fields = source.fields;
  const fieldOf = (key) => fields.find((f) => f.key === key);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // A new source makes the fields chosen for the old one meaningless, so they are cleared.
  const changeSource = (key) => setForm((f) => ({ ...EMPTY, source: key, mode: f.mode, limit: f.limit }));
  const setOption = (k, v) => setForm((f) => ({ ...f, options: { ...f.options, [k]: v } }));
  const setFilter = (i, patch) => setForm((f) => ({ ...f, filters: f.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const addFilter = () => setForm((f) => ({ ...f, filters: [...f.filters, { field: fields[0].key, op: catalog.operators[fields[0].type][0].key, value: '' }] }));
  const removeFilter = (i) => setForm((f) => ({ ...f, filters: f.filters.filter((_, j) => j !== i) }));
  const toggleColumn = (key, on) => setForm((f) => ({ ...f, columns: on ? [...f.columns, key].slice(0, catalog.limits.columns) : f.columns.filter((c) => c !== key) }));
  const setMeasure = (i, patch) => setForm((f) => ({ ...f, measures: f.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const addMeasure = () => setForm((f) => ({ ...f, measures: [...f.measures, { op: 'count', field: '' }] }));
  const removeMeasure = (i) => setForm((f) => ({ ...f, measures: f.measures.filter((_, j) => j !== i) }));
  const groupable = fields.filter((f) => f.type !== 'list');
  const numberFields = fields.filter((f) => f.type === 'number');
  const dateGroup = fieldOf(form.group_by)?.type === 'date';

  async function preview() {
    setError('');
    try {
      setResult(await api(`${BASE}/builder/preview`, { method: 'POST', body: { definition: toDefinition(form) } }));
    } catch (err) {
      setResult(null);
      setError(errorText(err));
    }
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    const body = { name, description, kind: 'builder', definition: toDefinition(form) };
    try {
      if (report) {
        await api(`${BASE}/${report.id}`, { method: 'PUT', body });
        notify('Report saved');
      } else {
        const created = await api(BASE, { method: 'POST', body });
        notify('Report created');
        navigate(`${BASE}/${created.id}`, { replace: true });
      }
    } catch (err) { setError(errorText(err)); }
  }

  async function remove() {
    setDeleting(false);
    try { await api(`${BASE}/${report.id}`, { method: 'DELETE' }); notify('Report deleted'); navigate(BASE); } catch (err) { setError(errorText(err)); }
  }

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Button component={RouterLink} to={BASE} size="small">← Reports</Button>
        <Typography variant="h6" component="h2">{report ? report.name : 'New report'}</Typography>
      </Stack>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack component="form" onSubmit={save} spacing={3} aria-label="Report builder">
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} sx={{ flex: 1 }} />
            <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canManage} sx={{ flex: 2 }} />
          </Stack>

          <Stack spacing={2}>
            <Typography variant="subtitle1" component="h3">1. Data</Typography>
            <TextField select label="Source" value={form.source} onChange={(e) => changeSource(e.target.value)} disabled={!canManage} sx={{ maxWidth: 360 }}>
              {catalog.sources.map((s) => <MenuItem key={s.key} value={s.key}>{s.label}</MenuItem>)}
            </TextField>
            {form.source === 'users' && (
              <TextField select label="Accounts" value={form.options.active === undefined ? 'all' : form.options.active ? 'active' : 'inactive'} disabled={!canManage}
                onChange={(e) => setOption('active', e.target.value === 'all' ? undefined : e.target.value === 'active')} sx={{ maxWidth: 360 }}>
                <MenuItem value="all">All accounts</MenuItem>
                <MenuItem value="active">Active accounts</MenuItem>
                <MenuItem value="inactive">Deactivated accounts</MenuItem>
              </TextField>
            )}
            {source.options.includes('days') && (
              <TextField label="Days back" type="number" value={form.options.days ?? 7} disabled={!canManage} sx={{ maxWidth: 200 }}
                onChange={(e) => setOption('days', Number(e.target.value))} slotProps={{ htmlInput: { min: 1, max: 365 } }} />
            )}
            {source.options.includes('type') && <TextField label="Type (optional)" value={form.options.type || ''} disabled={!canManage} onChange={(e) => setOption('type', e.target.value)} sx={{ maxWidth: 360 }} />}
            {source.options.includes('outcome') && <TextField label="Outcome (optional)" value={form.options.outcome || ''} disabled={!canManage} onChange={(e) => setOption('outcome', e.target.value)} sx={{ maxWidth: 360 }} />}
            {source.options.includes('category') && <TextField label="Category (optional)" value={form.options.category || ''} disabled={!canManage} onChange={(e) => setOption('category', e.target.value)} sx={{ maxWidth: 360 }} />}
          </Stack>

          <Stack spacing={2}>
            <Typography variant="subtitle1" component="h3">2. Only the rows where</Typography>
            {form.filters.length === 0 && <Typography color="text.secondary" variant="body2">No filters: every row is used.</Typography>}
            {form.filters.map((flt, i) => {
              const field = fieldOf(flt.field) || fields[0];
              const ops = catalog.operators[field.type] || [];
              const op = ops.find((o) => o.key === flt.op) || ops[0];
              return (
                <Stack key={i} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} aria-label={`Filter ${i + 1}`}>
                  <TextField select label="Field" value={field.key} disabled={!canManage} sx={{ minWidth: 200 }}
                    onChange={(e) => { const f2 = fieldOf(e.target.value); setFilter(i, { field: e.target.value, op: catalog.operators[f2.type][0].key, value: '' }); }}>
                    {fields.map((f) => <MenuItem key={f.key} value={f.key}>{f.label}</MenuItem>)}
                  </TextField>
                  <TextField select label="Is" value={op.key} disabled={!canManage} sx={{ minWidth: 170 }} onChange={(e) => setFilter(i, { op: e.target.value })}>
                    {ops.map((o) => <MenuItem key={o.key} value={o.key}>{o.label}</MenuItem>)}
                  </TextField>
                  {op.takesValue && field.type === 'boolean' && (
                    <TextField select label="Value" value={flt.value || 'true'} disabled={!canManage} sx={{ minWidth: 140 }} onChange={(e) => setFilter(i, { value: e.target.value })}>
                      <MenuItem value="true">true</MenuItem><MenuItem value="false">false</MenuItem>
                    </TextField>
                  )}
                  {op.takesValue && field.type !== 'boolean' && (
                    <TextField label="Value" value={flt.value} disabled={!canManage} sx={{ minWidth: 200 }}
                      placeholder={field.type === 'date' ? 'YYYY-MM-DD' : ''} type={field.type === 'number' ? 'number' : 'text'} onChange={(e) => setFilter(i, { value: e.target.value })} />
                  )}
                  {canManage && <IconButton aria-label={`Remove filter ${i + 1}`} onClick={() => removeFilter(i)}><DeleteOutlineIcon /></IconButton>}
                </Stack>
              );
            })}
            {canManage && form.filters.length < catalog.limits.filters && <Button onClick={addFilter} sx={{ alignSelf: 'flex-start' }}>Add a filter</Button>}
          </Stack>

          <Stack spacing={2}>
            <Typography variant="subtitle1" component="h3">3. Show</Typography>
            <RadioGroup row value={form.mode} onChange={(e) => set('mode', e.target.value)}>
              <FormControlLabel value="rows" control={<Radio />} label="The rows, with the columns I choose" disabled={!canManage} />
              <FormControlLabel value="summary" control={<Radio />} label="A summary, grouped by a field" disabled={!canManage} />
            </RadioGroup>

            {form.mode === 'rows' && (
              <FormGroup aria-label="Columns" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                {fields.map((f) => (
                  <FormControlLabel key={f.key} disabled={!canManage} label={f.label}
                    control={<Checkbox checked={form.columns.includes(f.key)} onChange={(e) => toggleColumn(f.key, e.target.checked)} />} />
                ))}
              </FormGroup>
            )}

            {form.mode === 'summary' && (
              <Stack spacing={2}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField select label="Group by" value={form.group_by} disabled={!canManage} sx={{ minWidth: 240 }} onChange={(e) => set('group_by', e.target.value)}
                    helperText={form.group_by ? '' : 'Choose a field'}>
                    {groupable.map((f) => <MenuItem key={f.key} value={f.key}>{f.label}</MenuItem>)}
                  </TextField>
                  {dateGroup && (
                    <TextField select label="Each" value={form.bucket} disabled={!canManage} sx={{ minWidth: 160 }} onChange={(e) => set('bucket', e.target.value)}>
                      <MenuItem value="day">day</MenuItem><MenuItem value="month">month</MenuItem>
                    </TextField>
                  )}
                </Stack>
                <Typography variant="body2" color="text.secondary">For each group, add what to work out:</Typography>
                {form.measures.map((m, i) => {
                  const measure = catalog.measures.find((x) => x.key === m.op) || catalog.measures[0];
                  const choices = measure.needsNumber ? numberFields : measure.needsField ? fields : [];
                  return (
                    <Stack key={i} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} aria-label={`Measure ${i + 1}`}>
                      <TextField select label="Work out" value={m.op} disabled={!canManage} sx={{ minWidth: 200 }}
                        onChange={(e) => setMeasure(i, { op: e.target.value, field: '' })}>
                        {catalog.measures.map((x) => <MenuItem key={x.key} value={x.key}>{x.label}</MenuItem>)}
                      </TextField>
                      {measure.needsField && (
                        <TextField select label="of" value={m.field} disabled={!canManage} sx={{ minWidth: 240 }} onChange={(e) => setMeasure(i, { field: e.target.value })}>
                          {choices.map((f) => <MenuItem key={f.key} value={f.key}>{f.label}</MenuItem>)}
                        </TextField>
                      )}
                      {canManage && <IconButton aria-label={`Remove measure ${i + 1}`} onClick={() => removeMeasure(i)}><DeleteOutlineIcon /></IconButton>}
                    </Stack>
                  );
                })}
                {canManage && form.measures.length < catalog.limits.measures && <Button onClick={addMeasure} sx={{ alignSelf: 'flex-start' }}>Add a measure</Button>}
              </Stack>
            )}
          </Stack>

          <Stack spacing={2}>
            <Typography variant="subtitle1" component="h3">4. As</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField select label="Shown as" value={form.mode === 'summary' ? form.view : 'table'} disabled={!canManage || form.mode !== 'summary'} sx={{ minWidth: 200 }}
                onChange={(e) => set('view', e.target.value)} helperText={form.mode === 'summary' ? '' : 'Summaries can be charted'}>
                {VIEWS.map(([k, label]) => <MenuItem key={k} value={k}>{label}</MenuItem>)}
              </TextField>
              {form.mode === 'summary' && (
                <TextField select label="Sort by" value={form.sort.by} disabled={!canManage} sx={{ minWidth: 200 }} onChange={(e) => set('sort', { ...form.sort, by: e.target.value })}>
                  <MenuItem value="">Default</MenuItem>
                  <MenuItem value="group">The group</MenuItem>
                  {form.measures.map((m, i) => <MenuItem key={i} value={`m${i}`}>{catalog.measures.find((x) => x.key === m.op)?.label || m.op} (measure {i + 1})</MenuItem>)}
                </TextField>
              )}
              {form.mode === 'rows' && (
                <TextField select label="Sort by" value={form.sort.by} disabled={!canManage} sx={{ minWidth: 200 }} onChange={(e) => set('sort', { ...form.sort, by: e.target.value })}>
                  <MenuItem value="">Default</MenuItem>
                  {form.columns.map((c) => <MenuItem key={c} value={c}>{fieldOf(c)?.label || c}</MenuItem>)}
                </TextField>
              )}
              {form.sort.by && (
                <TextField select label="Direction" value={form.sort.dir} disabled={!canManage} sx={{ minWidth: 140 }} onChange={(e) => set('sort', { ...form.sort, dir: e.target.value })}>
                  <MenuItem value="asc">Ascending</MenuItem><MenuItem value="desc">Descending</MenuItem>
                </TextField>
              )}
              <TextField label="Rows to show" type="number" value={form.limit} disabled={!canManage} sx={{ width: 180 }} onChange={(e) => set('limit', e.target.value)}
                slotProps={{ htmlInput: { min: catalog.limits.limit.min, max: catalog.limits.limit.max } }} />
            </Stack>
          </Stack>

          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={preview}>Preview</Button>
            {canManage && <Button type="submit" variant="contained">{report ? 'Save' : 'Create report'}</Button>}
            {report && canManage && <Button color="error" onClick={() => setDeleting(true)}>Delete</Button>}
          </Stack>
        </Stack>
      </Paper>

      {result && <Result result={result} />}

      <ConfirmDialog open={deleting} title="Delete this report?" confirmLabel="Delete report"
        message="Its definition is removed. Nothing else is affected." onConfirm={remove} onClose={() => setDeleting(false)} />
    </Stack>
  );
}
