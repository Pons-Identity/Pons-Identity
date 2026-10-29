import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Container, Link, Stack, TextField, Typography } from '@mui/material';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { api } from '../api/client.js';

// Opened from the emailed link: choose a new password, or (for a second-factor link) remove the lost factors. When identity
// verification is required, the person first completes it with the provider, then checks again here.
export default function RecoverReset() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [error, setError] = useState('');
  const [state, setState] = useState('loading'); // loading | ready | done | dead

  const apply = (i) => { setInfo(i); setState('ready'); };
  useEffect(() => {
    api(`/recover/${encodeURIComponent(token)}`).then(apply).catch((e) => { setError(e.message); setState('dead'); });
  }, [token]);

  const identity = info?.identity || { required: false, status: 'none' };
  const passed = Boolean(info) && (!identity.required || identity.status === 'approved');
  const mfa = info?.purpose === 'mfa';

  async function act(path, body) {
    setError('');
    try { return await api(path, { method: 'POST', body }); } catch (err) { setError(err.message); return null; }
  }

  async function startIdentity() {
    const r = await act('/recover/identity', { token });
    if (r) apply(r);
  }

  async function checkIdentity() {
    const r = await act('/recover/identity/check', { token });
    if (r) apply(r);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (pw.next !== pw.confirm) return setError('The two passwords do not match.');
    try {
      await api('/recover/reset', { method: 'POST', body: { token, new_password: pw.next } });
      setState('done');
    } catch (err) {
      setError(err.message);
      if (err.status === 404) setState('dead');
    }
  }

  async function removeFactors() {
    setError('');
    try {
      await api('/recover/mfa/reset', { method: 'POST', body: { token } });
      setState('done');
    } catch (err) {
      setError(err.message);
      if (err.status === 404) setState('dead');
    }
  }

  return (
    <Container maxWidth="xs" sx={{ py: 8 }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h5" component="h1">{mfa ? 'Remove your second factors' : 'Choose a new password'}</Typography>
            {error && <Alert severity={state === 'dead' ? 'warning' : 'error'}>{error}</Alert>}
            {state === 'done' && (
              <Alert severity="success">
                {mfa ? 'Your second factors were removed. Sign in, and you will be asked to set up a new one.'
                  : 'Your password has been changed. If your account uses a second step, you will be asked for it as usual.'}
              </Alert>
            )}
            {state === 'ready' && info && (
              <>
                <Typography color="text.secondary">Account: {info.username}</Typography>
                {identity.required && (
                  <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
                    <Typography>{passed ? 'Your identity is verified.' : 'Before you continue, verify who you are with the service this site uses.'}</Typography>
                    {!passed && identity.status === 'missing' && <Button variant="outlined" onClick={startIdentity}>Verify my identity</Button>}
                    {!passed && identity.status !== 'missing' && (
                      <>
                        {identity.url && <Link href={identity.url} target="_blank" rel="noopener noreferrer">Open the verification</Link>}
                        <Typography color="text.secondary" variant="body2">
                          {identity.status === 'declined' || identity.status === 'expired'
                            ? 'The verification did not pass or has expired. Contact an administrator if you think this is a mistake.'
                            : 'When you have finished, check again here.'}
                        </Typography>
                        <Button variant="outlined" onClick={checkIdentity}>Check again</Button>
                      </>
                    )}
                  </Stack>
                )}
                {passed && mfa && <Button variant="contained" onClick={removeFactors} sx={{ alignSelf: 'flex-start' }}>Remove my second factors</Button>}
                {passed && !mfa && (
                  <Stack spacing={2} component="form" onSubmit={submit}>
                    <TextField label="New password" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })}
                      helperText={`At least ${info.min_length} characters.`} autoFocus required />
                    <TextField label="Confirm new password" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
                    <Button type="submit" variant="contained">Change password</Button>
                  </Stack>
                )}
              </>
            )}
            {state === 'dead' && <Button component={RouterLink} to="/recover" sx={{ alignSelf: 'flex-start' }}>Send a new link</Button>}
            {(state === 'done' || state === 'dead') && <Button component={RouterLink} to="/login" sx={{ alignSelf: 'flex-start' }}>Go to sign in</Button>}
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
