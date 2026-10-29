import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Button, Card, CardContent, Checkbox, Chip, FormControlLabel, InputAdornment, MenuItem, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';
import MultiCombobox from '../../../components/MultiCombobox.jsx';

const ACTIONS = { allow: 'Allow', require_mfa: 'Require a second factor', phishing_resistant: 'Phishing-resistant factors only', webauthn_only: 'Security keys only', block: 'Block' };
const MODES = { off: 'Off: do nothing', report: 'Report only: score and log, change nothing', enforce: 'Enforce: apply the actions below' };
const SIGNALS = {
  spray: ['Password spraying', 'Many accounts failing from one address or network, or one account failing from many addresses, in a short time.', [['ipUsernames', 'Accounts per address'], ['asnUsernames', 'Accounts per network'], ['accountIps', 'Addresses per account']]],
  impossible_travel: ['Impossible travel', 'The last sign-in was too far away to have reached this one in the time between them.', [['maxSpeedKmh', 'Fastest plausible (km/h)'], ['minDistanceKm', 'Ignore trips under (km)']]],
  new_device: ['Unrecognized device', 'This browser has not signed in to this account before.', []],
  new_country: ['New country', 'The account has not signed in from this country before.', []],
  country_mismatch: ['Country mismatch', "The sign-in country differs from the country on the person's profile.", []],
  new_asn: ['New network', 'The account has not signed in from this network (ASN) before.', []],
  device_geo: ['Device location', "The browser's own location is far from the address's. Asks the person's browser for permission; can only add risk.", [['maxDistanceKm', 'Allowed difference (km)']]],
  sensitive_group: ['Sensitive groups', 'Anyone in one of the chosen groups, such as the C-suite or people often targeted by phishing.', []],
};
const lvlColor = { low: 'default', medium: 'warning', high: 'error' };
// Example sign-ins for Try it. They assume the person's last sign-in was from New York, on a browser they have used before.
const PREBUILTS = [
  { name: 'Usual sign-in', values: { ip: '203.0.113.1', country: 'US', lat: '40.71', lon: '-74.0', asn: '7922', new_device: false } },
  { name: 'New browser, new network', values: { ip: '203.0.113.20', country: 'US', lat: '40.71', lon: '-74.0', asn: '701', new_device: true } },
  { name: 'Abroad, new browser', values: { ip: '198.51.100.9', country: 'GB', lat: '51.5', lon: '-0.12', asn: '2856', new_device: true } },
];

