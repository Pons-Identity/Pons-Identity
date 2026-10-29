import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, FormControlLabel, FormHelperText, Stack, Switch, TextField } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { useNotify } from '../../../components/Notify.jsx';

export default function DuoTab() {
  const { refresh } = useAuth();
  const notify = useNotify();
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState('');
  // Duo can be turned on only once the current details have passed Test connection.
  const [verified, setVerified] = useState(false);

  const adopt = (d) => {
    setSaved(d);
    setVerified(Boolean(d.enabled));
    setForm({ enabled: d.enabled, apiHost: d.apiHost || '', integrationKey: d.integrationKey || '', secretKey: '' });
  };

  useEffect(() => {
    api('/admin/settings/duo').then(adopt).catch((e) => setErrors([e.message]));
  }, []);

  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;
  const set = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key !== 'enabled') setVerified(false);
  };

  async function run(kind, fn) {
    setBusy(kind);
    setErrors([]);
    try {
      await fn();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setBusy('');
    }
  }

  const test = () => run('test', async () => {
    await api('/admin/settings/duo/test', { method: 'POST', body: form });
    setVerified(true);
    notify('Duo accepted these settings');
  });

  const save = (e) => {
    e.preventDefault();
    return run('save', async () => {
      adopt(await api('/admin/settings/duo', { method: 'PUT', body: form }));
      await refresh();
      notify('Duo settings saved');
    });
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack component="form" spacing={2.5} onSubmit={save} sx={{ maxWidth: 640 }}>
          <PageIntro title="Duo MFA">
            Duo adds a second factor after the password, using a Duo Auth API application. Create one in the Duo Admin Panel
            (Applications &rarr; Protect an Application &rarr; Auth API) and copy its details here.
          </PageIntro>
          {saved.bypassed && (
            <Alert severity="error">
              Duo is off right now because the break-glass file is present on the server. Duo is not used for sign-in until that file is removed.
            </Alert>
          )}
          {saved.source === 'file' && (
            <Alert severity="info">
              {saved.apiHost ? 'These values come from config.json or environment variables. Saving here replaces them.' : 'Duo is not configured yet.'}
            </Alert>
          )}
          {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

          <div>
            <FormControlLabel control={<Switch checked={form.enabled} disabled={!form.enabled && !verified} onChange={(e) => set('enabled', e.target.checked)} />}
              label="Require Duo after the password" />
            {!form.enabled && !verified && (
              <FormHelperText>Configure Duo and pass Test connection before turning this on.</FormHelperText>
            )}
          </div>
          <TextField label="API hostname" placeholder="api-xxxxxxxx.duosecurity.com" value={form.apiHost} onChange={(e) => set('apiHost', e.target.value)} />
          <TextField label="Integration key" value={form.integrationKey} onChange={(e) => set('integrationKey', e.target.value)} autoComplete="off" />
          <TextField label="Secret key" type="password" autoComplete="new-password" value={form.secretKey} onChange={(e) => set('secretKey', e.target.value)}
            placeholder={saved.secretSet ? '••••••••' : ''}
            helperText={saved.secretSet ? 'A secret key is saved. Leave blank to keep it.' : 'Required to turn Duo on.'} />

          <Alert severity="warning">
            Turning Duo on is checked against Duo first, so a wrong key cannot lock everyone out. If Duo is unreachable later, sign-in fails closed.
          </Alert>

          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained" disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
            <Button onClick={test} disabled={Boolean(busy)}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
