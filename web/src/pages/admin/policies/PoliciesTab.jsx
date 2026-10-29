import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Autocomplete, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem,
  Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import PageIntro from '../settings/PageIntro.jsx';
import AddIcon from '@mui/icons-material/Add';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import { factorName } from '../../../factorNames.js';

const BLANK = { id: null, name: '', description: '', subject_type: 'role', subject_id: '', group_ids: [], block_sign_in: false, require_mfa: false, allowed_factors: [], require_phishing_resistant: false, disable_password_recovery: false, password_policy_id: '', risk_medium_action: '', risk_high_action: '', remember_mfa_hours: '' };
const RISK_ACTIONS = { '': 'No extra rule', allow: 'Allow', require_mfa: 'Require a second factor', phishing_resistant: 'Phishing-resistant factors only', webauthn_only: 'Security keys only', block: 'Block' };

function Rules({ policy }) {
  const chips = [];
  if (policy.block_sign_in) chips.push(<Chip key="block" size="small" color="error" label="Sign-in blocked" />);
  if (policy.risk_medium_action || policy.risk_high_action) chips.push(<Chip key="risk" size="small" label={`Risk: ${[policy.risk_medium_action && `medium → ${RISK_ACTIONS[policy.risk_medium_action]}`, policy.risk_high_action && `high → ${RISK_ACTIONS[policy.risk_high_action]}`].filter(Boolean).join(', ')}`} />);
  if (policy.disable_password_recovery) chips.push(<Chip key="norec" size="small" label="No password recovery" />);
  if (policy.require_phishing_resistant) chips.push(<Chip key="pr" size="small" label="Phishing-resistant only" />);
  if (policy.allowed_factors?.length) chips.push(<Chip key="af" size="small" label={`Factors: ${policy.allowed_factors.map((t) => factorName(t)).join(', ')}`} />);
  if (policy.require_mfa) chips.push(<Chip key="mfa" size="small" label="MFA required" />);
  if (policy.remember_mfa_hours != null) chips.push(<Chip key="rem" size="small" label={policy.remember_mfa_hours ? `Remember MFA for ${policy.remember_mfa_hours} h` : 'Ask for MFA every time'} />);
  if (policy.password_policy_name) chips.push(<Chip key="pp" size="small" label={`Password policy: ${policy.password_policy_name}`} />);
  if (policy.global_override?.active?.length) chips.push(<Chip key="ovr" size="small" color="warning" label="Overrides global policy" />);
  if (policy.global_override?.needs_acceptance?.length) chips.push(<Chip key="rev" size="small" color="warning" variant="outlined" label="Weaker than global policy: review" />);
  return chips.length ? <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">{chips}</Stack> : <Typography variant="body2" color="text.secondary">No extra rules</Typography>;
}

