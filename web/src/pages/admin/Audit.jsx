import SuggestField from '../../components/SuggestField.jsx';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useCan } from '../../auth/permissions.js';
import { useNotify } from '../../components/Notify.jsx';

const EMPTY = { category: '', outcome: '', action: '', actor: '', q: '', from: '', to: '' };
const toEpoch = (v) => (v ? String(Math.floor(new Date(v).getTime() / 1000)) : '');

function queryString(filters, extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filters, from: toEpoch(filters.from), to: toEpoch(filters.to), ...extra })) {
    if (v) p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

const when = (ts) => new Date(ts * 1000).toLocaleString();
const who = (e) => e.actor_name || (e.actor_type === 'system' ? 'system' : e.actor_type);
const what = (e) => [e.target_type, e.target_name || e.target_id].filter(Boolean).join(': ');

function ForwardingStatus() {
  const notify = useNotify();
  const can = useCan();
  const [sinks, setSinks] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/admin/audit/forwarding').then((r) => setSinks(r.sinks)).catch(() => setSinks([]));
  }, []);

  async function sendTest() {
    setBusy(true);
    try {
      const r = await api('/admin/audit/forwarding/test', { method: 'POST' });
      setSinks(r.sinks);
      const failing = r.sinks.find((s) => s.lastError);
      if (failing) notify(`Test event not delivered to ${failing.sink}: ${failing.lastError.message}`);
      else notify('Test event sent.');
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (sinks === null) return null;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography variant="subtitle1" component="h2">Log forwarding</Typography>
        {sinks.length > 0 && <Button size="small" onClick={sendTest} disabled={busy}>Send test event</Button>}
      </Stack>
      {sinks.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Not configured. {can('audit.manage')
            ? <>Set up a syslog server or SIEM under <RouterLink to="/admin/settings/log-forwarding">Settings › Log forwarding</RouterLink> to send events to it.</>
            : 'An administrator can send events to a syslog server or SIEM under Settings › Log forwarding.'}
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ mt: 1 }}>
          {sinks.map((s) => (
            <Stack key={s.sink} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip size="small" label={s.sink} />
              <Typography variant="body2">{s.target}</Typography>
              <Chip size="small" color={s.lastError ? 'error' : 'success'} label={s.lastError ? 'Failing' : 'Healthy'} />
              <Typography variant="body2" color="text.secondary">
                {s.pending} waiting{s.lastSuccess ? `, last delivered ${when(Date.parse(s.lastSuccess) / 1000)}` : ''}
              </Typography>
              {s.lastError && <Typography variant="body2" color="error">{s.lastError.message}</Typography>}
            </Stack>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

export default function Audit() {
  // A search from the Search button arrives as ?q=; start from it.
  const [params] = useSearchParams();
  const [filters, setFilters] = useState(() => ({ ...EMPTY, q: params.get('q') || '' }));
  const [applied, setApplied] = useState(() => ({ ...EMPTY, q: params.get('q') || '' }));
  const [events, setEvents] = useState(null);
  const [next, setNext] = useState(null);
  const [retention, setRetention] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const load = useCallback(async (f, before) => {
    setError('');
    try {
      const r = await api(`/admin/audit${queryString(f, before ? { before: String(before) } : {})}`);
      setEvents((prev) => (before ? [...(prev || []), ...r.events] : r.events));
      setNext(r.next);
      setRetention(r.retentionDays);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(applied); }, [applied, load]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const apply = (e) => { e.preventDefault(); setApplied(filters); };
  const reset = () => { setFilters(EMPTY); setApplied(EMPTY); };

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <div>
          <Typography variant="h5" component="h1">Audit log</Typography>
          {retention !== null && (
            <Typography variant="body2" color="text.secondary">
              {retention ? `Events are kept for ${retention} days.` : 'Events are kept indefinitely.'}
            </Typography>
          )}
        </div>
        <Button variant="outlined" startIcon={<DownloadIcon />} component="a" href={`/api/admin/audit.csv${queryString(applied)}`}>
          Export CSV
        </Button>
      </Stack>

      <ForwardingStatus />

      <Paper variant="outlined" sx={{ p: 2 }} component="form" onSubmit={apply}>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
          <TextField select size="small" label="Category" value={filters.category} onChange={set('category')} sx={{ minWidth: 130 }}>
            <MenuItem value="">All</MenuItem>
            <MenuItem value="system">System</MenuItem>
            <MenuItem value="admin">Administrator</MenuItem>
            <MenuItem value="user">User</MenuItem>
          </TextField>
          <TextField select size="small" label="Outcome" value={filters.outcome} onChange={set('outcome')} sx={{ minWidth: 120 }}>
            <MenuItem value="">All</MenuItem>
            <MenuItem value="success">Success</MenuItem>
            <MenuItem value="failure">Failure</MenuItem>
          </TextField>
          <SuggestField label="Action" source="/admin/audit/suggest" field="action" value={filters.action} onChange={(v) => setFilters((f) => ({ ...f, action: v }))} />
          <SuggestField label="Actor" source="/admin/audit/suggest" field="actor" value={filters.actor} onChange={(v) => setFilters((f) => ({ ...f, actor: v }))} />
          <TextField size="small" label="Search" value={filters.q} onChange={set('q')} />
          <TextField size="small" type="datetime-local" label="From" value={filters.from} onChange={set('from')} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField size="small" type="datetime-local" label="To" value={filters.to} onChange={set('to')} slotProps={{ inputLabel: { shrink: true } }} />
          <Button type="submit" variant="contained">Search</Button>
          <Button onClick={reset}>Clear</Button>
        </Stack>
      </Paper>

      {error && <Alert severity="error">{error}</Alert>}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>
              <TableCell>Category</TableCell>
              <TableCell>Event</TableCell>
              <TableCell>Actor</TableCell>
              <TableCell>Target</TableCell>
              <TableCell>IP</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(events || []).map((e) => (
              <TableRow key={e.id} hover onClick={() => setOpen(e)} sx={{ cursor: 'pointer' }}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{when(e.ts)}</TableCell>
                <TableCell>{e.category}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <span>{e.action}</span>
                    {e.outcome === 'failure' && <Chip size="small" color="warning" label="Failed" />}
                  </Stack>
                </TableCell>
                <TableCell>{who(e)}</TableCell>
                <TableCell>{what(e)}</TableCell>
                <TableCell>{e.ip}</TableCell>
              </TableRow>
            ))}
            {events && events.length === 0 && (
              <TableRow><TableCell colSpan={6}><Typography color="text.secondary">No matching events.</Typography></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {next && <Button onClick={() => load(applied, next)} sx={{ alignSelf: 'center' }}>Load more</Button>}

      <Dialog open={Boolean(open)} onClose={() => setOpen(null)} maxWidth="md" fullWidth>
        {open && (
          <>
            <DialogTitle>{open.action}</DialogTitle>
            <DialogContent>
              <Stack spacing={0.5} sx={{ mb: 2 }}>
                {[
                  ['Event ID', open.id], ['Time', new Date(open.ts * 1000).toISOString()], ['Category', open.category], ['Outcome', open.outcome],
                  ['Actor', `${who(open)} (${open.actor_type})`], ['Target', what(open)], ['IP address', open.ip], ['User agent', open.user_agent],
                  ['Request ID', open.request_id], ['Session', open.session_id],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <Typography key={k} variant="body2"><strong>{k}:</strong> {v}</Typography>
                ))}
              </Stack>
              <Typography variant="subtitle2">Details</Typography>
              <pre style={{ margin: 0, overflow: 'auto' }}>{JSON.stringify(open.detail, null, 2)}</pre>
            </DialogContent>
            <DialogActions><Button onClick={() => setOpen(null)}>Close</Button></DialogActions>
          </>
        )}
      </Dialog>
    </Stack>
  );
}
