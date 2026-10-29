import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Paper, Radio, RadioGroup, Stack, Switch,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import PageIntro from '../settings/PageIntro.jsx';
import AddIcon from '@mui/icons-material/Add';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';

const BLANK = {
  id: null, name: '', description: '', min_length: '', require_lowercase: false, require_uppercase: false, require_digit: false, require_symbol: false,
  min_character_classes: 0, block_personal_info: false, restricted_words: [], restricted_patterns: [], history_count: 0, history_forbid_all: false,
  hibp_enabled: false, hibp_min_count: 1, hibp_block_on_error: false, zxcvbn_enabled: false, zxcvbn_min_score: 2, used_by: [],
};

// A stored rule set as the form edits it: word and pattern lists as one entry per line, a blank minimum as ''.
const formFrom = (p) => ({
  ...BLANK, ...(p || {}), min_length: p?.min_length || '',
  restricted_words: (p?.restricted_words || []).join('\n'), restricted_patterns: (p?.restricted_patterns || []).join('\n'),
});

function Rules({ p, labels }) {
  const chips = [];
  if (p.min_length) chips.push(`${p.min_length}+ characters`);
  const kinds = [[p.require_lowercase, 'lowercase'], [p.require_uppercase, 'uppercase'], [p.require_digit, 'digit'], [p.require_symbol, 'symbol']].filter(([on]) => on).map(([, t]) => t);
  if (kinds.length) chips.push(`Requires ${kinds.join(', ')}`);
  if (p.min_character_classes) chips.push(`${p.min_character_classes}+ character types`);
  if (p.block_personal_info) chips.push('No personal info');
  if (p.restricted_words.length) chips.push(`${p.restricted_words.length} restricted word${p.restricted_words.length === 1 ? '' : 's'}`);
  if (p.restricted_patterns.length) chips.push(`${p.restricted_patterns.length} restricted pattern${p.restricted_patterns.length === 1 ? '' : 's'}`);
  if (p.history_forbid_all) chips.push('Never reuse');
  else if (p.history_count) chips.push(`Remember ${p.history_count}`);
  if (p.hibp_enabled) chips.push('Breach check');
  if (p.zxcvbn_enabled) chips.push(p.zxcvbn_min_score ? `Strength: ${labels[p.zxcvbn_min_score]}+` : 'Strength meter');
  return chips.length
    ? <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">{chips.map((c) => <Chip key={c} size="small" label={c} />)}</Stack>
    : <Typography variant="body2" color="text.secondary">No rules</Typography>;
}

