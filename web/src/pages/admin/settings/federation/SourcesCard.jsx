import { useEffect, useState } from 'react';
import {
  Alert, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, MenuItem, Stack, Switch,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import { api } from '../../../../api/client.js';
import { useNotify } from '../../../../components/Notify.jsx';
import ConfirmDialog from '../../../../components/ConfirmDialog.jsx';
import { readFile } from '../../sp/spForm.js';

const BLANK = { id: null, kind: 'aggregate', roles: 'all', name: '', url: '', refresh_hours: 6, enabled: true, signing_cert_pem: '', signing_cert: null, cert_name: '' };
const KINDS = [
  { value: 'mdq', label: 'MDQ service: looks up entities as they are needed' },
  { value: 'aggregate', label: 'Metadata file: downloaded on a schedule' },
];
const ROLES = [{ value: 'all', label: 'Everything' }, { value: 'idp', label: 'Identity providers only' }, { value: 'sp', label: 'Service providers only' }];
const when = (s) => (s ? new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toLocaleString() : '');
const errorText = (e) => e.data?.errors?.join(' ') || e.message;

function Status({ s }) {
  if (s.kind === 'mdq' && !s.last_error) {
    return (
      <Stack spacing={0.5} alignItems="flex-start">
        <Chip size="small" color={s.enabled ? 'success' : 'default'} label={s.enabled ? 'Queried on demand' : 'Disabled'} />
        {s.last_success_at && <Typography variant="caption" color="text.secondary">Last lookup: {when(s.last_success_at)}</Typography>}
      </Stack>
    );
  }
  if (s.last_error) {
    return (
      <Stack spacing={0.5} alignItems="flex-start">
        <Chip size="small" color="error" label={s.kind === 'mdq' ? 'Lookup failed' : 'Refresh failed'} />
        <Typography variant="caption" color="error">{s.last_error}</Typography>
        {s.last_success_at && <Typography variant="caption" color="text.secondary">Last good copy: {when(s.last_success_at)}</Typography>}
      </Stack>
    );
  }
  if (!s.last_success_at) return <Chip size="small" label={s.enabled ? 'Not fetched yet' : 'Disabled'} />;
  return (
    <Stack spacing={0.5} alignItems="flex-start">
      <Chip size="small" color="success" label={`Updated ${when(s.last_success_at)}`} />
      {!s.enabled && <Chip size="small" label="Disabled" />}
    </Stack>
  );
}

export default function SourcesCard({ canManage, onChanged = () => {} }) {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [probe, setProbe] = useState({ entityId: '', result: '', error: '' });

  const load = () => api('/admin/federation/sources').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const replace = (source) => setData((d) => ({ ...d, sources: d.sources.map((s) => (s.id === source.id ? source : s)) }));
  const open = (form) => { setDialogError(''); setProbe({ entityId: '', result: '', error: '' }); setDialog(form); };

  async function pickCert(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = (await readFile(file)).trim();
      setDialog((d) => ({ ...d, signing_cert_pem: text, signing_cert: null, cert_name: file.name }));
    } catch (err) {
      setDialogError(err.message);
    }
  }

  async function save(e) {
    e.preventDefault();
    setDialogError('');
    const { id, kind, roles, name, url, refresh_hours, enabled, signing_cert_pem } = dialog;
    const body = { name, kind, roles, url, refresh_hours: Number(refresh_hours), enabled, ...(signing_cert_pem && { signing_cert_pem }) };
    try {
      await api(id ? `/admin/federation/sources/${id}` : '/admin/federation/sources', { method: id ? 'PUT' : 'POST', body });
      setDialog(null);
      await load();
      onChanged();
      notify(id ? 'Metadata source saved' : 'Metadata source added. Use Refresh to download it.');
    } catch (err) {
      setDialogError(errorText(err));
    }
  }

  async function lookup() {
    setProbe((p) => ({ ...p, result: '', error: '' }));
    try {
      const r = await api(`/admin/federation/sources/${dialog.id}/lookup`, { method: 'POST', body: { entityId: probe.entityId } });
      replace(r.source);
      onChanged();
      setProbe((p) => ({ ...p, result: `Found ${r.name} (${[r.isIdp && 'identity provider', r.isSp && 'service provider'].filter(Boolean).join(' and ')}). Signature verified.` }));
    } catch (err) {
      if (err.data?.source) replace(err.data.source);
      setProbe((p) => ({ ...p, error: errorText(err) }));
    }
  }

  async function refresh(s) {
    setBusy(s.id);
    setError('');
    try {
      const r = await api(`/admin/federation/sources/${s.id}/refresh`, { method: 'POST', body: {} });
      replace(r.source);
      onChanged();
      notify(r.notModified ? 'Already up to date' : `Imported ${r.count} entities`);
    } catch (err) {
      if (err.data?.source) replace(err.data.source);
      onChanged();
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const s = confirm;
    setConfirm(null);
    try {
      await api(`/admin/federation/sources/${s.id}`, { method: 'DELETE' });
      await load();
      onChanged();
      notify('Metadata source and its imported entities removed');
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;
  const editing = Boolean(dialog?.id);
  const isMdq = dialog?.kind === 'mdq';
  const hasCert = Boolean(dialog?.signing_cert_pem || dialog?.signing_cert);

  return (
    <Card variant="outlined" component="section" aria-labelledby="fed-sources">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
            <Typography variant="h6" component="h2" id="fed-sources">Metadata sources</Typography>
            {canManage && (
              <Stack direction="row" spacing={1}>
                <Button onClick={() => open({ ...BLANK, kind: 'mdq', name: 'InCommon MDQ', url: data.defaults.incommonMdqUrl })}>
                  Add InCommon MDQ
                </Button>
                <Button onClick={() => open({ ...BLANK, kind: 'aggregate', roles: 'idp', name: 'InCommon identity providers', url: data.defaults.incommonIdpOnlyUrl, refresh_hours: data.defaults.refreshHours })}>
                  Add InCommon IdP list
                </Button>
                <Button variant="outlined" startIcon={<AddIcon />} onClick={() => open({ ...BLANK })}>Add source</Button>
              </Stack>
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            A source is trusted only when its metadata is signed by the certificate you upload here, so get that certificate from the
            federation's own site and check its fingerprint before uploading it. The query service and the downloaded file may be signed
            with different certificates. A good setup for a large federation is its identity-provider list (small, and what the
            institution picker needs) plus its query service (so the thousands of service providers are fetched only as they appear).
            Check the preset addresses against the federation's current documentation.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          {!data.sources.length ? (
            <Typography color="text.secondary">No metadata sources yet.</Typography>
          ) : (
            <TableContainer>
              <Table size="small" aria-label="Metadata sources">
                <TableHead>
                  <TableRow>
                    <TableCell>Source</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Entities</TableCell>
                    <TableCell>Signing certificate</TableCell>
                    {canManage && <TableCell align="right">Actions</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.sources.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Typography>{s.name}</Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{s.url}</Typography>
                      </TableCell>
                      <TableCell><Status s={s} /></TableCell>
                      <TableCell align="right">{s.kind === 'mdq' ? `${s.entity_count} cached` : s.entity_count}</TableCell>
                      <TableCell sx={{ maxWidth: 280 }}>
                        {s.signing_cert ? (
                          <>
                            <Typography variant="body2">{s.signing_cert.subject}</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                              Expires {s.signing_cert.notAfter}. SHA-256 {s.signing_cert.sha256}
                            </Typography>
                          </>
                        ) : 'None'}
                      </TableCell>
                      {canManage && (
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {s.kind !== 'mdq' && (
                            <Tooltip title="Refresh now">
                              <span>
                                <IconButton aria-label={`Refresh ${s.name}`} disabled={busy === s.id} onClick={() => refresh(s)}><RefreshIcon /></IconButton>
                              </span>
                            </Tooltip>
                          )}
                          <IconButton aria-label={`Edit ${s.name}`} onClick={() => open({ ...BLANK, ...s, signing_cert_pem: '', cert_name: '' })}><EditIcon /></IconButton>
                          <IconButton aria-label={`Delete ${s.name}`} onClick={() => setConfirm(s)}><DeleteIcon /></IconButton>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </CardContent>

      <Dialog open={Boolean(dialog)} onClose={() => setDialog(null)} fullWidth maxWidth="sm" component="form" onSubmit={save}>
        <DialogTitle>{editing ? 'Edit metadata source' : 'Add metadata source'}</DialogTitle>
        <DialogContent>
          {dialog && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              {dialogError && <Alert severity="error">{dialogError}</Alert>}
              <TextField select label="Type" value={dialog.kind} onChange={(e) => setDialog({ ...dialog, kind: e.target.value })}>
                {KINDS.map((k) => <MenuItem key={k.value} value={k.value}>{k.label}</MenuItem>)}
              </TextField>
              <TextField label="Name" required value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} />
              {isMdq ? (
                <TextField label="MDQ service URL" required value={dialog.url} onChange={(e) => setDialog({ ...dialog, url: e.target.value })}
                  helperText="The https base address of the query service. Entities are requested from its /entities/ path." />
              ) : (
                <>
                  <TextField label="Metadata URL" required value={dialog.url} onChange={(e) => setDialog({ ...dialog, url: e.target.value })}
                    helperText="An https URL for the federation's signed metadata." />
                  <TextField select label="Keep" value={dialog.roles} onChange={(e) => setDialog({ ...dialog, roles: e.target.value })}
                    helperText="Keeping only what you use makes the stored copy smaller. A file that already contains only one kind needs no filter.">
                    {ROLES.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
                  </TextField>
                  <TextField label="Refresh every (hours)" type="number" slotProps={{ htmlInput: { min: 1, max: 168 } }}
                    value={dialog.refresh_hours} onChange={(e) => setDialog({ ...dialog, refresh_hours: e.target.value })} />
                </>
              )}
              <Stack spacing={1} alignItems="flex-start">
                <Button variant="outlined" component="label">
                  {hasCert ? 'Replace signing certificate' : 'Upload signing certificate'}
                  <input type="file" hidden accept=".pem,.crt,.cer,.cert,application/x-x509-ca-cert,application/x-pem-file"
                    aria-label="Signing certificate file" onChange={pickCert} />
                </Button>
                <Typography variant="body2" color="text.secondary">
                  {dialog.signing_cert_pem && `${dialog.cert_name || 'Certificate'} selected. It is checked when you save.`}
                  {!dialog.signing_cert_pem && dialog.signing_cert && `Current: ${dialog.signing_cert.subject}. Expires ${dialog.signing_cert.notAfter}. SHA-256 ${dialog.signing_cert.sha256}`}
                  {!hasCert && "Required. The certificate (PEM or DER) the federation signs its metadata with."}
                </Typography>
              </Stack>
              <FormControlLabel label={isMdq ? 'Use this service for lookups' : 'Refresh this source automatically'}
                control={<Switch checked={dialog.enabled} onChange={(e) => setDialog({ ...dialog, enabled: e.target.checked })} />} />
              {isMdq && editing && (
                <Stack spacing={1}>
                  <Typography variant="subtitle2" component="h3">Test lookup</Typography>
                  <Stack direction="row" spacing={1}>
                    <TextField fullWidth size="small" label="Entity ID to look up" value={probe.entityId}
                      onChange={(e) => setProbe({ ...probe, entityId: e.target.value })} />
                    <Button variant="outlined" disabled={!probe.entityId} onClick={lookup} sx={{ flexShrink: 0 }}>Look up</Button>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">Uses the saved address and certificate.</Typography>
                  {probe.result && <Alert severity="success">{probe.result}</Alert>}
                  {probe.error && <Alert severity="error">{probe.error}</Alert>}
                </Stack>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={!dialog || !hasCert}>Save</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog open={Boolean(confirm)} title="Remove metadata source?" confirmLabel="Remove"
        message={`This removes "${confirm?.name}" and the ${confirm?.entity_count || 0} entities ${confirm?.kind === 'mdq' ? 'cached from it' : 'imported from it'}. Federation sign-in stops for service providers that came only from this source.`}
        onConfirm={remove} onClose={() => setConfirm(null)} />
    </Card>
  );
}
