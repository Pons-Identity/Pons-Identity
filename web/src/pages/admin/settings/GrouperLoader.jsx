import { useEffect, useState } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import { useProductName } from '../../../auth/AuthContext.jsx';

const COLUMNS = { subject_id: 'subject_id', subject_identifier: 'subject_identifier', subject_id_or_identifier: 'subject_id_or_identifier' };
const errorText = (err) => err.data?.errors?.join(' ') || err.message;

// A read-only feed of this IdP's groups for Grouper's loader to pull, so Grouper can follow Pons Identity until cutover.
export default function GrouperLoader({ fields }) {
  const productName = useProductName();
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [token, setToken] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');

  const load = (d) => {
    setData(d);
    setForm({ subjectField: d.subjectField, rootStem: d.rootStem, subjectColumn: d.subjectColumn, subjectSourceId: d.subjectSourceId });
  };
  useEffect(() => { api('/admin/grouper/loader').then(load).catch((e) => setError(errorText(e))); }, []);

  const edit = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const act = async (fn, done) => {
    setError('');
    try { await fn(); if (done) notify(done); } catch (err) { setError(errorText(err)); }
  };
  const save = () => act(async () => load(await api('/admin/grouper/loader', { method: 'PUT', body: form })), 'Feed settings saved');
  const makeToken = () => act(async () => {
    setConfirm(false);
    const d = await api('/admin/grouper/loader/token', { method: 'POST' });
    setToken(d.token);
    load(d);
  });
  const revoke = () => act(async () => { setToken(''); load(await api('/admin/grouper/loader/token', { method: 'DELETE' })); }, 'Feed token revoked');

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;
  const dirty = JSON.stringify(form) !== JSON.stringify({ subjectField: data.subjectField, rootStem: data.rootStem, subjectColumn: data.subjectColumn, subjectSourceId: data.subjectSourceId });

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        While {productName} is still where groups are managed, Grouper's SQL loader can follow it. The feed serves each group's effective members
        (nested groups and composites already resolved) as CSV. A small script copies it into tables the loader reads; download the starter files below.
        Loader-managed groups take their members only from the feed.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="People are identified by" value={form.subjectField} onChange={edit('subjectField')} sx={{ minWidth: 240 }}>
          {Object.entries(fields).map(([k, label]) => <MenuItem key={k} value={k}>{label}</MenuItem>)}
        </TextField>
        <TextField label="Folder for names without ':'" value={form.rootStem} onChange={edit('rootStem')} />
        <TextField select label="Subject column" value={form.subjectColumn} onChange={edit('subjectColumn')} sx={{ minWidth: 240 }}>
          {Object.keys(COLUMNS).map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
        </TextField>
        <TextField label="Subject source ID (optional)" value={form.subjectSourceId} onChange={edit('subjectSourceId')} />
      </Stack>
      <Button variant="outlined" disabled={!dirty} onClick={save} sx={{ alignSelf: 'flex-start' }}>Save settings</Button>

      <Typography variant="body2">
        {data.counts.groups} groups and {data.counts.memberships} memberships are in the feed.
        {data.counts.skipped > 0 && ` ${data.counts.skipped === 1 ? '1 person has' : `${data.counts.skipped} people have`} no ${fields[data.subjectField]?.toLowerCase()} and ${data.counts.skipped === 1 ? 'is' : 'are'} left out.`}
      </Typography>
      <ReadOnlyField label="Memberships feed" value={data.urls.memberships} />
      <ReadOnlyField label="Groups feed" value={data.urls.groups} />

      {token && (
        <Alert severity="success">
          <Stack spacing={1}>
            <span>Copy this token now. It is not shown again. The sync script reads it from SIMPLEIDP_FEED_TOKEN.</span>
            <ReadOnlyField label="Feed token" value={token} />
          </Stack>
        </Alert>
      )}
      <Typography variant="body2" color="text.secondary">
        {data.tokenSet ? `A token was created ${new Date(data.tokenCreatedAt).toLocaleString()}.` : 'No token has been created, so the feed is closed.'}
        {data.lastFetchAt && ` Last fetched ${new Date(data.lastFetchAt).toLocaleString()}.`}
      </Typography>
      <Stack direction="row" spacing={1}>
        <Button variant="outlined" onClick={() => (data.tokenSet ? setConfirm(true) : makeToken())}>{data.tokenSet ? 'Replace token' : 'Create token'}</Button>
        {data.tokenSet && <Button color="error" onClick={revoke}>Revoke token</Button>}
        <Button variant="contained" component="a" href="/api/admin/grouper/loader/bundle">Download starter files</Button>
      </Stack>
      <Alert severity="info">The starter files (staging tables, sync script, loader settings) have not been run against your Grouper. Try them on a test Grouper first.</Alert>

      <ConfirmDialog open={confirm} title="Replace the feed token?" message="Whatever fetches the feed stops working until it is given the new token."
        confirmLabel="Replace" onConfirm={makeToken} onClose={() => setConfirm(false)} />
    </Stack>
  );
}
