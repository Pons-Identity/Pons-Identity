import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import { api } from '../api/client.js';
import AuthLogTable, { place } from './AuthLogTable.jsx';

// One person's sign-in history for an investigation: a summary of the last 90 days, then every step.
export default function UserSignIns({ userId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/admin/users/${userId}/auth-log?limit=100`).then(setData).catch((e) => setError(e.message)); }, [userId]);
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;
  const s = data.summary;
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
            <Typography variant="h6" component="h2">Sign-in activity</Typography>
            <Button size="small" href={`/api/admin/users/${userId}/auth-log?format=csv`}>Export CSV</Button>
          </Stack>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <Chip label={s.last_success ? `Last sign-in ${new Date(s.last_success.ts * 1000).toLocaleString()} from ${s.last_success.ip}${place(s.last_success) ? ` (${place(s.last_success)})` : ''}` : 'Never signed in'} />
            <Chip label={`${s.sign_ins_90d} sign-ins in 90 days`} />
            <Chip label={`${s.ips} addresses`} /><Chip label={`${s.devices} devices`} />
            <Chip label={`Countries: ${s.countries.join(', ') || 'none known'}`} />
            <Chip label={`${s.failures_24h} failures in 24 hours`} color={s.failures_24h ? 'warning' : 'default'} />
            {s.risky_90d > 0 && <Chip label={`${s.risky_90d} risky sign-ins`} color="warning" />}
          </Stack>
          <AuthLogTable events={data.events} showPerson={false} />
        </Stack>
      </CardContent>
    </Card>
  );
}
