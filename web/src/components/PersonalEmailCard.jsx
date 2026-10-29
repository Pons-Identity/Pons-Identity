import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, Stack, TextField, Typography } from '@mui/material';
import { api } from '../api/client.js';
import { useNotify } from './Notify.jsx';

// The recovery address on the profile page: added with the password, confirmed with a code sent to it.
export default function PersonalEmailCard() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ email: '', current_password: '' });
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => api('/account/personal-email').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!data || !data.recovery_available) return null;

  async function send(e) {
    e.preventDefault();
    setError('');
    try {
      setSentTo((await api('/account/personal-email', { method: 'POST', body: form })).sent_to);
      setForm({ ...form, current_password: '' });
    } catch (err) { setError(err.message); }
  }

  async function confirm(e) {
    e.preventDefault();
    setError('');
    try {
      setData(await api('/account/personal-email/verify', { method: 'POST', body: { code } }));
      setSentTo(''); setCode(''); setForm({ email: '', current_password: '' });
      notify('Recovery address saved');
    } catch (err) { setError(err.message); }
  }

  async function remove() {
    setError('');
    try {
      setData(await api('/account/personal-email', { method: 'DELETE', body: { current_password: password } }));
      setPassword('');
      notify('Recovery address removed');
    } catch (err) { setError(err.message); }
  }

  const current = data.personal_email;
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Password recovery</Typography>
          <Typography variant="body2" color="text.secondary">
            If you forget your password, we can send a reset link to a personal email address that is not part of your organization&apos;s mail.
          </Typography>
          {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
          {current && (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center"><Typography>Recovery address: {current.hint}</Typography><Chip size="small" color={current.verified ? 'success' : 'warning'} label={current.verified ? 'Confirmed' : 'Not confirmed'} /></Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <TextField size="small" type="password" label="Current password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <Button color="error" onClick={remove} disabled={!password}>Remove</Button>
              </Stack>
            </Stack>
          )}
          {!sentTo ? (
            <Stack component="form" spacing={1} onSubmit={send}>
              <Typography variant="subtitle2">{current ? 'Change it' : 'Add one'}</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <TextField size="small" type="email" label="Personal email address" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required sx={{ flexGrow: 1 }} />
                <TextField size="small" type="password" label="Current password" autoComplete="current-password" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} required />
                <Button type="submit" variant="outlined">Send a code</Button>
              </Stack>
            </Stack>
          ) : (
            <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1} onSubmit={confirm}>
              <TextField size="small" label={`Code sent to ${sentTo}`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required sx={{ flexGrow: 1 }} />
              <Button type="submit" variant="contained">Confirm</Button>
              <Button onClick={() => { setSentTo(''); setCode(''); }}>Cancel</Button>
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
