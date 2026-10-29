import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import { useProductName } from '../../../auth/AuthContext.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

const CURL = (url) => `curl -H "Authorization: Bearer $TOKEN" ${url}/tree`;

// Tokens for the group API, and a pointer to the SQL views for software that reads the database directly.
export default function GroupApiTab() {
  const productName = useProductName();
  const notify = useNotify();
  const [info, setInfo] = useState(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('read');
  const [token, setToken] = useState('');
  const [revoking, setRevoking] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api('/admin/group-api').then(setInfo).catch((e) => setError(e.message)); }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      const { token: t, ...rest } = await api('/admin/group-api/tokens', { method: 'POST', body: { name, scope } });
      setInfo(rest);
      setToken(t);
      setName('');
    } catch (err) { setError(errorText(err)); }
  }

  async function revoke(t) {
    setRevoking(null);
    setError('');
    try {
      setInfo(await api(`/admin/group-api/tokens/${t.id}`, { method: 'DELETE' }));
      notify('Token revoked');
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <Stack spacing={3}>
      <PageIntro title="Group API">
        External software can manage groups and the folders that organize them through a REST API, or work on the database directly through SQL views.
        A token reaches every local group, so keep it as safe as an administrator password. Use a read-only token wherever you can.
      </PageIntro>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2">REST API</Typography>
            {info && <ReadOnlyField label="Base URL" value={info.apiUrl} />}
            {info && <Typography variant="body2" component="pre" sx={{ m: 0, overflowX: 'auto' }}>{CURL(info.apiUrl)}</Typography>}
            <Typography variant="body2" color="text.secondary">Endpoints, request bodies and examples are in the README under “Group management API”.</Typography>

            <Stack component="form" onSubmit={create} direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'flex-start' }}>
              <TextField label="Token name" required value={name} onChange={(e) => setName(e.target.value)} helperText="For example “HR sync”." />
              <TextField select label="Access" value={scope} onChange={(e) => setScope(e.target.value)} sx={{ minWidth: 200 }}>
                <MenuItem value="read">Read only</MenuItem>
                <MenuItem value="write">Read and write</MenuItem>
              </TextField>
              <Button type="submit" variant="contained" sx={{ height: 40, whiteSpace: 'nowrap' }}>Create token</Button>
            </Stack>

            {token && (
              <Alert severity="success" onClose={() => setToken('')}>
                <Stack spacing={1}>
                  <span>Copy this token now. It is not shown again.</span>
                  <ReadOnlyField label="API token" value={token} />
                </Stack>
              </Alert>
            )}

            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label="API tokens">
                <TableHead>
                  <TableRow><TableCell>Name</TableCell><TableCell>Access</TableCell><TableCell>Created</TableCell><TableCell>Last used</TableCell><TableCell /></TableRow>
                </TableHead>
                <TableBody>
                  {info && info.tokens.length === 0 && <TableRow><TableCell colSpan={5}><Typography color="text.secondary">No tokens yet.</Typography></TableCell></TableRow>}
                  {(info?.tokens || []).map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>{t.name}</TableCell>
                      <TableCell>{t.scope === 'write' ? 'Read and write' : 'Read only'}</TableCell>
                      <TableCell>{when(t.created_at)}{t.created_by && ` by ${t.created_by}`}</TableCell>
                      <TableCell>{when(t.last_used_at)}</TableCell>
                      <TableCell align="right"><Button size="small" color="error" onClick={() => setRevoking(t)}>Revoke</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h6" component="h2">SQL views</Typography>
            <Typography variant="body2" color="text.secondary">
              Software with access to the {productName} database file can use these views instead of the API. They are the supported contract; the tables behind them may change.
              Writes follow the same rules as the console and appear in group history and the audit log as “sql-interface”.
              SQLite has no per-user permissions, so anyone who can open the file can read and change everything. Do not hand it to software you would not trust with an administrator account.
            </Typography>
            <Typography variant="body2" component="pre" sx={{ m: 0, overflowX: 'auto' }}>{(info?.sqlViews || []).join('\n')}</Typography>
            <Typography variant="body2" color="text.secondary">Open the file with <code>PRAGMA foreign_keys = ON</code> (writes are refused without it) and a busy timeout. See the README under “SQL interface”.</Typography>
          </Stack>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={Boolean(revoking)}
        title="Revoke this token?"
        message={revoking ? `Software using “${revoking.name}” loses access to the group API immediately.` : ''}
        confirmLabel="Revoke token"
        onConfirm={() => revoke(revoking)}
        onClose={() => setRevoking(null)}
      />
    </Stack>
  );
}
