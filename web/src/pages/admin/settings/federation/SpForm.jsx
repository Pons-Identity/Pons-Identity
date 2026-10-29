import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import { api } from '../../../../api/client.js';
import { useNotify } from '../../../../components/Notify.jsx';
import ReadOnlyField from '../../../../components/ReadOnlyField.jsx';
import KeyRollover from './KeyRollover.jsx';

const POLICIES = [
  { value: 'approve', label: 'Hold first-time sign-ins until an administrator approves them' },
  { value: 'auto', label: 'Create an account automatically on first sign-in' },
];

// Letting people from other institutions sign in here: this server acting as a service provider.
export default function SpForm({ canManage, onChanged = () => {} }) {
  const notify = useNotify();
  const [view, setView] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  const apply = (v) => { setView(v); setCfg({ ...v.config, idpAllowlist: v.config.idpAllowlist.join('\n') }); };
  useEffect(() => { api('/admin/federation/sp').then(apply).catch((e) => setErrors([e.message])); }, []);
  if (!cfg) return errors.length ? <Alert severity="error">{errors.join(' ')}</Alert> : null;

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const ro = !canManage;

  async function save(e) {
    e.preventDefault();
    setErrors([]);
    setSaving(true);
    try {
      apply(await api('/admin/federation/sp', { method: 'PUT', body: cfg }));
      onChanged();
      notify('Sign-in from other institutions saved');
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card variant="outlined" component="section" aria-labelledby="fed-sp">
      <CardContent>
        <Stack component="form" spacing={2} onSubmit={save} aria-label="Sign in from other institutions">
          <Typography variant="h6" component="h2" id="fed-sp">Sign in from other institutions</Typography>
          <Typography variant="body2" color="text.secondary">
            People from institutions in the federation can sign in here with their own institution's account. They are never
            matched to existing accounts by email address; an administrator links or approves them.
          </Typography>
          {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
          <FormControlLabel label="Offer “Sign in with your institution”"
            control={<Switch checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={ro} />} />
          <TextField fullWidth label="Service provider entity ID" value={cfg.entityId} disabled={ro} placeholder={view.defaultEntityId}
            onChange={(e) => set({ entityId: e.target.value })} helperText="Leave empty to use the default. Changing it after registering means re-registering." />
          <TextField select fullWidth label="New people" value={cfg.provisioning} disabled={ro} onChange={(e) => set({ provisioning: e.target.value })}>
            {POLICIES.map((p) => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
          </TextField>
          {cfg.provisioning === 'auto' && !cfg.idpAllowlist.trim() && (
            <Alert severity="warning">
              With no allow list, anyone at any institution in the federation can create an account here. Limit the institutions below,
              or hold first-time sign-ins for approval.
            </Alert>
          )}
          <TextField fullWidth multiline minRows={3} label="Allowed institutions (optional)" value={cfg.idpAllowlist} disabled={ro}
            onChange={(e) => set({ idpAllowlist: e.target.value })}
            helperText="One identity provider entity ID per line. Leave empty to allow every institution in the imported metadata." />
          <FormControlLabel label="Sign authentication requests"
            control={<Switch checked={cfg.signRequests} onChange={(e) => set({ signRequests: e.target.checked })} disabled={ro} />} />
          <KeyRollover kind="sp" keys={view.keys} canManage={canManage}
            onKeys={(keys) => { setView((v) => ({ ...v, keys })); onChanged(); }} />
          <ReadOnlyField label="Service provider metadata URL" value={view.urls.metadata} />
          <ReadOnlyField label="Assertion consumer service URL" value={view.urls.acs} />
          <Typography variant="body2" color="text.secondary">
            Register the metadata with your federation as a service provider. Institutions release attributes to it according to
            their own policies, so what people receive varies. The organization and technical contact come from Federation identity above.
          </Typography>
          {canManage && <Button type="submit" variant="contained" disabled={saving} sx={{ alignSelf: 'flex-start' }}>Save</Button>}
        </Stack>
      </CardContent>
    </Card>
  );
}
