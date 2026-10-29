import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';

export const ATTRIBUTE_TYPES = [['text', 'Text'], ['number', 'Number'], ['bool', 'Yes / no'], ['date', 'Date'], ['enum', 'Choice']];
const BLANK = { name: '', label: '', type: 'text', options: '', required: false, default_value: '' };

// Administrator-defined user attributes: typed, optionally required, and offered to SAML attribute mapping as custom:<name>.
export default function AttributesTab() {
  const notify = useNotify();
  const [defs, setDefs] = useState(null);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(null);
  const [errors, setErrors] = useState([]);
  const [remove, setRemove] = useState(null);

  const load = useCallback(() => api('/admin/attribute-defs').then(setDefs).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const open = (d) => { setErrors([]); setEdit(d ? { ...d, options: d.options.join('\n'), isNew: false } : { ...BLANK, isNew: true }); };
  const set = (k, v) => setEdit((e) => ({ ...e, [k]: v }));

  async function save() {
    try {
      const body = { ...edit };
      await api(edit.isNew ? '/admin/attribute-defs' : `/admin/attribute-defs/${encodeURIComponent(edit.name)}`, { method: edit.isNew ? 'POST' : 'PUT', body });
      setEdit(null);
      notify('Attribute saved');
      load();
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    }
  }

  async function del() {
    const name = remove;
    setRemove(null);
    try {
      await api(`/admin/attribute-defs/${encodeURIComponent(name)}`, { method: 'DELETE' });
      notify('Attribute definition deleted');
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (!defs) return error ? <Alert severity="error">{error}</Alert> : null;
  return (
    <Stack spacing={2}>
      <PageIntro title="User attributes">
        Define extra attributes for users. Values are checked against the type when a user is saved, and each attribute can be
        released to applications as <code>custom:name</code>. Deleting a definition keeps the stored values as free-form attributes.
      </PageIntro>
      {error && <Alert severity="error">{error}</Alert>}
      <Button variant="contained" sx={{ alignSelf: 'flex-start' }} onClick={() => open(null)}>Add attribute</Button>
      <Table size="small">
        <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Label</TableCell><TableCell>Type</TableCell><TableCell>Required</TableCell><TableCell /></TableRow></TableHead>
        <TableBody>
          {defs.map((d) => (
            <TableRow key={d.name}>
              <TableCell>{d.name}</TableCell>
              <TableCell>{d.label}</TableCell>
              <TableCell>{ATTRIBUTE_TYPES.find(([t]) => t === d.type)?.[1]}</TableCell>
              <TableCell>{d.required ? 'Yes' : 'No'}</TableCell>
              <TableCell align="right">
                <Button size="small" onClick={() => open(d)}>Edit</Button>
                <Button size="small" color="error" onClick={() => setRemove(d.name)}>Delete</Button>
              </TableCell>
            </TableRow>
          ))}
          {!defs.length && <TableRow><TableCell colSpan={5}>No attributes defined.</TableCell></TableRow>}
        </TableBody>
      </Table>

      <Dialog open={Boolean(edit)} onClose={() => setEdit(null)} fullWidth maxWidth="sm">
        <DialogTitle>{edit?.isNew ? 'Add attribute' : `Edit ${edit?.name}`}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
            <TextField label="Name" value={edit?.name || ''} onChange={(e) => set('name', e.target.value)} disabled={!edit?.isNew}
              helperText="Used in SAML mapping and the API. Cannot be changed later." required />
            <TextField label="Label" value={edit?.label || ''} onChange={(e) => set('label', e.target.value)} />
            <TextField select label="Type" value={edit?.type || 'text'} onChange={(e) => set('type', e.target.value)}>
              {ATTRIBUTE_TYPES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
            </TextField>
            {edit?.type === 'enum' && <TextField label="Allowed values" multiline minRows={3} helperText="One per line." value={edit.options} onChange={(e) => set('options', e.target.value)} />}
            <TextField label="Default value" value={edit?.default_value || ''} onChange={(e) => set('default_value', e.target.value)} helperText="Applied to new users that are given no value." />
            <FormControlLabel control={<Switch checked={!!edit?.required} onChange={(e) => set('required', e.target.checked)} />} label="Required" />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEdit(null)}>Cancel</Button>
          <Button variant="contained" onClick={save}>Save</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog open={Boolean(remove)} title="Delete attribute definition?" message={`Values for "${remove}" are kept but are no longer validated or required.`}
        confirmLabel="Delete" onConfirm={del} onClose={() => setRemove(null)} />
    </Stack>
  );
}
