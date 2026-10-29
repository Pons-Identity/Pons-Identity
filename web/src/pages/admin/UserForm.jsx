import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Checkbox, Chip, Divider, FormControlLabel, FormGroup, Paper, Radio, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { api } from '../../api/client.js';
import { useNotify } from '../../components/Notify.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import CopyButton from '../../components/CopyButton.jsx';
import CopyTextField from '../../components/CopyTextField.jsx';
import { useCan } from '../../auth/permissions.js';
import UserSignIns from '../../components/UserSignIns.jsx';
import SchedulePanel from '../../components/SchedulePanel.jsx';
import PasswordChangeInfo from '../../components/PasswordChangeInfo.jsx';
import { PasswordGuidance } from '../../components/PasswordStrength.jsx';
import PassphraseGenerator from '../../components/PassphraseGenerator.jsx';
import MultiCombobox from '../../components/MultiCombobox.jsx';
import { MembershipHow } from '../../components/GroupPanels.jsx';

const EMPTY = {
  username: '', password: '', personal_email: '', emails: [], first_name: '', last_name: '', display_name: '', email: '',
  employee_id: '', department: '', title: '', phone: '', custom: '',
  upn: '', sam_account_name: '', distinguished_name: '', mail_nickname: '', company: '', manager: '', office: '',
  mobile: '', street_address: '', city: '', state: '', postal_code: '', country: '', description: '',
  active: true, mfa_enabled: false, group_ids: [], role_ids: [],
};

export const TEXT_FIELDS = [
  ['username', 'Username'], ['first_name', 'First name'], ['last_name', 'Last name'],
  ['display_name', 'Display name'], ['email', 'Email'], ['employee_id', 'Employee ID'],
  ['department', 'Department'], ['title', 'Title'], ['phone', 'Phone'],
];

// Active Directory style attributes, with the LDAP attribute name as helper text.
export const AD_FIELDS = [
  ['upn', 'User principal name', 'userPrincipalName'], ['sam_account_name', 'sAMAccountName', 'sAMAccountName'],
  ['distinguished_name', 'Distinguished name', 'distinguishedName'], ['mail_nickname', 'Mail nickname', 'mailNickname'],
  ['company', 'Company', 'company'], ['manager', 'Manager (DN)', 'manager'],
  ['office', 'Office', 'physicalDeliveryOfficeName'], ['mobile', 'Mobile', 'mobile'],
  ['street_address', 'Street address', 'streetAddress'], ['city', 'City', 'l'],
  ['state', 'State / province', 'st'], ['postal_code', 'Postal code', 'postalCode'],
  ['country', 'Country', 'c'], ['description', 'Description', 'description'],
];