// Every password rule an administrator can set. Shared by a named password policy and the global password rules.
function PasswordRuleFields({ form, set, readOnly, limits, global = false }) {
  const toggle = (key, label, help) => (
    <FormControlLabel disabled={readOnly} label={help ? <><span>{label}</span><Typography variant="body2" color="text.secondary">{help}</Typography></> : label}
      control={<Switch checked={form[key]} onChange={(e) => set(key, e.target.checked)} />} />
  );
  const section = (title) => <Typography variant="subtitle2" sx={{ pt: 1 }}>{title}</Typography>;
  return (
    <Stack spacing={2}>
      {section('Length and complexity')}
      <TextField type="number" label="Minimum length" value={form.min_length} disabled={readOnly} onChange={(e) => set('min_length', e.target.value)}
        slotProps={{ htmlInput: { min: 8, max: limits.max_length } }}
        helperText={global
          ? `Blank or 0 keeps the built-in ${limits.built_in_min_length}. Lowest allowed: ${limits.floor_min_length}.`
          : `Never below the minimum for every password, currently ${limits.default_min_length}.`} />
      <Stack direction="row" flexWrap="wrap" useFlexGap>
        {toggle('require_lowercase', 'Lowercase letter')}
        {toggle('require_uppercase', 'Uppercase letter')}
        {toggle('require_digit', 'Digit')}
        {toggle('require_symbol', 'Symbol')}
      </Stack>
      <TextField select label="Character types required" value={form.min_character_classes} disabled={readOnly} onChange={(e) => set('min_character_classes', Number(e.target.value))}
        helperText="Lowercase, uppercase, digits and symbols each count as one type.">
        <MenuItem value={0}>No requirement</MenuItem>
        {[2, 3, 4].map((n) => <MenuItem key={n} value={n}>At least {n} of the 4</MenuItem>)}
      </TextField>

      {section('Restrictions')}
      {toggle('block_personal_info', 'Refuse passwords containing the person’s name, username or email address')}
      <TextField multiline minRows={2} label="Restricted words" value={form.restricted_words} disabled={readOnly} onChange={(e) => set('restricted_words', e.target.value)}
        helperText="One per line. A password containing any of them, in any letter case, is refused. People are never shown the list." />
      <TextField multiline minRows={2} label="Restricted patterns" value={form.restricted_patterns} disabled={readOnly} onChange={(e) => set('restricted_patterns', e.target.value)}
        slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
        helperText="Regular expressions, one per line. A password matching any is refused. Write /pattern/i to set flags; otherwise matching is case-sensitive." />

      {section('Reuse')}
      {toggle('history_forbid_all', 'Never allow a previous password to be used again', `Checks the last ${limits.history_kept} passwords kept for each person, plus the current one. History starts when this feature is first used.`)}
      {!form.history_forbid_all && (
        <TextField type="number" label="Remember this many previous passwords" value={form.history_count} disabled={readOnly} onChange={(e) => set('history_count', e.target.value)}
          slotProps={{ htmlInput: { min: 0, max: limits.max_history } }} helperText="0 allows reuse (the current password can still be kept). The current password counts as one." />
      )}

      {section('Compromised passwords (HaveIBeenPwned)')}
      {toggle('hibp_enabled', 'Refuse passwords found in known data breaches', 'Only the first five characters of a hash of the password are sent to api.pwnedpasswords.com; the password itself never leaves this server.')}
      {form.hibp_enabled && (
        <>
          <TextField type="number" label="Refuse if seen at least this many times" value={form.hibp_min_count} disabled={readOnly} onChange={(e) => set('hibp_min_count', e.target.value)}
            slotProps={{ htmlInput: { min: 1 } }} />
          {toggle('hibp_block_on_error', 'Refuse the password when the breach service cannot be reached', 'Off: the check is skipped if the service is down, so people can still change their password.')}
        </>
      )}

      {section('Strength (zxcvbn)')}
      {toggle('zxcvbn_enabled', 'Estimate password strength and show people a strength bar as they type')}
      {form.zxcvbn_enabled && (
        <TextField select label="Refuse passwords weaker than" value={form.zxcvbn_min_score} disabled={readOnly} onChange={(e) => set('zxcvbn_min_score', Number(e.target.value))}
          helperText="The bar always shows; this sets the lowest strength that can be saved.">
          <MenuItem value={0}>Show the bar only; do not refuse</MenuItem>
          {limits.score_labels.slice(1).map((l, i) => <MenuItem key={l} value={i + 1}>{l}</MenuItem>)}
        </TextField>
      )}
    </Stack>
  );
}

// How a rule change reaches people who already have a password. Stored passwords are hashed, so they cannot be re-checked: either each
// person is made to choose a new compliant password at their next sign-in, or their current one stands until they next change it.
function EnforcementChoice({ value, onChange, who }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="subtitle2">Existing passwords</Typography>
      <RadioGroup value={value ? 'now' : 'attrition'} onChange={(e) => onChange(e.target.value === 'now')}>
        <FormControlLabel value="attrition" control={<Radio />}
          label={<><span>Change by attrition</span><Typography variant="body2" color="text.secondary">The new rules apply the next time {who} change their password. A password that does not meet them stays valid until then.</Typography></>} />
        <FormControlLabel value="now" control={<Radio />}
          label={<><span>Enforce immediately</span><Typography variant="body2" color="text.secondary">{who[0].toUpperCase() + who.slice(1)} must choose a new password that meets the rules before doing anything else, including people already signed in.</Typography></>} />
      </RadioGroup>
    </Stack>
  );
}

