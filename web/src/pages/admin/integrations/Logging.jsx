import { useCallback, useEffect, useState } from 'react';
import { Alert, Autocomplete, Button, FormControlLabel, MenuItem, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import LogLines, { COLOR_NAMES } from '../../../components/LogLines.jsx';

const BASE = '/admin/integrations';
const errorText = (e) => (e.data?.errors || [e.message]).join(' ');

// A color is a name from the list or a hex value; either can be typed.
function ColorField({ label, value, onChange, disabled }) {
  return (
    <Autocomplete freeSolo size="small" options={COLOR_NAMES} value={value} disabled={disabled} sx={{ width: 160 }}
      onChange={(_, v) => onChange(v || '')} onInputChange={(_, v, reason) => { if (reason === 'input') onChange(v); }}
      renderInput={(p) => <TextField {...p} label={label} />} />
  );
}

function Settings({ cfg, levels, onSaved }) {
  const can = useCan();
  const notify = useNotify();
  const [form, setForm] = useState(cfg);
  const [error, setError] = useState('');
  const manage = can('integrations.manage');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      const r = await api(`${BASE}/logging`, { method: 'PUT', body: { ...form, retentionDays: Number(form.retentionDays) } });
      onSaved(r);
      notify('Logging settings saved');
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack component="form" onSubmit={save} spacing={2} aria-label="Logging settings">
        <Typography variant="h6" component="h2">Logging engine</Typography>
        <Typography variant="body2" color="text.secondary">
          Two things are written, and they are kept apart. <strong>Output</strong> (<code>output()</code>) is what a run printed: it is shown on the run&apos;s page and kept with the run.
          <strong> Log</strong> (<code>log()</code>, <code>log.debug()</code>, <code>log.warning()</code> and <code>log.error()</code>) is what it logged: it is shown on the run&apos;s page too,
          and the lines at or above the level chosen here are saved as plain text files, one a day for each integration, in the files module under <code>/logs</code>.
          Those files are kept for the number of days below, and can be read in the Files tab or over SFTP.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField select label="Save log lines at or above" value={form.saveLevel} onChange={(e) => set('saveLevel', e.target.value)} disabled={!manage} sx={{ maxWidth: 320 }}>
          <MenuItem value="off">Don't save log lines</MenuItem>
          {levels.map((l) => <MenuItem key={l.id} value={l.id}>{l.label}</MenuItem>)}
        </TextField>
        <FormControlLabel control={<Switch checked={form.saveOutput} onChange={(e) => set('saveOutput', e.target.checked)} disabled={!manage} />} label="Also save output() lines" />
        <TextField label="Keep saved log files for (days, 0 = no limit)" type="number" value={form.retentionDays} onChange={(e) => set('retentionDays', e.target.value)} disabled={!manage} sx={{ maxWidth: 320 }}
          slotProps={{ htmlInput: { min: 0, max: 3650 } }} />
        <Typography variant="subtitle1" component="h3">Default colors</Typography>
        <Typography variant="body2" color="text.secondary">
          A line uses its level's color unless the script picks one: <code>output.color("green", "done")</code> or <code>log.error.color("#b3261e", "…")</code>. Use a name or a hex value.
        </Typography>
        <Stack direction="row" gap={2} flexWrap="wrap">
          {[...levels.map((l) => [l.id, l.label]), ['output', 'Output']].map(([id, name]) => (
            <ColorField key={id} label={name} value={form.colors[id]} disabled={!manage} onChange={(v) => setForm((f) => ({ ...f, colors: { ...f.colors, [id]: v } }))} />
          ))}
        </Stack>
        {manage && <Button type="submit" variant="contained" sx={{ alignSelf: 'flex-start' }}>Save</Button>}
      </Stack>
    </Paper>
  );
}

// The saved lines, newest first, and the settings that decide what is saved.
export default function Logging() {
  const can = useCan();
  const notify = useNotify();
  const [meta, setMeta] = useState(null);
  const [integrations, setIntegrations] = useState([]);
  const [filter, setFilter] = useState({ integration: '', level: '', stream: '', q: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    api(`${BASE}/logging`).then(setMeta).catch((e) => setError(e.message));
    api(BASE).then((d) => setIntegrations(d.integrations)).catch(() => {});
  }, []);

  const load = useCallback(() => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    return api(`${BASE}/logs?${params}`).then((r) => { setResult(r); setError(''); }).catch((e) => setError(e.message));
  }, [filter]);
  useEffect(() => {
    const t = setTimeout(load, filter.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, filter.q]);

  async function clear() {
    setClearing(false);
    try {
      const r = await api(`${BASE}/logs${filter.integration ? `?integration=${filter.integration}` : ''}`, { method: 'DELETE' });
      notify(`${r.removed.toLocaleString()} saved lines deleted`);
      load();
    } catch (e) { setError(e.message); }
  }

  const set = (k, v) => setFilter((f) => ({ ...f, [k]: v }));
  const lines = (result?.lines || []).map((l) => ({
    ...l, prefix: `${l.integration || `#${l.integration_id}`}${l.stream === 'output' ? ' (output)' : ''}`,
  }));

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}
      {meta && <Settings cfg={meta.settings} levels={meta.levels} onSaved={setMeta} />}
      <Stack spacing={2}>
        <Typography variant="h6" component="h2">Saved log</Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={2} flexWrap="wrap">
          <TextField select size="small" label="Integration" value={filter.integration} onChange={(e) => set('integration', e.target.value)} sx={{ minWidth: 200 }}>
            <MenuItem value="">All integrations</MenuItem>
            {integrations.map((i) => <MenuItem key={i.id} value={String(i.id)}>{i.name}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Level" value={filter.level} onChange={(e) => set('level', e.target.value)} sx={{ minWidth: 160 }}>
            <MenuItem value="">Any level</MenuItem>
            {(meta?.levels || []).map((l) => <MenuItem key={l.id} value={l.id}>{l.label} and above</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Kind" value={filter.stream} onChange={(e) => set('stream', e.target.value)} sx={{ minWidth: 140 }}>
            <MenuItem value="">Log and output</MenuItem>
            <MenuItem value="log">Log only</MenuItem>
            <MenuItem value="output">Output only</MenuItem>
          </TextField>
          <TextField size="small" label="Contains" value={filter.q} onChange={(e) => set('q', e.target.value)} />
          {can('integrations.manage') && <Button color="error" onClick={() => setClearing(true)}>{filter.integration ? 'Delete these integration\'s lines' : 'Delete all saved lines'}</Button>}
        </Stack>
        {result && <LogLines lines={lines} label="Saved log" showLevel showTime empty="Nothing is saved yet. Choose a level above and run an integration." />}
        {result?.more && <Typography variant="body2" color="text.secondary">Showing the newest {lines.length}. Narrow the filters to see more.</Typography>}
      </Stack>
      <ConfirmDialog open={clearing} title="Delete saved lines?" confirmLabel="Delete"
        message="The saved log lines are removed. Each run's own output and log are not affected." onConfirm={clear} onClose={() => setClearing(false)} />
    </Stack>
  );
}
