import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Checkbox, FormControlLabel, FormGroup, FormHelperText, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import RiskAcknowledgement from '../../../components/RiskAcknowledgement.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';

const CHANNELS = [['email', 'Email'], ['sms', 'Text message (SMS)'], ['voice', 'Phone call']];

// Each way a channel can prove the sign-in, as its own factor. Verified and unverified yes or no are separate factors.
const WAYS = [
  ['code', 'Code typed into the sign-in page', 'A code is sent and typed into the sign-in page. Convenient, but a fake sign-in page can ask for it.'],
  ['number_match', 'Number matching', 'The sign-in page shows a number. The person sends it back from the device that got the message: by following the link, on the keypad, or by replying. Nothing is typed into the sign-in page.'],
  ['yes_no', 'Yes or no, unverified (not recommended)', 'The device is asked "are you logging in?" and answers Y or N. Nothing is shown on the sign-in page, so this is not phishing resistant, and a person can approve a request they did not start. Prefer number matching or yes or no, verified. Turning this on means accepting that risk.'],
  ['yes_no_verified', 'Yes or no, verified', 'The device is asked the same question. A yes must be answered with the number shown on the sign-in page; N denies the sign-in.'],
];
const LENGTHS = [2, 3, 4, 5, 6];

// Which extra sign-in factors people may use, and how email, SMS and voice prove the person is holding the device.
export default function FactorsTab() {
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [accepted, setAccepted] = useState([]);

  const load = (r) => { setForm(r); setWarnings(r.warnings || []); };
  useEffect(() => { api('/admin/settings/factors').then(load).catch((e) => setErrors([e.message])); }, []);
  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  // With no type, the key is a setting of its own (such as the code length) rather than one of a channel's.
  const set = (type, key, value) => setForm((f) => (type ? { ...f, [type]: { ...f[type], [key]: value } } : { ...f, [key]: value }));

  async function save() {
    setErrors([]);
    try {
      load(await api('/admin/settings/factors', { method: 'PUT', body: { ...form, acknowledge: accepted } }));
      notify('Sign-in factors saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
      if (e.data?.warnings) setWarnings(e.data.warnings);
    }
  }

  return (
    <Stack spacing={3}>
      <PageIntro title="Sign-in factors">
        Authenticator apps are always available. Turn on more methods here; people then add them on their profile page. Policies can
        limit who may use which, or require phishing-resistant methods only. Email, SMS and voice need delivery set up under Messaging first.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Security keys and passkeys (FIDO2)</Typography>
          <Typography variant="body2" color="text.secondary">Phishing resistant by design: a key only answers the site it was registered on.</Typography>
          <FormControlLabel control={<Switch checked={form.webauthn.enabled} onChange={(e) => set('webauthn', 'enabled', e.target.checked)} />} label="Allow security keys" />
          <TextField select label="User verification" value={form.webauthn.userVerification} onChange={(e) => set('webauthn', 'userVerification', e.target.value)} sx={{ maxWidth: 360 }}
            helperText="Required means the key must check the person too, with a PIN or fingerprint.">
            <MenuItem value="preferred">Preferred</MenuItem>
            <MenuItem value="required">Required</MenuItem>
          </TextField>
        </Stack>
      </CardContent></Card>

      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Code and number length</Typography>
          <Typography variant="body2" color="text.secondary">
            Digits in a code that is typed into the sign-in page, and in the number the sign-in page shows for number matching. Anything from 2 to 6.
            Short codes are easier to guess: with five tries, someone guessing a 2-digit code succeeds about one time in twenty.
          </Typography>
          <Stack direction="row" spacing={2}>
            <TextField select label="Code length" value={form.codeLength} onChange={(e) => set('', 'codeLength', Number(e.target.value))} sx={{ minWidth: 180 }}>
              {LENGTHS.map((n) => <MenuItem key={n} value={n}>{n} characters</MenuItem>)}
            </TextField>
            <TextField select label="Number length" value={form.numberLength} onChange={(e) => set('', 'numberLength', Number(e.target.value))} sx={{ minWidth: 180 }}>
              {LENGTHS.map((n) => <MenuItem key={n} value={n}>{n} characters</MenuItem>)}
            </TextField>
          </Stack>
        </Stack>
      </CardContent></Card>

      {CHANNELS.map(([type, label]) => {
        const modes = form[type].modes || [];
        const toggle = (mode, on) => set(type, 'modes', on ? [...modes, mode] : modes.filter((m) => m !== mode));
        return (
          <Card key={type} variant="outlined"><CardContent>
            <Stack spacing={2}>
              <Typography variant="h6" component="h2">{label}</Typography>
              <FormControlLabel control={<Switch checked={form[type].enabled} onChange={(e) => set(type, 'enabled', e.target.checked)} />} label={`Allow ${label.toLowerCase()} as a sign-in factor`} />
              <FormGroup aria-label={`${label} ways`}>
                {WAYS.map(([mode, name, help]) => (
                  <FormControlLabel key={mode} control={<Checkbox checked={modes.includes(mode)} onChange={(e) => toggle(mode, e.target.checked)} />}
                    label={<span>{name}<Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>{help}</Typography></span>} />
                ))}
              </FormGroup>
              <FormHelperText>Each way you tick is its own factor, so a policy can allow one and refuse another. Turn on at least one way.</FormHelperText>
            </Stack>
          </CardContent></Card>
        );
      })}
      <Card variant="outlined"><CardContent>
        <Stack spacing={1}>
          <Typography variant="h6" component="h2">Phishing-resistant methods</Typography>
          <Typography variant="body2" color="text.secondary">
            Choose which methods count as phishing resistant. This is what a policy's &ldquo;require a phishing-resistant factor&rdquo; and the risk rules'
            &ldquo;phishing-resistant factors only&rdquo; limit people to, so a method left unticked is refused whenever either applies. A method must also be turned on
            above before anyone can use it. By default only the methods a fake sign-in page cannot relay are ticked.
          </Typography>
          <FormGroup>
            {form.methods.map((m) => (
              <FormControlLabel key={m.id} label={<span>{m.label}{!m.recommended && <Typography component="span" variant="body2" color="text.secondary"> — can be relayed from a fake sign-in page</Typography>}</span>}
                control={<Checkbox checked={form.phishingResistantMethods.includes(m.id)}
                  onChange={(e) => setForm((f) => ({ ...f, phishingResistantMethods: e.target.checked ? [...f.phishingResistantMethods, m.id] : f.phishingResistantMethods.filter((x) => x !== m.id) }))} />} />
            ))}
          </FormGroup>
        </Stack>
      </CardContent></Card>
      <RiskAcknowledgement warnings={warnings} accepted={accepted} onChange={setAccepted} />
      <Button variant="contained" onClick={save} sx={{ alignSelf: 'flex-start' }}>Save</Button>
    </Stack>
  );
}
