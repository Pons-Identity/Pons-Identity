import { useEffect, useState } from 'react';
import {
  Alert, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { api } from '../../../../api/client.js';

const PAGE = 25;
const ROLE_OPTIONS = [{ value: '', label: 'All' }, { value: 'idp', label: 'Identity providers' }, { value: 'sp', label: 'Service providers' }];

const Field = ({ label, children }) => (
  <div>
    <Typography variant="caption" color="text.secondary">{label}</Typography>
    <Typography variant="body2" component="div" sx={{ wordBreak: 'break-all' }}>{children}</Typography>
  </div>
);

function Detail({ entity }) {
  const p = entity.parsed;
  const role = p.idp || p.sp;
  const attrs = Object.entries(p.entityAttributes || {});
  return (
    <Stack spacing={2}>
      <Field label="Entity ID">{entity.entity_id}</Field>
      {p.registrationAuthority && <Field label="Registered by">{p.registrationAuthority}</Field>}
      {p.organization?.name && <Field label="Organization">{p.organization.displayName || p.organization.name}{p.organization.url && ` (${p.organization.url})`}</Field>}
      {entity.valid_until && <Field label="Valid until">{entity.valid_until}</Field>}
      {p.idp?.scopes?.length > 0 && <Field label="Scopes">{p.idp.scopes.map((s) => (s.regexp ? `/${s.value}/` : s.value)).join(', ')}</Field>}
      {p.idp?.singleSignOnServices?.length > 0 && (
        <Field label="Sign-in endpoints">{p.idp.singleSignOnServices.map((s) => <div key={s.binding + s.location}>{s.binding.split(':').pop()}: {s.location}</div>)}</Field>
      )}
      {p.sp?.assertionConsumerServices?.length > 0 && (
        <Field label="Assertion consumer services">{p.sp.assertionConsumerServices.map((s) => <div key={s.binding + s.location}>{s.binding.split(':').pop()}: {s.location}</div>)}</Field>
      )}
      {attrs.length > 0 && (
        <Field label="Entity attributes">{attrs.map(([name, values]) => <div key={name}>{name}: {values.join(', ')}</div>)}</Field>
      )}
      {p.sp?.requestedAttributes?.length > 0 && (
        <Field label="Requested attributes">{p.sp.requestedAttributes.map((a) => <div key={a.name}>{a.friendlyName || a.name}{a.required ? ' (required)' : ''}</div>)}</Field>
      )}
      {role?.keys?.length > 0 && (
        <Field label="Keys">
          {role.keys.map((k, i) => (
            <div key={i}><strong>{k.use}</strong>: {k.subject}. Expires {k.notAfter}. SHA-256 {k.sha256}</div>
          ))}
        </Field>
      )}
    </Stack>
  );
}

// Everything imported from the metadata sources, so an administrator can check what an institution actually published.
export default function EntitiesCard() {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      api(`/admin/federation/entities?limit=${PAGE}&offset=${offset}&role=${role}&q=${encodeURIComponent(query)}`)
        .then((r) => { setData(r); setError(''); }).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [query, role, offset]);

  async function open(e) {
    setError('');
    try {
      setDetail(await api(`/admin/federation/entity?entityId=${encodeURIComponent(e.entity_id)}`));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Card variant="outlined" component="section" aria-labelledby="fed-entities">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" id="fed-entities">Imported entities</Typography>
          <Typography variant="body2" color="text.secondary">
            What the metadata sources currently supply. Only metadata that has not expired is listed.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField fullWidth label="Search entities" value={query} onChange={(e) => { setOffset(0); setQuery(e.target.value); }} />
            <TextField select label="Show" value={role} onChange={(e) => { setOffset(0); setRole(e.target.value); }} sx={{ minWidth: 200 }}>
              {ROLE_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
            </TextField>
          </Stack>
          {data && !data.entities.length ? <Typography color="text.secondary">No entities match.</Typography> : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label="Imported entities">
                <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Entity ID</TableCell><TableCell>Type</TableCell></TableRow></TableHead>
                <TableBody>
                  {(data?.entities || []).map((e) => (
                    <TableRow key={`${e.source_id}${e.entity_id}`} hover onClick={() => open(e)} sx={{ cursor: 'pointer' }}>
                      <TableCell>{e.display_name}</TableCell>
                      <TableCell sx={{ wordBreak: 'break-all' }}>{e.entity_id}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5}>{e.is_idp && <Chip size="small" label="IdP" />}{e.is_sp && <Chip size="small" label="SP" />}</Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {data && data.total > PAGE && (
            <Stack direction="row" spacing={2} alignItems="center">
              <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
              <Typography variant="body2">{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</Typography>
              <Button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
            </Stack>
          )}
        </Stack>
      </CardContent>
      <Dialog open={Boolean(detail)} onClose={() => setDetail(null)} fullWidth maxWidth="md">
        <DialogTitle>{detail?.display_name}</DialogTitle>
        <DialogContent>{detail && <Detail entity={detail} />}</DialogContent>
        <DialogActions><Button onClick={() => setDetail(null)}>Close</Button></DialogActions>
      </Dialog>
    </Card>
  );
}
