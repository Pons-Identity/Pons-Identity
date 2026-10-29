import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Container, List, ListItemButton, ListItemText, Stack, TextField, Typography } from '@mui/material';
import { Link as RouterLink, Navigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { safeNext } from '../safeNext.js';
import { signInImages } from '../components/brandImages.js';

const KEY = 'federation.lastIdp';
// Remembering the last choice is a convenience only; storage can be unavailable.
const remembered = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const remember = (idp) => { try { localStorage.setItem(KEY, JSON.stringify(idp)); } catch { /* ignore */ } };

// Choose the institution to sign in with, then hand over to the server, which sends the browser to its identity provider.
export default function FederatedLogin() {
  const { session } = useAuth();
  const { appName } = session.branding;
  const { logo } = signInImages(session.branding);
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [query, setQuery] = useState('');
  const [idps, setIdps] = useState(null);
  const [error, setError] = useState('');
  const last = remembered();

  useEffect(() => {
    const t = setTimeout(() => {
      api(`/federation/idps?q=${encodeURIComponent(query)}&limit=30`).then((r) => { setIdps(r.idps); setError(''); }).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  if (!session.config?.federationLogin) return <Navigate to="/login" replace />;

  const go = (idp) => {
    remember({ entity_id: idp.entity_id, name: idp.name });
    window.location.assign(`/fed/sp/login?idp=${encodeURIComponent(idp.entity_id)}&next=${encodeURIComponent(next)}`);
  };
  const shown = (idps || []).filter((i) => !last || i.entity_id !== last.entity_id || query);

  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            {logo && <Box component="img" src={logo} alt={appName} sx={{ maxHeight: 64, maxWidth: '100%', alignSelf: 'flex-start', objectFit: 'contain' }} />}
            <Typography variant="h5" component="h1">Sign in with your institution</Typography>
            <Typography variant="body2" color="text.secondary">
              Choose where you normally sign in. You will be sent there to prove who you are, then brought back.
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
            {last && !query && (
              <Button variant="contained" onClick={() => go(last)} sx={{ justifyContent: 'flex-start' }}>Continue with {last.name}</Button>
            )}
            <TextField label="Find your institution" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
            {idps && !shown.length && <Typography color="text.secondary">No institution matches that search.</Typography>}
            {idps && idps.length >= 30 && !query && <Typography variant="caption" color="text.secondary">Showing the first 30. Type to narrow the list.</Typography>}
            <List dense aria-label="Institutions" disablePadding>
              {shown.map((i) => (
                <ListItemButton key={i.entity_id} onClick={() => go(i)}>
                  <ListItemText primary={i.name} secondary={i.name !== i.entity_id ? i.entity_id : undefined} secondaryTypographyProps={{ sx: { wordBreak: 'break-all' } }} />
                </ListItemButton>
              ))}
            </List>
            <Button component={RouterLink} to={`/login${params.has('next') ? `?next=${encodeURIComponent(next)}` : ''}`} sx={{ alignSelf: 'flex-start' }}>
              Sign in with a username and password instead
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
