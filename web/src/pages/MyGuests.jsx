import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Chip, FormControlLabel, FormGroup, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { api } from '../api/client.js';
import CopyTextField from '../components/CopyTextField.jsx';
import { useNotify } from '../components/Notify.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.data?.error || err.message;
// datetime-local works in the browser's time zone; the server is sent a full ISO time.
const pad = (n) => String(n).padStart(2, '0');
const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const inDays = (n) => toLocal(new Date(Date.now() + n * 86400000));
const toIso = (local) => (local ? new Date(local).toISOString() : '');
// A guest's first password is always generated (never typed): four words with capitals, a number and hyphens, as in the passphrase
// generator on the password forms. The word list loads when the page does.
const PASSPHRASE = { words: 4, separator: '-', capitalize: true, includeNumber: true };
const BLANK = { username: '', first_name: '', last_name: '', email: '', password: '', role_ids: [], expires_at: '' };

// People the signed-in person hosts. A guest can sign in and, by default, do nothing else; the host may give them roles, but
// only ones whose permissions the host holds in full.
export default function MyGuests() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState('');
  const [generate, setGenerate] = useState(null);
  const [created, setCreated] = useState(null);

  // The new guest's expiry starts at the longest allowed, up to 30 days, and the host may shorten it.
  const defaultExpiry = (d) => inDays(Math.min(30, d.max_days));
  const load = () => api('/my/guests').then((d) => { setData(d); setForm((f) => (f.expires_at ? f : { ...f, expires_at: defaultExpiry(d) })); }).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, []);
  useEffect(() => { import('../passphrase.js').then((m) => setGenerate(() => m.generatePassphrase)); }, []);
  useEffect(() => { if (generate && !form.password) setForm((f) => ({ ...f, password: generate(PASSPHRASE) })); }, [generate, form.password]);

  const run = async (fn, done) => {
    setError('');
    try { await fn(); notify(done); await load(); return true; } catch (err) { setError(errorText(err)); return false; }
  };
  const toggleRole = (ids, id) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function invite(e) {
    e.preventDefault();
    const { username, password } = form;
    if (await run(() => api('/my/guests', { method: 'POST', body: { ...form, expires_at: toIso(form.expires_at) } }), `Invited ${username}`)) {
      setCreated({ username, password });
      setForm({ ...BLANK, expires_at: defaultExpiry(data) });
    }
  }

  const roles = data?.assignable_roles || [];
  const roleName = (id) => roles.find((r) => r.id === id)?.name || `Role ${id}`;
  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">My guests</Typography>
      <Typography variant="body2" color="text.secondary">
        A guest signs in with their own account until it expires, and can do nothing else until you give them a role. A guest can never do more than you can,
        and loses access you lose. You can host up to {data?.limit ?? 25} guests.
      </Typography>
      {created && (
        <Alert severity="success" onClose={() => setCreated(null)}>
          <Typography variant="body2" sx={{ mb: 1 }}>{created.username} can sign in with this password. It is not shown again, so give it to them now.</Typography>
          <CopyTextField label={`Password for ${created.username}`} value={created.password} fullWidth slotProps={{ htmlInput: { readOnly: true } }} />
        </Alert>
      )}
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      {data && !data.can_host && <Alert severity="info">You are no longer allowed to host guests. You can still see and remove the guests you have.</Alert>}
      {data && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label="Guests">
            <TableHead><TableRow><TableCell>Guest</TableCell><TableCell>Roles</TableCell><TableCell>Expires</TableCell><TableCell>Status</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>
              {data.guests.length === 0 && <TableRow><TableCell colSpan={5}>You have no guests.</TableCell></TableRow>}
              {data.guests.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>{g.display_name || g.username}<Typography variant="caption" display="block" color="text.secondary">{g.username}</Typography></TableCell>
                  <TableCell>
                    <FormGroup>
                      {roles.map((r) => (
                        <FormControlLabel key={r.id} label={r.name} control={(
                          <Checkbox size="small" checked={g.role_ids.includes(r.id)}
                            onChange={() => run(() => api(`/my/guests/${g.id}`, { method: 'PUT', body: { role_ids: toggleRole(g.role_ids, r.id) } }), 'Saved')} />
                        )} />
                      ))}
                      {g.role_ids.filter((id) => !roles.some((r) => r.id === id)).map((id) => <Chip key={id} size="small" label={roleName(id)} />)}
                    </FormGroup>
                    {g.role_ids.length === 0 && <Typography variant="caption" color="text.secondary">Login only</Typography>}
                  </TableCell>
                  <TableCell>
                    <TextField size="small" type="datetime-local" aria-label={`Expiry for ${g.username}`} defaultValue={toLocal(new Date(g.expires_at))}
                      key={g.expires_at} slotProps={{ htmlInput: { 'aria-label': `Expiry for ${g.username}` } }}
                      onBlur={(e) => e.target.value && toIso(e.target.value) !== g.expires_at && run(() => api(`/my/guests/${g.id}`, { method: 'PUT', body: { expires_at: toIso(e.target.value) } }), 'Expiry saved')} />
                  </TableCell>
                  <TableCell>{g.expired ? 'Expired' : g.active ? 'Active' : 'Disabled'}</TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => run(() => api(`/my/guests/${g.id}`, { method: 'PUT', body: { active: !g.active } }), g.active ? 'Disabled' : 'Enabled')}>{g.active ? 'Disable' : 'Enable'}</Button>
                    <Button size="small" color="error" onClick={() => window.confirm(`Remove ${g.username}?`) && run(() => api(`/my/guests/${g.id}`, { method: 'DELETE' }), 'Removed')}>Remove</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {data?.can_host && <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack component="form" spacing={2} onSubmit={invite} aria-label="Invite a guest">
          <Typography variant="h6" component="h2">Invite a guest</Typography>
          <TextField label="Username" value={form.username} onChange={set('username')} required />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="First name" value={form.first_name} onChange={set('first_name')} fullWidth />
            <TextField label="Last name" value={form.last_name} onChange={set('last_name')} fullWidth />
          </Stack>
          <TextField label="Email" type="email" value={form.email} onChange={set('email')} />
          <TextField label="Expires" type="datetime-local" value={form.expires_at} onChange={set('expires_at')} required
            helperText={`The guest stops working at this time. At most ${data?.max_days ?? 14} days from now; you can extend it later.`} slotProps={{ inputLabel: { shrink: true } }} />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <TextField label="Initial password" value={form.password} fullWidth required
              helperText="Generated for you. Give it to the guest; they can change it after signing in."
              slotProps={{ htmlInput: { readOnly: true, autoComplete: 'off', style: { fontFamily: 'monospace' } } }} />
            <Button variant="outlined" disabled={!generate} onClick={() => setForm((f) => ({ ...f, password: generate(PASSPHRASE) }))} sx={{ mt: 1 }}>Regenerate</Button>
          </Stack>
          {roles.length > 0 && (
            <FormGroup aria-label="Roles">
              {roles.map((r) => (
                <FormControlLabel key={r.id} label={r.name} control={<Checkbox checked={form.role_ids.includes(r.id)} onChange={() => setForm((f) => ({ ...f, role_ids: toggleRole(f.role_ids, r.id) }))} />} />
              ))}
            </FormGroup>
          )}
          <Button type="submit" variant="contained" sx={{ alignSelf: 'flex-start' }}>Invite</Button>
        </Stack>
      </Paper>}
    </Stack>
  );
}
