import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { api } from '../../api/client.js';

const COLOR = { pending: 'info', running: 'info', done: 'success', failed: 'error', cancelled: 'default' };
const LABEL = { create: 'Create', activate: 'Activate', deactivate: 'Deactivate', delete: 'Delete' };

// Every scheduled account action, with what happened when it ran.
export default function Schedules() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api('/admin/schedules').then(setItems).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function cancel(id) {
    try { await api(`/admin/schedules/${id}`, { method: 'DELETE' }); load(); } catch (e) { setError(e.data?.errors?.[0] || e.message); }
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h5" component="h1">Scheduled changes</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead><TableRow><TableCell>When</TableCell><TableCell>Action</TableCell><TableCell>Target</TableCell><TableCell>Status</TableCell><TableCell>Result</TableCell><TableCell>By</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {(items || []).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{new Date(s.run_at * 1000).toLocaleString()}</TableCell>
                <TableCell>{LABEL[s.action]}</TableCell>
                <TableCell>{s.scope === 'group' ? `Group ${s.target}` : s.target}</TableCell>
                <TableCell><Chip size="small" label={s.status} color={COLOR[s.status]} /></TableCell>
                <TableCell>{s.result}</TableCell>
                <TableCell>{s.created_by}</TableCell>
                <TableCell align="right">{s.status === 'pending' && <Button size="small" color="error" onClick={() => cancel(s.id)}>Cancel</Button>}</TableCell>
              </TableRow>
            ))}
            {items && !items.length && <TableRow><TableCell colSpan={7}>Nothing has been scheduled.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
