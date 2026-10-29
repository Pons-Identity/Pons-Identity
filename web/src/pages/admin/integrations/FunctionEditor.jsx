import { useEffect, useState } from 'react';
import { Alert, Button, Stack, TextField, Typography } from '@mui/material';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import CodeEditor from '../../../components/CodeEditor.jsx';
import { EditorTabs, TabForm, changedFields } from '../../../components/EditorTabs.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import InputsTable from './InputsTable.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const BASE = '/admin/integrations/functions';
const BLANK = { name: '', description: '', inputs: [], script: '' };

// The tabs of a function's page. A new function has only its details until it is added, since it is named by that first save.
const TABS = [
  { key: 'details', label: 'Details', fields: ['name', 'description'] },
  { key: 'inputs', label: 'Inputs', fields: ['inputs'] },
  { key: 'body', label: 'Function body', fields: ['script'] },
];

const fromFunction = (f) => ({ name: f.name, description: f.description, inputs: f.inputs, script: f.script });

// Create or change one function. Each tab saves its own fields.
export default function FunctionEditor() {
  const { name } = useParams();
  const isNew = name === undefined;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const can = useCan();
  const notify = useNotify();
  const canManage = can('integrations.manage');

  const [catalog, setCatalog] = useState([]);
  // What scripts can call, for the editor's hover tips. Without it the tips cover only JavaScript itself.
  const [reference, setReference] = useState(null);
  const [form, setForm] = useState(null);
  // The form as it was last loaded or saved. A tab has unsaved changes when its fields differ from this.
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api('/admin/integrations/functions').then((d) => {
      if (!live) return;
      setCatalog(d.inputs);
      if (isNew) {
        setForm(BLANK);
        setSaved(BLANK);
        return;
      }
      const f = d.functions.find((x) => x.name === name);
      if (!f) { setError(`There is no function named ${name}.`); return; }
      const next = fromFunction(f);
      setForm(next);
      setSaved(next);
    }).catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [name, isNew]);

  useEffect(() => {
    let live = true;
    api('/admin/integrations').then((m) => { if (live) setReference(m.reference || null); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!form || !saved) return error ? <Alert severity="error">{error}</Alert> : null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const tabs = TABS.map((t) => ({ ...t, disabled: isNew && t.key !== 'details' }));
  const current = tabs.find((t) => t.key === searchParams.get('tab') && !t.disabled) || tabs[0];
  const dirty = changedFields(form, saved, current.fields);
  const switchTab = (key) => setSearchParams(key === 'details' ? {} : { tab: key });

  // Saves the whole function. Only the tab showing can have changes, so this saves that tab.
  async function save(e) {
    e.preventDefault();
    setError('');
    const fnName = form.name;
    try {
      const d = await api(`${BASE}/${encodeURIComponent(fnName)}`, { method: 'PUT', body: { description: form.description, script: form.script, inputs: form.inputs } });
      if (isNew) {
        notify('Function added');
        setSaved(form);
        navigate(`${BASE}/${encodeURIComponent(fnName)}`, { replace: true });
        return;
      }
      const next = fromFunction(d.functions.find((x) => x.name === fnName));
      setForm(next);
      setSaved(next);
      notify('Function saved');
    } catch (err) { setError(errorText(err)); }
  }

  // Every tab's form shares this save and discard.
  const tabForm = { canManage, dirty, saveLabel: isNew ? 'Add function' : 'Save function', onSubmit: save, onDiscard: () => setForm(saved) };

  const panes = {
    details: (
      <TabForm {...tabForm}>
        <TextField label="Name" required value={form.name} disabled={!isNew || !canManage} onChange={(e) => set('name', e.target.value)}
          helperText="Starts with a letter or underscore: letters, digits and underscores. Called as fn.NAME. It cannot be changed once added." sx={{ maxWidth: 360 }} />
        <TextField label="Description" value={form.description} disabled={!canManage} onChange={(e) => set('description', e.target.value)}
          helperText="Say what it takes and returns, and which scopes it needs." />
      </TabForm>
    ),
    inputs: (
      <TabForm {...tabForm}>
        <InputsTable value={form.inputs} catalog={catalog} disabled={!canManage} onChange={(inputs) => set('inputs', inputs)}
          helperText="Each row is a key the caller passes in its object, and the variable the function body reads that value from." />
      </TabForm>
    ),
    body: (
      <TabForm {...tabForm}>
        <CodeEditor label="Function body" reference={reference} variables={form.inputs.map((i) => i.variable || i.name)} fileName={`${form.name || 'function'}.js`} value={form.script} disabled={!canManage} onChange={(script) => set('script', script)}
          helperText="The body of an async function. Its inputs are the variables in the Inputs tab. Use await, and return a value." />
      </TabForm>
    ),
  };

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Button component={RouterLink} to={BASE} size="small">← Functions</Button>
        <Typography variant="h6" component="h2">{isNew ? 'New function' : `fn.${name}`}</Typography>
      </Stack>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      {isNew && <Alert severity="info">Add the function first. Its inputs and body are set on their tabs after that.</Alert>}

      <EditorTabs tabs={tabs} value={current.key} dirty={dirty} onChange={switchTab} ariaLabel="Function sections" />
      {panes[current.key]}
    </Stack>
  );
}
