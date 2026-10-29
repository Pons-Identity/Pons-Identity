import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardActionArea, CardContent, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useCan } from '../../auth/permissions.js';
import SignInChart from '../../components/SignInChart.jsx';

// One stat tile. `to` makes it a link; without a route it is a plain figure.
function Stat({ label, value, note, to }) {
  const body = (
    <CardContent>
      <Typography variant="overline" color="text.secondary">{label}</Typography>
      <Typography variant="h3">{value ?? '…'}</Typography>
      {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
    </CardContent>
  );
  return (
    <Card variant="outlined">
      {to ? <CardActionArea component={RouterLink} to={to}>{body}</CardActionArea> : body}
    </Card>
  );
}

const grid = (count) => ({ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: `repeat(${Math.max(Math.min(count, 4), 1)}, 1fr)`, lg: `repeat(${Math.max(count, 1)}, 1fr)` } });

export default function Dashboard() {
  const can = useCan();
  const [counts, setCounts] = useState(null);
  const [error, setError] = useState('');

  const [fedAlerts, setFedAlerts] = useState([]);

  useEffect(() => {
    api('/admin/dashboard').then(setCounts).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!can('federation.view')) return;
    api('/admin/federation/health').then((r) => setFedAlerts((r.alerts || []).filter((a) => a.severity !== 'info'))).catch(() => {});
  }, []);

  const directory = [
    ['Users', '/admin/users', counts?.users, 'users.view', counts && `${counts.activeUsers.toLocaleString()} active`],
    ['Groups', '/admin/groups', counts?.groups, 'groups.view'],
    ['Applications', '/admin/sps', counts?.sps, 'sps.view'],
    ['Roles', '/admin/settings/roles', counts?.roles, 'roles.view'],
  ].filter(([, , , permission]) => can(permission));

  const signIns = counts?.signIns;
  const showSignIns = can('audit.view');
  const signInTiles = showSignIns ? [
    ['Successful sign-ins', '/admin/sign-ins', signIns?.succeeded, 'in the last 24 hours'],
    ['Failed or denied', '/admin/sign-ins', signIns?.failed, 'in the last 24 hours'],
    ['People signed in', '/admin/sign-ins', signIns?.usersSignedIn, 'in the last 24 hours'],
  ] : [];

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">Dashboard</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {fedAlerts.length > 0 && (
        <Alert severity={fedAlerts.some((a) => a.severity === 'error') ? 'error' : 'warning'}
          action={<Button color="inherit" size="small" component={RouterLink} to="/admin/federation">Review</Button>}>
          {fedAlerts.length === 1 ? fedAlerts[0].detail : `${fedAlerts.length} federation problems need attention.`}
        </Alert>
      )}
      {directory.length > 0 && (
        <Box sx={grid(directory.length)}>
          {directory.map(([label, to, n, , note]) => (
            <Stat key={label} label={label} to={to} value={n?.toLocaleString()} note={note} />
          ))}
        </Box>
      )}
      {showSignIns && (
        <>
          <Box sx={grid(signInTiles.length)}>
            {signInTiles.map(([label, to, n, note]) => (
              <Stat key={label} label={label} to={to} value={n?.toLocaleString()} note={note} />
            ))}
          </Box>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="h6" component="h2">Authentications, last 24 hours</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Per 15 minutes. Failed or denied counts passwords, sign-ins and second steps that were refused.</Typography>
              {signIns ? <SignInChart buckets={signIns.buckets} /> :<Typography variant="body2">Loading…</Typography>}
            </CardContent>
          </Card>
        </>
      )}
    </Stack>
  );
}
