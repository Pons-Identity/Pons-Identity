import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, FormControlLabel, MenuItem, Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { api } from '../../api/client.js';
import { useCan } from '../../auth/permissions.js';
import { useNotify } from '../../components/Notify.jsx';

const STATUS_COLOR = { valid: 'success', created: 'success', error: 'error', skipped: 'warning' };
const MAX_FILE = 900 * 1024;

const download = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

// Create many users from a CSV file: check first, then create now or at a chosen time.
export default function BulkUsers() {
  const can = useCan();
  const notify = useNotify();
  const [csv, setCsv] = useState('');
  const [opts, setOpts] = useState({ on_error: 'skip', generate_passwords: false, later: false, at: '' });
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState([]);

  const loadJobs = useCallback(() => api('/admin/users/bulk').then(setJobs).catch(() => {}), []);
  useEffect(() => { loadJobs(); }, [loadJobs]);

  function pick(e) {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MAX_FILE) { setErrors(['That file is too large; split it into smaller files.']); return; }
    f.text().then((t) => { setCsv(t); setResult(null); setErrors([]); });
  }

  async function submit(dry_run) {
    setBusy(true);
    setErrors([]);
    try {
      const body = { csv, dry_run, on_error: opts.on_error, generate_passwords: opts.generate_passwords };
      if (!dry_run && opts.later) body.run_at = new Date(opts.at).toISOString();
      const r = await api('/admin/users/bulk', { method: 'POST', body });
      if (r.scheduled) { notify('Import scheduled'); setResult(null); } else { setResult(r); if (!dry_run) loadJobs(); }
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    } finally {
      setBusy(false);
    }
  }

  async function template() {
    const r = await fetch('/api/admin/users/bulk/template', { credentials: 'same-origin' });
    download('users-template.csv', await r.text());
  }

  const s = result?.summary;
  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">Import users</Typography>
      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <Typography color="text.secondary">
            One user per row. Columns: username, password, first_name, last_name, display_name, email, emails (extra addresses separated by ;),
            groups (names separated by ;), active, mfa_required, any other user field, and attr.NAME for custom attributes. Roles cannot be set by import.
          </Typography>
          {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" component="label">Choose CSV file<input hidden type="file" accept=".csv,text/csv" onChange={pick} /></Button>
            <Button onClick={template}>Download template</Button>
          </Stack>
          <TextField label="CSV" multiline minRows={6} maxRows={16} value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null); }}
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } } }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <TextField select size="small" label="If a row has errors" value={opts.on_error} onChange={(e) => setOpts({ ...opts, on_error: e.target.value })} sx={{ minWidth: 260 }}>
              <MenuItem value="skip">Create the other rows</MenuItem>
              <MenuItem value="abort">Create nothing</MenuItem>
            </TextField>
            <FormControlLabel control={<Switch checked={opts.generate_passwords} disabled={opts.later} onChange={(e) => setOpts({ ...opts, generate_passwords: e.target.checked })} />} label="Generate missing passwords" />
            {can('users.schedule') && <FormControlLabel control={<Switch checked={opts.later} onChange={(e) => setOpts({ ...opts, later: e.target.checked, generate_passwords: false })} />} label="Create later" />}
            {opts.later && <TextField size="small" type="datetime-local" label="When" value={opts.at} onChange={(e) => setOpts({ ...opts, at: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />}
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" disabled={busy || !csv.trim()} onClick={() => submit(true)}>Check</Button>
            <Button variant="contained" disabled={busy || !csv.trim() || (opts.later && !opts.at)} onClick={() => submit(false)}>{opts.later ? 'Schedule import' : 'Create users'}</Button>
          </Stack>
        </Stack>
      </CardContent></Card>

      {result && (
        <Card variant="outlined"><CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2">{result.dry_run ? 'Check result' : `Import #${result.job_id}`}</Typography>
            <Typography>
              {s.total} rows: {result.dry_run ? `${s.valid} ready, ` : `${s.created} created, `}{s.failed} with errors.
              {!result.dry_run && result.job_id && <> <Button size="small" href={`/api/admin/users/bulk/${result.job_id}?format=csv`}>Download rows with errors</Button></>}
            </Typography>
            {result.generated.length > 0 && (
              <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => download('generated-passwords.csv', `username,password\n${result.generated.map((g) => `${g.username},${g.password}`).join('\n')}\n`)}>Download</Button>}>
                {result.generated.length} passwords were generated. They are shown only here and cannot be recovered; download them now and pass them on securely.
              </Alert>
            )}
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 420 }}>
              <Table size="small" stickyHeader>
                <TableHead><TableRow><TableCell>Row</TableCell><TableCell>Username</TableCell><TableCell>Result</TableCell><TableCell>Problems</TableCell></TableRow></TableHead>
                <TableBody>
                  {result.rows.map((r) => (
                    <TableRow key={r.row}>
                      <TableCell>{r.row}</TableCell><TableCell>{r.username}</TableCell>
                      <TableCell><Chip size="small" label={r.status} color={STATUS_COLOR[r.status]} /></TableCell>
                      <TableCell>{r.errors.join(' ')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        </CardContent></Card>
      )}

      {jobs.length > 0 && (
        <Card variant="outlined"><CardContent>
          <Typography variant="h6" component="h2" gutterBottom>Earlier imports</Typography>
          <Table size="small">
            <TableHead><TableRow><TableCell>#</TableCell><TableCell>When</TableCell><TableCell>By</TableCell><TableCell align="right">Created</TableCell><TableCell align="right">Failed</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>{j.id}</TableCell><TableCell>{new Date(j.created_at * 1000).toLocaleString()}</TableCell><TableCell>{j.actor}</TableCell>
                  <TableCell align="right">{j.created}</TableCell><TableCell align="right">{j.failed}</TableCell>
                  <TableCell align="right">{j.failed > 0 && <Button size="small" href={`/api/admin/users/bulk/${j.id}?format=csv`}>Errors CSV</Button>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}
    </Stack>
  );
}
