import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { api } from '../api/client.js';
import { useNotify } from './Notify.jsx';

const USER_ACTIONS = [['deactivate', 'Deactivate'], ['activate', 'Activate'], ['delete', 'Delete']];
const GROUP_ACTIONS = [['deactivate', 'Deactivate all members'], ['activate', 'Activate all members']];

// datetime-local gives local wall time; the server wants an absolute instant.
const toIso = (local) => new Date(local).toISOString();
const defaultTime = () => {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

// Pending account actions for one person or one group, and a form to add another.
export default function SchedulePanel({ userId, groupId }) {
  const notify = useNotify();
  const actions = groupId ? GROUP_ACTIONS : USER_ACTIONS;
  const [items, setItems] = useState(null);
  const [form, setForm] = useState({ action: 'deactivate', at: defaultTime() });
  const [errors, setErrors] = useState([]);
  const query = groupId ? `group_id=${groupId}` : `user_id=${userId}`;

  const load = useCallback(() => api(`/admin/schedules?${query}`).then(setItems).catch((e) => setErrors([e.message])), [query]);
  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    setErrors([]);
    try {
      await api('/admin/schedules', { method: 'POST', body: { action: form.action, run_at: toIso(form.at), ...(groupId ? { group_id: groupId } : { user_id: userId }) } });
      notify('Scheduled');
      load();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    }
  }

  async function cancel(id) {
    try {
      await api(`/admin/schedules/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    }
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Scheduled changes</Typography>
          {groupId && <Typography variant="body2" color="text.secondary">Applies to whoever is a member when it runs. Administrators and anyone who outranks you are skipped.</Typography>}
          {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
          {(items || []).map((s) => (
            <Stack key={s.id} direction="row" spacing={2} alignItems="center">
              <Typography sx={{ flexGrow: 1 }}>{USER_ACTIONS.concat(GROUP_ACTIONS).find(([k]) => k === s.action)?.[1] || s.action} on {new Date(s.run_at * 1000).toLocaleString()} <Typography component="span" color="text.secondary">(by {s.created_by})</Typography></Typography>
              <Button size="small" color="error" onClick={() => cancel(s.id)}>Cancel</Button>
            </Stack>
          ))}
          {items && !items.length && <Typography color="text.secondary">Nothing scheduled.</Typography>}
          <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={2} onSubmit={add}>
            <TextField select size="small" label="Action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} sx={{ minWidth: 220 }}>
              {actions.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
            </TextField>
            <TextField size="small" type="datetime-local" label="When" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
            <Button type="submit" variant="outlined">Schedule</Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
