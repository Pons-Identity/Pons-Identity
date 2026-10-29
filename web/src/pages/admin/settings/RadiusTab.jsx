import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, FormControlLabel, IconButton, MenuItem, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';
import MultiCombobox from '../../../components/MultiCombobox.jsx';

const BLANK_CLIENT = { name: '', address: '', secret: '', enabled: true, requireMessageAuthenticator: true, mfaMode: 'challenge', groups: [], attributes: [] };

// A random shared secret: 24 characters from a set that is easy to type into a device.
function generateSecret() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function ClientCard({ client, index, groups, replyAttributes, minSecret, onChange, onRemove }) {
  const set = (key, value) => onChange({ ...client, [key]: value });
  const setAttribute = (i, patch) => set('attributes', client.attributes.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const label = client.name || `Client ${index + 1}`;
  return (
    <Card variant="outlined" component="section" aria-label={label}>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="subtitle1" component="h3">{label}</Typography>
            <Tooltip title="Remove this client"><IconButton aria-label={`Remove ${label}`} onClick={onRemove}><DeleteOutlineIcon /></IconButton></Tooltip>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Name" required value={client.name} onChange={(e) => set('name', e.target.value)} sx={{ flex: 1 }} helperText="For example: Office VPN or Building 3 switches." />
            <TextField label="Address" required value={client.address} onChange={(e) => set('address', e.target.value)} sx={{ flex: 1 }}
              placeholder="10.0.0.5 or 10.0.0.0/24" helperText="Where its requests come from: one address, or a range." />
          </Stack>
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField label="Shared secret" type="text" autoComplete="off" value={client.secret} onChange={(e) => set('secret', e.target.value)} sx={{ flex: 1 }}
              placeholder={client.secret_set ? 'Saved. Leave blank to keep it.' : ''}
              helperText={`At least ${minSecret} characters, and the same on the device. It is never shown again once saved.`}
              slotProps={{ input: { sx: { fontFamily: 'monospace' } } }} />
            <Button onClick={() => set('secret', generateSecret())} sx={{ mt: 1 }}>Generate</Button>
          </Stack>
          <FormControlLabel label="Turned on" control={<Switch checked={client.enabled} onChange={(e) => set('enabled', e.target.checked)} />} />
          <FormControlLabel label="Require the device to sign its requests (Message-Authenticator)" control={<Switch checked={client.requireMessageAuthenticator} onChange={(e) => set('requireMessageAuthenticator', e.target.checked)} />} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
            Recommended. Unsigned requests can be forged by anyone on the network path (the &ldquo;BlastRADIUS&rdquo; attack). Turn it off only for a device that cannot send one.
          </Typography>
          <TextField select label="When a person has a second factor" value={client.mfaMode} onChange={(e) => set('mfaMode', e.target.value)} sx={{ maxWidth: 560 }}
            helperText="Only authenticator-app codes can be used here; other factors need a web page.">
            <MenuItem value="challenge">Ask for the code after the password (the device shows our prompt)</MenuItem>
            <MenuItem value="append">The person types the code right after the password (secret123456)</MenuItem>
          </TextField>
          <MultiCombobox label="Who may sign in through this client" placeholder="Everyone, or search groups" options={groups.map((g) => ({ id: g.id, label: g.name }))}
            value={client.groups} onChange={(ids) => set('groups', ids)} helperText="Leave empty to allow everyone. Otherwise only members of these groups, including through nested groups." />

          <Typography variant="subtitle2" component="h4">Attributes sent with an acceptance</Typography>
          {client.attributes.length === 0 && <Typography variant="body2" color="text.secondary">None. For example, send a VLAN so a switch puts people in the right network.</Typography>}
          {client.attributes.map((a, i) => (
            <Stack key={i} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }} role="group" aria-label={`Attribute ${i + 1}`}>
              <TextField select size="small" label="Attribute" value={a.attribute} onChange={(e) => setAttribute(i, { attribute: e.target.value })} sx={{ minWidth: 180 }}>
                {Object.keys(replyAttributes).map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
              </TextField>
              <TextField size="small" label="Value" value={a.value} onChange={(e) => setAttribute(i, { value: e.target.value })} sx={{ flex: 1 }} helperText={replyAttributes[a.attribute]?.help} />
              <TextField select size="small" label="Only for" value={a.group_id || ''} onChange={(e) => setAttribute(i, { group_id: e.target.value || null })} sx={{ minWidth: 200 }}>
                <MenuItem value="">Everyone</MenuItem>
                {groups.map((g) => <MenuItem key={g.id} value={g.id}>Members of {g.name}</MenuItem>)}
              </TextField>
              <IconButton aria-label={`Remove attribute ${i + 1}`} onClick={() => set('attributes', client.attributes.filter((_, j) => j !== i))}><DeleteOutlineIcon /></IconButton>
            </Stack>
          ))}
          <Button size="small" startIcon={<AddIcon />} sx={{ alignSelf: 'flex-start' }}
            onClick={() => set('attributes', [...client.attributes, { attribute: 'VLAN', value: '', group_id: null }])}>Add an attribute</Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

// This server as a RADIUS identity server: whether it listens, and the network devices that may ask it to sign people in.
export default function RadiusTab() {
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [groups, setGroups] = useState([]);
  const [errors, setErrors] = useState([]);

  useEffect(() => {
    Promise.all([api('/admin/settings/radius'), api('/admin/options')])
      .then(([r, o]) => { setForm(r); setGroups(o.groups); })
      .catch((e) => setErrors([e.message]));
  }, []);
  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setClient = (i, client) => setForm((f) => ({ ...f, clients: f.clients.map((c, j) => (j === i ? client : c)) }));

  async function save() {
    setErrors([]);
    try {
      setForm(await api('/admin/settings/radius', { method: 'PUT', body: { ...form, port: Number(form.port) } }));
      notify('RADIUS settings saved');
    } catch (e) {
      setErrors(e.data?.errors || [e.message]);
    }
  }

  const { status } = form;
  return (
    <Stack spacing={3}>
      <PageIntro title="RADIUS">
        Let network devices such as VPN gateways, switches, wireless controllers and SSH hosts sign people in with their account here. This server answers
        RADIUS requests over UDP as the identity server. People use the same password, directory and second-factor rules as on the sign-in page.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      {form.enabled && status.error && <Alert severity="error">{status.error}</Alert>}

      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="h6" component="h3">Server</Typography>
            {status.listening ? <Chip size="small" color="success" label={`Listening on ${status.address}:${status.port}`} /> : <Chip size="small" label="Not listening" />}
          </Stack>
          <FormControlLabel label="Answer RADIUS requests" control={<Switch checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="UDP port" type="number" value={form.port} onChange={(e) => set('port', e.target.value)} slotProps={{ htmlInput: { min: 1, max: 65535 } }} helperText="RADIUS normally uses 1812." />
            <TextField label="Listen on address" value={form.bindAddress} onChange={(e) => set('bindAddress', e.target.value)} helperText="0.0.0.0 listens on every IPv4 address." />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Supported: PAP (the password the device sends is encrypted with the shared secret) with an authenticator-app code as the second step. Methods that need the plain or
            NT-hashed password, such as CHAP, MS-CHAPv2 and EAP, are refused because only one-way password hashes are stored. Risk-based sign-in rules are not applied, since the
            address seen here is the device&apos;s, not the person&apos;s. Open the port in your firewall for the devices listed below only.
          </Typography>
          {status.counters && (
            <Typography variant="body2" color="text.secondary">
              Since the server started: {status.counters.accepted.toLocaleString()} accepted, {status.counters.rejected.toLocaleString()} rejected,
              {' '}{status.counters.challenged.toLocaleString()} code prompts, {status.counters.dropped.toLocaleString()} ignored (unknown device or bad signature).
              Each sign-in is in the Sign-in log, with the device that asked.
            </Typography>
          )}
        </Stack>
      </CardContent></Card>

      <Typography variant="h6" component="h3">Clients (network devices)</Typography>
      {form.clients.length === 0 && <Typography color="text.secondary">No clients yet. A device that is not listed is ignored.</Typography>}
      {form.clients.map((c, i) => (
        <ClientCard key={c.id || `new-${i}`} client={c} index={i} groups={groups} replyAttributes={form.replyAttributes} minSecret={form.minSecret}
          onChange={(client) => setClient(i, client)} onRemove={() => setForm((f) => ({ ...f, clients: f.clients.filter((_, j) => j !== i) }))} />
      ))}
      <Stack direction="row" spacing={1}>
        <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setForm((f) => ({ ...f, clients: [...f.clients, { ...BLANK_CLIENT }] }))}>Add a client</Button>
        <Button variant="contained" onClick={save}>Save</Button>
      </Stack>
    </Stack>
  );
}
