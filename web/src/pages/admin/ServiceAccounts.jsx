import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControlLabel, Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { api } from '../../api/client.js';
import { useCan } from '../../auth/permissions.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import ReadOnlyField from '../../components/ReadOnlyField.jsx';
import RepeaterRows from '../../components/RepeaterRows.jsx';
import { useNotify } from '../../components/Notify.jsx';
import UsersTabs from './UsersTabs.jsx';

const ACCESS = [
  { value: 'read', label: 'Read (list and read)' },
  { value: 'write', label: 'Write (create, change, remove; cannot read)' },
  { value: 'readwrite', label: 'Read and write' },
];
const ACCESS_LABEL = Object.fromEntries(ACCESS.map((a) => [a.value, a.label.split(' (')[0].toLowerCase()]));
const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const EMPTY = { username: '', description: '', enabled: true, grants: [{ path: '/', access: 'read' }], public_keys: '', password: '', generate: true };

const formOf = (a) => ({
  username: a.username, description: a.description, enabled: a.enabled, grants: a.grants, public_keys: a.public_keys.join('\n'), password: '', generate: false,
});

// Everything that signs in as a service account: who it is, what it may reach, and how it proves who it is.
function AccountDialog({ account, open, onClose, onSaved }) {
  const notify = useNotify();
  const editing = Boolean(account);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) { setForm(account ? formOf(account) : EMPTY); setError(''); }
  }, [open, account]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setError('');
    const body = { ...form, username: form.username.trim(), public_keys: form.public_keys, generate: form.generate };
    try {
      const r = editing
        ? await api(`/admin/service-accounts/${account.id}`, { method: 'PUT', body })
        : await api('/admin/service-accounts', { method: 'POST', body });
      notify(editing ? 'Service account saved' : 'Service account created');
      onSaved(r, r.generated_password);
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" aria-labelledby="service-account-title">
      <DialogTitle id="service-account-title">{editing ? `Service account ${account.username}` : 'New service account'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }} component="form" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label="Service account">
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Name" required value={form.username} onChange={(e) => set('username', e.target.value)} sx={{ flex: 1 }}
              helperText="The name the software signs in with. Letters, digits, dots, dashes and underscores." />
            <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />} label="Turned on" />
          </Stack>
          <TextField label="What it is for" value={form.description} onChange={(e) => set('description', e.target.value)} />

          <Typography variant="subtitle1" component="h3">Directories it may use</Typography>
          <Typography variant="body2" color="text.secondary">
            It sees only these, and the folders above them on the way. A directory that does not exist yet can be granted; it appears once something is put in it.
          </Typography>
          <RepeaterRows rows={form.grants} onChange={(rows) => set('grants', rows)} addLabel="Add a directory" emptyRow={{ path: '/', access: 'read' }}
            fields={[{ key: 'path', label: 'Directory' }, { key: 'access', label: 'Access', options: ACCESS }]} />

          <Typography variant="subtitle1" component="h3">How it signs in</Typography>
          <TextField label="Password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)}
            helperText={editing ? 'Leave blank to keep the current password. At least 12 characters.' : 'At least 12 characters, or ask for one to be generated below.'} />
          {!editing && (
            <FormControlLabel control={<Switch checked={form.generate} onChange={(e) => set('generate', e.target.checked)} />}
              label="Generate a password if none is given (it is shown once, after saving)" />
          )}
          <TextField label="SSH public keys" multiline minRows={2} value={form.public_keys} onChange={(e) => set('public_keys', e.target.value)}
            helperText="One key per line, in OpenSSH form (ssh-ed25519 AAAA… comment). The software signs with the matching private key." />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save}>{editing ? 'Save' : 'Create service account'}</Button>
      </DialogActions>
    </Dialog>
  );
}

