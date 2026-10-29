import { useEffect, useState } from 'react';
import { Alert, Button, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import { when } from './IntegrationList.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;

// Functions every integration can call as fn.NAME({ ... }). Written once here; a function runs inside the integration that calls it.
export default function Functions() {
  const can = useCan();
  const notify = useNotify();
  const manage = can('integrations.manage');
  const [fns, setFns] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api('/admin/integrations/functions').then((d) => setFns(d.functions)).catch((e) => setError(e.message)); }, []);

  async function remove(f) {
    setRemoving(null);
    try { setFns((await api(`/admin/integrations/functions/${encodeURIComponent(f.name)}`, { method: 'DELETE' })).functions); notify('Function deleted'); } catch (err) { setError(errorText(err)); }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
          A function is written once and called from any integration as <code>await fn.NAME(&#123; ... &#125;)</code>, with one object in (one key for each input) and one value out. It runs inside
          the integration that calls it, so it has that integration&apos;s scopes, variables and limits: it cannot do more than its caller. The functions
          below are ones to start from; edit or delete them as you like.
        </Typography>
        {manage && <Button variant="contained" startIcon={<AddIcon />} component={RouterLink} to="/admin/integrations/functions/new">New function</Button>}
      </Stack>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Functions">
          <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Inputs</TableCell><TableCell>Description</TableCell><TableCell>Last changed</TableCell>{manage && <TableCell />}</TableRow></TableHead>
          <TableBody>
            {fns && fns.length === 0 && <TableRow><TableCell colSpan={5}><Typography color="text.secondary">No functions yet.</Typography></TableCell></TableRow>}
            {(fns || []).map((f) => (
              <TableRow key={f.name}>
                <TableCell><code>fn.{f.name}</code></TableCell>
                <TableCell>{f.inputs.map((i) => <code key={i.name} style={{ display: 'block' }}>{i.name}</code>)}</TableCell>
                <TableCell>{f.description}</TableCell>
                <TableCell>{when(f.updated_at)}</TableCell>
                {manage && (
                  <TableCell align="right">
                    <Button size="small" component={RouterLink} to={`/admin/integrations/functions/${encodeURIComponent(f.name)}`}>Edit</Button>
                    <Button size="small" color="error" onClick={() => setRemoving(f)}>Delete</Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <ConfirmDialog open={Boolean(removing)} title="Delete this function?" confirmLabel="Delete function"
        message={removing ? `Integrations that call fn.${removing.name} will fail until it is added back.` : ''}
        onConfirm={() => remove(removing)} onClose={() => setRemoving(null)} />
    </Stack>
  );
}
