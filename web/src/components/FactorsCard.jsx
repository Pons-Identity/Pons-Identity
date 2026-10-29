import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api/client.js';
import { useNotify } from './Notify.jsx';

const NAMES = { totp: 'Authenticator app', webauthn: 'Security key or passkey', email: 'Email', sms: 'Text message', voice: 'Phone call' };
const when = (s) => (s ? new Date(`${s.replace(' ', 'T')}Z`).toLocaleString() : 'never');

// The signed-in person's extra sign-in methods: security keys, and email, SMS and voice.
export default function FactorsCard() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [add, setAdd] = useState({ type: '', destination: '' });
  const [pendingCode, setPendingCode] = useState(null);
  const [code, setCode] = useState('');
  const [removing, setRemoving] = useState(null);
  const [password, setPassword] = useState('');

  const load = useCallback(() => api('/account/factors').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;

  const channels = ['email', 'sms', 'voice'].filter((t) => data.available[t].enabled);
  const anyAvailable = data.available.webauthn.enabled || channels.length > 0;
  const managed = data.factors.filter((f) => f.type !== 'totp');
  if (!anyAvailable && !managed.length) return null;

  async function addKey() {
    setError('');
    try {
      const optionsJSON = await api('/account/factors/webauthn/options', { method: 'POST', body: {} });
      const response = await startRegistration({ optionsJSON });
      setData(await api('/account/factors/webauthn/verify', { method: 'POST', body: { response, label } }));
      setLabel('');
      notify('Security key added');
    } catch (e) {
      setError(e.name === 'NotAllowedError' ? 'The security key request was cancelled or timed out.' : e.message);
    }
  }

  async function sendCode(e) {
    e.preventDefault();
    setError('');
    try {
      const r = await api('/account/factors/otp', { method: 'POST', body: add });
      setPendingCode(r);
    } catch (err) { setError(err.message); }
  }

  async function verify(e) {
    e.preventDefault();
    setError('');
    try {
      setData(await api('/account/factors/otp/verify', { method: 'POST', body: { code } }));
      setPendingCode(null); setCode(''); setAdd({ type: '', destination: '' });
      notify('Method added');
    } catch (err) { setError(err.message); }
  }

  async function remove() {
    const f = removing;
    setError('');
    try {
      setData(await api(`/account/factors/${f.id.slice(1)}`, { method: 'DELETE', body: { current_password: password } }));
      setRemoving(null); setPassword('');
      notify('Method removed');
    } catch (err) { setError(err.message); }
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Other ways to verify</Typography>
          {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
          {managed.map((f) => (
            <Stack key={f.id} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography sx={{ flexGrow: 1 }}>
                {NAMES[f.type]}{f.type === 'webauthn' ? ` — ${f.label}` : ` — ${f.hint}`}
                <Typography component="span" variant="body2" color="text.secondary"> · last used {when(f.last_used_at)}</Typography>
              </Typography>
              {f.phishing_resistant && <Chip size="small" color="success" label="Phishing resistant" />}
              <Button size="small" color="error" onClick={() => setRemoving(f)}>Remove</Button>
            </Stack>
          ))}
          {!managed.length && <Typography color="text.secondary">None set up. Your authenticator app{data.factors.some((f) => f.type === 'totp') ? '' : ' (above)'} is your only second step.</Typography>}

          {data.available.webauthn.enabled && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField size="small" label="Name for this key" value={label} onChange={(e) => setLabel(e.target.value)} />
              <Button variant="outlined" onClick={addKey}>Add a security key</Button>
            </Stack>
          )}

          {channels.length > 0 && !pendingCode && (
            <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1} onSubmit={sendCode}>
              <TextField select size="small" label="Add" value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value })} sx={{ minWidth: 190 }} required>
                {channels.map((t) => <MenuItem key={t} value={t}>{NAMES[t]}{data.available[t].phishing_resistant ? ' (phishing resistant)' : ''}</MenuItem>)}
              </TextField>
              <TextField size="small" label={add.type === 'email' ? 'Email address' : 'Number, like +15551234567'} value={add.destination} onChange={(e) => setAdd({ ...add, destination: e.target.value })} required sx={{ flexGrow: 1 }} />
              <Button type="submit" variant="outlined">Send a code</Button>
            </Stack>
          )}
          {pendingCode && (
            <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1} onSubmit={verify}>
              <TextField size="small" label={`Code sent to ${pendingCode.hint}`} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required sx={{ flexGrow: 1 }} />
              <Button type="submit" variant="contained">Confirm</Button>
              <Button onClick={() => { setPendingCode(null); setCode(''); }}>Cancel</Button>
            </Stack>
          )}
        </Stack>
      </CardContent>

      <Dialog open={Boolean(removing)} onClose={() => setRemoving(null)} fullWidth maxWidth="xs">
        <DialogTitle>Remove this method?</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {data.user.can_change_password && <TextField label="Current password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={remove}>Remove</Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
