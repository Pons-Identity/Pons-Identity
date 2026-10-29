import { useEffect, useState } from 'react';
import { Alert, Button, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../api/client.js';
import { useNotify } from '../components/Notify.jsx';
import { PRIVILEGE_LABELS } from '../components/GroupPanels.jsx';

// Groups the signed-in person manages through a per-group grant, and groups they may join or leave themselves.
export default function MyGroups() {
  const notify = useNotify();
  const [managed, setManaged] = useState(null);
  const [available, setAvailable] = useState(null);
  const [error, setError] = useState('');

  const loadAvailable = () => api('/my/groups/available').then(setAvailable).catch((e) => setError(e.message));
  useEffect(() => {
    api('/my/groups').then(setManaged).catch((e) => setError(e.message));
    loadAvailable();
  }, []);

  async function change(group, action) {
    setError('');
    try {
      await api(`/my/groups/${group.id}/${action}`, { method: 'POST' });
      notify(action === 'join' ? `Joined ${group.name}` : `Left ${group.name}`);
      await loadAvailable();
    } catch (err) {
      setError(err.data?.error || err.message);
    }
  }

  const nothing = managed && available && managed.length === 0 && available.length === 0;
  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">My groups</Typography>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      {nothing && <Typography color="text.secondary">You have not been given access to any groups.</Typography>}

      {available && available.length > 0 && (
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">Groups you can join or leave</Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Description</TableCell><TableCell>Your membership</TableCell><TableCell align="right" /></TableRow></TableHead>
              <TableBody>
                {available.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>{g.name}</TableCell>
                    <TableCell>{g.description}</TableCell>
                    <TableCell>
                      {g.member ? <Chip size="small" color="success" label="Member" /> : <Chip size="small" label="Not a member" />}
                      {g.member && !g.direct && <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>through another group</Typography>}
                    </TableCell>
                    <TableCell align="right">
                      {g.can_join && <Button size="small" variant="contained" onClick={() => change(g, 'join')}>Join</Button>}
                      {g.can_leave && <Button size="small" color="error" onClick={() => change(g, 'leave')}>Leave</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Stack>
      )}

      {managed && managed.length > 0 && (
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">Groups you manage</Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Description</TableCell><TableCell>Your access</TableCell></TableRow></TableHead>
              <TableBody>
                {managed.map((g) => (
                  <TableRow key={g.id} hover component={RouterLink} to={`/groups/${g.id}`} sx={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
                    <TableCell>{g.name}{g.source !== 'local' && <Chip label={g.source === 'grouper' ? 'Grouper' : 'Directory'} size="small" sx={{ ml: 1 }} />}</TableCell>
                    <TableCell>{g.description}</TableCell>
                    <TableCell>{PRIVILEGE_LABELS[g.privilege]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Stack>
      )}
    </Stack>
  );
}
