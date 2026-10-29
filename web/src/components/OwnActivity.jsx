import { useEffect, useState } from 'react';
import { Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import { api } from '../api/client.js';

// The signed-in person's own recent sign-ins and failed attempts, so an unfamiliar one stands out.
export default function OwnActivity() {
  const [events, setEvents] = useState(null);
  useEffect(() => { api('/account/activity').then((r) => setEvents(r.events)).catch(() => setEvents([])); }, []);
  if (!events || !events.length) return null;
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">Recent sign-in activity</Typography>
          <Typography variant="body2" color="text.secondary">If you do not recognize something here, change your password and tell an administrator.</Typography>
          {events.slice(0, 10).map((e, i) => (
            <Stack key={i} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip size="small" color={e.outcome === 'success' ? 'success' : 'error'} label={e.outcome === 'success' ? 'Signed in' : 'Failed'} />
              <Typography variant="body2">
                {new Date(e.ts * 1000).toLocaleString()} · {[e.browser, e.os].filter(Boolean).join(' on ') || 'unknown device'} · {[e.city, e.country_name].filter(Boolean).join(', ') || e.ip}
                {e.device_known === false && ' · new device'}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}
