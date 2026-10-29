import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import { useNotify } from '../../../components/Notify.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const BLANK = { name: '', value: '', secret: false, description: '' };

// Values scripts read as vars.NAME. A secret's value is write-only: it is never shown again, and is blanked from run output.
export default function Variables() {
  const can = useCan();
  const notify = useNotify();
  const manage = can('integrations.manage');
  const [vars, setVars] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api('/admin/integrations/variables').then((d) => setVars(d.variables)).catch((e) => setError(e.message)); }, []);

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      const d = await api(`/admin/integrations/variables/${encodeURIComponent(form.name)}`, { method: 'PUT', body: { value: form.value, secret: form.secret, description: form.description } });
      setVars(d.variables);
      notify(editing ? 'Variable saved' : 'Variable added');
      setForm(BLANK);
      setEditing(false);
    } catch (err) { setError(errorText(err)); }
  }

  async function remove(v) {
    setRemoving(null);
    try { setVars((await api(`/admin/integrations/variables/${encodeURIComponent(v.name)}`, { method: 'DELETE' })).variables); notify('Variable deleted'); } catch (err) { setError(errorText(err)); }
  }

  const edit = (v) => { setEditing(true); setForm({ name: v.name, value: v.secret ? '' : v.value, secret: v.secret, description: v.description }); };
  const existingSecret = editing && form.secret;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
        Keep endpoints, API keys and other values out of your scripts. A script reads them as <code>vars.NAME</code>. Secret values cannot be read back
        here and are replaced with [secret] in run logs and results.
      </Typography>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      {manage && (
        <Stack component="form" onSubmit={save} spacing={2} sx={{ maxWidth: 640 }} aria-label="Variable">
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Name" required value={form.name} disabled={editing} onChange={(e) => setForm({ ...form, name: e.target.value })} helperText="Letters, digits and underscores, e.g. CRM_URL." />
            <TextField label="Value" fullWidth type={form.secret ? 'password' : 'text'} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })}
              helperText={existingSecret ? 'Leave blank to keep the stored secret.' : undefined} autoComplete="off" />
          </Stack>
          <TextField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <FormControlLabel disabled={existingSecret} control={<Checkbox checked={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.checked })} />}
            label="Secret (hide the value, and blank it from run output)" />
          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained">{editing ? 'Save variable' : 'Add variable'}</Button>
            {editing && <Button onClick={() => { setEditing(false); setForm(BLANK); }}>Cancel</Button>}
          </Stack>
        </Stack>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Variables">
          <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Value</TableCell><TableCell>Description</TableCell>{manage && <TableCell />}</TableRow></TableHead>
          <TableBody>
            {vars && vars.length === 0 && <TableRow><TableCell colSpan={4}><Typography color="text.secondary">No variables yet.</Typography></TableCell></TableRow>}
            {(vars || []).map((v) => (
              <TableRow key={v.name}>
                <TableCell><code>vars.{v.name}</code></TableCell>
                <TableCell sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{v.secret ? (v.set ? '•••••••• (secret)' : '(empty secret)') : v.value}</TableCell>
                <TableCell>{v.description}</TableCell>
                {manage && (
                  <TableCell align="right">
                    <Button size="small" onClick={() => edit(v)}>Edit</Button>
                    <Button size="small" color="error" onClick={() => setRemoving(v)}>Delete</Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <ConfirmDialog open={Boolean(removing)} title="Delete this variable?" confirmLabel="Delete variable"
        message={removing ? `Scripts that read vars.${removing.name} will get nothing for it.` : ''}
        onConfirm={() => remove(removing)} onClose={() => setRemoving(null)} />
    </Stack>
  );
}
