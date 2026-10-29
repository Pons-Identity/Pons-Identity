import { forwardRef, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Checkbox, FormControlLabel, FormGroup, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import RiskAcknowledgement from '../../../components/RiskAcknowledgement.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';

const SECRET_HINT = 'Stored. Leave blank to keep it.';
const secretProps = (set) => ({ type: 'password', autoComplete: 'new-password', helperText: set ? SECRET_HINT : undefined, placeholder: set ? '••••••••' : '' });

// The form keeps E.164 (+15551234567), which the providers expect. Typed text is reduced to digits and shown as +1 (555) 123-4567 for US and Canada numbers.
const toE164 = (text) => {
  const digits = text.replace(/\D/g, '');
  return digits ? `+${digits.slice(0, digits[0] === '1' ? 11 : 15)}` : '';
};
const formatPhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits[0] !== '1') return `+${digits}`;
  const area = digits.slice(1, 4);
  const mid = digits.slice(4, 7);
  const last = digits.slice(7, 11);
  return `+1${area ? ` (${area}${area.length === 3 ? ')' : ''}` : ''}${mid ? ` ${mid}` : ''}${last ? `-${last}` : ''}`;
};

// MUI's input-mask hook: TextField passes it as inputComponent, so the label, helper text and error state still come from the field.
const PhoneMaskInput = forwardRef(function PhoneMaskInput({ value, onChange, ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      inputMode="tel"
      value={formatPhone(value)}
      onChange={(e) => onChange({ target: { value: toE164(e.target.value) } })}
    />
  );
});

// Email, SMS and voice delivery. Secrets come back from the server only as "is set", so the fields stay blank.
function PhoneChannel({ title, cfg, secrets, onChange, test }) {
  const set = (path, v) => onChange(path, v);
  return (
    <Card variant="outlined"><CardContent>
      <Stack spacing={2}>
        <Typography variant="h6" component="h2">{title}</Typography>
        <TextField select label="Provider" value={cfg.provider} onChange={(e) => set(['provider'], e.target.value)} sx={{ maxWidth: 320 }}>
          <MenuItem value="none">Not configured</MenuItem>
          <MenuItem value="twilio">Twilio</MenuItem>
          <MenuItem value="http">Custom HTTP API</MenuItem>
        </TextField>
        {cfg.provider === 'twilio' && (
          <Stack spacing={2}>
            <TextField label="Account SID" value={cfg.twilio.accountSid} onChange={(e) => set(['twilio', 'accountSid'], e.target.value)} />
            <TextField label="Auth token" value={cfg.twilio.authToken} onChange={(e) => set(['twilio', 'authToken'], e.target.value)} {...secretProps(secrets['twilio.authToken'])} />
            <TextField label="From number" value={cfg.twilio.from} onChange={(e) => set(['twilio', 'from'], e.target.value)} helperText="Include the country code, for example +1 (555) 123-4567."
              slotProps={{ input: { inputComponent: PhoneMaskInput } }} />
            {cfg.twilio.verifySignature !== undefined && (
              <FormControlLabel control={<Switch checked={cfg.twilio.verifySignature} onChange={(e) => set(['twilio', 'verifySignature'], e.target.checked)} />}
                label="Verify Twilio's signature on sign-in call requests (recommended). Uses the auth token above; Twilio must be given this server's public address (BASE_URL)." />
            )}
          </Stack>
        )}
        {cfg.provider === 'http' && (
          <Stack spacing={2}>
            <TextField label="URL" value={cfg.http.url} onChange={(e) => set(['http', 'url'], e.target.value)} helperText="May contain {{to}}, {{message}} and {{from}}. Must be a public https address." />
            <TextField label="From" value={cfg.from} onChange={(e) => set(['from'], e.target.value)} />
            <TextField select label="Body format" value={cfg.http.contentType} onChange={(e) => set(['http', 'contentType'], e.target.value)} sx={{ maxWidth: 240 }}>
              <MenuItem value="json">JSON</MenuItem>
              <MenuItem value="form">Form (URL-encoded)</MenuItem>
            </TextField>
            <TextField label="Request body" multiline minRows={3} value={cfg.http.body} onChange={(e) => set(['http', 'body'], e.target.value)}
              helperText="Must include {{to}} and {{message}}; values are escaped for the chosen format." slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }} />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Auth header name" value={cfg.http.authHeader} onChange={(e) => set(['http', 'authHeader'], e.target.value)} fullWidth />
              <TextField label="Auth header value" value={cfg.http.authValue} onChange={(e) => set(['http', 'authValue'], e.target.value)} fullWidth {...secretProps(secrets['http.authValue'])} />
            </Stack>
            <TextField label="Extra headers" multiline minRows={2} value={cfg.http.headers} onChange={(e) => set(['http', 'headers'], e.target.value)} helperText="One per line: Name: value" />
          </Stack>
        )}
        {cfg.provider !== 'none' && test}
      </Stack>
    </CardContent></Card>
  );
}

