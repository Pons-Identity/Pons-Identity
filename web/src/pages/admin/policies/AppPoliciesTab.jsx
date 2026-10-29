import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Autocomplete, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import PageIntro from '../settings/PageIntro.jsx';
import AddIcon from '@mui/icons-material/Add';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import { factorName } from '../../../factorNames.js';

const BLANK = { id: null, name: '', description: '', require_mfa: true, require_phishing_resistant: false, allowed_factors: [], apps: [], service_providers: [] };

function Rules({ policy }) {
  const chips = [];
  if (policy.require_phishing_resistant) chips.push(<Chip key="pr" size="small" label="Phishing-resistant factor" />);
  else if (policy.require_mfa) chips.push(<Chip key="mfa" size="small" label="Second factor required" />);
  if (policy.allowed_factors?.length) chips.push(<Chip key="af" size="small" label={`Only: ${policy.allowed_factors.map((t) => factorName(t)).join(', ')}`} />);
  return chips.length ? <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">{chips}</Stack> : <Typography variant="body2" color="text.secondary">Nothing beyond sign-in</Typography>;
}

function AppPolicyDialog({ initial, options, readOnly, onClose, onSaved }) {
  const notify = useNotify();
  const [form, setForm] = useState({ ...BLANK, ...initial });
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isNew = initial.id === null;
  const targets = [...options.apps.map((a) => ({ ...a, kind: 'app' })), ...options.service_providers.map((s) => ({ ...s, kind: 'sp' }))];
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      if (isNew) await api('/admin/app-policies', { method: 'POST', body: form });
      else await api(`/admin/app-policies/${initial.id}`, { method: 'PUT', body: form });
      notify('Application policy saved');
      onSaved();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/admin/app-policies/${initial.id}`, { method: 'DELETE' });
      notify('Application policy deleted');
      onSaved();
    } catch (err) {
      setConfirmDelete(false);
      setErrors(err.data?.errors || [err.message]);
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <form onSubmit={save}>
        <DialogTitle>{isNew ? 'New application policy' : readOnly ? initial.name : 'Edit application policy'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
            <TextField label="Name" required value={form.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} />
            <TextField label="Description" value={form.description} onChange={(e) => set('description', e.target.value)} disabled={readOnly} />

            <Autocomplete multiple disabled={readOnly} options={targets} value={targets.filter((t) => (t.kind === 'app' ? form.apps : form.service_providers).includes(t.id))}
              groupBy={(t) => (t.kind === 'app' ? 'Applications' : 'SAML service providers')} getOptionLabel={(t) => t.name}
              isOptionEqualToValue={(a, b) => a.kind === b.kind && a.id === b.id}
              onChange={(_, v) => setForm((f) => ({ ...f, apps: v.filter((t) => t.kind === 'app').map((t) => t.id), service_providers: v.filter((t) => t.kind === 'sp').map((t) => t.id) }))}
              renderInput={(params) => <TextField {...params} label="Applications"
                helperText="Single sign-on applications (OpenID Connect, OAuth 2.0 and CAS) and SAML service providers." />} />

            <Stack spacing={1}>
              <Typography variant="subtitle2">Requires</Typography>
              <FormControlLabel disabled={readOnly} control={<Switch checked={form.require_mfa} onChange={(e) => set('require_mfa', e.target.checked)} />}
                label="A second factor" />
              <FormControlLabel disabled={readOnly} control={<Switch checked={form.require_phishing_resistant} onChange={(e) => set('require_phishing_resistant', e.target.checked)} />}
                label="A phishing-resistant factor (security keys, and email, SMS or voice in number-matching mode)" />
              <Typography variant="body2" color="text.secondary">Or only these factors (none ticked = any factor that meets the rules above)</Typography>
              <Stack direction="row" flexWrap="wrap" useFlexGap>
                {(options.factor_types || []).map((t) => (
                  <FormControlLabel key={t} disabled={readOnly} label={factorName(t)}
                    control={<Checkbox checked={form.allowed_factors.includes(t)} onChange={(e) => set('allowed_factors', e.target.checked ? [...form.allowed_factors, t] : form.allowed_factors.filter((x) => x !== t))} />} />
                ))}
              </Stack>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              A person whose current sign-in does not meet this is asked for a factor that does. A person with no such factor is refused.
              When several application policies cover one application, the strictest of each rule applies.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          {!isNew && !readOnly && <Button color="error" onClick={() => setConfirmDelete(true)} sx={{ mr: 'auto' }}>Delete</Button>}
          <Button onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button type="submit" variant="contained" disabled={saving}>Save</Button>}
        </DialogActions>
      </form>
      <ConfirmDialog open={confirmDelete} title="Delete application policy?" message={`"${initial.name}" will stop applying immediately.`}
        confirmLabel="Delete" onConfirm={remove} onClose={() => setConfirmDelete(false)} />
    </Dialog>
  );
}

export default function AppPoliciesTab() {
  const can = useCan();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const readOnly = !can('policies.manage');

  const load = useCallback(() => api('/admin/app-policies').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;
  const appName = (id) => data.apps.find((a) => a.id === id)?.name || id;
  const spName = (id) => data.service_providers.find((s) => s.id === id)?.name || id;

  return (
    <Stack spacing={2}>
      <PageIntro title="Application policies">
        Set what sign-in an application needs before it gives someone a sign-in: a second factor, a phishing-resistant factor, or only certain factors.
        People who signed in with less are asked for the right factor first.
      </PageIntro>
      {!readOnly && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({ ...BLANK })} sx={{ alignSelf: 'flex-start' }}>New application policy</Button>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow><TableCell>Policy</TableCell><TableCell>Applications</TableCell><TableCell>Requires</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {data.policies.map((p) => (
              <TableRow key={p.id} hover sx={{ cursor: 'pointer' }} onClick={() => setEditing(p)}>
                <TableCell>
                  <Typography fontWeight={500}>{p.name}</Typography>
                  {p.description && <Typography variant="body2" color="text.secondary">{p.description}</Typography>}
                </TableCell>
                <TableCell>
                  {[...p.apps.map(appName), ...p.service_providers.map(spName)].join(', ') || '—'}
                </TableCell>
                <TableCell><Rules policy={p} /></TableCell>
              </TableRow>
            ))}
            {!data.policies.length && (
              <TableRow><TableCell colSpan={3}><Typography color="text.secondary">No application policies yet.</Typography></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {editing && (
        <AppPolicyDialog initial={editing} options={data} readOnly={readOnly} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </Stack>
  );
}
