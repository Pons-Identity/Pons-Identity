import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, FormControlLabel, MenuItem, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import { useProductName } from '../../../auth/AuthContext.jsx';

const MONO = { style: { fontFamily: 'monospace' } };
const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : 'never');
const num = (v) => (v === '' ? '' : Number(v));

const STATUS_COLOR = { applied: 'success', preview: 'info', blocked: 'warning', failed: 'error' };

function Summary({ s }) {
  if (s.error) return <Typography variant="body2" color="error">{s.error}</Typography>;
  const parts = [['created', s.created], ['updated', s.updated], ['unchanged', s.unchanged], ['deactivated', (s.deactivated || 0) + (s.leavers || 0)], ['reactivated', s.reactivated], ['errors', s.errors]];
  return <Typography variant="body2">{parts.filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'No changes'}</Typography>;
}

// The outcome of a preview or a run: counts, why it was held back, and what happened to each record that changed.
function Result({ result, onForce, busy }) {
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Chip size="small" color={STATUS_COLOR[result.status]} label={result.status === 'preview' ? 'Preview: nothing was changed' : result.status} />
        <Summary s={result.summary} />
      </Stack>
      {result.blocked && (
        <Alert severity="warning" action={result.status !== 'applied' && onForce ? <Button color="inherit" size="small" disabled={busy} onClick={onForce}>Apply anyway</Button> : null}>
          Held back by a safety limit: {result.blocked}
        </Alert>
      )}
      {result.rows.length > 0 && (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Records that changed">
            <TableHead><TableRow><TableCell>Row</TableCell><TableCell>Person</TableCell><TableCell>Result</TableCell><TableCell>Details</TableCell></TableRow></TableHead>
            <TableBody>
              {result.rows.map((r) => (
                <TableRow key={r.row}>
                  <TableCell>{r.row}</TableCell>
                  <TableCell>{r.username || r.external_id || '—'}</TableCell>
                  <TableCell>{r.action}</TableCell>
                  <TableCell>{[...r.errors, ...r.warnings, r.changes.length ? `changed: ${r.changes.join(', ')}` : ''].filter(Boolean).join(' ')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {result.hidden > 0 && <Typography variant="body2" color="text.secondary">{result.hidden} more not shown.</Typography>}
    </Stack>
  );
}

export default function ProvisioningFeed({ directory }) {
  const productName = useProductName();
  const notify = useNotify();
  const base = `/admin/directories/${directory.id}/feed`;
  const [data, setData] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [errors, setErrors] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null); // how to repeat the last preview with force
  const file = useRef(null);

  const load = useCallback(async () => {
    const d = await api(base);
    setData(d);
    setCfg((c) => c || { ...d.config, pull: { ...d.config.pull, authValue: '' } });
  }, [base]);
  useEffect(() => { load().catch((e) => setErrors([e.message])); }, [load]);
  if (!cfg || !data) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setPull = (k, v) => setCfg((c) => ({ ...c, pull: { ...c.pull, [k]: v } }));

  async function save() {
    setErrors([]);
    try {
      const d = await api(base, { method: 'PUT', body: cfg });
      setData(d);
      setCfg({ ...d.config, pull: { ...d.config.pull, authValue: '' } });
      notify('Provisioning feed saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    }
  }

  async function run(source, { dry_run: dryRun, force = false } = {}) {
    setErrors([]);
    setBusy(true);
    try {
      const body = { source, dry_run: dryRun, force };
      if (source === 'upload') {
        const f = file.current?.files?.[0];
        if (!f) { setErrors(['Choose a file first.']); return; }
        body.content = await f.text();
        body.filename = f.name;
      }
      const r = await api(`${base}/run`, { method: 'POST', body });
      setResult(r);
      setLast({ source, dryRun });
      if (!dryRun) { notify(r.status === 'applied' ? 'Feed applied' : 'Feed held back'); await load(); }
    } catch (e) {
      setResult(null);
      setErrors(e.data?.errors || [e.message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card variant="outlined"><CardContent>
      <Stack spacing={3}>
        <Box>
          <Typography variant="subtitle1" component="h3">Provisioning feed</Typography>
          <Typography variant="body2" color="text.secondary">
            Keep the people in this directory in step with a system of record (an HR, ERP, payroll or other system). A feed lists the people who should
            exist; {productName} creates them, updates them, puts them in groups and, when they leave, deactivates and later deletes them. It works with
            any system that can produce CSV or JSON. Only accounts this directory owns are touched, never local accounts or roles.
          </Typography>
        </Box>
        {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

        <FormControlLabel control={<Switch checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />}
          label="Accept the feed by push and fetch it on a schedule (previews and uploads from this page always work)" />

        <Stack spacing={2}>
          <Typography variant="subtitle2">Format</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label="File format" value={cfg.format} onChange={(e) => set('format', e.target.value)} sx={{ minWidth: 160 }}>
              <MenuItem value="csv">CSV (first row is the header)</MenuItem>
              <MenuItem value="json">JSON</MenuItem>
            </TextField>
            {cfg.format === 'json' && <TextField label="Records path" value={cfg.recordsPath} onChange={(e) => set('recordsPath', e.target.value)} fullWidth
              helperText="Where the list of people is inside the JSON, for example Report_Entry or data.workers. Leave blank if the file is the list." />}
            <TextField select label="Each delivery is" value={cfg.mode} onChange={(e) => set('mode', e.target.value)} sx={{ minWidth: 260 }}
              helperText={cfg.mode === 'full' ? 'Everyone who should exist. Anyone missing has left.' : 'Only changes. Absence means nothing; leavers need an inactive status or end date.'}>
              <MenuItem value="full">A full list of everyone</MenuItem>
              <MenuItem value="delta">Only what changed</MenuItem>
            </TextField>
          </Stack>
        </Stack>

        <Stack spacing={1.5}>
          <Typography variant="subtitle2">Mapping</Typography>
          <Typography variant="body2" color="text.secondary">
            One <code>target = expression</code> per line. On the right of the equals sign, a column or JSON field name gives its value; write <code>attr("Column Name")</code> when the
            name has spaces. A target you set earlier can be used later in the file. Lines starting with # are comments.
          </Typography>
          <TextField label="Mapping" multiline minRows={10} value={cfg.rules} onChange={(e) => set('rules', e.target.value)} slotProps={{ htmlInput: MONO }} fullWidth />
          <Box><Button size="small" onClick={() => set('rules', data.reference.example)}>Insert an example</Button></Box>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Mapping targets">
              <TableHead><TableRow><TableCell>Target</TableCell><TableCell>What it does</TableCell></TableRow></TableHead>
              <TableBody>
                {data.reference.targets.filter((t) => !t.description.startsWith('Profile field ')).map((t) => (
                  <TableRow key={t.name}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}><code>{t.name}</code>{t.required && ' (required)'}</TableCell>
                    <TableCell>{t.description}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}><code>first_name</code>, <code>email</code>, …</TableCell>
                  <TableCell>
                    Any profile field: {data.reference.targets.filter((t) => t.description.startsWith('Profile field ')).map((t) => t.name).join(', ')}.
                    Only fields you map are changed; the others are left as they are.
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Box>
          <Typography variant="body2" color="text.secondary">
            Functions: {data.reference.functions.map((f) => <code key={f}>{f}() </code>)}. For example <code>lower</code>, <code>concat</code>, <code>replace</code>, and <code>extract(value, "regex")</code> which yields nothing when
            the pattern does not match, so it can make a group or status apply only to some people.
          </Typography>
        </Stack>

        <Stack spacing={2}>
          <Typography variant="subtitle2">When people leave</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label="Missing from a full list" value={cfg.leaverAction} onChange={(e) => set('leaverAction', e.target.value)} sx={{ minWidth: 240 }}>
              <MenuItem value="deactivate">Deactivate the account</MenuItem>
              <MenuItem value="none">Leave the account alone</MenuItem>
            </TextField>
            <TextField label="Delete after (days)" type="number" value={cfg.deleteAfterDays} onChange={(e) => set('deleteAfterDays', num(e.target.value))} sx={{ maxWidth: 200 }}
              helperText="Days a leaver stays deactivated before deletion. 0 never deletes. Administrators are never deleted." />
            <TextField label="Hold back above (%)" type="number" value={cfg.maxRemovalPercent} onChange={(e) => set('maxRemovalPercent', num(e.target.value))} sx={{ maxWidth: 200 }}
              helperText="If a full list would deactivate more than this share of people, or is empty, nothing is applied until you approve it here." />
            <TextField select label="If a username is taken" value={cfg.usernameCollision} onChange={(e) => set('usernameCollision', e.target.value)} sx={{ minWidth: 220 }}>
              <MenuItem value="error">Report an error for that person</MenuItem>
              <MenuItem value="suffix">Add a number (sam.rivera2)</MenuItem>
            </TextField>
          </Stack>
        </Stack>

        <Stack spacing={2}>
          <Typography variant="subtitle2">Ways to deliver the feed</Typography>
          <Typography variant="body2" color="text.secondary">
            <strong>Push:</strong> the source system sends <code>POST</code> to the address below with this directory&apos;s API token, as <code>text/csv</code> or <code>application/json</code>
            (<code>?mode=full</code> or <code>?mode=delta</code> overrides the setting above; <code>?dry_run=true</code> only reports).
          </Typography>
          <ReadOnlyField label="Push address" value={data.pushUrl} />
          <Typography variant="body2" color="text.secondary"><strong>Fetch:</strong> {productName} downloads the feed from an address you choose. Last fetch: {when(data.lastPullAt)}.</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Feed URL" value={cfg.pull.url} onChange={(e) => setPull('url', e.target.value)} fullWidth helperText="Must be a public https address." />
            <TextField label="Header name" value={cfg.pull.authHeader} onChange={(e) => setPull('authHeader', e.target.value)} sx={{ minWidth: 180 }} />
            <TextField label="Header value" type="password" autoComplete="new-password" value={cfg.pull.authValue} onChange={(e) => setPull('authValue', e.target.value)} sx={{ minWidth: 200 }}
              placeholder={cfg.pull.authValueSet ? '••••••••' : ''} helperText={cfg.pull.authValueSet ? 'Stored. Leave blank to keep it.' : 'For example Bearer <token>'} />
            <TextField label="Fetch every (minutes)" type="number" value={cfg.pull.intervalMinutes} onChange={(e) => setPull('intervalMinutes', num(e.target.value))} sx={{ minWidth: 190 }} helperText="0 for manual only; otherwise 5 or more." />
          </Stack>
        </Stack>

        <Box><Button variant="contained" onClick={save}>Save feed settings</Button></Box>

        <Stack spacing={2}>
          <Typography variant="subtitle2">Try it</Typography>
          <Typography variant="body2" color="text.secondary">Uses the saved settings above. Preview first: it shows exactly what would happen and changes nothing.</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
            <input ref={file} type="file" accept=".csv,.json,text/csv,application/json" aria-label="Feed file" />
            <Button variant="outlined" disabled={busy} onClick={() => run('upload', { dry_run: true })}>Preview file</Button>
            <Button variant="contained" disabled={busy} onClick={() => run('upload', { dry_run: false })}>Apply file</Button>
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" disabled={busy || !data.config.pull.url} onClick={() => run('pull', { dry_run: true })}>Preview fetch</Button>
            <Button variant="contained" disabled={busy || !data.config.pull.url} onClick={() => run('pull', { dry_run: false })}>Fetch and apply</Button>
          </Stack>
          {result && <Result result={result} busy={busy} onForce={last && (() => run(last.source, { dry_run: false, force: true }))} />}
        </Stack>

        <Stack spacing={1}>
          <Typography variant="subtitle2">Status</Typography>
          <Typography variant="body2">
            {data.managed} {data.managed === 1 ? 'person is' : 'people are'} managed by this feed; {data.pendingStart} waiting for a start date; {data.missing} missing from the last full list.
          </Typography>
          {data.runs.length > 0 && (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Recent runs">
                <TableHead><TableRow><TableCell>When</TableCell><TableCell>Delivered by</TableCell><TableCell>Outcome</TableCell><TableCell>Result</TableCell></TableRow></TableHead>
                <TableBody>
                  {data.runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{when(r.started_at)}</TableCell>
                      <TableCell>{r.via}{r.actor ? ` (${r.actor})` : ''}, {r.mode}</TableCell>
                      <TableCell><Chip size="small" color={STATUS_COLOR[r.status]} label={r.status} /></TableCell>
                      <TableCell><Summary s={r.summary} />{r.summary.blocked && <Typography variant="body2" color="text.secondary">{r.summary.blocked}</Typography>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </Stack>
      </Stack>
    </CardContent></Card>
  );
}
