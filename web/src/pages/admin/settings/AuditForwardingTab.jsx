import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, FormControlLabel, MenuItem, Stack, Switch, TextField } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';

const HTTP_FORMATS = [
  { value: 'json', label: 'JSON array' },
  { value: 'splunk-hec', label: 'Splunk HTTP Event Collector' },
  { value: 'ecs', label: 'Elastic Common Schema (ECS)' },
  { value: 'cef', label: 'CEF (ArcSight-style)' },
];

export default function AuditForwardingTab() {
  const notify = useNotify();
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);

  const adopt = (d) => {
    setSaved(d);
    setForm({
      syslog: { ...d.syslog },
      http: { enabled: d.http.enabled, url: d.http.url, format: d.http.format, authToken: '' },
    });
  };

  useEffect(() => {
    api('/admin/settings/audit-forwarding').then(adopt).catch((e) => setErrors([e.message]));
  }, []);

  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const setSyslog = (key, value) => setForm((f) => ({ ...f, syslog: { ...f.syslog, [key]: value } }));
  const setHttp = (key, value) => setForm((f) => ({ ...f, http: { ...f.http, [key]: value } }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      adopt(await api('/admin/settings/audit-forwarding', { method: 'PUT', body: form }));
      notify('Log forwarding saved');
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack component="form" spacing={2.5} onSubmit={save} sx={{ maxWidth: 640 }}>
          <PageIntro title="Log forwarding">
            Send a copy of every audit event to a syslog server or a SIEM as it happens. Events are delivered in order and retried
            if the receiver is down. Use <code>tls://</code> or <code>https://</code> unless the receiver is on a trusted network,
            because events contain usernames and IP addresses. The Audit page shows each destination&apos;s health.
          </PageIntro>
          {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

          <FormControlLabel
            control={<Switch checked={form.syslog.enabled} onChange={(e) => setSyslog('enabled', e.target.checked)} />}
            label="Send to a syslog server"
          />
          <TextField label="Syslog server" placeholder="tls://logs.example.net:6514" value={form.syslog.url} disabled={!form.syslog.enabled}
            onChange={(e) => setSyslog('url', e.target.value)} helperText="udp://, tcp:// or tls://, then host and port" />
          <TextField select label="Facility" value={form.syslog.facility} disabled={!form.syslog.enabled}
            onChange={(e) => setSyslog('facility', e.target.value)}>
            {saved.facilities.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
          </TextField>
          <TextField label="Application name" value={form.syslog.appName} disabled={!form.syslog.enabled}
            onChange={(e) => setSyslog('appName', e.target.value)} />
          <TextField label="CA certificate file" placeholder="/etc/ssl/log-ca.pem" value={form.syslog.caFile} disabled={!form.syslog.enabled}
            onChange={(e) => setSyslog('caFile', e.target.value)}
            helperText="Optional. A file on this server, for a log server with a private certificate authority." />

          <FormControlLabel
            control={<Switch checked={form.http.enabled} onChange={(e) => setHttp('enabled', e.target.checked)} />}
            label="Send to a SIEM over HTTP"
          />
          <TextField label="SIEM URL" placeholder="https://splunk.example.net:8088/services/collector/event" value={form.http.url}
            disabled={!form.http.enabled} onChange={(e) => setHttp('url', e.target.value)} />
          <TextField select label="Event format" value={form.http.format} disabled={!form.http.enabled}
            onChange={(e) => setHttp('format', e.target.value)}>
            {HTTP_FORMATS.map((f) => <MenuItem key={f.value} value={f.value}>{f.label}</MenuItem>)}
          </TextField>
          <TextField label="Access token" type="password" autoComplete="new-password" value={form.http.authToken} disabled={!form.http.enabled}
            onChange={(e) => setHttp('authToken', e.target.value)}
            placeholder={saved.http.tokenSet ? '••••••••' : ''}
            helperText={saved.http.tokenSet ? 'A token is saved. Leave blank to keep it.' : 'Optional. Sent as a bearer token, or as Splunk <token> for Splunk.'} />

          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
