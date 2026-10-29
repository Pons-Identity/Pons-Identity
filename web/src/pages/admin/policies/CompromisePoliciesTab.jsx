import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Autocomplete, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, FormGroup, MenuItem,
  Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import PageIntro from '../settings/PageIntro.jsx';
import AddIcon from '@mui/icons-material/Add';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';

const BLANK = {
  id: null, name: '', description: '', subject_type: 'everyone', subject_id: '', group_ids: [],
  end_sessions: true, reset_password: true, rotate_mfa: true, forget_remembered: true, lock_account: true, notify_user: true,
  add_to_group: false, add_to_group_id: '',
  restrict_networks: [],
};

function Steps({ policy, steps }) {
  const on = steps.filter((s) => policy[s.key]);
  if (!on.length && !policy.restrict_networks?.length) return <Typography variant="body2" color="text.secondary">Nothing</Typography>;
  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
      {on.map((s) => <Chip key={s.key} size="small" label={s.key === 'add_to_group' && policy.add_to_group_name ? `${s.label}: ${policy.add_to_group_name}` : s.label} />)}
      {policy.restrict_networks?.length > 0 && <Chip size="small" variant="outlined" label={`Networks: ${policy.restrict_networks.length}`} />}
    </Stack>
  );
}

function CompromisePolicyDialog({ initial, options, readOnly, onClose, onSaved }) {
  const notify = useNotify();
  const [form, setForm] = useState({ ...BLANK, ...initial, group_ids: initial.group_ids ?? (initial.subject_type === 'group' && initial.subject_id ? [initial.subject_id] : []), add_to_group_id: initial.add_to_group_id ? String(initial.add_to_group_id) : '', restrict_networks: (initial.restrict_networks || []).join('\n') });
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isNew = initial.id === null;
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e) {
    e.preventDefault();
    if (form.add_to_group && !form.add_to_group_id) {
      setErrors(['Choose the group to add people to, or turn off "Add to a group".']);
      return;
    }
    setSaving(true);
    setErrors([]);
    try {
      if (isNew) await api('/admin/compromise-policies', { method: 'POST', body: form });
      else await api(`/admin/compromise-policies/${initial.id}`, { method: 'PUT', body: form });
      notify('Compromised account policy saved');
      onSaved();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/admin/compromise-policies/${initial.id}`, { method: 'DELETE' });
      notify('Compromised account policy deleted');
      onSaved();
    } catch (err) {
      setConfirmDelete(false);
      setErrors(err.data?.errors || [err.message]);
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" component="form" onSubmit={save}>
      <DialogTitle>{isNew ? 'New compromised account policy' : `Edit ${initial.name}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {errors.map((e) => <Alert key={e} severity="error">{e}</Alert>)}
          <TextField label="Name" value={form.name} onChange={(e) => set('name', e.target.value)} required disabled={readOnly} />
          <TextField label="Description" value={form.description} onChange={(e) => set('description', e.target.value)} disabled={readOnly} />
          <TextField select label="Applies to" value={form.subject_type} disabled={readOnly || !isNew}
            onChange={(e) => setForm((f) => ({ ...f, subject_type: e.target.value, subject_id: '', group_ids: [] }))}
            helperText={form.subject_type === 'everyone' ? 'The default for every account. Its steps are used unless a role or group policy adds to them.' : 'Adds these steps for the people in it. Each step any policy sets is run.'}>
            <MenuItem value="everyone">Everyone (the default)</MenuItem>
            <MenuItem value="role">A role</MenuItem>
            <MenuItem value="group">Groups</MenuItem>
          </TextField>
          {form.subject_type === 'role' && (
            <TextField select label="Role" value={form.subject_id} disabled={readOnly || !isNew} onChange={(e) => set('subject_id', e.target.value)} required>
              {options.roles.map((s) => <MenuItem key={s.id} value={String(s.id)}>{s.name}</MenuItem>)}
            </TextField>
          )}
          {form.subject_type === 'group' && (
            <Autocomplete multiple disabled={readOnly} options={options.groups} value={options.groups.filter((g) => form.group_ids.includes(g.id))}
              getOptionLabel={(g) => g.name} isOptionEqualToValue={(a, b) => a.id === b.id}
              onChange={(_, v) => set('group_ids', v.map((g) => g.id))}
              renderInput={(params) => <TextField {...params} label="Groups" required={!form.group_ids.length} />} />
          )}
          <Typography variant="subtitle2">When an account is locked down</Typography>
          <FormGroup>
            {options.steps.map((s) => (
              <FormControlLabel key={s.key} disabled={readOnly}
                control={<Checkbox checked={Boolean(form[s.key])} onChange={(e) => set(s.key, e.target.checked)} />}
                label={<span><strong>{s.label}.</strong> <Typography component="span" variant="body2" color="text.secondary">{s.detail}</Typography></span>} />
            ))}
          </FormGroup>
          {form.add_to_group && (
            <TextField select label="Group to add people to" value={form.add_to_group_id} disabled={readOnly} required
              onChange={(e) => set('add_to_group_id', e.target.value)}
              error={!form.add_to_group_id} helperText="Required while Add to a group is on. Only groups managed in the console are listed.">
              {options.groups.filter((g) => g.source === 'local').map((g) => <MenuItem key={g.id} value={String(g.id)}>{g.name}</MenuItem>)}
            </TextField>
          )}
          <TextField label="Allow sign-in only from these addresses or networks" multiline minRows={2} value={form.restrict_networks}
            onChange={(e) => set('restrict_networks', e.target.value)} disabled={readOnly}
            helperText="One per line, or separated by commas: 10.0.0.0/8, 2001:db8::/32 or 192.0.2.7. Blank means no limit. While the lockdown lasts, sign-in is refused from outside the list." />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <div>
          {!isNew && !readOnly && <Button color="error" onClick={() => setConfirmDelete(true)}>Delete</Button>}
        </div>
        <Stack direction="row" spacing={1}>
          <Button onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button type="submit" variant="contained" disabled={saving}>Save</Button>}
        </Stack>
      </DialogActions>
      <ConfirmDialog open={confirmDelete} title="Delete this policy?" message={`${initial.name} will no longer apply to anyone.`}
        confirmLabel="Delete" onConfirm={remove} onClose={() => setConfirmDelete(false)} />
    </Dialog>
  );
}

