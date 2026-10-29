import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Container, Stack, TextField, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';

// Opened from the link in an email or text message, on the device that received it. The person types the number from the
// sign-in screen here; nothing about the sign-in is revealed on this page, and the link alone approves nothing.
export default function Approve() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [number, setNumber] = useState('');
  const [error, setError] = useState('');
  const [state, setState] = useState('ready'); // ready | done | dead

  useEffect(() => {
    api(`/factors/approve/${encodeURIComponent(token)}`).then(setInfo).catch((e) => { setError(e.message); setState('dead'); });
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api(`/factors/approve/${encodeURIComponent(token)}`, { method: 'POST', body: { number } });
      setState('done');
    } catch (err) {
      setError(err.message);
      setNumber('');
      if (err.status === 404 || err.status === 429) setState('dead');
    }
  }

  return (
    <Container maxWidth="xs" sx={{ py: 8 }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2} component="form" onSubmit={submit}>
            <Typography variant="h5" component="h1">{info ? `Approve your ${info.app} sign-in` : 'Approve sign-in'}</Typography>
            {error && <Alert severity={state === 'dead' ? 'warning' : 'error'}>{error}</Alert>}
            {state === 'done' && <Alert severity="success">Approved. You can go back to the sign-in screen.</Alert>}
            {state === 'ready' && info && (
              <>
                <Typography>Enter the number shown on the screen where you are signing in. If you are not signing in, close this page.</Typography>
                <TextField label="Number on the sign-in screen" inputMode="numeric" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} autoFocus required />
                <Button type="submit" variant="contained">Approve</Button>
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
