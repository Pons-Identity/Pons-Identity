import { useState } from 'react';
import { Alert, Button, Card, CardContent, Container, Stack, TextField, Typography } from '@mui/material';
import { Link as RouterLink, Navigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

// Ask for a reset link: a new password (the default), or, with ?kind=mfa, removal of a lost second factor. The answer is the same
// whether or not an account matched, so it says only what happens next.
export default function Recover() {
  const { session } = useAuth();
  const [params] = useSearchParams();
  const mfa = params.get('kind') === 'mfa';
  const [identifier, setIdentifier] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!session.config?.passwordRecovery || (mfa && !session.config?.mfaReset)) return <Navigate to="/login" replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setMessage((await api(mfa ? '/recover/mfa' : '/recover', { method: 'POST', body: { identifier } })).message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container maxWidth="xs" sx={{ py: 8 }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2} component="form" onSubmit={submit}>
            <Typography variant="h5" component="h1">{mfa ? 'Lost your second factor?' : 'Forgot your password?'}</Typography>
            {error && <Alert severity="error">{error}</Alert>}
            {message ? <Alert severity="success">{message}</Alert> : (
              <>
                {mfa
                  ? <Typography color="text.secondary">Enter your username or email. If you have added a personal recovery address, we will send a link there. You will verify your identity before your second factors are removed.</Typography>
                  : <Typography color="text.secondary">Enter your username or email. If you have added a personal recovery address, we will send a reset link there.</Typography>}
                <TextField label="Username or email" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus required />
                <Button type="submit" variant="contained" disabled={busy}>{mfa ? 'Send link' : 'Send reset link'}</Button>
              </>
            )}
            {!mfa && session.config?.mfaReset && <Button component={RouterLink} to="/recover?kind=mfa" sx={{ alignSelf: 'flex-start' }}>Lost your second factor?</Button>}
            <Button component={RouterLink} to="/login" sx={{ alignSelf: 'flex-start' }}>Back to sign in</Button>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