export default function RiskTab() {
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState([]);
  const [sim, setSim] = useState({ username: '', ip: '', country: '', lat: '', lon: '', asn: '', new_device: true });
  const [simResult, setSimResult] = useState(null);
  const [geoStatus, setGeoStatus] = useState(null);
  const [groupOptions, setGroupOptions] = useState([]);

  useEffect(() => { api('/admin/settings/risk').then(setForm).catch((e) => setErrors([e.message])); }, []);
  // The groups to choose from. Someone without permission to view groups still gets the rest of the page.
  useEffect(() => {
    api('/admin/groups').then((list) => { if (Array.isArray(list)) setGroupOptions(list.map((g) => ({ id: g.id, label: g.name, secondary: g.description }))); }).catch(() => { /* no list: the chosen groups show as none */ });
  }, []);
  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setSignal = (sig, k, v) => setForm((f) => ({ ...f, signals: { ...f.signals, [sig]: { ...f.signals[sig], [k]: v } } }));

  async function save() {
    setErrors([]);
    try {
      const r = await api('/admin/settings/risk', { method: 'PUT', body: form });
      setForm(r); setGeoStatus(r.geoip_status);
      notify('Risk settings saved');
    } catch (e) { setErrors(e.data?.errors || [e.message]); }
  }

  // Uploads one database and puts its status into the form, leaving any other unsaved edits on the page as they are.
  async function uploadGeoip(kind, e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErrors([]);
    try {
      const r = await api(`/admin/settings/risk/geoip/${kind}`, { method: 'PUT', body: file });
      set('geoip', r.geoip);
      setGeoStatus(r.geoip_status);
      notify(`${file.name} uploaded`);
    } catch (err) { setErrors(err.data?.errors || [err.message]); }
  }

  async function score(s) {
    setErrors([]);
    try {
      // The AS prefix is shown in the field, but someone who types it anyway still gets the number.
      const geo = Object.fromEntries(['country', 'lat', 'lon', 'asn'].filter((k) => s[k] !== '').map((k) => [k, k === 'asn' ? s[k].replace(/^\s*as/i, '').trim() : s[k]]));
      setSimResult(await api('/admin/settings/risk/simulate', { method: 'POST', body: { username: s.username, ip: s.ip, geo, new_device: s.new_device } }));
    } catch (err) { setErrors(err.data?.errors || [err.message]); setSimResult(null); }
  }

  function simulate(e) {
    e.preventDefault();
    score(sim);
  }

  // Fills the sign-in details from an example and, if a username is entered, scores it straight away. The username is never changed.
  function prebuilt(p) {
    const next = { ...sim, ...p.values };
    setSim(next);
    if (next.username.trim()) score(next);
    else setSimResult(null);
  }

  const g = form.geoip;
  return (
    <Stack spacing={3}>
      <PageIntro title="Risk-based authentication">
        After the password is right, each sign-in is scored from the account&apos;s own history in the sign-in log. Signals add their weight; the total
        decides whether the sign-in is low, medium or high risk, and each level can lead to an action. Policies can make an action stricter for a role or
        group. Administrators are never locked out by a score: for them a block becomes security-keys-only, and that steps aside if they have none.
        Start in report-only mode, read the Sign-ins page, then enforce.
      </PageIntro>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}

      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <TextField select label="Mode" value={form.mode} onChange={(e) => set('mode', e.target.value)} sx={{ maxWidth: 520 }}>
            {Object.entries(MODES).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </TextField>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField type="number" label="Medium risk from score" value={form.medium} onChange={(e) => set('medium', e.target.value)} />
            <TextField select label="At medium risk" value={form.actions.medium} onChange={(e) => set('actions', { ...form.actions, medium: e.target.value })} sx={{ minWidth: 280 }}>
              {Object.entries(ACTIONS).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
            </TextField>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField type="number" label="High risk from score" value={form.high} onChange={(e) => set('high', e.target.value)} />
            <TextField select label="At high risk" value={form.actions.high} onChange={(e) => set('actions', { ...form.actions, high: e.target.value })} sx={{ minWidth: 280 }}>
              {Object.entries(ACTIONS).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
            </TextField>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            &ldquo;Phishing-resistant factors only&rdquo; allows the methods ticked under <RouterLink to="/admin/settings/factors">Sign-in factors &rarr; Phishing-resistant methods</RouterLink>.
          </Typography>
          <Alert severity="info">A risky sign-in is never allowed to set up a new method (a thief with the password would): if the action needs a factor the person does not have, the sign-in is refused and they contact an administrator.</Alert>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField type="number" label="Spray window (minutes)" value={form.windowMinutes} onChange={(e) => set('windowMinutes', e.target.value)} />
            <TextField type="number" label="History used (days)" value={form.historyDays} onChange={(e) => set('historyDays', e.target.value)} />
          </Stack>
        </Stack>
      </CardContent></Card>

      <Card variant="outlined"><CardContent>
        <Typography variant="h6" component="h2" gutterBottom>Signals</Typography>
        <Table size="small" aria-label="Risk signals">
          <TableHead><TableRow><TableCell>On</TableCell><TableCell>Signal</TableCell><TableCell>Weight</TableCell><TableCell>Settings</TableCell></TableRow></TableHead>
          <TableBody>
            {Object.entries(SIGNALS).map(([sig, [name, help, extras]]) => (
              <TableRow key={sig}>
                <TableCell><Checkbox checked={form.signals[sig].enabled} onChange={(e) => setSignal(sig, 'enabled', e.target.checked)} slotProps={{ input: { 'aria-label': `Use ${name}` } }} /></TableCell>
                <TableCell><Typography>{name}</Typography><Typography variant="caption" color="text.secondary">{help}</Typography></TableCell>
                <TableCell><TextField size="small" type="number" value={form.signals[sig].weight} onChange={(e) => setSignal(sig, 'weight', e.target.value)} sx={{ width: 90 }} slotProps={{ htmlInput: { 'aria-label': `${name} weight` } }} /></TableCell>
                <TableCell>
                  {sig === 'sensitive_group' ? (
                    <Stack sx={{ minWidth: 320 }}>
                      <MultiCombobox label="Groups" options={groupOptions} value={form.signals[sig].groups} onChange={(ids) => setSignal(sig, 'groups', ids)} placeholder="Search groups…" noOptionsText="No groups to choose from." />
                    </Stack>
                  ) : (
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {extras.map(([k, label]) => <TextField key={k} size="small" type="number" label={label} value={form.signals[sig][k]} onChange={(e) => setSignal(sig, k, e.target.value)} sx={{ width: 180 }} />)}
                    </Stack>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>

      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">IP geolocation</Typography>
          <Typography variant="body2" color="text.secondary">
            Place and network come from MaxMind GeoLite2 database files on this server; nothing is sent anywhere. Download <code>GeoLite2-City.mmdb</code> and
            <code> GeoLite2-ASN.mmdb</code> (free, with a MaxMind account) and upload them here. To update, upload again. A file kept elsewhere on the server can
            be used instead by giving its path. Without them the signals that need a place stay quiet and the log shows addresses only.
          </Typography>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
            <Button variant="outlined" component="label">
              Upload City database
              <input type="file" hidden accept=".mmdb" aria-label="City database file" onChange={(e) => uploadGeoip('city', e)} />
            </Button>
            <Button variant="outlined" component="label">
              Upload ASN database
              <input type="file" hidden accept=".mmdb" aria-label="ASN database file" onChange={(e) => uploadGeoip('asn', e)} />
            </Button>
          </Stack>
          <TextField label="City database path" value={g.cityPath} onChange={(e) => set('geoip', { ...g, cityPath: e.target.value })} helperText={geoStatus?.city || (g.city ? `${g.city.type}, built ${g.city.built}` : 'Not loaded')} />
          <TextField label="ASN database path" value={g.asnPath} onChange={(e) => set('geoip', { ...g, asnPath: e.target.value })} helperText={geoStatus?.asn || (g.asn ? `${g.asn.type}, built ${g.asn.built}` : 'Not loaded')} />
        </Stack>
      </CardContent></Card>

      <Button variant="contained" onClick={save} sx={{ alignSelf: 'flex-start' }}>Save</Button>

      <Card variant="outlined"><CardContent>
        <Stack spacing={2} component="form" onSubmit={simulate}>
          <Typography variant="h6" component="h2">Try it</Typography>
          <Typography variant="body2" color="text.secondary">See how a sign-in by a real person would be scored with the saved settings. Nothing is recorded or changed.</Typography>
          <Stack direction="row" flexWrap="wrap" gap={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">Examples:</Typography>
            {PREBUILTS.map((p) => <Chip key={p.name} label={p.name} variant="outlined" onClick={() => prebuilt(p)} />)}
          </Stack>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            <TextField size="small" label="Username" required value={sim.username} onChange={(e) => setSim({ ...sim, username: e.target.value })} />
            <TextField size="small" label="From address" value={sim.ip} onChange={(e) => setSim({ ...sim, ip: e.target.value })} />
            <TextField size="small" label="Country code" value={sim.country} onChange={(e) => setSim({ ...sim, country: e.target.value })} sx={{ width: 120 }} />
            <TextField size="small" label="Latitude" value={sim.lat} onChange={(e) => setSim({ ...sim, lat: e.target.value })} sx={{ width: 110 }} />
            <TextField size="small" label="Longitude" value={sim.lon} onChange={(e) => setSim({ ...sim, lon: e.target.value })} sx={{ width: 110 }} />
            <TextField size="small" label="AS number" value={sim.asn} onChange={(e) => setSim({ ...sim, asn: e.target.value })} sx={{ width: 150 }} slotProps={{ input: { startAdornment: <InputAdornment position="start">AS</InputAdornment> } }} />
            <FormControlLabel control={<Checkbox checked={sim.new_device} onChange={(e) => setSim({ ...sim, new_device: e.target.checked })} />} label="From a new browser" />
            <Button type="submit" variant="outlined">Score it</Button>
          </Stack>
          {simResult && (
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center"><Chip color={lvlColor[simResult.level]} label={`${simResult.level} (${simResult.score})`} /><Typography>Action: {ACTIONS[simResult.action]}{simResult.mode !== 'enforce' ? ` (not applied: mode is ${simResult.mode})` : ''}</Typography></Stack>
              {simResult.reasons.length === 0 && <Typography color="text.secondary">No signals fired.</Typography>}
              {simResult.reasons.map((r) => <Typography key={r.code} variant="body2">• {r.detail} (+{r.weight})</Typography>)}
            </Stack>
          )}
        </Stack>
      </CardContent></Card>
    </Stack>
  );
}