// The sign-in rules, shared by a sign-in policy and the global policy. A global policy cannot block sign-in, so it has no block switch.
function RuleFields({ form, set, readOnly, options, showBlock }) {
  return (
    <>
      <FormControlLabel disabled={readOnly} control={<Switch checked={form.require_mfa} onChange={(e) => set('require_mfa', e.target.checked)} />}
        label="Require an authenticator at sign-in (people without one must set it up)" />
      <FormControlLabel disabled={readOnly} control={<Switch checked={form.require_phishing_resistant} onChange={(e) => set('require_phishing_resistant', e.target.checked)} />}
        label="Require a phishing-resistant factor (security keys, and email, SMS or voice in number-matching mode). Implies MFA; people with only weaker factors are refused until an administrator resets them." />
      <TextField label="Remember a second factor for (hours)" type="number" size="small" value={form.remember_mfa_hours} disabled={readOnly}
        onChange={(e) => set('remember_mfa_hours', e.target.value)}
        slotProps={{ htmlInput: { min: 0, max: 720, step: 1 } }}
        helperText="After someone completes a second factor in a browser, that browser skips it for this long. Blank = no rule; 0 = always ask. Not used while Duo is turned on." />
      <FormControlLabel disabled={readOnly} control={<Switch checked={form.disable_password_recovery} onChange={(e) => set('disable_password_recovery', e.target.checked)} />}
        label="Turn off password recovery by personal email for these people" />
      <Typography variant="body2" color="text.secondary">When a sign-in looks risky (Settings → Risk), at least this response applies to these people:</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select size="small" label="Medium risk" value={form.risk_medium_action} disabled={readOnly} onChange={(e) => set('risk_medium_action', e.target.value)} sx={{ minWidth: 260 }}>
          {Object.entries(RISK_ACTIONS).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
        </TextField>
        <TextField select size="small" label="High risk" value={form.risk_high_action} disabled={readOnly} onChange={(e) => set('risk_high_action', e.target.value)} sx={{ minWidth: 260 }}>
          {Object.entries(RISK_ACTIONS).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
        </TextField>
      </Stack>
      <Typography variant="body2" color="text.secondary">Allowed sign-in factors (none ticked = no limit)</Typography>
      <Stack direction="row" flexWrap="wrap" useFlexGap>
        {(options.factor_types || []).map((t) => (
          <FormControlLabel key={t} disabled={readOnly} label={factorName(t)}
            control={<Checkbox checked={form.allowed_factors.includes(t)} onChange={(e) => set('allowed_factors', e.target.checked ? [...form.allowed_factors, t] : form.allowed_factors.filter((x) => x !== t))} />} />
        ))}
      </Stack>
      <TextField select label="Password policy" value={form.password_policy_id ?? ''} disabled={readOnly} onChange={(e) => set('password_policy_id', e.target.value)}
        slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
        helperText="Complexity, restricted words, reuse, breach checks and strength rules. Create them under Policies → Password policies.">
        <MenuItem value="">{options.global_password_set && showBlock ? 'Global policy (inherited)' : 'None'}</MenuItem>
        {(options.password_policies || []).map((pp) => <MenuItem key={pp.id} value={pp.id}>{pp.name}</MenuItem>)}
      </TextField>
      {showBlock && (
        <>
          <FormControlLabel disabled={readOnly} control={<Switch color="error" checked={form.block_sign_in} onChange={(e) => set('block_sign_in', e.target.checked)} />}
            label="Block sign-in" />
          {form.block_sign_in && (
            <Alert severity="warning">
              People covered by this policy can no longer sign in or get single sign-on to applications. Administrators, you, and
              anyone with more access than you cannot be blocked.
            </Alert>
          )}
        </>
      )}
    </>
  );
}

function PolicyDialog({ initial, options, readOnly, global = false, onClose, onSaved }) {
  const notify = useNotify();
  const [form, setForm] = useState({
    ...BLANK, ...initial, remember_mfa_hours: initial.remember_mfa_hours ?? '',
    group_ids: initial.group_ids ?? (initial.subject_type === 'group' && initial.subject_id ? [initial.subject_id] : []),
  });
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [weakens, setWeakens] = useState([]);
  const isNew = global ? !options.global : initial.id === null;
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  // The rules a sign-in policy would weaken against the global policy, checked by the server as the form changes. The global policy
  // may be only password rules (no sign-in rules), so this is asked whatever `options.global` holds.
  const rulesKey = JSON.stringify([form.require_mfa, form.require_phishing_resistant, form.allowed_factors, form.disable_password_recovery,
    form.risk_medium_action, form.risk_high_action, form.remember_mfa_hours, form.password_policy_id]);
  useEffect(() => {
    if (global || readOnly) { setWeakens([]); return undefined; }
    let current = true;
    api('/admin/policies/preview', { method: 'POST', body: form })
      .then((r) => { if (current) setWeakens(r.weakens); })
      .catch(() => { if (current) setWeakens([]); });
    return () => { current = false; };
  }, [rulesKey, global, readOnly]);

  const blocked = weakens.length > 0 && !accepted;

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const body = { ...form, accept_global_override: accepted };
      if (global) await api('/admin/global-policy', { method: 'PUT', body });
      else if (isNew) await api('/admin/policies', { method: 'POST', body });
      else await api(`/admin/policies/${initial.id}`, { method: 'PUT', body });
      notify(global ? 'Global policy saved' : 'Policy saved');
      onSaved();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      if (global) await api('/admin/global-policy', { method: 'DELETE' });
      else await api(`/admin/policies/${initial.id}`, { method: 'DELETE' });
      notify(global ? 'Global policy removed' : 'Policy deleted');
      onSaved();
    } catch (err) {
      setConfirmDelete(false);
      setErrors(err.data?.errors || [err.message]);
    }
  }

  const title = global ? 'Global policy' : isNew ? 'New policy' : readOnly ? initial.name : 'Edit policy';
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <form onSubmit={save}>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
            {!global && <TextField label="Name" required value={form.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} />}
            <TextField label="Description" value={form.description} onChange={(e) => set('description', e.target.value)} disabled={readOnly} />

            {global ? (
              <Typography variant="body2" color="text.secondary">
                Applies to every account. A sign-in policy can be less strict than this on one rule only when an administrator accepts that it reduces security.
              </Typography>
            ) : (
              <Stack spacing={1.5}>
                <Typography variant="subtitle2">Applies to</Typography>
                <ToggleButtonGroup exclusive size="small" value={form.subject_type} disabled={readOnly} aria-label="Applies to"
                  onChange={(_, v) => { if (v) setForm((f) => ({ ...f, subject_type: v, subject_id: '', group_ids: [] })); }}>
                  <ToggleButton value="role">A role</ToggleButton>
                  <ToggleButton value="group">Groups</ToggleButton>
                </ToggleButtonGroup>
                {form.subject_type === 'role' ? (
                  <TextField select required label="Role" value={form.subject_id} disabled={readOnly} onChange={(e) => set('subject_id', e.target.value)}>
                    {options.roles.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
                  </TextField>
                ) : (
                  <Autocomplete multiple disabled={readOnly} options={options.groups} value={options.groups.filter((g) => form.group_ids.includes(g.id))}
                    getOptionLabel={(g) => g.name} isOptionEqualToValue={(a, b) => a.id === b.id}
                    onChange={(_, v) => set('group_ids', v.map((g) => g.id))}
                    renderInput={(params) => <TextField {...params} label="Groups" required={!form.group_ids.length}
                      helperText="Everyone in any of these groups, including through nested groups, is covered." />} />
                )}
              </Stack>
            )}

            <Stack spacing={1}>
              <Typography variant="subtitle2">Rules</Typography>
              <RuleFields form={form} set={set} readOnly={readOnly} options={options} showBlock={!global} />
            </Stack>

            {blocked && (
              <Alert severity="warning">
                This policy is less secure than the global policy: {weakens.map((k) => options.override_rules[k]).join('; ')}.
                It would lower security for the people it covers. Accept that to save it.
                <FormControlLabel sx={{ display: 'flex', mt: 1 }} control={<Checkbox checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />}
                  label="I accept that this policy reduces security below the global policy for the people it covers" />
              </Alert>
            )}
            {!blocked && weakens.length > 0 && (
              <Typography variant="body2" color="text.secondary">Accepted: this policy overrides the global policy for {weakens.map((k) => options.override_rules[k]).join('; ')}.</Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {global
                ? 'Every account is held to these rules. When a sign-in policy overrides one, the stricter value here applies again if this rule changes.'
                : 'When someone is covered by several policies, the strictest value of each rule applies, except where an accepted override applies.'}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          {!isNew && !readOnly && <Button color="error" onClick={() => setConfirmDelete(true)} sx={{ mr: 'auto' }}>{global ? 'Remove' : 'Delete'}</Button>}
          <Button onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button type="submit" variant="contained" disabled={saving || blocked}>Save</Button>}
        </DialogActions>
      </form>
      <ConfirmDialog open={confirmDelete}
        title={global ? 'Remove the global policy?' : 'Delete policy?'}
        message={global ? 'Its rules stop applying to every account at once.' : `"${initial.name}" will stop applying immediately.`}
        confirmLabel={global ? 'Remove' : 'Delete'} onConfirm={remove} onClose={() => setConfirmDelete(false)} />
    </Dialog>
  );
}

export default function PoliciesTab() {
  const can = useCan();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editingGlobal, setEditingGlobal] = useState(false);
  const readOnly = !can('policies.manage');

  const load = useCallback(() => api('/admin/policies').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;

  return (
    <Stack spacing={2}>
      <PageIntro title="Policies">
        Policies set sign-in and password rules for everyone holding a role or belonging to a group. Where several apply to a person, the strictest wins.
      </PageIntro>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
            <Typography variant="subtitle2">Global policy</Typography>
            {!readOnly && <Button onClick={() => setEditingGlobal(true)}>{data.global ? 'Edit global policy' : 'Set a global policy'}</Button>}
          </Stack>
          {data.global ? <Rules policy={data.global} /> : <Typography variant="body2" color="text.secondary">None. Each policy below stands alone.</Typography>}
          <Typography variant="body2" color="text.secondary">
            Applies to every account. A policy below can be less strict than this on a rule only when an administrator accepts that it reduces security.
          </Typography>
        </Stack>
      </Paper>
      {!readOnly && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({ ...BLANK })} sx={{ alignSelf: 'flex-start' }}>New policy</Button>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow><TableCell>Policy</TableCell><TableCell>Applies to</TableCell><TableCell>Rules</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {data.policies.map((p) => (
              <TableRow key={p.id} hover sx={{ cursor: 'pointer' }} onClick={() => setEditing(p)}>
                <TableCell>
                  <Typography fontWeight={500}>{p.name}</Typography>
                  {p.description && <Typography variant="body2" color="text.secondary">{p.description}</Typography>}
                </TableCell>
                <TableCell>{p.subject_type === 'role' ? 'Role' : (p.group_ids?.length || 0) > 1 ? 'Groups' : 'Group'}: {p.subject_name}</TableCell>
                <TableCell><Rules policy={p} /></TableCell>
              </TableRow>
            ))}
            {!data.policies.length && (
              <TableRow><TableCell colSpan={3}><Typography color="text.secondary">No policies yet.</Typography></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {editingGlobal && (
        <PolicyDialog global initial={data.global ?? BLANK} options={data} readOnly={readOnly} onClose={() => setEditingGlobal(false)}
          onSaved={() => { setEditingGlobal(false); load(); }} />
      )}
      {editing && (
        <PolicyDialog initial={editing} options={data} readOnly={readOnly} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </Stack>
  );
}
