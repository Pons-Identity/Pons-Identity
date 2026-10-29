import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Stack, TextField, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import RiskAcknowledgement from '../../../components/RiskAcknowledgement.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';

// How long a sign-in session lasts, and whether it ends sooner when nobody is using it.
export default function SessionTab() {
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [accepted, setAccepted] = useState([]);
  const [errors, setErrors] = useState([]);

  const load = (r) => { setForm({ sessionHours: r.sessionHours, idleMinutes: r.idleMinutes, limits: r.limits }); setWarnings(r.warnings); };
  useEffect(() => { api('/admin/settings/session').then(load).catch((e) => setErrors([e.message])); }, []);
  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  async function save() {
    setErrors([]);
    try {
      load(await api('/admin/settings/session', { method: 'PUT', body: { sessionHours: Number(form.sessionHours), idleMinutes: Number(form.idleMinutes) || 0, acknowledge: accepted } }));
      notify('Session settings saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
      if (e.data?.warnings) setWarnings(e.data.warnings);
    }
  }

  return (
    <Stack spacing={3}>
      <PageIntro title="Sessions">
        A session starts when someone signs in. It ends after the session length whatever they do, and, if you set an idle timeout, sooner when they have
        done nothing for that long. A change applies to sessions that are already open, and ends any that are now past the new limits.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Limits</Typography>
          <TextField label="Session length (hours)" type="number" value={form.sessionHours} sx={{ maxWidth: 280 }}
            onChange={(e) => setForm({ ...form, sessionHours: e.target.value })}
            slotProps={{ htmlInput: { min: form.limits.hours.min, max: form.limits.hours.max } }}
            helperText={`The longest a session can last, counted from sign-in. ${form.limits.hours.min} to ${form.limits.hours.max} hours; the default is ${form.limits.hours.default}.`} />
          <TextField label="Idle timeout (minutes)" type="number" value={form.idleMinutes} sx={{ maxWidth: 280 }}
            onChange={(e) => setForm({ ...form, idleMinutes: e.target.value })}
            slotProps={{ htmlInput: { min: 0, max: form.limits.idleMinutes.max } }}
            helperText={`0 turns the idle timeout off. Otherwise ${form.limits.idleMinutes.min} to ${form.limits.idleMinutes.max} minutes without any request ends the session. Open pages that check in on their own count as activity.`} />
        </Stack>
      </CardContent></Card>
      <RiskAcknowledgement warnings={Number(form.idleMinutes) ? [] : warnings} accepted={accepted} onChange={setAccepted} />
      <Button variant="contained" onClick={save} sx={{ alignSelf: 'flex-start' }}>Save</Button>
    </Stack>
  );
}