export default function UserForm() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const notify = useNotify();
  const can = useCan();
  const [form, setForm] = useState(null);
  const [groups, setGroups] = useState([]);
  const [roles, setRoles] = useState([]);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [attrDefs, setAttrDefs] = useState([]);
  const [rules, setRules] = useState(null);
  // Whether sign-in policy requires a second factor for this person, and the policies that say so.
  const [policyMfa, setPolicyMfa] = useState(null);

  useEffect(() => {
    const loadUser = isNew ? Promise.resolve(EMPTY) : api(`/admin/users/${id}`);
    Promise.all([api('/admin/options'), loadUser, api('/admin/attribute-defs')])
      .then(([opts, u, defs]) => {
        setAttrDefs(defs);
        setGroups(opts.groups);
        setRoles(opts.roles);
        setForm({ ...EMPTY, ...u, password: '' });
      })
      .catch((e) => setErrors([e.message]));
  }, [id, isNew]);

  // The rules that apply to this person (a new account has no roles or groups yet, so none beyond the default).
  useEffect(() => {
    if (!isNew) api(`/admin/users/${id}/password-rules`).then(setRules).catch(() => setRules(null));
  }, [id, isNew]);

  // Whether a sign-in policy requires the second factor. Loaded alongside the rules, so the form is not held up by it.
  useEffect(() => {
    if (!isNew) api(`/admin/users/mfa-required?ids=${id}`).then((found) => setPolicyMfa(found[id] || null)).catch(() => setPolicyMfa(null));
  }, [id, isNew]);

  const setAttr = (name, value) => setForm((f) => ({ ...f, attributes: { ...(f.attributes || {}), [name]: value } }));
  const setEmails = (emails) => set('emails', emails);

  if (!form) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const memberships = form?.memberships || [];
  const toggleRole = (rid, on) => set('role_ids', on
    ? [...form.role_ids, rid]
    : form.role_ids.filter((r) => r !== rid));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const u = isNew
        ? await api('/admin/users', { method: 'POST', body: form })
        : await api(`/admin/users/${id}`, { method: 'PUT', body: form });
      notify('User saved');
      if (isNew) navigate(`/admin/users/${u.id}`, { replace: true });
      else setForm({ ...EMPTY, ...u, password: '' });
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  async function removeFactor(factor) {
    try {
      const u = await api(`/admin/users/${id}/factors/${factor}`, { method: 'DELETE' });
      setForm({ ...EMPTY, ...u, password: '' });
      notify('Sign-in method removed');
    } catch (err) {
      setErrors([err.message]);
    }
  }

  async function resetTotp() {
    setConfirm(null);
    try {
      const u = await api(`/admin/users/${id}/reset-totp`, { method: 'POST' });
      setForm({ ...EMPTY, ...u, password: '' });
      notify('Authenticator reset');
    } catch (err) {
      setErrors([err.message]);
    }
  }

  // Locks the account down with the steps its Compromised account policies set. On failure the reply still carries the user, as it is now.
  async function lockDown() {
    setConfirm(null);
    try {
      const u = await api(`/admin/users/${id}/lockdown`, { method: 'POST' });
      setForm({ ...EMPTY, ...u, password: '' });
      notify('Account locked down');
    } catch (err) {
      if (err.data?.user) setForm({ ...EMPTY, ...err.data.user, password: '' });
      setErrors([err.message]);
    }
  }

  async function endLockdown() {
    setConfirm(null);
    try {
      const u = await api(`/admin/users/${id}/lockdown`, { method: 'DELETE' });
      setForm({ ...EMPTY, ...u, password: '' });
      notify('Lockdown ended');
    } catch (err) {
      setErrors([err.message]);
    }
  }

  async function remove() {
    setConfirm(null);
    try {
      await api(`/admin/users/${id}`, { method: 'DELETE' });
      navigate('/admin/users', { replace: true });
    } catch (err) {
      setErrors([err.message]);
    }
  }

  return (
    <Stack spacing={3}>
      {!isNew && <Button component={RouterLink} to="/admin/users" startIcon={<ArrowBackIcon />} sx={{ alignSelf: 'flex-start' }}>Back to users</Button>}
      <Typography variant="h5" component="h1">{isNew ? 'New user' : `Edit ${form.username}`}</Typography>
      {errors.length > 0 && (
        <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>
      )}

      {!isNew && can('users.manage') && form.compromise && (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5}>
              <Typography variant="h6" component="h2">Compromised account lockdown</Typography>
              {form.compromise.lockdown ? (
                <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setConfirm('end-lockdown')}>End lockdown</Button>}>
                  In lockdown since {new Date(form.compromise.lockdown.started_at).toLocaleString()}
                  {form.compromise.lockdown.started_by ? `, started by ${form.compromise.lockdown.started_by}` : ''}.
                  {form.compromise.lockdown.locked_account ? ' The account is turned off.' : ''}
                  {form.compromise.lockdown.networks.length ? ' Sign-in is limited to the allowed networks.' : ''}
                </Alert>
              ) : (
                <Typography variant="body2" color="text.secondary">Not in lockdown.</Typography>
              )}
              <Typography variant="body2">
                Lock this account down if you suspect it's been compromised. These steps run per the Compromised account policy:
              </Typography>
              {form.compromise.plan.steps.length ? (
                <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 3 }}>
                  {form.compromise.plan.steps.map((s) => <Typography component="li" variant="body2" key={s.key}>{s.label}</Typography>)}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">No steps are set for this person.</Typography>
              )}
              {form.compromise.plan.networks.length > 0 && (
                <Typography variant="body2" color="text.secondary">
                  Sign-in will be limited to {form.compromise.plan.networks.length} network list{form.compromise.plan.networks.length === 1 ? '' : 's'}.
                </Typography>
              )}
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Button color="error" disabled={form.is_admin} onClick={() => setConfirm('lockdown')}>Lock down account</Button>
              </Stack>
              {form.is_admin && <Typography variant="caption" color="text.secondary">Accounts with administrative access cannot be locked down from here.</Typography>}
            </Stack>
          </CardContent>
        </Card>
      )}

      <Card variant="outlined">
        <CardContent>
          <Stack component="form" spacing={2} onSubmit={save}>
            {!isNew && (
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <TextField label="GUID" value={form.guid || ''} size="small" slotProps={{ input: { readOnly: true } }} sx={{ flexGrow: 1, minWidth: 260 }} />
                <CopyButton value={form.guid || ''} />
              </Stack>
            )}
            <Stack spacing={2}>
              <CopyTextField label="Username" required value={form.username} onChange={(e) => set('username', e.target.value)} fullWidth />
              <TextField label={isNew ? 'Password' : 'New password'} type="password" autoComplete="new-password"
                required={isNew} helperText={isNew ? 'At least 12 characters.' : 'Leave blank to keep the current password.'}
                value={form.password} onChange={(e) => set('password', e.target.value)} fullWidth />
              <PassphraseGenerator onUse={(phrase) => set('password', phrase)} />
            </Stack>
            {!isNew && !form.directory && form.password && <PasswordGuidance rules={rules} password={form.password} userInputs={[form.username, form.email, form.first_name, form.last_name].filter(Boolean)} />}
            {!isNew && !form.directory && <PasswordChangeInfo info={form.password_info} />}
            <Stack spacing={2}>
              {TEXT_FIELDS.slice(1, 5).filter(([k]) => k !== 'email').map(([k, label]) => (
                <CopyTextField key={k} label={label} value={form[k] || ''} onChange={(e) => set(k, e.target.value)} fullWidth />
              ))}
            </Stack>
            <Stack spacing={2}>
              {TEXT_FIELDS.slice(5).filter(([k]) => k !== 'email').map(([k, label]) => (
                <CopyTextField key={k} label={label} value={form[k] || ''} onChange={(e) => set(k, e.target.value)} fullWidth />
              ))}
            </Stack>

            <Typography variant="subtitle2" component="h2">Email addresses</Typography>
            <Stack spacing={1}>
              {(form.emails || []).map((m, i) => (
                <Stack key={i} direction="row" spacing={1} alignItems="center">
                  <CopyTextField size="small" type="email" label={m.primary ? 'Primary email' : 'Email'} value={m.email}
                    onChange={(e) => setEmails(form.emails.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} sx={{ flexGrow: 1 }} />
                  <FormControlLabel label="Primary" control={<Radio checked={!!m.primary}
                    onChange={() => setEmails(form.emails.map((x, j) => ({ ...x, primary: j === i })))} />} />
                  <Button size="small" onClick={() => setEmails(form.emails.filter((_, j) => j !== i))}>Remove</Button>
                </Stack>
              ))}
              <Button size="small" sx={{ alignSelf: 'flex-start' }}
                onClick={() => setEmails([...(form.emails || []), { email: '', primary: !(form.emails || []).length }])}>Add email address</Button>
            </Stack>

            {!form.directory && (
              <CopyTextField label="Personal recovery email" type="email" value={form.personal_email || ''} onChange={(e) => set('personal_email', e.target.value)}
                helperText="Used only to send a password reset link, if recovery is on. An address entered here counts as confirmed." />
            )}

            <Typography variant="subtitle2" component="h2">Active Directory attributes</Typography>
            <Stack spacing={2}>
              {AD_FIELDS.map(([k, label, ldap]) => (
                <CopyTextField key={k} label={label} helperText={ldap} value={form[k] || ''} onChange={(e) => set(k, e.target.value)} fullWidth />
              ))}
            </Stack>

            {attrDefs.length > 0 && (
              <Stack spacing={2}>
                {attrDefs.map((d) => {
                  const value = (form.attributes || {})[d.name] ?? (isNew ? d.default_value : '');
                  const common = { label: d.label, required: d.required, value, onChange: (e) => setAttr(d.name, e.target.value) };
                  if (d.type === 'enum' || d.type === 'bool') {
                    const opts = d.type === 'bool' ? ['true', 'false'] : d.options;
                    return (
                      <TextField key={d.name} {...common} fullWidth select slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}>
                        <option value="" />
                        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                      </TextField>
                    );
                  }
                  return <CopyTextField key={d.name} {...common} fullWidth type={d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : 'text'} slotProps={{ inputLabel: { shrink: d.type === 'date' ? true : undefined } }} />;
                })}
              </Stack>
            )}
            <CopyTextField label="Custom attributes" multiline minRows={3} value={form.custom || ''}
              onChange={(e) => set('custom', e.target.value)}
              helperText="One name=value per line. These can be mapped to SAML attributes." />

            <Divider />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap">
              <FormControlLabel control={<Switch checked={form.active} onChange={(e) => set('active', e.target.checked)} />} label="Active" />
              <FormControlLabel
                control={<Switch checked={form.mfa_enabled || Boolean(policyMfa?.required)} disabled={Boolean(policyMfa?.required)} onChange={(e) => set('mfa_enabled', e.target.checked)} />}
                label="Require MFA" />
              {policyMfa?.required && (
                <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>
                  Required by sign-in policy{policyMfa.sources?.length ? `: ${policyMfa.sources.join(', ')}` : ''}. It can't be turned off here.
                </Typography>
              )}
            </Stack>

            <Typography variant="subtitle2">Roles</Typography>
            {!can('roles.manage') && <Typography variant="body2" color="text.secondary">Changing roles needs the Manage roles permission.</Typography>}
            <FormGroup>
              {roles.map((r) => (
                <FormControlLabel key={r.id} label={r.name} disabled={!can('roles.manage')}
                  control={<Checkbox checked={form.role_ids.includes(r.id)} onChange={(e) => toggleRole(r.id, e.target.checked)} />} />
              ))}
            </FormGroup>

            {form.grouper_role_ids?.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                Also granted by Grouper group membership: {roles.filter((r) => form.grouper_role_ids.includes(r.id)).map((r) => r.name).join(', ')}.
                These come and go with Grouper and cannot be changed here.
              </Typography>
            )}

            <Typography variant="subtitle2">Groups</Typography>
            {!can('groups.manage') && <Typography variant="body2" color="text.secondary">Changing groups needs the Manage groups permission.</Typography>}
            {groups.length === 0 && <Typography color="text.secondary" variant="body2">No groups yet.</Typography>}
            {groups.length > 0 && (
              <MultiCombobox label="Added directly to" placeholder="Search groups" disabled={!can('groups.manage')}
                options={groups.filter((g) => g.source === 'local').map((g) => ({ id: g.id, label: g.name, secondary: g.description }))}
                value={form.group_ids} onChange={(ids) => set('group_ids', ids)}
                helperText="Groups this person is a member of by being added. Groups that come from a nested group, a composite or a directory are listed below." />
            )}
            {memberships.length > 0 && (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label="Group memberships">
                  <TableHead><TableRow><TableCell>Group</TableCell><TableCell>Membership</TableCell></TableRow></TableHead>
                  <TableBody>
                    {memberships.map((g) => (
                      <TableRow key={g.id}>
                        <TableCell>{g.name}{g.source !== 'local' && <Chip size="small" variant="outlined" label={g.source === 'grouper' ? 'Grouper' : 'Directory'} sx={{ ml: 1 }} />}</TableCell>
                        <TableCell><MembershipHow member={{ ...g, via: g.via.map((v) => v.name) }} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button type="submit" variant="contained" disabled={saving}>Save</Button>
              {!isNew && (
                <>
                  <Button color="warning" onClick={() => setConfirm('totp')}>Reset authenticator</Button>
                  <Button color="error" onClick={() => setConfirm('delete')}>Delete user</Button>
                </>
              )}
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      {!isNew && (form.factors || []).length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="h6" component="h2">Sign-in factors</Typography>
              {form.factors.map((f) => (
                <Stack key={f.id} direction="row" spacing={1} alignItems="center">
                  <Typography sx={{ flexGrow: 1 }}>{f.label}{f.hint ? ` — ${f.hint}` : ''}{f.phishing_resistant ? ' (phishing resistant)' : ''}</Typography>
                  {can('users.manage') && <Button size="small" color="warning" onClick={() => removeFactor(f.id)}>Remove</Button>}
                </Stack>
              ))}
              {can('users.manage') && form.factors.length > 1 && <Button size="small" color="warning" sx={{ alignSelf: 'flex-start' }} onClick={() => removeFactor('all')}>Remove all (lost device)</Button>}
            </Stack>
          </CardContent>
        </Card>
      )}

      {!isNew && can('audit.view') && <UserSignIns userId={Number(id)} />}

      {!isNew && can('users.schedule') && can('users.manage') && <SchedulePanel userId={Number(id)} />}

      <ConfirmDialog
        open={confirm === 'totp'}
        title="Reset authenticator?"
        message="The user will have to set up their authenticator app again at next sign-in."
        confirmLabel="Reset"
        color="warning"
        onConfirm={resetTotp}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'lockdown'}
        title="Lock down this account?"
        message={`For ${form.username}, these steps run: ${(form.compromise?.plan.steps || []).map((s) => s.label.toLowerCase()).join('; ') || 'none'}.`}
        confirmLabel="Lock down"
        color="error"
        onConfirm={lockDown}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'end-lockdown'}
        title="End the lockdown?"
        message={`${form.username} can sign in again, subject to their sign-in rules. Their password and sign-in methods are not restored.`}
        confirmLabel="End lockdown"
        onConfirm={endLockdown}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete user?"
        message={`This permanently deletes ${form.username}.`}
        confirmLabel="Delete"
        onConfirm={remove}
        onClose={() => setConfirm(null)}
      />
    </Stack>
  );
}
