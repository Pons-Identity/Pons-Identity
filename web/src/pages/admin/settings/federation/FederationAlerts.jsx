import { useEffect, useState } from 'react';
import { Alert, AlertTitle, Stack } from '@mui/material';
import { api } from '../../../../api/client.js';

// Problems that will break (or already have broken) federation sign-in, most severe first. `rev` changes when something
// the alerts depend on was changed, so they are fetched again.
export default function FederationAlerts({ rev }) {
  const [alerts, setAlerts] = useState([]);
  useEffect(() => {
    api('/admin/federation/health').then((r) => setAlerts(r.alerts || [])).catch(() => setAlerts([]));
  }, [rev]);
  if (!alerts.length) return null;
  return (
    <Stack spacing={1} role="region" aria-label="Federation alerts">
      {alerts.map((a, i) => (
        <Alert key={`${a.code}${a.ref}${i}`} severity={a.severity}>
          <AlertTitle>{a.title}</AlertTitle>
          {a.detail}
        </Alert>
      ))}
    </Stack>
  );
}
