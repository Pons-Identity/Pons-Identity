import { useState } from 'react';
import { Alert, Button, Card, CardContent, Stack, Typography } from '@mui/material';
import { api } from '../api/client.js';
import OwnActivity from '../components/OwnActivity.jsx';

// Self-service browsers and activity: browsers that may skip the second factor, and recent sign-ins to check.
export default function Browsers() {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function requireMfaNext() {
    setError('');
    setNotice('');
    try {
      const r = await api('/account/mfa/forget', { method: 'POST', body: {} });
      setNotice(r.browsers ? 'You will be asked for your second factor at your next sign-in.' : 'No browser was remembering a second factor. You will be asked at your next sign-in.');
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">Browsers and activity</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2} alignItems="flex-start">
            <Typography variant="h6" component="h2">Remembered browsers</Typography>
            <Typography color="text.secondary">
              A browser where you completed a second factor may skip it again for a while, as your sign-in rules allow.
              Use this to be asked for it at your next sign-in, from every browser.
            </Typography>
            <Button variant="outlined" onClick={requireMfaNext}>Require MFA at my next sign-in</Button>
          </Stack>
        </CardContent>
      </Card>

      <OwnActivity />
    </Stack>
  );
}