// Service accounts: other software's sign-ins for the SFTP server. Listed beside the people, on the Users page.
export default function ServiceAccounts() {
  const can = useCan();
  const notify = useNotify();
  const canManage = can('users.manage');
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [dialog, setDialog] = useState(false);
  const [shown, setShown] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [locking, setLocking] = useState(null);
  const [ending, setEnding] = useState(null);
  const [restoreKeys, setRestoreKeys] = useState(false);

  const load = () => api('/admin/service-accounts').then((d) => setAccounts(d.accounts)).catch((e) => setError(errorText(e)));
  useEffect(() => { load(); }, []);

  function saved(r, password) {
    setDialog(false);
    setAccounts(r.accounts);
    if (password) setShown({ username: r.account.username, password });
  }

  async function resetPassword(a) {
    setError('');
    try {
      const r = await api(`/admin/service-accounts/${a.id}/password`, { method: 'POST' });
      setAccounts(r.accounts);
      setShown({ username: a.username, password: r.generated_password });
    } catch (err) { setError(errorText(err)); }
  }

  async function lockDown() {
    const a = locking;
    setLocking(null);
    setError('');
    try {
      const r = await api(`/admin/service-accounts/${a.id}/lockdown`, { method: 'POST' });
      setAccounts(r.accounts);
      notify(`${a.username} is locked down`);
    } catch (err) { setError(errorText(err)); }
  }

  async function endLockdown() {
    const a = ending;
    setEnding(null);
    setError('');
    try {
      const r = await api(`/admin/service-accounts/${a.id}/lockdown`, { method: 'DELETE', body: { restore_keys: restoreKeys } });
      setAccounts(r.accounts);
      notify(`Lockdown ended for ${a.username}`);
    } catch (err) { setError(errorText(err)); }
  }

  async function remove() {
    const a = deleting;
    setDeleting(null);
    try {
      const r = await api(`/admin/service-accounts/${a.id}`, { method: 'DELETE' });
      setAccounts(r.accounts);
      notify(`${a.username} deleted`);
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography variant="h5" component="h1">Users</Typography>
        {canManage && <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setEditing(null); setDialog(true); }}>New service account</Button>}
      </Stack>
      <UsersTabs />
      <Typography variant="body2" color="text.secondary">
        Service accounts are for other software, not people. They sign in over SFTP to the files module, and see only the directories granted to them.
        They cannot sign in to the console. See <em>Files and SFTP access</em> in the README.
      </Typography>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Service accounts">
          <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Directories</TableCell><TableCell>Signs in with</TableCell><TableCell>Status</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {accounts && !accounts.length && <TableRow><TableCell colSpan={5}><Typography color="text.secondary">No service accounts yet.</Typography></TableCell></TableRow>}
            {(accounts || []).map((a) => (
              <TableRow key={a.id} hover>
                <TableCell>
                  <Typography variant="body2" fontWeight={600}>{a.username}</Typography>
                  {a.description && <Typography variant="caption" color="text.secondary">{a.description}</Typography>}
                </TableCell>
                <TableCell>{a.grants.map((g) => `${g.path} (${ACCESS_LABEL[g.access]})`).join(', ')}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {a.has_password && <Chip size="small" label="Password" />}
                    {a.key_labels.map((k) => <Chip key={k} size="small" variant="outlined" label={k} />)}
                    {!a.has_password && !a.key_labels.length && <Typography variant="body2" color="text.secondary">Nothing yet</Typography>}
                  </Stack>
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {a.enabled ? <Chip size="small" color="success" label="On" /> : <Chip size="small" label="Off" />}
                    {a.locked_down && <Chip size="small" color="error" label="In lockdown" />}
                  </Stack>
                </TableCell>
                <TableCell align="right">
                  {canManage && <Button size="small" onClick={() => { setEditing(a); setDialog(true); }}>Edit</Button>}
                  {canManage && <Button size="small" onClick={() => resetPassword(a)}>New password</Button>}
                  {canManage && !a.locked_down && <Button size="small" color="warning" onClick={() => setLocking(a)}>Lock down</Button>}
                  {canManage && a.locked_down && <Button size="small" onClick={() => { setRestoreKeys(false); setEnding(a); }}>End lockdown</Button>}
                  {canManage && <Button size="small" color="error" onClick={() => setDeleting(a)}>Delete</Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <AccountDialog open={dialog} account={editing} onClose={() => setDialog(false)} onSaved={saved} />
      <Dialog open={Boolean(shown)} onClose={() => setShown(null)} fullWidth maxWidth="xs" aria-labelledby="password-shown-title">
        <DialogTitle id="password-shown-title">Password for {shown?.username}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>Copy it now. It is not shown again.</DialogContentText>
          <ReadOnlyField label="Password" value={shown?.password || ''} />
        </DialogContent>
        <DialogActions><Button variant="contained" onClick={() => setShown(null)}>Done</Button></DialogActions>
      </Dialog>
      <ConfirmDialog open={Boolean(locking)} title="Lock down this service account?" confirmLabel="Lock down" color="warning"
        message={`${locking?.username} is turned off, its password is replaced with one nobody knows, and its SSH keys are suspended. Its open SFTP connections are closed now. Ending the lockdown turns it back on, but does not restore the password.`}
        onConfirm={lockDown} onClose={() => setLocking(null)} />
      <Dialog open={Boolean(ending)} onClose={() => setEnding(null)} fullWidth maxWidth="xs" aria-labelledby="end-lockdown-title">
        <DialogTitle id="end-lockdown-title">End the lockdown for {ending?.username}?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 1 }}>
            {ending?.lockdown?.enabled_before === false ? 'The account stays off, because it was off before the lockdown.' : 'The account is turned on again.'} Set a new password for it, since the old one is not restored.
          </DialogContentText>
          <FormControlLabel control={<Checkbox checked={restoreKeys} onChange={(e) => setRestoreKeys(e.target.checked)} />}
            label={`Restore the SSH keys that were suspended (${ending?.lockdown?.keys_suspended ?? 0}). Otherwise they are discarded.`} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEnding(null)}>Cancel</Button>
          <Button variant="contained" onClick={endLockdown}>End lockdown</Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog open={Boolean(deleting)} title="Delete this service account?" confirmLabel="Delete"
        message={`${deleting?.username} can no longer sign in over SFTP. Files it wrote are kept.`} onConfirm={remove} onClose={() => setDeleting(null)} />
    </Stack>
  );
}