function PasswordPolicyDialog({ initial, limits, readOnly, onClose, onSaved }) {
  const notify = useNotify();
  const [form, setForm] = useState(() => formFrom(initial));
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [enforce, setEnforce] = useState(false);
  const isNew = initial.id === null;
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  // Below the minimum every password must meet (the global rule, or the built-in one) needs an acceptance, as the server requires.
  const minLength = Number(form.min_length) || 0;
  const lowered = minLength > 0 && minLength < limits.default_min_length;
  const blocked = lowered && !accepted;

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const body = { ...form, accept_global_override: accepted, enforce_immediately: enforce };
      let saved;
      if (isNew) saved = await api('/admin/password-policies', { method: 'POST', body });
      else saved = await api(`/admin/password-policies/${initial.id}`, { method: 'PUT', body });
      notify(saved?.enforced ? `Password policy saved; ${saved.enforced} ${saved.enforced === 1 ? 'person' : 'people'} must choose a new password` : 'Password policy saved');
      onSaved();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/admin/password-policies/${initial.id}`, { method: 'DELETE' });
      notify('Password policy deleted');
      onSaved();
    } catch (err) {
      setConfirmDelete(false);
      setErrors(err.data?.errors || [err.message]);
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <form onSubmit={save}>
        <DialogTitle>{isNew ? 'New password policy' : readOnly ? initial.name : 'Edit password policy'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
            <TextField label="Name" required value={form.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} />
            <TextField label="Description" value={form.description} onChange={(e) => set('description', e.target.value)} disabled={readOnly} />
            {initial.used_by.length > 0 && <Typography variant="body2" color="text.secondary">Used by: {initial.used_by.join(', ')}</Typography>}
            <PasswordRuleFields form={form} set={set} readOnly={readOnly} limits={limits} />
            {!readOnly && <EnforcementChoice value={enforce} onChange={setEnforce} who="the people it covers" />}
            {!readOnly && (isNew || !initial.used_by.length) && (
              <Typography variant="body2" color="text.secondary">
                Nobody is covered by this password policy yet, so this choice affects no one until a sign-in policy uses it.
              </Typography>
            )}
            {lowered && !readOnly && (
              <Alert severity="warning">
                The minimum length for every password is {limits.default_min_length} characters. Setting this policy to {minLength} lets the people it covers use
                shorter passwords, which are easier to guess. Accept that to save it.
                <FormControlLabel sx={{ display: 'flex', mt: 1 }} control={<Checkbox checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />}
                  label="I accept that this password policy reduces security below the minimum for every password" />
              </Alert>
            )}
            <Typography variant="body2" color="text.secondary">
              Attach a password policy to a role or group under Policies → Sign-in policies. When someone is covered by several, the strictest value of each rule applies.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          {!isNew && !readOnly && <Button color="error" onClick={() => setConfirmDelete(true)} sx={{ mr: 'auto' }}>Delete</Button>}
          <Button onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button type="submit" variant="contained" disabled={saving || blocked}>Save</Button>}
        </DialogActions>
      </form>
      <ConfirmDialog open={confirmDelete} title="Delete password policy?" message={`"${initial.name}" will be removed.`}
        confirmLabel="Delete" onConfirm={remove} onClose={() => setConfirmDelete(false)} />
    </Dialog>
  );
}

// The password rules every account is held to. Lowering the minimum below the built-in one is confirmed and flagged first.
function GlobalPasswordRules({ rules, limits, readOnly, onSaved }) {
  const notify = useNotify();
  const builtIn = limits.built_in_min_length;
  const [form, setForm] = useState(() => formFrom(rules));
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirmLower, setConfirmLower] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [enforce, setEnforce] = useState(false);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const minLength = Number(form.min_length) || 0;
  const lowered = minLength > 0 && minLength < builtIn;

  useEffect(() => { setForm(formFrom(rules)); }, [rules]);

  async function save(body) {
    setSaving(true);
    setErrors([]);
    try {
      const saved = await api('/admin/global-password-policy', { method: 'PUT', body: { ...body, enforce_immediately: enforce } });
      notify(saved?.enforced ? `Global password rules saved; ${saved.enforced} ${saved.enforced === 1 ? 'person' : 'people'} must choose a new password` : 'Global password rules saved');
      onSaved();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setConfirmClear(false);
    try {
      await api('/admin/global-password-policy', { method: 'DELETE' });
      notify('Global password rules removed');
      onSaved();
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (lowered) setConfirmLower(true);
    else save(form);
  }

  return (
    <Paper variant="outlined" component="form" onSubmit={submit} sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">Global password rules</Typography>
          <Typography variant="body2" color="text.secondary">
            These apply to every account. A policy can relax one of them only with an accepted override on the Sign-in policies tab.
          </Typography>
        </Stack>
        {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
        {lowered && (
          <Alert severity="warning">
            The built-in minimum is {builtIn} characters. Setting it to {minLength} lets every account, on sign-up and on password change, use shorter passwords,
            which are easier to guess.
          </Alert>
        )}
        <PasswordRuleFields form={form} set={set} readOnly={readOnly} limits={limits} global />
        {!readOnly && <EnforcementChoice value={enforce} onChange={setEnforce} who="people" />}
        {!readOnly && (
          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained" disabled={saving}>Save global rules</Button>
            {rules && <Button color="error" onClick={() => setConfirmClear(true)} disabled={saving}>Clear global rules</Button>}
          </Stack>
        )}
      </Stack>
      <ConfirmDialog open={confirmLower} title="Lower the minimum password length?"
        message={`Passwords for every account may be ${minLength} characters long instead of ${builtIn}. Shorter passwords are easier to guess.`}
        confirmLabel="Lower it" onConfirm={() => { setConfirmLower(false); save(form); }} onClose={() => setConfirmLower(false)} />
      <ConfirmDialog open={confirmClear} title="Clear the global password rules?"
        message="Every account is held only to the password policies it is covered by."
        confirmLabel="Clear" onConfirm={clear} onClose={() => setConfirmClear(false)} />
    </Paper>
  );
}

export default function PasswordPoliciesTab() {
  const can = useCan();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const readOnly = !can('policies.manage');

  const load = useCallback(() => api('/admin/password-policies').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;

  return (
    <Stack spacing={2}>
      <PageIntro title="Password policies">
        Global password rules apply to every account. A password policy is a reusable set of password rules that a sign-in policy can apply to a role or group.
      </PageIntro>
      <GlobalPasswordRules rules={data.global} limits={data.limits} readOnly={readOnly} onSaved={load} />
      {!readOnly && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({ ...BLANK })} sx={{ alignSelf: 'flex-start' }}>New password policy</Button>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow><TableCell>Password policy</TableCell><TableCell>Rules</TableCell><TableCell>Used by</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {data.password_policies.map((p) => (
              <TableRow key={p.id} hover sx={{ cursor: 'pointer' }} onClick={() => setEditing(p)}>
                <TableCell>
                  <Typography fontWeight={500}>{p.name}</Typography>
                  {p.description && <Typography variant="body2" color="text.secondary">{p.description}</Typography>}
                </TableCell>
                <TableCell><Rules p={p} labels={data.limits.score_labels} /></TableCell>
                <TableCell>{p.used_by.length ? p.used_by.join(', ') : <Typography variant="body2" color="text.secondary">Not used</Typography>}</TableCell>
              </TableRow>
            ))}
            {!data.password_policies.length && (
              <TableRow><TableCell colSpan={3}><Typography color="text.secondary">No password policies yet.</Typography></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {editing && (
        <PasswordPolicyDialog initial={editing} limits={data.limits} readOnly={readOnly} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </Stack>
  );
}
