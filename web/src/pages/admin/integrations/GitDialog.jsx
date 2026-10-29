import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, List, ListItem, ListItemText, Stack, TextField, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import { useNotify } from '../../../components/Notify.jsx';

const MAX_LISTED = 8;

// Version control for integrations: commit their settings and scripts to a Git repository kept by the server, and push it to a remote.
// The access token is sent with the push and is not kept anywhere.
export default function GitDialog({ open, onClose }) {
  const can = useCan();
  const notify = useNotify();
  const manage = can('integrations.manage');
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);

  const apply = (s, first = false) => {
    setStatus(s);
    if (first) { setRemoteUrl(s.remoteUrl || ''); setBranch(s.branch || 'main'); }
  };

  useEffect(() => {
    if (!open) return;
    setErrors([]); setToken(''); setMessage('');
    api('/admin/integrations/git').then((s) => apply(s, true)).catch((e) => setErrors(e.data?.errors || [e.message]));
  }, [open]);

  async function act(path, body, done) {
    setErrors([]); setBusy(true);
    try {
      const r = await api(`/admin/integrations/git/${path}`, { method: 'POST', body });
      apply(r.status);
      done(r);
    } catch (e) { setErrors(e.data?.errors || [e.message]); } finally { setBusy(false); }
  }

  const commit = () => act('commit', { message, branch }, (r) => { setMessage(''); notify(r.created ? 'Repository created and changes committed' : 'Changes committed'); });
  const push = () => act('push', { remoteUrl, branch, token }, () => { setToken(''); notify('Pushed'); });

  let line = '';
  if (status?.available) {
    if (!status.initialized) line = 'Not a Git repository yet (committing will initialize one).';
    else {
      const n = status.changes.length;
      line = `On branch ${status.branch}. ${n ? `${n} changed file${n === 1 ? '' : 's'} not committed.` : 'Nothing has changed since the last commit.'}`
        + `${status.last ? ` Last commit ${status.last.short}: ${status.last.subject}.` : ''}${status.unpushed ? ` ${status.unpushed} commit${status.unpushed === 1 ? '' : 's'} not pushed.` : ''}`;
    }
  }
  const canCommit = manage && !busy && message.trim() && status?.available && (!status.initialized || status.changes.length > 0);
  const canPush = manage && !busy && status?.available && status.initialized && status.last && remoteUrl.trim();

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="git-title">
      <DialogTitle id="git-title">Git</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
          {status && !status.available && <Alert severity="warning">{status.message}</Alert>}
          {status?.available && <Typography>{line}</Typography>}
          {status?.available && status.changes.length > 0 && (
            <List dense disablePadding aria-label="Changed files" sx={{ maxHeight: 140, overflow: 'auto' }}>
              {status.changes.slice(0, MAX_LISTED).map((c) => <ListItem key={c.path} disableGutters sx={{ py: 0 }}><ListItemText primary={`${c.status}  ${c.path}`} slotProps={{ primary: { variant: 'caption', fontFamily: 'monospace' } }} /></ListItem>)}
              {status.changes.length > MAX_LISTED && <ListItem disableGutters sx={{ py: 0 }}><ListItemText primary={`and ${status.changes.length - MAX_LISTED} more`} slotProps={{ primary: { variant: 'caption' } }} /></ListItem>}
            </List>
          )}
          <TextField label="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} fullWidth disabled={!manage}
            onKeyDown={(e) => e.key === 'Enter' && canCommit && commit()} />
          <Button variant="contained" disableElevation disabled={!canCommit} onClick={commit} sx={{ alignSelf: 'flex-start' }}>Commit all changes</Button>
          <Divider />
          <TextField label="Remote URL (https)" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} fullWidth disabled={!manage} />
          <Stack direction="row" spacing={2}>
            <TextField label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} sx={{ width: '30%' }} disabled={!manage} />
            <TextField label="Access token (not stored)" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} fullWidth disabled={!manage} />
          </Stack>
          <Button variant="outlined" disabled={!canPush} onClick={push} sx={{ alignSelf: 'flex-start' }}>Push</Button>
          {!manage && <Typography variant="caption" color="text.secondary">You can see the state of the repository. Committing and pushing need permission to manage integrations.</Typography>}
          <Typography variant="caption" color="text.secondary">
            Settings, scripts and functions are committed; secret variable values, webhook tokens and run history never are. Pushes are never forced.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose} disabled={busy}>Close</Button></DialogActions>
    </Dialog>
  );
}
