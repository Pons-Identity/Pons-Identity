import { useEffect, useRef, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox, Chip, FormControlLabel, IconButton, List, ListItem, ListItemText, MenuItem,
  Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { api } from '../api/client.js';
import { useProductName } from '../auth/AuthContext.jsx';

const CATEGORIES = [
  { key: 'users', label: 'Users', note: 'Imported with a password nobody knows: people set one through password recovery, or you set it.' },
  { key: 'groups', label: 'Groups and their nesting' },
  { key: 'sps', label: 'SAML service providers' },
  { key: 'apps', label: 'OpenID Connect / OAuth applications' },
];

// Imports from another identity provider. `base` is the API path of the migrate routes (the wizard's or the console's), `headers`
// any extra headers they need (the wizard's token). Each source has a slot per file it needs, and each slot shows what the file is
// and where to find it. In the console the preview can be applied here; in the wizard (`onPlan`) it only chooses what to import,
// and the wizard applies it when it finishes.
export default function MigrationPanel({ base, headers, onPlan, onApplied }) {
  const productName = useProductName();
  const inputs = useRef({});
  const [sources, setSources] = useState([]);
  const [source, setSource] = useState('');
  const [files, setFiles] = useState([]);
  const [usernameFrom, setUsernameFrom] = useState('full');
  const [plan, setPlan] = useState(null);
  const [pick, setPick] = useState({ users: true, groups: true, sps: true, apps: true });
  const [enableApps, setEnableApps] = useState(false);
  const [report, setReport] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);

  const call = (path, opts = {}) => api(`${base}${path}`, { headers, ...opts });
  useEffect(() => {
    call('').then((r) => { setSources(r.sources); setFiles(r.files); }).catch((e) => setErrors([e.message]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // Whatever is chosen is what the wizard will apply.
  useEffect(() => {
    if (onPlan) onPlan(plan ? { planId: plan.planId, options: { ...pick, enableApps } } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, pick, enableApps]);

  const current = sources.find((s) => s.id === source);
  const mine = files.filter((f) => f.source === source);

  function choose(id) {
    setSource(id); setErrors([]); setPlan(null); setReport(null);
  }

  async function upload(slot, list) {
    setErrors([]); setPlan(null); setReport(null); setBusy(true);
    try {
      let latest = files;
      for (const f of list) {
        const r = await call(`/files?name=${encodeURIComponent(f.name)}&kind=${slot.kind}`, { method: 'POST', body: new Blob([await f.arrayBuffer()], { type: 'application/octet-stream' }) });
        latest = r.files;
      }
      setFiles(latest);
    } catch (e) { setErrors(e.data?.errors || [e.message]); } finally {
      setBusy(false);
      if (inputs.current[slot.kind]) inputs.current[slot.kind].value = '';
    }
  }

  async function remove(id) {
    setPlan(null);
    try { setFiles((await call(`/files/${id}`, { method: 'DELETE' })).files); } catch (e) { setErrors([e.message]); }
  }

  async function preview() {
    setErrors([]); setReport(null); setBusy(true);
    try { setPlan(await call('/preview', { method: 'POST', body: { source, options: { usernameFrom } } })); } catch (e) { setErrors(e.data?.errors || [e.message]); } finally { setBusy(false); }
  }

  async function apply() {
    setErrors([]); setBusy(true);
    try {
      const r = await call('/apply', { method: 'POST', body: { planId: plan.planId, options: { ...pick, enableApps } } });
      setReport(r); setPlan(null);
      setFiles((await call('')).files); // what was imported is no longer staged
      if (onApplied) onApplied(r);
    } catch (e) { setErrors(e.data?.errors || [e.message]); } finally { setBusy(false); }
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Move to {productName} from Shibboleth, Okta or Microsoft. Upload what you exported; you see what was found before anything is created, and nothing is changed
        until you apply it. Files stay in memory for an hour and are never saved.
      </Typography>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select size="small" label="Coming from" value={source} onChange={(e) => choose(e.target.value)} sx={{ minWidth: 260 }}
          helperText={current ? undefined : 'Choose where your users and applications are coming from. The files it needs appear below.'}>
          {sources.map((s) => <MenuItem key={s.id} value={s.id}>{s.label}</MenuItem>)}
        </TextField>
        <TextField select size="small" label="Usernames" value={usernameFrom} onChange={(e) => { setUsernameFrom(e.target.value); setPlan(null); }} sx={{ minWidth: 260 }}
          helperText="Okta logins and Microsoft principal names look like email addresses.">
          <MenuItem value="full">Use the whole login (ada@example.net)</MenuItem>
          <MenuItem value="local">Use the part before the @ (ada)</MenuItem>
        </TextField>
      </Stack>

      {current && (
        <Stack spacing={2} aria-label="Files to upload">
          <Typography variant="body2" color="text.secondary">
            Upload each file you have. Files marked Needed are the ones an import usually starts from; the rest add detail.
          </Typography>
          {current.slots.map((slot) => {
            const have = mine.filter((f) => f.kind === slot.kind);
            return (
              <Box key={slot.kind} aria-label={slot.label} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
                <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Typography variant="subtitle2" component="h3">{slot.label}</Typography>
                  <Chip size="small" variant="outlined" color={slot.needed ? 'primary' : 'default'} label={slot.needed ? 'Needed' : 'Optional'} />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{slot.help}</Typography>
                <Typography variant="body2" sx={{ mt: 1 }}><b>Where to find it:</b> {slot.where}</Typography>
                {have.length > 0 && (
                  <List dense disablePadding aria-label={`Uploaded ${slot.label}`} sx={{ mt: 1 }}>
                    {have.map((f) => (
                      <ListItem key={f.id} disableGutters secondaryAction={<IconButton edge="end" aria-label={`Remove ${f.name}`} onClick={() => remove(f.id)}><DeleteOutlineIcon /></IconButton>}>
                        <ListItemText primary={f.name} secondary={`${Math.max(1, Math.round(f.bytes / 1024))} KB`} />
                      </ListItem>
                    ))}
                  </List>
                )}
                <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" sx={{ mt: 1.5 }}>
                  <input ref={(el) => { inputs.current[slot.kind] = el; }} type="file" multiple={Boolean(slot.many)} hidden
                    onChange={(e) => upload(slot, [...e.target.files])} data-testid={`migration-file-${slot.kind}`} />
                  <Button variant="outlined" size="small" startIcon={<UploadFileIcon />} disabled={busy} onClick={() => inputs.current[slot.kind].click()}>
                    {slot.many ? 'Add files' : have.length > 0 ? 'Replace file' : 'Choose file'}
                  </Button>
                  <Button size="small" endIcon={<OpenInNewIcon />} href={`/help/${current.docs}`} target="_blank" rel="noopener noreferrer">Read the guide</Button>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}

      {current && (
        <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
          <Button variant="contained" disabled={busy || !mine.length} onClick={preview}>Preview what will be imported</Button>
          {!mine.length && <Typography variant="caption" color="text.secondary">Upload at least one file to preview.</Typography>}
        </Stack>
      )}

      {plan && (
        <Stack spacing={2} aria-label="Import preview">
          <Typography variant="h6" component="h3">Found</Typography>
          <Stack direction="row" gap={1} flexWrap="wrap">
            {plan.files.map((f) => <Chip key={f.name} size="small" label={`${f.name}: ${f.label}`} />)}
          </Stack>
          {plan.notes.length > 0 && <Alert severity="info"><Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2 }}>{plan.notes.map((n) => <li key={n}>{n}</li>)}</Stack></Alert>}
          {CATEGORIES.map((c) => (
            <Accordion key={c.key} disableGutters variant="outlined" disabled={!plan.counts[c.key]}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <FormControlLabel onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()}
                  control={<Checkbox checked={pick[c.key] && plan.counts[c.key] > 0} disabled={!plan.counts[c.key]} onChange={(e) => setPick({ ...pick, [c.key]: e.target.checked })} />}
                  label={`${c.label} (${plan.counts[c.key]})`} />
              </AccordionSummary>
              <AccordionDetails>
                {c.note && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{c.note}</Typography>}
                <PreviewTable kind={c.key} rows={plan[c.key]} />
                {plan.truncated && <Typography variant="caption" color="text.secondary">Only the first 1000 are listed; all are imported.</Typography>}
              </AccordionDetails>
            </Accordion>
          ))}
          {(plan.counts.sps > 0 || plan.counts.apps > 0) && (
            <FormControlLabel control={<Checkbox checked={enableApps} onChange={(e) => setEnableApps(e.target.checked)} />}
              label="Let everyone sign in to imported applications straight away" />
          )}
          {(plan.counts.sps > 0 || plan.counts.apps > 0) && !enableApps && (
            <Typography variant="caption" color="text.secondary">Applications are created turned off, so nothing starts signing people in until you have looked at each one and set who may use it.</Typography>
          )}
          {onPlan ? (
            <Alert severity="success">This will be imported when you finish the setup.</Alert>
          ) : (
            <Button variant="contained" color="primary" disabled={busy || !Object.entries(pick).some(([k, v]) => v && plan.counts[k])} onClick={apply} sx={{ alignSelf: 'flex-start' }}>Import</Button>
          )}
        </Stack>
      )}

      {report && <ImportReport report={report} />}
    </Stack>
  );
}

function PreviewTable({ kind, rows }) {
  const cols = {
    users: [['Username', 'username'], ['Name', 'display_name'], ['Email', 'email'], ['', (r) => (r.active ? '' : 'inactive')]],
    groups: [['Group', 'name'], ['Members', 'members'], ['Nested in', (r) => r.parents.join(', ')]],
    sps: [['Application', 'name'], ['Entity ID', 'entityId'], ['Attributes', 'attributes']],
    apps: [['Application', 'name'], ['Type', 'protocol'], ['Redirect URIs', (r) => r.redirectUris.join(', ')]],
  }[kind];
  const cell = (r, c) => (typeof c === 'function' ? c(r) : r[c]);
  return (
    <Box sx={{ maxHeight: 280, overflow: 'auto' }}>
      <Table size="small">
        <TableHead><TableRow>{cols.map(([h]) => <TableCell key={h}>{h}</TableCell>)}<TableCell /></TableRow></TableHead>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={`${r.username || r.name}-${i}`}>
              {cols.map(([h, c]) => <TableCell key={h}>{cell(r, c)}</TableCell>)}
              <TableCell>{r.exists && <Chip size="small" label="already here" />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

export function ImportReport({ report }) {
  const c = report.counts;
  const line = (label, x) => `${label}: ${x.created} created, ${x.skipped} skipped, ${x.failed} failed`;
  return (
    <Stack spacing={2} aria-label="Import result">
      <Alert severity={Object.values(c).some((x) => x && x.failed) ? 'warning' : 'success'}>
        <div>{line('Users', c.users)}</div><div>{line('Groups', c.groups)} ({c.memberships} memberships, {c.nested} nested)</div>
        <div>{line('SAML applications', c.sps)}</div><div>{line('OpenID Connect / OAuth applications', c.apps)}</div>
      </Alert>
      {report.secrets?.length > 0 && (
        <Alert severity="warning">
          <Typography variant="subtitle2">Client secrets (shown only now; copy them before leaving this page)</Typography>
          {report.secrets.map((s) => <div key={s.clientId}><b>{s.name}</b> · {s.clientId} · <code>{s.secret}</code></div>)}
        </Alert>
      )}
      {report.details?.length > 0 && (
        <Accordion disableGutters variant="outlined">
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>Details ({report.details.length})</AccordionSummary>
          <AccordionDetails sx={{ maxHeight: 320, overflow: 'auto' }}>
            <Table size="small">
              <TableBody>
                {report.details.map((d, i) => (
                  <TableRow key={`${d.kind}-${d.name}-${i}`}><TableCell>{d.kind}</TableCell><TableCell>{d.name}</TableCell><TableCell>{d.status}</TableCell><TableCell>{d.message}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </AccordionDetails>
        </Accordion>
      )}
    </Stack>
  );
}
