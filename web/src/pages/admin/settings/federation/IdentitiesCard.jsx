import { useEffect, useState } from 'react';
import {
  Alert, Autocomplete, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { api } from '../../../../api/client.js';
import { useNotify } from '../../../../components/Notify.jsx';
import ConfirmDialog from '../../../../components/ConfirmDialog.jsx';

const COLORS = { pending: 'warning', active: 'success', blocked: 'error' };
const when = (s) => (s ? new Date(`${s.replace(' ', 'T')}${/Z$/.test(s) ? '' : 'Z'}`).toLocaleString() : 'Never');

// Everyone who has come back from another institution, and the queue of first-time sign-ins waiting for a decision.
export default function IdentitiesCard({ canManage, canLink }) {
  const notify = useNotify();
  const [rows, setRows] = useState(null);
  const [users, setUsers] = useState([]);
  const [link, setLink] = useState(null);
  const [linkUser, setLinkUser] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/admin/federation/identities').then((r) => setRows(r.identities)).catch((e) => setError(e.message));
    if (canLink) api('/admin/users').then(setUsers).catch(() => {});
  }, [canLink]);

  async function act(path, options, message) {
    setError('');
    try {
      const r = await api(`/admin/federation/identities/${path}`, options);
      setRows(r.identities);
      if (message) notify(message);
    } catch (err) {
      setError(err.data?.errors?.join(' ') || err.message);
    }
  }

  if (!rows) return error ? <Alert severity="error">{error}</Alert> : null;
  const pending = rows.filter((r) => r.status === 'pending').length;

  return (
    <Card variant="outlined" component="section" aria-labelledby="fed-identities">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" id="fed-identities">
            People from other institutions{pending > 0 && <Chip size="small" color="warning" label={`${pending} waiting`} sx={{ ml: 1 }} />}
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          {!rows.length ? <Typography color="text.secondary">Nobody has signed in through another institution yet.</Typography> : (
            <TableContainer>
              <Table size="small" aria-label="Federated identities">
                <TableHead>
                  <TableRow>
                    <TableCell>Person</TableCell><TableCell>Institution</TableCell><TableCell>Status</TableCell><TableCell>Local account</TableCell>
                    <TableCell>Last sign-in</TableCell>{canManage && <TableCell align="right">Actions</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Typography variant="body2">{r.display_name || r.subject}</Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{r.email || r.subject}</Typography>
                      </TableCell>
                      <TableCell sx={{ wordBreak: 'break-all' }}>{r.idp_entity_id}</TableCell>
                      <TableCell><Chip size="small" color={COLORS[r.status]} label={r.status} /></TableCell>
                      <TableCell>{r.username || '—'}</TableCell>
                      <TableCell>{when(r.last_login_at)}</TableCell>
                      {canManage && (
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {r.status === 'pending' && canLink && (
                            <>
                              <Button size="small" aria-label={`Approve ${r.display_name || r.subject}`}
                                onClick={() => act(`${r.id}/approve`, { method: 'POST', body: {} }, 'Approved. A new account was created.')}>Approve</Button>
                              <Button size="small" aria-label={`Link ${r.display_name || r.subject}`}
                                onClick={() => { setLinkUser(null); setLink(r); }}>Link to user</Button>
                            </>
                          )}
                          {r.status === 'active' && (
                            <Button size="small" aria-label={`Block ${r.display_name || r.subject}`}
                              onClick={() => act(`${r.id}/status`, { method: 'POST', body: { status: 'blocked' } }, 'Blocked')}>Block</Button>
                          )}
                          {r.status === 'blocked' && (
                            <Button size="small" aria-label={`Unblock ${r.display_name || r.subject}`}
                              onClick={() => act(`${r.id}/status`, { method: 'POST', body: { status: r.user_id ? 'active' : 'pending' } }, 'Unblocked')}>Unblock</Button>
                          )}
                          <Tooltip title="Forget this sign-in. The local account is kept.">
                            <IconButton aria-label={`Delete ${r.display_name || r.subject}`} onClick={() => setConfirm(r)}><DeleteIcon /></IconButton>
                          </Tooltip>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </CardContent>

      <Dialog open={Boolean(link)} onClose={() => setLink(null)} fullWidth maxWidth="sm">
        <DialogTitle>Link to an existing user</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {link && `${link.display_name || link.subject} from ${link.idp_entity_id} will sign in as the user you choose, with all of that user's access.`}
              {' '}Check this really is the same person; an institution's email address is not proof.
            </Typography>
            <Autocomplete options={users.filter((u) => u.active)} value={linkUser} onChange={(_, v) => setLinkUser(v)}
              getOptionLabel={(u) => `${u.username}${u.display_name ? ` (${u.display_name})` : ''}`} isOptionEqualToValue={(a, b) => a.id === b.id}
              renderInput={(params) => <TextField {...params} label="Local user" />} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLink(null)}>Cancel</Button>
          <Button variant="contained" disabled={!linkUser}
            onClick={() => { const id = link.id; const user_id = linkUser.id; setLink(null); act(`${id}/approve`, { method: 'POST', body: { user_id } }, 'Linked'); }}>Link</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog open={Boolean(confirm)} title="Forget this sign-in?" confirmLabel="Forget"
        message={`${confirm?.display_name || confirm?.subject || ''} will have to be approved again the next time they sign in. Their local account is not deleted.`}
        onConfirm={() => { const id = confirm.id; setConfirm(null); act(String(id), { method: 'DELETE' }, 'Removed'); }} onClose={() => setConfirm(null)} />
    </Card>
  );
}
