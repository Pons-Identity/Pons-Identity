import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, FormControlLabel, Stack, Switch } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';

// Forgotten-password recovery by a link sent to a personal email address.
export default function RecoveryTab() {
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);

  useEffect(() => { api('/admin/settings/recovery').then(setForm).catch((e) => setErrors([e.message])); }, []);
  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  async function save() {
    setErrors([]);
    try {
      setForm(await api('/admin/settings/recovery', { method: 'PUT', body: form }));
      notify('Password recovery settings saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    }
  }

  return (
    <Stack spacing={3}>
      <PageIntro title="Password recovery">
        With recovery on, someone who forgot their password asks for a reset link on the sign-in page. It is sent only to a personal email address they
        added and confirmed (or that an administrator or onboarding system entered), is valid for 30 minutes and works once. It never skips a second
        factor. Accounts owned by an external directory cannot use it, and a policy can turn it off for a role or group.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      {!form.email_ready && <Alert severity="info">Email delivery is not set up yet. Configure it under Messaging first.</Alert>}
      <Card variant="outlined"><CardContent>
        <Stack spacing={1}>
          <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />} label="Allow password recovery by personal email" />
          <FormControlLabel control={<Switch checked={form.allowAdmins} onChange={(e) => setForm({ ...form, allowAdmins: e.target.checked })} />}
            label="Allow administrators to recover this way (not recommended: a hijacked mailbox would then reach an administrator account)" />
        </Stack>
      </CardContent></Card>
      <Button variant="contained" onClick={save} sx={{ alignSelf: 'flex-start' }}>Save</Button>
    </Stack>
  );
}
