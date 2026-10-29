import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import PageIntro from './PageIntro.jsx';
import AddIcon from '@mui/icons-material/Add';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';

const userLabel = (u) => (u.display_name && u.display_name !== u.username ? `${u.display_name} (${u.username})` : u.username);

// Permissions grouped for display, in catalog order.
const grouped = (permissions) => permissions.reduce((acc, p) => {
  (acc[p.group] ||= []).push(p);
  return acc;
}, {});

function RoleDialog({ roleId, permissions, onClose, onSaved }) {
  const can = useCan();
  const notify = useNotify();
  const readOnly = !can('roles.manage');
  const isNew = roleId === 'new';
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    api(`/admin/roles/${isNew ? 'blank' : roleId}`).then((d) => {
      setData(d);
      setForm({ name: d.role.name, description: d.role.description || '', permissions: d.role.permissions, members: d.members });
    }).catch((e) => setErrors([e.message]));
  }, [roleId, isNew]);

  const builtin = Boolean(data?.role.builtin);
  const locked = readOnly || builtin;
  const people = data ? [...data.members, ...data.candidates] : [];

  // A "manage" permission brings its "view" along and keeps it on.
  const impliedByChecked = (key) => permissions.some((p) => form.permissions.includes(p.key) && p.implies.includes(key));
  const toggle = (p, on) => setForm((f) => {
    const next = new Set(f.permissions);
    if (on) [p.key, ...p.implies].forEach((k) => next.add(k));
    else next.delete(p.key);
    return { ...f, permissions: [...next] };
  });

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    const body = { name: form.name, description: form.description, permissions: form.permissions, user_ids: form.members.map((m) => m.id) };
    try {
      if (isNew) await api('/admin/roles', { method: 'POST', body });
      else await api(`/admin/roles/${roleId}`, { method: 'PUT', body });
      notify('Role saved');
      onSaved();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    try {
      await api(`/admin/roles/${roleId}`, { method: 'DELETE' });
      notify('Role deleted');
      onSaved();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <form onSubmit={save}>
        <DialogTitle>{isNew ? 'New role' : data ? `Role: ${data.role.name}` : 'Role'}</DialogTitle>
        <DialogContent>
          {errors.length > 0 && <Alert severity="error" sx={{ mb: 2 }}>{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
          {form && (
            <Stack spacing={3} sx={{ pt: 1 }}>
              {builtin && <Alert severity="info">The Administrator role always holds every permission and cannot be edited. You can still change who is in it.</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Name" required disabled={locked} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} fullWidth />
                <TextField label="Description" disabled={locked} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} fullWidth />
              </Stack>

              <Box>
                <Typography variant="subtitle2" component="h2" gutterBottom>Permissions</Typography>
                <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
                  {Object.entries(grouped(permissions)).map(([group, items]) => (
                    <Paper key={group} variant="outlined" sx={{ p: 1.5 }}>
                      <Typography variant="overline" color="text.secondary">{group}</Typography>
                      <Stack>
                        {items.map((p) => (
                          <FormControlLabel key={p.key} disabled={locked || impliedByChecked(p.key)} sx={{ alignItems: 'flex-start', mb: 0.5 }}
                            control={<Checkbox size="small" sx={{ pt: 0.5 }} checked={builtin || form.permissions.includes(p.key)} onChange={(e) => toggle(p, e.target.checked)} />}
                            label={<><Typography variant="body2">{p.label}</Typography><Typography variant="caption" color="text.secondary">{p.description}</Typography></>} />
                        ))}
                      </Stack>
                    </Paper>
                  ))}
                </Box>
              </Box>

              <Autocomplete multiple disableCloseOnSelect disabled={readOnly} options={people}
                value={form.members} onChange={(_, v) => setForm({ ...form, members: v })}
                getOptionLabel={userLabel} isOptionEqualToValue={(a, b) => a.id === b.id}
                renderInput={(params) => <TextField {...params} label="Members" placeholder={form.members.length ? '' : 'Add people'} helperText="Everyone in this role gets its permissions." />} />
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          {!isNew && !builtin && !readOnly && <Button color="error" onClick={() => setConfirmDelete(true)} sx={{ mr: 'auto' }}>Delete role</Button>}
          <Button onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button type="submit" variant="contained" disabled={saving || !form}>Save</Button>}
        </DialogActions>
      </form>
      <ConfirmDialog open={confirmDelete} title="Delete role?" confirmLabel="Delete"
        message={`${data?.role.name || 'This role'} will be removed and its ${data?.members.length || 0} member(s) lose the permissions it gave them.`}
        onConfirm={remove} onClose={() => setConfirmDelete(false)} />
    </Dialog>
  );
}

export default function RolesTab() {
  const can = useCan();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => api('/admin/roles').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const labels = Object.fromEntries((data?.permissions || []).map((p) => [p.key, p.label]));

  return (
    <Stack spacing={2}>
      <PageIntro title="Roles & permissions">
        A role is a set of permissions. Give people a role to let them use those parts of the admin console; the Administrator role has them all.
      </PageIntro>
      {can('roles.manage') && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')} sx={{ alignSelf: 'flex-start' }}>New role</Button>}
      {error && <Alert severity="error">{error}</Alert>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Role</TableCell>
              <TableCell>Permissions</TableCell>
              <TableCell align="right">Members</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {(data?.roles || []).map((r) => (
              <TableRow key={r.id} hover>
                <TableCell>
                  <Typography variant="body2" fontWeight={600}>{r.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{r.description}</Typography>
                </TableCell>
                <TableCell>
                  {r.builtin
                    ? <Chip size="small" color="primary" label="All permissions" />
                    : r.permissions.length === 0
                      ? <Typography variant="body2" color="text.secondary">None</Typography>
                      : <Stack direction="row" flexWrap="wrap" gap={0.5}>{r.permissions.map((k) => <Chip key={k} size="small" variant="outlined" label={labels[k] || k} />)}</Stack>}
                </TableCell>
                <TableCell align="right">{r.member_count}</TableCell>
                <TableCell align="right"><Button size="small" onClick={() => setEditing(r.id)}>{can('roles.manage') ? 'Edit' : 'View'}</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {editing && (
        <RoleDialog roleId={editing} permissions={data?.permissions || []} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </Stack>
  );
}
