import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';
import { useProductName } from '../../../auth/AuthContext.jsx';

const secretProps = (set) => ({ type: 'password', autoComplete: 'new-password', placeholder: set ? '••••••••' : '', helperText: set ? 'Saved. Leave blank to keep it.' : '' });

// One call the service makes: the request to create the verification, to send the person's details, or to read its status.
function CallFields({ label, value, onChange, secrets, secretKey, required, help }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <Card variant="outlined"><CardContent>
      <Stack spacing={2}>
        <Typography variant="subtitle1" component="h3">{label}</Typography>
        {help && <Typography variant="body2" color="text.secondary">{help}</Typography>}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField select label="Method" value={value.method} onChange={(e) => set('method', e.target.value)} sx={{ minWidth: 140 }}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
          </TextField>
          <TextField label="Address" value={value.url} onChange={(e) => set('url', e.target.value)} fullWidth required={required}
            helperText="Variables: {{user.username}}, {{user.email}}, {{user.first_name}}, {{user.last_name}}, {{user.guid}}, {{ref}}" />
        </Stack>
        <TextField label="Headers" multiline minRows={2} value={value.headers} onChange={(e) => set('headers', e.target.value)} fullWidth
          placeholder={'Authorization: Bearer {{...}}'} {...secretProps(secrets[`${secretKey}.headers`])}
          helperText={secrets[`${secretKey}.headers`] ? 'Saved. Leave blank to keep the headers.' : 'One per line, as Name: value. Headers often carry a token, so they are kept secret.'} />
        <TextField label="Body" multiline minRows={3} value={value.body} onChange={(e) => set('body', e.target.value)} fullWidth
          placeholder={'{"email": "{{user.email}}", "name": "{{user.first_name}} {{user.last_name}}"}'}
          helperText="JSON or text. Values are escaped for JSON, so a name cannot break the body." />
      </Stack>
    </CardContent></Card>
  );
}

