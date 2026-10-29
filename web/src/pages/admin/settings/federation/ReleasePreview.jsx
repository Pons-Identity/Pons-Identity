import { useEffect, useState } from 'react';
import {
  Alert, Autocomplete, Button, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Typography,
} from '@mui/material';
import { api } from '../../../../api/client.js';

// Shows exactly what a chosen person would be sent when signing in to a chosen federation service provider.
export default function ReleasePreview() {
  const [users, setUsers] = useState([]);
  const [user, setUser] = useState(null);
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState([]);
  const [entity, setEntity] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api('/admin/users').then(setUsers).catch(() => {}); }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/admin/federation/entities?role=sp&limit=25&q=${encodeURIComponent(query)}`).then((r) => setEntities(r.entities)).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  async function run() {
    setError('');
    setResult(null);
    try {
      setResult(await api(`/admin/federation/idp/preview?entityId=${encodeURIComponent(entity.entity_id)}&userId=${user.id}`));
    } catch (err) {
      setError(err.data?.errors?.join(' ') || err.message);
    }
  }

  return (
    <Card variant="outlined" component="section" aria-labelledby="fed-preview">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" id="fed-preview">Preview attribute release</Typography>
          <Typography variant="body2" color="text.secondary">
            Uses the saved settings and imported metadata. Previewing issues the person's identifier for that service provider if they have none yet.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <Autocomplete fullWidth options={entities} value={entity} filterOptions={(o) => o}
              getOptionLabel={(e) => (e.display_name && e.display_name !== e.entity_id ? `${e.display_name} (${e.entity_id})` : e.entity_id)}
              isOptionEqualToValue={(a, b) => a.entity_id === b.entity_id}
              onChange={(_, v) => setEntity(v)} onInputChange={(_, v, reason) => reason === 'input' && setQuery(v)}
              renderInput={(params) => <TextField {...params} label="Service provider" />} />
            <Autocomplete fullWidth options={users} value={user}
              getOptionLabel={(u) => `${u.username}${u.display_name ? ` (${u.display_name})` : ''}`}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              onChange={(_, v) => setUser(v)} renderInput={(params) => <TextField {...params} label="Person" />} />
            <Button variant="outlined" disabled={!entity || !user} onClick={run} sx={{ flexShrink: 0 }}>Preview</Button>
          </Stack>
          {result && (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip size="small" label={`NameID: ${result.nameIdFormat}`} />
                <Chip size="small" color={result.encrypted ? 'success' : 'default'} label={result.encrypted ? 'Assertion encrypted' : 'Assertion not encrypted'} />
                {result.registered && <Chip size="small" label="Registered service provider" />}
              </Stack>
              {result.attributes.length ? (
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small" aria-label="Released attributes">
                    <TableHead>
                      <TableRow><TableCell>Attribute</TableCell><TableCell>Value</TableCell><TableCell>Released because</TableCell></TableRow>
                    </TableHead>
                    <TableBody>
                      {result.attributes.map((a) => (
                        <TableRow key={a.name}>
                          <TableCell>
                            {a.friendly && <Typography variant="body2">{a.friendly}</Typography>}
                            <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{a.name}</Typography>
                          </TableCell>
                          <TableCell sx={{ wordBreak: 'break-all' }}>{a.values.join(', ')}</TableCell>
                          <TableCell>{a.via}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              ) : <Typography color="text.secondary">No attributes would be released.</Typography>}
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
