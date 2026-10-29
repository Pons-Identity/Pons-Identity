import { useEffect, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox, Chip, FormControlLabel, FormGroup, MenuItem, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import CodeEditor from '../../../components/CodeEditor.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import RepeaterRows from '../../../components/RepeaterRows.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import { EditorTabs, TabForm, changedFields } from '../../../components/EditorTabs.jsx';
import RunOutput from './RunOutput.jsx';
import { ReferenceBody, referenceText } from './Reference.jsx';
import CopyButton from '../../../components/CopyButton.jsx';
import DownloadTextButton from '../../../components/DownloadTextButton.jsx';
import ScheduleFields, { newSchedule, scheduleBody } from './ScheduleFields.jsx';
import InputsTable from './InputsTable.jsx';
import ValueTable, { valueBody } from './ValueTable.jsx';
import MultiCombobox from '../../../components/MultiCombobox.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const BASE = '/admin/integrations';
const ACCESS_OPTIONS = [
  { value: 'read', label: 'Read (list and read)' },
  { value: 'write', label: 'Write (create, change, remove; cannot read)' },
  { value: 'readwrite', label: 'Read and write' },
];

// The tabs of an integration's page. `fields` are the form fields a tab saves; a tab without them has its own actions. `saved` tabs need the integration to exist, and `manage` ones need permission to change it.
const TABS = [
  { key: 'details', label: 'Details', fields: ['name', 'description', 'enabled', 'timeout_seconds', 'home_dir'] },
  { key: 'permissions', label: 'Permissions', fields: ['scopes', 'file_dirs', 'run_groups', 'api_enabled'] },
  { key: 'triggers', label: 'Triggers', fields: ['schedules', 'events', 'event_inputs'] },
  { key: 'inputs', label: 'Inputs', fields: ['inputs'] },
  { key: 'script', label: 'Script', fields: ['script'] },
  { key: 'logging', label: 'Logging', fields: ['logging'] },
  { key: 'run', label: 'Run', saved: true, manage: true },
  { key: 'runs', label: 'Recent runs', saved: true },
  { key: 'webhook', label: 'Webhook & API', saved: true },
  { key: 'files', label: 'Files', saved: true },
];

const CURL = (url) => `curl -X POST ${url} \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"first_name":"Sam","last_name":"Rivera","email":"sam@example.net"}'`;

// The form for an integration as the server has it.
const formFrom = (i) => ({ name: i.name, description: i.description, enabled: i.enabled, script: i.script, inputs: i.inputs, scopes: i.scopes, timeout_seconds: i.timeout_seconds, schedules: i.schedules.map(newSchedule), events: i.events, event_inputs: i.event_inputs || [], run_groups: (i.run_groups || []).map((g) => g.id), api_enabled: Boolean(i.api_enabled), logging: i.logging || { inherit: true }, file_dirs: i.file_dirs || [], home_dir: i.home_dir || '' });

function Webhook({ integration, webhookBase, canManage, onChange }) {
  const notify = useNotify();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const url = `${webhookBase}${integration.webhook.path}`;

  async function make() {
    setError('');
    try {
      const { token: t, ...rest } = await api(`${BASE}/${integration.id}/webhook`, { method: 'POST' });
      setToken(t);
      onChange(rest);
    } catch (err) { setError(errorText(err)); }
  }
  async function turnOff() {
    setError('');
    try { onChange(await api(`${BASE}/${integration.id}/webhook`, { method: 'DELETE' })); setToken(''); notify('Webhook turned off'); } catch (err) { setError(errorText(err)); }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6" component="h2">Webhook</Typography>
        <Typography variant="body2" color="text.secondary">
          Lets other software start this integration. The JSON it sends arrives in the script as <code>input</code>, and the script&apos;s result is sent back.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {integration.webhook.enabled ? (
          <>
            <ReadOnlyField label="Webhook URL" value={url} />
            <Typography variant="body2" component="pre" sx={{ m: 0, overflowX: 'auto' }}>{CURL(url)}</Typography>
          </>
        ) : <Typography variant="body2">The webhook is off.</Typography>}
        {token && (
          <Alert severity="success" onClose={() => setToken('')}>
            <Stack spacing={1}><span>Copy this token now. It is not shown again.</span><ReadOnlyField label="Webhook token" value={token} /></Stack>
          </Alert>
        )}
        {canManage && (
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={make}>{integration.webhook.enabled ? 'Replace token' : 'Turn on webhook'}</Button>
            {integration.webhook.enabled && <Button color="error" onClick={turnOff}>Turn off</Button>}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

const DEFAULT_LOGGING = { inherit: true, saveLevel: 'warning', saveOutput: false, retentionDays: 30 };

// The directories of the files module this integration may use besides its own folder. The script's relative paths are in its folder.
function Directories({ value, folder, canManage, onChange }) {
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle1" component="h3">Directories it may use</Typography>
      <Typography variant="body2" color="text.secondary">
        The integration always has its own folder, <code>{folder}</code>, and a relative path such as <code>report.csv</code> is in it. Add a directory for each other place
        it may read or write, such as <code>/exports/hr</code>. Nothing else in the files module is reachable from its script.
      </Typography>
      {value.length === 0 && <Typography variant="body2" color="text.secondary">No other directories.</Typography>}
      <Box component="fieldset" disabled={!canManage} sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
        <RepeaterRows rows={value} onChange={onChange} addLabel="Add a directory" emptyRow={{ path: '/', access: 'readwrite' }}
          fields={[{ key: 'path', label: 'Directory' }, { key: 'access', label: 'Access', options: ACCESS_OPTIONS }]} />
      </Box>
    </Stack>
  );
}

// Who may run it besides people who manage integrations, and whether the API may.
function RunAccess({ form, set, groups, canManage }) {
  return (
    <Stack spacing={2}>
      <Typography variant="h6" component="h2">Who can run it</Typography>
      <Typography variant="body2" color="text.secondary">
        People who manage integrations can always run any of them. Choose groups to let their members run this one (and only this one) without being able to change it:
        they see it under <strong>Run an integration</strong> and it runs with the access given above, not theirs.
      </Typography>
      <MultiCombobox label="Groups that may run it" placeholder="Search groups" disabled={!canManage}
        options={groups.map((g) => ({ id: g.id, label: g.name }))} value={form.run_groups} onChange={(ids) => set('run_groups', ids)}
        helperText="Members of nested groups count. Leave empty to keep it to people who manage integrations." />
      <FormControlLabel control={<Switch checked={form.api_enabled} onChange={(e) => set('api_enabled', e.target.checked)} disabled={!canManage} />}
        label="Allow API requests to run this (a User API token with the integrations:run scope)" />
    </Stack>
  );
}

// How the log lines of this integration's runs are kept.
function RunLogging({ form, set, meta, canManage }) {
  const logging = form.logging || DEFAULT_LOGGING;
  const setLogging = (patch) => set('logging', { ...logging, ...patch });
  return (
    <Stack spacing={2}>
      <FormControlLabel control={<Switch checked={logging.inherit} disabled={!canManage} onChange={(e) => setLogging({ inherit: e.target.checked })} />}
        label="Use the logging settings for all integrations (Integrations → Logging)" />
      {!logging.inherit && (
        <Stack spacing={2} sx={{ pl: 2 }}>
          <TextField select label="Save log lines at or above" value={logging.saveLevel} disabled={!canManage} onChange={(e) => setLogging({ saveLevel: e.target.value })} sx={{ maxWidth: 320 }}>
            <MenuItem value="off">Don&apos;t save log lines</MenuItem>
            {meta.logLevels.map((l) => <MenuItem key={l.id} value={l.id}>{l.label}</MenuItem>)}
          </TextField>
          <FormControlLabel control={<Switch checked={logging.saveOutput} disabled={!canManage} onChange={(e) => setLogging({ saveOutput: e.target.checked })} />} label="Also save output() lines" />
          <TextField label="Keep saved log files for (days, 0 = no limit)" type="number" value={logging.retentionDays} disabled={!canManage} sx={{ maxWidth: 320 }}
            onChange={(e) => setLogging({ retentionDays: Number(e.target.value) })} slotProps={{ htmlInput: { min: 0, max: 3650 } }} />
          <Typography variant="body2" color="text.secondary">This integration&apos;s saved log files (in the files module, under <code>/logs</code>) age out by these settings, whatever the global ones say.</Typography>
        </Stack>
      )}
    </Stack>
  );
}

// Create or change one integration, try it, and see what it did. Each tab saves its own fields.
export default function IntegrationEditor() {
  const { id } = useParams();
  const isNew = id === undefined;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const can = useCan();
  const notify = useNotify();
  const canManage = can('integrations.manage');

  const [meta, setMeta] = useState(null);
  const [groups, setGroups] = useState([]);
  const [form, setForm] = useState(null);
  // The form as it was last loaded or saved. A tab has unsaved changes when its fields differ from this.
  const [saved, setSaved] = useState(null);
  const [integration, setIntegration] = useState(null);
  const [runs, setRuns] = useState([]);
  const [runValues, setRunValues] = useState([]);
  // The lowest level whose log lines this run saves: '' keeps the integration's own setting, 'off' saves none.
  const [runLevel, setRunLevel] = useState('');
  const [latest, setLatest] = useState(null);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const m = await api(BASE);
        if (!live) return;
        setMeta({ ...m, logLevels: ['debug', 'normal', 'warning', 'error'].map((l) => ({ id: l, label: l[0].toUpperCase() + l.slice(1) })) });
        api('/admin/options').then((o) => { if (live) setGroups(o.groups || []); }).catch(() => {});
        if (isNew) {
          const fresh = { name: '', description: '', enabled: true, script: m.starter, inputs: m.starter_inputs, scopes: ['users:read', 'users:write'], timeout_seconds: 10, schedules: [], events: [], event_inputs: [], run_groups: [], api_enabled: false, logging: { inherit: true }, file_dirs: [], home_dir: '' };
          setForm(fresh);
          setSaved(fresh);
        } else {
          const i = await api(`${BASE}/${id}`);
          if (!live) return;
          const { runs: r, ...rest } = i;
          setIntegration(rest);
          setRuns(r);
          // The Run table starts with a row for each input the saved integration declares, with no value yet.
          setRunValues(i.inputs.map((x) => ({ name: x.name, type: 'text', value: '', from: '' })));
          const next = formFrom(i);
          setForm(next);
          setSaved(next);
        }
      } catch (err) { if (live) setError(errorText(err)); }
    })();
    return () => { live = false; };
  }, [id, isNew]);

  // After creating, the route changes to the new id a moment before its data has loaded.
  if (!form || !saved || !meta || (!isNew && !integration)) return error ? <Alert severity="error">{error}</Alert> : null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setSchedule = (key, next) => setForm((f) => ({ ...f, schedules: f.schedules.map((s) => (s.key === key ? next : s)) }));
  const addSchedule = () => setForm((f) => ({ ...f, schedules: [...f.schedules, newSchedule()] }));
  const removeSchedule = (key) => setForm((f) => ({ ...f, schedules: f.schedules.filter((s) => s.key !== key) }));
  const toggleEvent = (e) => set('events', form.events.includes(e) ? form.events.filter((x) => x !== e) : [...form.events, e]);
  const toggle = (s) => set('scopes', form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s]);
  // The names offered for input values: the ones the integration declares, then the ones the reference lists.
  const inputNames = [...new Set([...form.inputs.map((i) => i.name), ...meta.reference.inputs.map((i) => i.name)])];
  // The fields an event trigger's inputs can take from the chosen events.
  const eventFields = [...new Set(meta.events.filter((e) => form.events.includes(e.name)).flatMap((e) => e.fields || []))];

  // What the server said about a saved schedule: its description and when it next runs.
  const scheduleNote = (s) => {
    const savedSchedule = (integration?.schedules || []).find((x) => x.id === s.id);
    if (!savedSchedule) return '';
    return `${savedSchedule.label}. ${savedSchedule.next_run_at ? `Next run: ${new Date(savedSchedule.next_run_at).toLocaleString()}.` : 'It has ended and will not run again.'}`;
  };

  // The tabs this page shows: a new integration has only its details until it exists, and the saved-only tabs wait for that too.
  const tabs = TABS.filter((t) => (!t.saved || !isNew) && (!t.manage || canManage))
    .map((t) => ({ ...t, disabled: isNew && t.key !== 'details' }));
  const current = tabs.find((t) => t.key === searchParams.get('tab') && !t.disabled) || tabs[0];
  const dirty = changedFields(form, saved, current.fields);
  const switchTab = (key) => setSearchParams(key === 'details' ? {} : { tab: key });

  async function save(e) {
    e.preventDefault();
    setError('');
    const body = { ...form, schedules: form.schedules.map(scheduleBody), event_inputs: valueBody(form.event_inputs) };
    try {
      if (isNew) {
        const created = await api(BASE, { method: 'POST', body });
        notify('Integration created');
        navigate(`${BASE}/${created.id}`, { replace: true });
      } else {
        const { runs: r, ...rest } = await api(`${BASE}/${id}`, { method: 'PUT', body });
        setIntegration(rest);
        setRuns(r);
        const next = formFrom(rest);
        setForm(next);
        setSaved(next);
        notify('Integration saved');
      }
    } catch (err) { setError(errorText(err)); }
  }

  const discard = () => setForm(saved);

  // A run's page: the run's output, log and result, opened in a new tab as the run starts.
  const runPage = (runId) => `${BASE}/${id}/runs/${runId}`;

  async function run() {
    setError('');
    setRunning(true);
    // The tab is opened now, while the click is still allowed to open one, and pointed at the run once the server has started it.
    const page = window.open('about:blank', '_blank');
    try {
      const { run: r } = await api(`${BASE}/${id}/run`, { method: 'POST', body: { values: valueBody(runValues), ...(runLevel ? { save_level: runLevel } : {}) } });
      setLatest(r);
      setRuns((cur) => [r, ...cur]);
      if (page) page.location.href = `${window.location.origin}${runPage(r.id)}`;
      else window.open(runPage(r.id), '_blank');
    } catch (err) {
      page?.close();
      setError(errorText(err));
    } finally { setRunning(false); }
  }

  // Puts the built-in's original code back. The server keeps this integration's schedules, events, run groups and whether it is on.
  async function restore() {
    setRestoring(false);
    try {
      const i = await api(`${BASE}/${id}/restore`, { method: 'POST' });
      const { runs: _runs, ...rest } = i;
      setIntegration(rest);
      const next = formFrom(i);
      setForm(next);
      setSaved(next);
      notify('Original code restored');
    } catch (err) { setError(errorText(err)); }
  }

  async function remove() {
    setDeleting(false);
    try { await api(`${BASE}/${id}`, { method: 'DELETE' }); notify('Integration deleted'); navigate(BASE); } catch (err) { setError(errorText(err)); }
  }

  // Every tab's form shares these: the same save, which saves the whole form, and the same discard.
  const tabForm = { canManage, dirty, saveLabel: isNew ? 'Create integration' : 'Save', onSubmit: save, onDiscard: discard };

  const panes = {
    details: () => (
      <Stack spacing={2}>
        {isNew && <Alert severity="info">Create the integration first. Its permissions, triggers, inputs, script and logging are set on their tabs after that.</Alert>}
        <TabForm {...tabForm}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Name" required value={form.name} onChange={(e) => set('name', e.target.value)} disabled={!canManage} sx={{ flex: 1 }} />
            <TextField label="Time limit (seconds)" type="number" value={form.timeout_seconds} disabled={!canManage}
              onChange={(e) => set('timeout_seconds', Number(e.target.value))} slotProps={{ htmlInput: { min: 1, max: 60 } }} sx={{ width: 200 }} />
          </Stack>
          <TextField label="Description" value={form.description} onChange={(e) => set('description', e.target.value)} disabled={!canManage} />
          <TextField label="Home folder" value={form.home_dir} onChange={(e) => set('home_dir', e.target.value)} disabled={!canManage}
            placeholder={integration?.files_folder || 'Its own folder'}
            helperText="The folder in the files module that relative paths in the script are in, such as users.csv. Leave empty to use the integration's own folder." />
          <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} disabled={!canManage} />} label="Turned on (a turned-off integration ignores its webhook, schedule and events)" />
        </TabForm>
        {!isNew && canManage && (
          <Stack direction="row" spacing={1} alignItems="center">
            {integration.builtin && <Button onClick={() => setRestoring(true)}>Restore original</Button>}
            {integration.deletable !== false && <Button color="error" onClick={() => setDeleting(true)}>Delete</Button>}
            {integration.deletable === false && <Typography variant="body2" color="text.secondary">This built-in integration cannot be deleted. Turn it off instead.</Typography>}
          </Stack>
        )}
      </Stack>
    ),
    permissions: () => (
      <TabForm {...tabForm}>
        <Typography variant="subtitle1" component="h3">What the script may use</Typography>
        <FormGroup>
          {Object.entries(meta.scopes).map(([s, label]) => (
            <FormControlLabel key={s} control={<Checkbox checked={form.scopes.includes(s)} onChange={() => toggle(s)} disabled={!canManage} />} label={<span><code>{s}</code> — {label}</span>} />
          ))}
        </FormGroup>
        <Directories value={form.file_dirs} folder={integration.files_folder} canManage={canManage} onChange={(rows) => set('file_dirs', rows)} />
        <RunAccess form={form} set={set} groups={groups} canManage={canManage} />
      </TabForm>
    ),
    triggers: () => (
      <TabForm {...tabForm}>
        <Typography variant="body2" color="text.secondary">Ways this integration starts without anyone pressing Run. The webhook is on the Webhook &amp; API tab.</Typography>
        <Typography variant="subtitle1" component="h3">Schedules</Typography>
        {form.schedules.length === 0 && <Typography variant="body2" color="text.secondary">Not on a schedule.</Typography>}
        {form.schedules.map((s) => (
          <ScheduleFields key={s.key} value={s} limits={meta.scheduleLimits} names={inputNames} disabled={!canManage} note={scheduleNote(s)}
            onChange={(next) => setSchedule(s.key, next)} onRemove={() => removeSchedule(s.key)} />
        ))}
        {canManage && form.schedules.length < meta.scheduleLimits.maxPerIntegration && (
          <Button variant="outlined" onClick={addSchedule} sx={{ alignSelf: 'flex-start' }}>Add a schedule</Button>
        )}
        <Typography variant="subtitle1" component="h3">Events</Typography>
        <Typography variant="body2" color="text.secondary">Run when one of these happens (the script receives an Event as <code>input</code>):</Typography>
        <FormGroup>
          {meta.events.map((ev) => (
            <FormControlLabel key={ev.name} control={<Checkbox checked={form.events.includes(ev.name)} onChange={() => toggleEvent(ev.name)} disabled={!canManage} />}
              label={<span><code>{ev.name}</code> — {ev.label}</span>} />
          ))}
        </FormGroup>
        {(form.events.length > 0 || form.event_inputs.length > 0) && (
          <ValueTable value={form.event_inputs} names={inputNames} fields={eventFields} disabled={!canManage} addLabel="Add an input"
            onChange={(rows) => set('event_inputs', rows)}
            helperText="Each event's input is given a value, or takes a field of the event (such as user.email) for each run. A blank value is not set." />
        )}
      </TabForm>
    ),
    inputs: () => (
      <TabForm {...tabForm}>
        <InputsTable value={form.inputs} catalog={meta.reference.inputs} disabled={!canManage} onChange={(inputs) => set('inputs', inputs)}
          helperText="Each row is a key of the input, and the variable the script reads that value from. The whole input is also available as input." />
      </TabForm>
    ),
    script: () => (
      <Stack spacing={2}>
        <TabForm {...tabForm}>
          <CodeEditor label="Script" reference={meta.reference} variables={form.inputs.map((i) => i.variable || i.name)} fileName={`${form.name || 'integration'}.js`} value={form.script} disabled={!canManage} onChange={(script) => set('script', script)}
            helperText="JavaScript, run as the body of an async function. See the reference below." />
        </TabForm>
        <Accordion variant="outlined" disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>Variables and functions available to scripts</AccordionSummary>
          <AccordionDetails>
            <Stack spacing={2}>
              <Box>
                <CopyButton value={referenceText(meta.reference, meta.scopes)} label="Copy as text" />
                <DownloadTextButton value={referenceText(meta.reference, meta.scopes)} filename="integration-script-reference.txt" />
              </Box>
              <ReferenceBody reference={meta.reference} scopes={meta.scopes} />
            </Stack>
          </AccordionDetails>
        </Accordion>
      </Stack>
    ),
    logging: () => (
      <TabForm {...tabForm}>
        <RunLogging form={form} set={set} meta={meta} canManage={canManage} />
      </TabForm>
    ),
    run: () => (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Run</Typography>
          <Typography variant="body2" color="text.secondary">
            Runs the saved script for real: anything it creates or changes is created or changed. The run opens in a new page, with its output and log as they are written.
          </Typography>
          <ValueTable value={runValues} onChange={setRunValues} names={inputNames} locked={integration.inputs.map((i) => i.name)}
            addLabel="Add a custom input" helperText="Each input the integration declares has a row. Add a custom input for any other name the script reads from input. A blank value is not set." />
          <TextField select label="Save log lines at or above" value={runLevel} onChange={(e) => setRunLevel(e.target.value)} sx={{ maxWidth: 320 }}
            helperText="For this run only. As saved uses the integration's Logging setting; Off saves no log lines for this run.">
            <MenuItem value="">As saved</MenuItem>
            <MenuItem value="off">Off</MenuItem>
            {meta.logLevels.map((l) => <MenuItem key={l.id} value={l.id}>{l.label}</MenuItem>)}
          </TextField>
          <Button variant="contained" onClick={run} disabled={running} sx={{ alignSelf: 'flex-start' }}>{running ? 'Starting…' : 'Run now'}</Button>
          {latest && (
            <Alert severity="info" action={<Button color="inherit" size="small" component="a" href={runPage(latest.id)} target="_blank" rel="noopener">Open run #{latest.id}</Button>}>
              Run #{latest.id} was started and opened in a new page.
            </Alert>
          )}
        </Stack>
      </Paper>
    ),
    runs: () => (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">Recent runs</Typography>
          {runs.length === 0 && <Typography color="text.secondary">It has not run yet.</Typography>}
          {runs.map((r) => (
            <Accordion key={r.id} variant="outlined" disableGutters>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="body2">#{r.id} · {r.status} · {new Date(r.started_at).toLocaleString()} · {r.trigger}</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={1}>
                  {r.input !== null && <Typography variant="body2" component="pre" sx={{ m: 0, overflowX: 'auto' }}>Input: {JSON.stringify(r.input)}</Typography>}
                  <Box><Button size="small" component={RouterLink} to={runPage(r.id)}>Open run page</Button></Box>
                  <RunOutput run={r} />
                </Stack>
              </AccordionDetails>
            </Accordion>
          ))}
        </Stack>
      </Paper>
    ),
    webhook: () => (
      <Stack spacing={2}>
        {integration.api_enabled && (
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1}>
              <Typography variant="h6" component="h2">REST API</Typography>
              <Typography variant="body2" color="text.secondary">
                Software with a User API token that has the <code>integrations:run</code> scope (Settings → User API) can run this. The JSON in <code>input</code> arrives in the script as <code>input</code>, and the run, with its result and output, is the response.
              </Typography>
              <ReadOnlyField label="Run URL" value={`${meta.webhookBase}${integration.api_path}`} />
              <Typography variant="body2" component="pre" sx={{ m: 0, overflowX: 'auto' }}>{`curl -X POST ${meta.webhookBase}${integration.api_path} \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"input":{}}'`}</Typography>
            </Stack>
          </Paper>
        )}
        <Webhook integration={integration} webhookBase={meta.webhookBase} canManage={canManage} onChange={(i) => setIntegration((cur) => ({ ...cur, ...i }))} />
      </Stack>
    ),
    files: () => (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">Files</Typography>
          <Typography variant="body2" color="text.secondary">
            The script reads and writes files with <code>files.read</code>, <code>files.write</code> and <code>files.list</code> (needs the <code>files</code> scope).
            A relative path is in this integration&apos;s folder, <code>{integration.files_folder}</code>; the directories on the Permissions tab are the others it may use.
            Browse, upload and download them in the Files tab, where the SFTP access for other software is also set.
          </Typography>
          <Box>
            <Button component={RouterLink} to={`${BASE}/files?path=${encodeURIComponent(integration.files_folder)}`}>Open this integration&apos;s folder</Button>
          </Box>
        </Stack>
      </Paper>
    ),
  };

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Button component={RouterLink} to={BASE} size="small">← Integrations</Button>
        <Typography variant="h6" component="h2">{isNew ? 'New integration' : integration.name}</Typography>
        {!isNew && integration.builtin && <Chip size="small" label="Built in" />}
      </Stack>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

      <EditorTabs tabs={tabs} value={current.key} dirty={dirty} onChange={switchTab} ariaLabel="Integration sections" />
      {panes[current.key]()}

      <ConfirmDialog open={restoring} title="Restore the original code?" confirmLabel="Restore original" color="warning"
        message="The name, description, script, scopes, inputs and time limit go back to the built-in version. Changes you made to them are lost. Its schedules, events and run groups are kept, and it stays on or off as it is now."
        onConfirm={restore} onClose={() => setRestoring(false)} />
      <ConfirmDialog open={deleting} title="Delete this integration?" confirmLabel="Delete integration"
        message="Its script, webhook and run history are removed, and anything calling its webhook stops working." onConfirm={remove} onClose={() => setDeleting(false)} />
    </Stack>
  );
}