// Identity verification for self-service password and MFA resets: Persona, or a REST service described here, decides whether the person
// is who they say. An integration script can take the place of both (see Integrations → Identity verification).
export default function IdentityTab() {
  const productName = useProductName();
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [integrations, setIntegrations] = useState([]);
  const [errors, setErrors] = useState([]);

  useEffect(() => {
    api('/admin/settings/identity').then(setForm).catch((e) => setErrors([e.message]));
    api('/admin/integrations').then((d) => setIntegrations(d.integrations || [])).catch(() => {});
  }, []);
  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const setTop = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setPersona = (k, v) => setForm((f) => ({ ...f, persona: { ...f.persona, [k]: v } }));
  const setRest = (k, v) => setForm((f) => ({ ...f, rest: { ...f.rest, [k]: v } }));
  const setReq = (k, v) => setForm((f) => ({ ...f, requirement: { ...f.requirement, [k]: v } }));

  async function save() {
    setErrors([]);
    try {
      setForm(await api('/admin/settings/identity', { method: 'PUT', body: form }));
      notify('Identity verification saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    }
  }

  const gate = form.requirement.integrationId !== null;
  return (
    <Stack spacing={3}>
      <PageIntro title="Identity verification">
        Before a forgotten password or a lost second factor can be reset from the sign-in page, the person can be asked to verify who they are with an
        outside service. Persona runs the check; a REST service you describe can do it instead, or send the person's details to one you already use.
        An integration script can also run the step, for anything that needs more than one call. Turn a reset on below to require it.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <TextField select label="Provider" value={form.provider} onChange={(e) => setTop('provider', e.target.value)} sx={{ maxWidth: 360 }}>
            <MenuItem value="none">Not configured</MenuItem>
            <MenuItem value="persona">Persona</MenuItem>
            <MenuItem value="rest">REST service</MenuItem>
          </TextField>
          <FormControlLabel control={<Switch checked={form.requirement.password} onChange={(e) => setReq('password', e.target.checked)} />}
            label="Require verification for a password reset" />
          <FormControlLabel control={<Switch checked={form.requirement.mfa} onChange={(e) => setReq('mfa', e.target.checked)} />}
            label="Allow a second-factor reset, only after verification" />
          <Typography variant="body2" color="text.secondary">
            A second-factor reset is never offered without verification, so turning this on is what lets someone who lost their phone start one.
          </Typography>
          <TextField select label="Use an integration script instead of the provider" value={form.requirement.integrationId ?? ''}
            onChange={(e) => setReq('integrationId', e.target.value === '' ? null : Number(e.target.value))} sx={{ maxWidth: 520 }}
            helperText="The script is called with input.step ('start' or 'check') and returns { url, ref } to start, or { approved } to check. It may use idp.identity.* and http.">
            <MenuItem value="">None: use the provider above</MenuItem>
            {integrations.filter((i) => i.enabled).map((i) => <MenuItem key={i.id} value={i.id}>{i.name}</MenuItem>)}
          </TextField>
          {gate && <Alert severity="info">The integration script is used for every verification, and the provider above is not.</Alert>}
        </Stack>
      </CardContent></Card>

      {form.provider === 'persona' && (
        <Card variant="outlined"><CardContent>
          <Stack spacing={2}>
            <Typography variant="subtitle1" component="h3">Persona</Typography>
            <TextField label="API key" value={form.persona.apiKey} onChange={(e) => setPersona('apiKey', e.target.value)} fullWidth {...secretProps(form.secrets['persona.apiKey'])} />
            <TextField label="Inquiry template ID" value={form.persona.templateId} onChange={(e) => setPersona('templateId', e.target.value)} fullWidth
              helperText="The template that sets what the person must do, such as itmpl_…" />
            <TextField label="Webhook signing secret" value={form.persona.webhookSecret} onChange={(e) => setPersona('webhookSecret', e.target.value)} fullWidth {...secretProps(form.secrets['persona.webhookSecret'])} />
            <TextField label="Webhook address" value={form.callbacks.persona} fullWidth InputProps={{ readOnly: true }}
              helperText="Add this in Persona's webhooks, and use its secret above. Persona's signature is checked on every call." />
          </Stack>
        </CardContent></Card>
      )}

      {form.provider === 'rest' && (
        <Stack spacing={2}>
          <CallFields label="1. Create the verification" value={form.rest.create} onChange={(v) => setRest('create', v)} secrets={form.secrets} secretKey="rest.create" required
            help="Called when a reset starts. Its answer must include a reference for the verification, read from the path below." />
          <CallFields label="2. Send the person's details (optional)" value={form.rest.send} onChange={(v) => setRest('send', v)} secrets={form.secrets} secretKey="rest.send"
            help="Leave the address empty to skip. Called after the verification is created, with {{ref}} set." />
          <CallFields label="3. Get the status" value={form.rest.status} onChange={(v) => setRest('status', v)} secrets={form.secrets} secretKey="rest.status" required
            help="Called to check where the verification stands. {{ref}} is the reference." />
          <Card variant="outlined"><CardContent>
            <Stack spacing={2}>
              <Typography variant="subtitle1" component="h3">Reading the answers</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Reference field" value={form.rest.refPath} onChange={(e) => setRest('refPath', e.target.value)} helperText="Path in the create answer, e.g. id or data.id" />
                <TextField label="Link field (optional)" value={form.rest.urlPath} onChange={(e) => setRest('urlPath', e.target.value)} helperText="Where the person goes to complete it" />
                <TextField label="Status field" value={form.rest.statusPath} onChange={(e) => setRest('statusPath', e.target.value)} helperText="Path in the status answer, e.g. status" />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Value for approved" value={form.rest.approved} onChange={(e) => setRest('approved', e.target.value)} />
                <TextField label="Value for declined" value={form.rest.declined} onChange={(e) => setRest('declined', e.target.value)} />
                <TextField label="Value for expired" value={form.rest.expired} onChange={(e) => setRest('expired', e.target.value)} />
              </Stack>
              <Typography variant="body2" color="text.secondary">Any other value means the verification is still pending.</Typography>
            </Stack>
          </CardContent></Card>
          <Card variant="outlined"><CardContent>
            <Stack spacing={2}>
              <Typography variant="subtitle1" component="h3">Callbacks (optional)</Typography>
              <Typography variant="body2" color="text.secondary">
                The service can tell {productName} when a status changes instead of waiting to be asked. Give it this address; when it calls, {productName} asks the
                service for the status again, so a call alone approves nothing.
              </Typography>
              <TextField label="Callback address" value={form.callbacks.rest} fullWidth InputProps={{ readOnly: true }} helperText="Contains a token; keep it private." />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Reference field in the callback" value={form.rest.webhookRefPath} onChange={(e) => setRest('webhookRefPath', e.target.value)} helperText="Path in the callback body" />
                <TextField label="Shared secret (optional)" value={form.rest.webhookSecret} onChange={(e) => setRest('webhookSecret', e.target.value)} fullWidth
                  {...secretProps(form.secrets['rest.webhookSecret'])} helperText={form.secrets['rest.webhookSecret'] ? 'Saved. Leave blank to keep it.' : 'Sent by the service in the X-Identity-Secret header'} />
              </Stack>
            </Stack>
          </CardContent></Card>
        </Stack>
      )}

      <Button variant="contained" onClick={save} sx={{ alignSelf: 'flex-start' }}>Save</Button>
    </Stack>
  );
}
