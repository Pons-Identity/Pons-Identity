import { useState } from 'react';
import { Alert, Button, Chip, Stack, Typography } from '@mui/material';
import { api } from '../../../../api/client.js';
import { useNotify } from '../../../../components/Notify.jsx';
import ConfirmDialog from '../../../../components/ConfirmDialog.jsx';

const ROLES = [['signing', 'Active', 'success'], ['next', 'Staged', 'info'], ['previous', 'Retiring', 'default']];

// The certificate set and its rollover. Publishing a new key well before using it is what keeps sign-in working while the
// federation catches up, so the steps are separate and explained rather than one "rotate" button.
export default function KeyRollover({ kind, keys, canManage, onKeys }) {
  const notify = useNotify();
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState('');

  async function run(action, message) {
    setConfirm(null);
    setError('');
    try {
      const view = await api(`/admin/federation/${kind}/keys/${action}`, { method: 'POST', body: {} });
      onKeys(view.keys);
      notify(message);
    } catch (err) {
      setError(err.data?.errors?.join(' ') || err.message);
    }
  }

  if (!keys) return <Typography variant="body2" color="text.secondary">Keys are generated the first time you save.</Typography>;
  const rows = ROLES.map(([key, label, color]) => ({ key, label, color, cert: key === 'signing' ? keys.signing : keys[key]?.signing })).filter((r) => r.cert);

  return (
    <Stack spacing={1.5} role="group" aria-label="Keys">
      <Typography variant="subtitle1" component="h3">Keys</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {rows.map((r) => (
        <Stack key={r.key} direction="row" spacing={1.5} alignItems="flex-start">
          <Chip size="small" color={r.color} label={r.label} sx={{ mt: 0.25 }} />
          <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
            {r.cert.subject}. Expires {r.cert.notAfter}. SHA-256 {r.cert.sha256}
          </Typography>
        </Stack>
      ))}
      {keys.next && (
        <Alert severity="info">
          The staged key is already in your metadata but is not used yet. Once the federation has published your updated metadata
          (this can take days), activate it. The old key stays published until you retire it.
        </Alert>
      )}
      {keys.previous && (
        <Alert severity="info">The old key is still published. Retire it once nobody still depends on it.</Alert>
      )}
      {canManage && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {!keys.next && <Button variant="outlined" onClick={() => run('stage', 'New key staged. Submit your updated metadata to the federation.')}>Stage a new key</Button>}
          {keys.next && <Button variant="contained" onClick={() => setConfirm('activate')}>Activate staged key</Button>}
          {keys.next && <Button onClick={() => run('cancel', 'Staged key discarded')}>Cancel staged key</Button>}
          {keys.previous && <Button color="warning" onClick={() => setConfirm('retire')}>Retire old key</Button>}
        </Stack>
      )}
      <ConfirmDialog open={confirm === 'activate'} title="Activate the staged key?" confirmLabel="Activate" color="primary"
        message="Assertions and metadata will be signed with the new key from now on. Do this only after the federation is publishing your metadata with the new key; before that, service providers will reject what you send."
        onConfirm={() => run('activate', 'New key is active. The old one stays published until you retire it.')} onClose={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'retire'} title="Retire the old key?" confirmLabel="Retire"
        message="The old key is removed from your metadata and can no longer decrypt. Anyone still using a cached copy of your old metadata will be unable to sign in."
        onConfirm={() => run('retire', 'Old key retired')} onClose={() => setConfirm(null)} />
    </Stack>
  );
}
