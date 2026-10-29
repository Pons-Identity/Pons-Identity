import { useState } from 'react';
import { Alert, Button, Chip, Link, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { useCan } from '../../../auth/permissions.js';
import { ListSearch, useSearchedList } from '../../../components/ListSearch.jsx';

export const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
export const STATUS_COLOR = { ok: 'success', error: 'error', timeout: 'warning', running: 'info' };

// The list endpoint returns the whole page's data; only the integrations are the list.
const integrationsOf = (d) => d.integrations;

export default function IntegrationList() {
  const can = useCan();
  const [params] = useSearchParams();
  const [text, setText] = useState(() => params.get('q') || '');
  const { rows, error } = useSearchedList('/admin/integrations', text, { pick: integrationsOf });

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
          An integration is a script that processes data from, or sends data to, another system: create users from an HR feed, look people up in an
          outside directory, post to a chat channel. Start it by hand, from a webhook, on a schedule, or when something happens in the IdP.
        </Typography>
        {can('integrations.manage') && <Button variant="contained" startIcon={<AddIcon />} component={RouterLink} to="/admin/integrations/new">New integration</Button>}
      </Stack>
      <ListSearch label="Search integrations" value={text} onChange={setText} helperText="Name or description." />
      {error && <Alert severity="error">{error}</Alert>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Integrations">
          <TableHead>
            <TableRow><TableCell>Name</TableCell><TableCell>Can use</TableCell><TableCell>Started by</TableCell><TableCell>Last run</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {rows && rows.length === 0 && (
              <TableRow><TableCell colSpan={4}><Typography color="text.secondary">{text.trim() ? 'No integrations match.' : 'No integrations yet.'}</Typography></TableCell></TableRow>
            )}
            {(rows || []).map((i) => (
              <TableRow key={i.id} hover>
                <TableCell>
                  <Link component={RouterLink} to={`/admin/integrations/${i.id}`}>{i.name}</Link>
                  {!i.enabled && <Chip size="small" label="Off" sx={{ ml: 1 }} />}
                  {i.description && <Typography variant="body2" color="text.secondary">{i.description}</Typography>}
                </TableCell>
                <TableCell>{i.scopes.length ? i.scopes.join(', ') : 'nothing outside the script'}</TableCell>
                <TableCell>{['Console', ...(i.webhook.enabled ? ['webhook'] : []), ...i.schedules.map((s) => s.label.toLowerCase()), ...(i.events.length ? [`${i.events.length} event${i.events.length === 1 ? '' : 's'}`] : [])].join(', ')}</TableCell>
                <TableCell>
                  {i.last_run ? <><Chip size="small" color={STATUS_COLOR[i.last_run.status]} label={i.last_run.status} sx={{ mr: 1 }} />{when(i.last_run.started_at)}</> : 'never'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
