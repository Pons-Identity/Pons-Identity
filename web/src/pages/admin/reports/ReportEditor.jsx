import { useEffect, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import RunPanel from './RunPanel.jsx';
import Reference from './Reference.jsx';
import BuilderEditor from './BuilderEditor.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const BASE = '/admin/reports';
const pre = { m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

// A pre-built report: its script can be read and run, and copied into a new report of your own.
function Builtin({ meta }) {
  const { key } = useParams();
  const can = useCan();
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api(`${BASE}/builtin/${key}`).then((r) => { if (live) setReport(r); }, (err) => { if (live) setError(errorText(err)); });
    return () => { live = false; };
  }, [key]);

  if (!report) return error ? <Alert severity="error">{error}</Alert> : null;
  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Button component={RouterLink} to={BASE} size="small">← Reports</Button>
        <Typography variant="h6" component="h2">{report.name}</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary">{report.description}</Typography>
      {!report.runnable && <Alert severity="info">Running this report needs the {report.requires.map((p) => `"${p}"`).join(' and ')} permission.</Alert>}
      <RunPanel path={`${BASE}/builtin/${key}/run`} name={report.name} initialInput={report.input} disabled={!report.runnable} />
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">Script</Typography>
          <Box component="pre" sx={pre} aria-label="Script">{report.script}</Box>
          {can('reports.manage') && (
            <Button component={RouterLink} to={`${BASE}/new`} state={{ name: `${report.name} (copy)`, description: report.description, script: report.script }} sx={{ alignSelf: 'flex-start' }}>
              Copy to a new report
            </Button>
          )}
        </Stack>
      </Paper>
      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>Functions available to report scripts</AccordionSummary>
        <AccordionDetails><Reference reference={meta.reference} /></AccordionDetails>
      </Accordion>
    </Stack>
  );
}

// Create, change, run or delete a custom report. Someone who can only run reports sees the script but cannot change it.
function Custom({ meta }) {
  const { id } = useParams();
  const isNew = id === undefined;
  const navigate = useNavigate();
  const { state } = useLocation();
  const can = useCan();
  const notify = useNotify();
  const canManage = can('reports.manage');

  const [form, setForm] = useState(() => (isNew ? { name: state?.name || '', description: state?.description || '', script: state?.script || meta.starter, timeout_seconds: meta.limits.defaultSeconds } : null));
  const [saved, setSaved] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isNew) return undefined;
    let live = true;
    api(`${BASE}/${id}`).then((r) => {
      if (!live) return;
      setSaved(r);
      setForm({ name: r.name, description: r.description, script: r.script, timeout_seconds: r.timeout_seconds });
    }, (err) => { if (live) setError(errorText(err)); });
    return () => { live = false; };
  }, [id, isNew]);

  // A report made in the builder is edited there, not as a script.
  if (saved && saved.kind === 'builder') return <BuilderEditor meta={meta} report={saved} />;
  if (!form || (!isNew && !saved)) return error ? <Alert severity="error">{error}</Alert> : null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      if (isNew) {
        const created = await api(BASE, { method: 'POST', body: form });
        notify('Report created');
        navigate(`${BASE}/${created.id}`, { replace: true });
      } else {
        setSaved(await api(`${BASE}/${id}`, { method: 'PUT', body: form }));
        notify('Report saved');
      }
    } catch (err) { setError(errorText(err)); }
  }

  async function remove() {
    setDeleting(false);
    try { await api(`${BASE}/${id}`, { method: 'DELETE' }); notify('Report deleted'); navigate(BASE); } catch (err) { setError(errorText(err)); }
  }

  const dirty = !isNew && form.script !== saved.script;

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Button component={RouterLink} to={BASE} size="small">← Reports</Button>
        <Typography variant="h6" component="h2">{isNew ? 'New report' : saved.name}</Typography>
      </Stack>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      {!isNew && <RunPanel path={`${BASE}/${id}/run`} name={saved.name} initialInput={{}} />}
      {dirty && <Alert severity="info">You have unsaved changes to the script. Save first to run them.</Alert>}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack component="form" onSubmit={save} spacing={2} aria-label="Report">
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Name" required value={form.name} onChange={(e) => set('name', e.target.value)} disabled={!canManage} sx={{ flex: 1 }} />
            <TextField label="Time limit (seconds)" type="number" value={form.timeout_seconds} disabled={!canManage}
              onChange={(e) => set('timeout_seconds', Number(e.target.value))} slotProps={{ htmlInput: { min: meta.limits.minSeconds, max: meta.limits.maxSeconds } }} sx={{ width: 200 }} />
          </Stack>
          <TextField label="Description" value={form.description} onChange={(e) => set('description', e.target.value)} disabled={!canManage} />
          <TextField
            label="Script" multiline minRows={14} maxRows={40} fullWidth value={form.script} disabled={!canManage}
            onChange={(e) => set('script', e.target.value)}
            slotProps={{ htmlInput: { spellCheck: false, 'aria-label': 'Script', style: { fontFamily: 'monospace', fontSize: 13 } } }}
            helperText="JavaScript, run as the body of an async function. Return an array of objects for a table that can be downloaded as CSV."
          />
          {canManage && (
            <Stack direction="row" spacing={1}>
              <Button type="submit" variant="contained">{isNew ? 'Create report' : 'Save'}</Button>
              {!isNew && <Button color="error" onClick={() => setDeleting(true)}>Delete</Button>}
            </Stack>
          )}
        </Stack>
      </Paper>

      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>Functions available to report scripts</AccordionSummary>
        <AccordionDetails><Reference reference={meta.reference} /></AccordionDetails>
      </Accordion>

      <ConfirmDialog open={deleting} title="Delete this report?" confirmLabel="Delete report"
        message="Its script is removed. Nothing else is affected." onConfirm={remove} onClose={() => setDeleting(false)} />
    </Stack>
  );
}

export default function ReportEditor({ meta, builtin = false }) {
  return builtin ? <Builtin meta={meta} /> : <Custom meta={meta} />;
}