export default function MessagingTab() {
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [to, setTo] = useState({ email: '', sms: '', voice: '' });
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [accepted, setAccepted] = useState([]);

  const load = (r) => { setForm(r); setWarnings(r.warnings || []); };
  useEffect(() => { api('/admin/settings/messaging').then(load).catch((e) => setErrors([e.message])); }, []);
  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const update = (channel) => (path, v) => setForm((f) => {
    const next = structuredClone(f);
    let o = next[channel];
    path.slice(0, -1).forEach((k) => { o = o[k]; });
    o[path[path.length - 1]] = v;
    return next;
  });

  async function save() {
    setSaving(true);
    setErrors([]);
    try {
      load(await api('/admin/settings/messaging', { method: 'PUT', body: { ...form, acknowledge: accepted } }));
      notify('Messaging settings saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
      if (e.data?.warnings) setWarnings(e.data.warnings);
    } finally {
      setSaving(false);
    }
  }

  async function sendTest(channel) {
    setErrors([]);
    try {
      await api('/admin/settings/messaging/test', { method: 'POST', body: { channel, to: to[channel] } });
      notify('Test message sent');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    }
  }

  const testRow = (channel, label, placeholder) => (
    <Stack direction="row" spacing={1} alignItems="flex-start">
      <TextField size="small" label={label} placeholder={placeholder} value={to[channel]} onChange={(e) => setTo({ ...to, [channel]: e.target.value })} sx={{ flexGrow: 1, maxWidth: 360 }}
        helperText="Save first: the test uses the saved settings." />
      <Button variant="outlined" onClick={() => sendTest(channel)} disabled={!form[channel].configured || !to[channel]}>Send test</Button>
    </Stack>
  );
  const e = form.email;
  // The inbound addresses sit beside the channels, not inside email, as the server returns them.
  const inbound = form.inbound;

  return (
    <Stack spacing={3}>
      <PageIntro title="Messaging">
        Delivery used for password recovery and for email, SMS and voice sign-in factors. Nothing is sent until a channel is configured.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Email</Typography>
          <TextField select label="Provider" value={e.provider} onChange={(ev) => update('email')(['provider'], ev.target.value)} sx={{ maxWidth: 320 }}>
            <MenuItem value="none">Not configured</MenuItem>
            <MenuItem value="smtp">SMTP server</MenuItem>
            <MenuItem value="sendgrid">SendGrid API</MenuItem>
            <MenuItem value="ses">Amazon SES</MenuItem>
            <MenuItem value="postmark">Postmark</MenuItem>
            <MenuItem value="mailgun">Mailgun</MenuItem>
          </TextField>
          {e.provider !== 'none' && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="From address" value={e.from} onChange={(ev) => update('email')(['from'], ev.target.value)} fullWidth required />
              <TextField label="From name" value={e.fromName} onChange={(ev) => update('email')(['fromName'], ev.target.value)} fullWidth />
            </Stack>
          )}
          {e.provider === 'smtp' && (
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Host" value={e.smtp.host} onChange={(ev) => update('email')(['smtp', 'host'], ev.target.value)} fullWidth required />
                <TextField label="Port" type="number" value={e.smtp.port} onChange={(ev) => update('email')(['smtp', 'port'], ev.target.value)} sx={{ minWidth: 120 }} />
              </Stack>
              <FormControlLabel control={<Switch checked={e.smtp.secure} onChange={(ev) => update('email')(['smtp', 'secure'], ev.target.checked)} />} label="Use TLS from the start (usually port 465)" />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Username" value={e.smtp.user} onChange={(ev) => update('email')(['smtp', 'user'], ev.target.value)} fullWidth autoComplete="off" />
                <TextField label="Password" value={e.smtp.pass} onChange={(ev) => update('email')(['smtp', 'pass'], ev.target.value)} fullWidth {...secretProps(e.secrets['smtp.pass'])} />
              </Stack>
            </Stack>
          )}
          {e.provider === 'sendgrid' && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="API key" value={e.sendgrid.apiKey} onChange={(ev) => update('email')(['sendgrid', 'apiKey'], ev.target.value)} fullWidth {...secretProps(e.secrets['sendgrid.apiKey'])} />
              <TextField label="API URL" value={e.sendgrid.apiUrl} onChange={(ev) => update('email')(['sendgrid', 'apiUrl'], ev.target.value)} fullWidth helperText="Use https://api.eu.sendgrid.com for EU-region accounts." />
            </Stack>
          )}
          {e.provider === 'ses' && (
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Access key ID" value={e.ses.accessKeyId} onChange={(ev) => update('email')(['ses', 'accessKeyId'], ev.target.value)} fullWidth autoComplete="off" />
                <TextField label="Secret access key" value={e.ses.secretAccessKey} onChange={(ev) => update('email')(['ses', 'secretAccessKey'], ev.target.value)} fullWidth {...secretProps(e.secrets['ses.secretAccessKey'])} />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Region" value={e.ses.region} onChange={(ev) => update('email')(['ses', 'region'], ev.target.value)} sx={{ minWidth: 200 }} helperText="For example us-east-1." />
                <TextField label="Configuration set (optional)" value={e.ses.configurationSet} onChange={(ev) => update('email')(['ses', 'configurationSet'], ev.target.value)} fullWidth />
              </Stack>
              <TextField label="SNS topic ARN for replies (optional)" value={e.ses.snsTopicArn} onChange={(ev) => update('email')(['ses', 'snsTopicArn'], ev.target.value)} fullWidth
                helperText={`Replies arrive through an SES receipt rule that publishes to an SNS topic subscribed to ${inbound.ses}. Give the topic to accept replies from that topic only.`} />
            </Stack>
          )}
          {e.provider === 'postmark' && (
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Server API token" value={e.postmark.serverToken} onChange={(ev) => update('email')(['postmark', 'serverToken'], ev.target.value)} fullWidth {...secretProps(e.secrets['postmark.serverToken'])} />
                <TextField label="Message stream" value={e.postmark.messageStream} onChange={(ev) => update('email')(['postmark', 'messageStream'], ev.target.value)} sx={{ minWidth: 200 }} />
              </Stack>
              <TextField label="Inbound webhook address" value={inbound.postmark} fullWidth InputProps={{ readOnly: true }}
                helperText="Paste this into Postmark as the inbound webhook for your inbound domain. It contains a secret token: keep it private." />
            </Stack>
          )}
          {e.provider === 'mailgun' && (
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="API key" value={e.mailgun.apiKey} onChange={(ev) => update('email')(['mailgun', 'apiKey'], ev.target.value)} fullWidth {...secretProps(e.secrets['mailgun.apiKey'])} />
                <TextField label="Sending domain" value={e.mailgun.domain} onChange={(ev) => update('email')(['mailgun', 'domain'], ev.target.value)} fullWidth helperText="For example mail.example.net." />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField select label="Region" value={e.mailgun.region} onChange={(ev) => update('email')(['mailgun', 'region'], ev.target.value)} sx={{ minWidth: 200 }}>
                  <MenuItem value="us">United States</MenuItem>
                  <MenuItem value="eu">Europe</MenuItem>
                </TextField>
                <TextField label="HTTP webhook signing key" value={e.mailgun.signingKey} onChange={(ev) => update('email')(['mailgun', 'signingKey'], ev.target.value)} fullWidth {...secretProps(e.secrets['mailgun.signingKey'])}
                  helperText={`For replies: a route in Mailgun forwards to ${inbound.mailgun}.`} />
              </Stack>
            </Stack>
          )}
          {e.provider !== 'none' && (
            <Stack spacing={0.5}>
              <Typography variant="subtitle1" component="h3">Check email replies for forgery</Typography>
              <Typography variant="body2" color="text.secondary">
                A reply to a sign-in message can approve the sign-in, and the sender address of an email is easy to forge. Choose which checks your provider
                must report as passed before a reply counts. A check that is required but that the provider does not report counts as failed. DMARC is the
                one that ties the check to the address people see, so require it where your provider reports it (Amazon SES and Mailgun do; Postmark and others only if they add an
                Authentication-Results header). With none ticked, a reply is trusted on its sender address alone.
              </Typography>
              <FormGroup row>
                {[['spf', 'SPF'], ['dkim', 'DKIM'], ['dmarc', 'DMARC']].map(([k, label]) => (
                  <FormControlLabel key={k} label={label}
                    control={<Checkbox checked={Boolean(e.inboundAuth?.[k])} onChange={(ev) => update('email')(['inboundAuth', k], ev.target.checked)} />} />
                ))}
              </FormGroup>
            </Stack>
          )}
          {e.provider !== 'none' && testRow('email', 'Send test to', 'you@example.net')}
        </Stack>
      </CardContent></Card>

      <PhoneChannel title="SMS" cfg={form.sms} secrets={form.sms.secrets} onChange={update('sms')} test={testRow('sms', 'Send test to', '+15551234567')} />
      <PhoneChannel title="Voice calls" cfg={form.voice} secrets={form.voice.secrets} onChange={update('voice')} test={testRow('voice', 'Call test to', '+15551234567')} />

      <RiskAcknowledgement warnings={warnings} accepted={accepted} onChange={setAccepted} />
      <Button variant="contained" onClick={save} disabled={saving} sx={{ alignSelf: 'flex-start' }}>Save</Button>
    </Stack>
  );
}
