import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, Stack, TextField, Typography } from '@mui/material';
import { api } from '../api/client.js';
import RunOutput from './admin/integrations/RunOutput.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;

function Runner({ item }) {
  const [values, setValues] = useState({});
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function go(e) {
    e.preventDefault();
    setBusy(true); setError(''); setRun(null);
    try {
      const out = await api(`/my/integrations/${item.id}/run`, { method: 'POST', body: { input: values } });
      setRun({ trigger: 'manual', actor: '', ...out.run });
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <Card variant="outlined" component="section" aria-label={item.name}>
      <CardContent>
        <Stack component="form" spacing={2} onSubmit={go}>
          <Typography variant="h6" component="h2">{item.name}</Typography>
          {item.description && <Typography variant="body2" color="text.secondary">{item.description}</Typography>}
          {item.inputs.map((i) => (
            <TextField key={i.name} label={i.name} value={values[i.name] || ''} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} />
          ))}
          <Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: 'flex-start' }}>{busy ? 'Running…' : 'Run'}</Button>
          {error && <Alert severity="error">{error}</Alert>}
          {run && <RunOutput run={run} label={`${item.name} output`} />}
        </Stack>
      </CardContent>
    </Card>
  );
}

// The integrations an administrator has allowed this person's groups to run.
export default function RunIntegrations() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/my/integrations').then(setItems).catch((e) => setError(errorText(e))); }, []);
  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">Run an integration</Typography>
      <Typography variant="body2" color="text.secondary">
        These tasks have been opened to your groups. Each runs for real, with the access it was set up with, and is recorded in the audit log under your name.
        {items?.length ? <> <Chip size="small" label={`${items.length} available`} sx={{ ml: 1 }} /></> : null}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {items && items.length === 0 && <Typography color="text.secondary">Nothing has been opened to your groups.</Typography>}
      {(items || []).map((i) => <Runner key={i.id} item={i} />)}
    </Stack>
  );
}