export default function CompromisePoliciesTab() {
  const can = useCan();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const readOnly = !can('policies.manage');

  const load = useCallback(() => api('/admin/compromise-policies').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;
  const subjectOf = (p) => (p.subject_type === 'everyone' ? 'Everyone' : `${p.subject_type === 'role' ? 'Role' : (p.group_ids?.length || 0) > 1 ? 'Groups' : 'Group'}: ${p.subject_name}`);

  return (
    <Stack spacing={2}>
      <PageIntro title="Compromised account policies">
        What a lockdown does to an account believed to be compromised, started from the account&rsquo;s page or through the user API.
        The Everyone policy sets the default. A role or group policy adds steps for the people in it, so a more sensitive group can be
        locked down more firmly.
      </PageIntro>
      {!data.integration && <Alert severity="warning">The Compromised account lockdown integration is missing. Lockdowns cannot run until it is restored under Integrations.</Alert>}
      {data.integration && !data.integration.enabled && <Alert severity="warning">The Compromised account lockdown integration is turned off. Turn it on under Integrations before locking down an account.</Alert>}
      {!readOnly && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({ ...BLANK })} sx={{ alignSelf: 'flex-start' }}>New compromised account policy</Button>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow><TableCell>Policy</TableCell><TableCell>Applies to</TableCell><TableCell>Steps</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {data.policies.map((p) => (
              <TableRow key={p.id} hover sx={{ cursor: 'pointer' }} onClick={() => setEditing(p)}>
                <TableCell>
                  <Typography fontWeight={500}>{p.name}</Typography>
                  {p.description && <Typography variant="body2" color="text.secondary">{p.description}</Typography>}
                </TableCell>
                <TableCell>{subjectOf(p)}</TableCell>
                <TableCell><Steps policy={p} steps={data.steps} /></TableCell>
              </TableRow>
            ))}
            {!data.policies.length && (
              <TableRow><TableCell colSpan={3}><Typography color="text.secondary">No compromised account policies yet. The built-in default applies.</Typography></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {editing && (
        <CompromisePolicyDialog initial={editing} options={data} readOnly={readOnly} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </Stack>
  );
}
