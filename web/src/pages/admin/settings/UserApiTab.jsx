import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Checkbox, FormControlLabel, FormGroup, Link, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import { useNotify } from '../../../components/Notify.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

const CURL = (url) => `curl -X POST ${url}/users \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"username":"srivera","generate_password":true,"email":"srivera@example.net"}'`;

// Tokens for the user API, which lets other software create and manage ordinary user accounts.
export default function UserApiTab() {
  const notify = useNotify();
  const [info, setInfo] = useState(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(['users:read', 'users:write']);
  const [expires, setExpires] = useState('');
  const [token, setToken] = useState('');
  const [revoking, setRevoking] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api('/admin/user-api').then(setInfo).catch((e) => setError(e.message)); }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      const { token: t, ...rest } = await api('/admin/user-api/tokens', { method: 'POST', body: { name, scopes, expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : '' } });
      setInfo(rest);
      setToken(t);
      setName('');
    } catch (err) { setError(errorText(err)); }
  }

  async function revoke(t) {
    setRevoking(null);
    setError('');
    try {
      setInfo(await api(`/admin/user-api/tokens/${t.id}`, { method: 'DELETE' }));
      notify('Token revoked');
    } catch (err) { setError(errorText(err)); }
  }

  const toggle = (s) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <Stack spacing={3}>
      <PageIntro title="User API">
        Other software, such as an HR system or a registration form, can create and manage ordinary user accounts through a REST API.
        A token can never change an administrator or a user owned by an external directory, and cannot grant roles. Give each integration its own token with only the scopes it needs.
      </PageIntro>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2">REST API</Typography>
            {info && <ReadOnlyField label="Base URL" value={info.apiUrl} />}
            {info && <Typography variant="body2">API reference: <Link href={info.docsUrl} target="_blank" rel="noreferrer">{info.docsUrl}</Link></Typography>}
            {info && <Typography variant="body2" component="pre" sx={{ m: 0, overflowX: 'auto' }}>{CURL(info.apiUrl)}</Typography>}

            <Stack component="form" onSubmit={create} spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Token name" required value={name} onChange={(e) => setName(e.target.value)} helperText="For example “HR sync”. Names are unique." sx={{ flexGrow: 1 }} />
                <TextField label="Expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} helperText="Optional." />
              </Stack>
              <FormGroup>
                {Object.entries(info?.scopes || {}).map(([s, label]) => (
                  <FormControlLabel key={s} control={<Checkbox checked={scopes.includes(s)} onChange={() => toggle(s)} />} label={<span><code>{s}</code> — {label}</span>} />
                ))}
              </FormGroup>
              <Button type="submit" variant="contained" sx={{ alignSelf: 'flex-start' }}>Create token</Button>
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
                  <TableRow><TableCell>Name</TableCell><TableCell>Scopes</TableCell><TableCell>Expires</TableCell><TableCell>Created</TableCell><TableCell>Last used</TableCell><TableCell /></TableRow>
                </TableHead>
                <TableBody>
                  {info && info.tokens.length === 0 && <TableRow><TableCell colSpan={6}><Typography color="text.secondary">No tokens yet.</Typography></TableCell></TableRow>}
                  {(info?.tokens || []).map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>{t.name}</TableCell>
                      <TableCell>{t.scopes.join(', ')}</TableCell>
                      <TableCell>{t.expires_at ? when(t.expires_at) : 'never'}</TableCell>
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

      <ConfirmDialog
        open={Boolean(revoking)}
        title="Revoke this token?"
        message={revoking ? `Software using “${revoking.name}” loses access immediately, and anything it scheduled that has not run yet is cancelled when it comes due.` : ''}
        confirmLabel="Revoke token"
        onConfirm={() => revoke(revoking)}
        onClose={() => setRevoking(null)}
      />
    </Stack>
  );
}
