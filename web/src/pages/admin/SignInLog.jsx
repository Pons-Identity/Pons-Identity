import SuggestField from '../../components/SuggestField.jsx';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { api } from '../../api/client.js';
import AuthLogTable from '../../components/AuthLogTable.jsx';

const BLANK = { username: '', ip: '', country: '', asn: '', type: '', outcome: '', risk_level: '' };

const query = (filters, extra = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v !== '' && v !== undefined && v !== null) p.set(k, v);
  return p.toString();
};

// Search every sign-in step by person, address, country, network, kind of step, result or risk: the first stop in an incident.
export default function SignInLog() {
  const [filters, setFilters] = useState(BLANK);
  const [applied, setApplied] = useState(BLANK);
  const [events, setEvents] = useState([]);
  const [next, setNext] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async (f, before) => {
    try {
      const r = await api(`/admin/auth-log?${query(f, { limit: 100, before })}`);
      setEvents((cur) => (before ? [...cur, ...r.events] : r.events));
      setNext(r.events.length === 100 ? r.next : null);
      setError('');
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(applied); }, [applied, load]);

  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  const pick = (patch) => { const f = { ...BLANK, ...patch }; setFilters(f); setApplied(f); };

  return (
    <Stack spacing={2}>
      <Typography variant="h5" component="h1">Sign-in log</Typography>
      <Stack component="form" direction="row" flexWrap="wrap" gap={1} onSubmit={(e) => { e.preventDefault(); setApplied(filters); }}>
        {[['username', 'Person'], ['ip', 'Address'], ['country', 'Country'], ['asn', 'Network (AS number)']].map(([field, label]) => (
          <SuggestField key={field} label={label} source="/admin/auth-log/suggest" field={field} value={filters[field]} onChange={(v) => setFilters((f) => ({ ...f, [field]: v }))} />
        ))}
        <TextField select size="small" label="Step" value={filters.type} onChange={set('type')} sx={{ minWidth: 130 }}>
          <MenuItem value="">Any</MenuItem><MenuItem value="password">Password</MenuItem><MenuItem value="mfa">Second step</MenuItem><MenuItem value="signin">Sign-in</MenuItem><MenuItem value="recovery">Recovery</MenuItem>
        </TextField>
        <TextField select size="small" label="Result" value={filters.outcome} onChange={set('outcome')} sx={{ minWidth: 110 }}>
          <MenuItem value="">Any</MenuItem><MenuItem value="success">Success</MenuItem><MenuItem value="failure">Failure</MenuItem>
        </TextField>
        <TextField select size="small" label="Risk" value={filters.risk_level} onChange={set('risk_level')} sx={{ minWidth: 110 }}>
          <MenuItem value="">Any</MenuItem><MenuItem value="medium">Medium</MenuItem><MenuItem value="high">High</MenuItem>
        </TextField>
        <Button type="submit" variant="contained">Search</Button>
        <Button onClick={() => pick({})}>Clear</Button>
        <Button href={`/api/admin/auth-log?${query(applied, { format: 'csv' })}`}>Export CSV</Button>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <AuthLogTable events={events} onPick={pick} />
      {next && <Button onClick={() => load(applied, next)} sx={{ alignSelf: 'flex-start' }}>Load more</Button>}
    </Stack>
  );
}
