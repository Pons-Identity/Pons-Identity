import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, CircularProgress, Container, Stack, TextField, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

const POLL_MS = 500;

export default function LoginDuo() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const loadState = useCallback(async () => {
    const s = await api('/login/duo');
    setState(s);
    setWaiting(s.waiting);
    setError(s.error || '');
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await refresh();
        await loadState();
      } catch {
        if (live) navigate('/login', { replace: true });
      }
    })();
    return () => { live = false; };
  }, [refresh, loadState, navigate]);

  // While a Duo Push is pending, poll until Duo answers.
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(async () => {
      try {
        const r = await api('/login/duo/status');
        if (r.result === 'allow') {
          clearInterval(timer);
          window.location.assign(r.next);
        } else if (r.result === 'deny') {
          setWaiting(false);
          await loadState();
        }
      } catch (e) {
        if (e.status === 400) navigate('/login', { replace: true });
        // Other failures are transient; keep polling.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, loadState, navigate]);

  async function sendPush() {
    setError('');
    try {
      await api('/login/duo/push', { method: 'POST' });
      setWaiting(true);
    } catch (e) {
      setError(e.message);
    }
  }

  async function submitPasscode(e) {
    e.preventDefault();
    setError('');
    try {
      const r = await api('/login/duo/passcode', { method: 'POST', body: { code } });
      window.location.assign(r.next);
    } catch (err) {
      setError(err.message);
      setCode('');
    }
  }

  if (!state) return null;

  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h5" component="h1">Two-step verification</Typography>
            <Typography color="text.secondary">Signed in as {state.username}</Typography>
            {error && <Alert severity="error">{error}</Alert>}
            {state.verificationCode && (
              <Stack spacing={1}>
                <Typography>When the Duo app asks, enter this number:</Typography>
                <Typography variant="h3" component="p" aria-label={`Number ${state.verificationCode.split('').join(' ')}`} sx={{ fontFamily: 'monospace', letterSpacing: 8 }}>
                  {state.verificationCode}
                </Typography>
              </Stack>
            )}

            {waiting ? (
              <Stack spacing={2} alignItems="flex-start">
                <Stack direction="row" spacing={2} alignItems="center">
                  <CircularProgress size={24} />
                  <Typography>Approve the Duo Push on your phone.</Typography>
                </Stack>
                <Button onClick={() => navigate('/login')}>Cancel</Button>
              </Stack>
            ) : (
              <Stack spacing={2}>
                {state.canPush && (
                  <Button variant="contained" onClick={sendPush}>Send Duo Push</Button>
                )}
                <Stack component="form" spacing={2} onSubmit={submitPasscode}>
                  <TextField label="Passcode" name="code" autoComplete="one-time-code" inputMode="numeric"
                    value={code} onChange={(e) => setCode(e.target.value)} required />
                  <Button type="submit" variant={state.canPush ? 'outlined' : 'contained'}>Verify passcode</Button>
                </Stack>
                <Button onClick={() => navigate('/login')}>Cancel</Button>
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
