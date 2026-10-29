import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Breadcrumbs, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Link, Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import TextViewDialog from '../../../components/TextViewDialog.jsx';

const BASE = '/admin/files';
// Names that look like plain text, which get a View button when they are small enough (the server checks the contents too).
const TEXT_FILE = /\.(txt|text|csv|tsv|log|json|md|xml|ya?ml|ini|conf|cfg)$/i;
const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const csrf = async () => (await api('/session', { withCsrf: false })).csrf;
const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parentOf = (p) => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/');
const enc = encodeURIComponent;

// The folders above a path, as links, from the top.
function Crumbs({ path, onOpen }) {
  const parts = path.split('/').filter(Boolean);
  return (
    <Breadcrumbs aria-label="Folder">
      <Link component="button" underline="hover" onClick={() => onOpen('/')}>Files</Link>
      {parts.map((name, i) => {
        const to = `/${parts.slice(0, i + 1).join('/')}`;
        return i === parts.length - 1
          ? <Typography key={to} color="text.primary">{name}</Typography>
          : <Link key={to} component="button" underline="hover" onClick={() => onOpen(to)}>{name}</Link>;
      })}
    </Breadcrumbs>
  );
}

// The SFTP server: whether other software may connect, on which port, and what is running.
function SftpServer({ canManage }) {
  const notify = useNotify();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api(`${BASE}/sftp`).then((s) => { setCfg(s); setForm({ enabled: s.enabled, port: s.port, bindAddress: s.bindAddress }); }).catch((e) => setError(errorText(e))), []);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      const s = await api(`${BASE}/sftp`, { method: 'PUT', body: { ...form, port: Number(form.port) } });
      setCfg(s);
      setForm({ enabled: s.enabled, port: s.port, bindAddress: s.bindAddress });
      notify(s.running ? 'SFTP server is running' : 'SFTP settings saved');
    } catch (err) { setError(errorText(err)); }
  }

  if (!cfg || !form) return null;
  const host = window.location.hostname;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack component="form" onSubmit={save} spacing={2} aria-label="SFTP server">
        <Typography variant="h6" component="h2">SFTP access for other software</Typography>
        <Typography variant="body2" color="text.secondary">
          Other software can list, read, write and remove files in this module over SFTP, as a <strong>service account</strong> (Users → Service accounts).
          Each account sees only the directories it has been granted. A password or an SSH key signs it in. Files it writes are kept in the same place the console shows them.
        </Typography>
        {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip size="small" color={cfg.running ? 'success' : cfg.enabled ? 'error' : 'default'} label={cfg.running ? 'Listening' : cfg.enabled ? 'Not listening' : 'Off'} />
          {cfg.running && <Typography variant="body2">on {cfg.bindAddress}:{cfg.port}</Typography>}
        </Stack>
        {cfg.error && <Alert severity="error">{cfg.error}</Alert>}
        <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} disabled={!canManage} />}
          label="Accept SFTP connections" />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Port" type="number" value={form.port} disabled={!canManage} sx={{ width: 160 }}
            onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} slotProps={{ htmlInput: { min: 1, max: 65535 } }} />
          <TextField label="Listen on address" value={form.bindAddress} disabled={!canManage} sx={{ flex: 1 }} helperText="0.0.0.0 for every address; an IP address for one."
            onChange={(e) => setForm((f) => ({ ...f, bindAddress: e.target.value }))} />
        </Stack>
        {cfg.fingerprint && <ReadOnlyField label="Server key fingerprint (clients should show this when they first connect)" value={cfg.fingerprint} />}
        <Typography variant="body2" color="text.secondary" component="pre" sx={{ m: 0, overflowX: 'auto' }}>{`sftp -P ${cfg.port} hr-export@${host}`}</Typography>
        <Typography variant="body2" color="text.secondary">
          Use the service account's name and its password (or key). The folders it can reach appear at the top level of the connection. Folders it is not granted are refused.
          The full description is in the README under <em>Files and SFTP access</em>.
        </Typography>
        {canManage && <Button type="submit" variant="contained" sx={{ alignSelf: 'flex-start' }}>Save SFTP settings</Button>}
      </Stack>
    </Paper>
  );
}

// The files module: browse, make folders, upload, download and remove. Integrations use the same files (see their Files section).
export default function FilesPage() {
  const can = useCan();
  const notify = useNotify();
  const canManage = can('integrations.manage');
  const [params, setParams] = useSearchParams();
  const path = params.get('path') || '/';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [viewing, setViewing] = useState(null);

  const open = (p) => setParams(p === '/' ? {} : { path: p });
  const canView = (e) => canManage && e.kind === 'file' && TEXT_FILE.test(e.name) && e.size <= (data?.viewBytes ?? 0);

  async function view(e) {
    setError('');
    try {
      const { text } = await api(`${BASE}/view?path=${enc(e.path)}`);
      setViewing({ name: e.name, text });
    } catch (err) { setError(errorText(err)); }
  }
  const load = useCallback(() => api(`${BASE}/list?path=${enc(path)}`).then((d) => { setData(d); setError(''); }).catch((e) => { setData(null); setError(errorText(e)); }), [path]);
  useEffect(() => { load(); }, [load]);

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const res = await fetch(`/api${BASE}/upload?path=${enc(joinPath(path, file.name))}`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': await csrf() }, body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body.errors || [body.error || 'Upload failed.']).join(' '));
      notify(`${file.name} uploaded`);
      load();
    } catch (err) { setError(err.message); }
  }

  async function makeFolder() {
    setFolderOpen(false);
    try {
      await api(`${BASE}/folder`, { method: 'POST', body: { path: joinPath(path, folderName.trim()) } });
      notify(`${folderName.trim()} made`);
      setFolderName('');
      load();
    } catch (err) { setError(errorText(err)); }
  }

  async function remove() {
    const target = deleting;
    setDeleting(null);
    try {
      await api(`${BASE}/entry?path=${enc(target.path)}&recursive=${target.kind === 'dir' ? 'true' : 'false'}`, { method: 'DELETE' });
      notify(`${target.name} deleted`);
      load();
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Typography variant="h6" component="h2">Files</Typography>
        <Typography variant="body2" color="text.secondary">
          One place for the files integrations write and read, and for files other software exchanges over SFTP. Each integration has its own folder under
          <code> /integrations</code>; saved integration logs are under <code>/logs</code>. A file can be at most 10 MB.
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Crumbs path={path} onOpen={open} />
        </Stack>
      </Stack>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      {canManage && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" onClick={() => setFolderOpen(true)}>New folder</Button>
          <Button variant="outlined" component="label">Upload a file<input type="file" hidden onChange={upload} data-testid="file-input" /></Button>
        </Stack>
      )}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Files and folders">
          <TableHead><TableRow><TableCell>Name</TableCell><TableCell align="right">Size</TableCell><TableCell>Changed</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {path !== '/' && (
              <TableRow hover>
                <TableCell colSpan={4}><Link component="button" underline="none" onClick={() => open(parentOf(path))}>.. up</Link></TableCell>
              </TableRow>
            )}
            {data && !data.entries.length && <TableRow><TableCell colSpan={4}><Typography color="text.secondary">This folder is empty.</Typography></TableCell></TableRow>}
            {(data?.entries || []).map((e) => (
              <TableRow key={e.path}>
                <TableCell>
                  {e.kind === 'dir'
                    ? <Link component="button" underline="hover" onClick={() => open(e.path)} sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}><FolderIcon fontSize="small" />{e.name}</Link>
                    : <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}><InsertDriveFileIcon fontSize="small" />{e.name}</Box>}
                </TableCell>
                <TableCell align="right">{e.kind === 'dir' ? '' : `${e.size.toLocaleString()} bytes`}</TableCell>
                <TableCell>{e.updated_at && new Date(e.updated_at).toLocaleString()}{e.updated_by && ` by ${e.updated_by}`}</TableCell>
                <TableCell align="right">
                  {canView(e) && <Button size="small" onClick={() => view(e)}>View</Button>}
                  {e.kind === 'file' && canManage && <Button size="small" component="a" href={`/api${BASE}/download?path=${enc(e.path)}`}>Download</Button>}
                  {canManage && <Button size="small" color="error" onClick={() => setDeleting(e)}>Delete</Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="body2" color="text.secondary">
        Logs an integration saved are in <RouterLink to="/admin/integrations/logging">Integrations → Logging</RouterLink> and in <code>/logs</code> here.
      </Typography>

      <SftpServer canManage={canManage} />

      <TextViewDialog open={Boolean(viewing)} title={viewing?.name || ''} text={viewing?.text || ''} onClose={() => setViewing(null)} />

      <Dialog open={folderOpen} onClose={() => setFolderOpen(false)} fullWidth maxWidth="xs" aria-labelledby="new-folder-title">
        <DialogTitle id="new-folder-title">New folder in {path}</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth label="Name" value={folderName} onChange={(e) => setFolderName(e.target.value)} sx={{ mt: 1 }}
            onKeyDown={(e) => { if (e.key === 'Enter' && folderName.trim()) makeFolder(); }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFolderOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!folderName.trim()} onClick={makeFolder}>Make folder</Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog open={Boolean(deleting)} title={deleting?.kind === 'dir' ? 'Delete this folder?' : 'Delete this file?'} confirmLabel="Delete"
        message={deleting?.kind === 'dir' ? `${deleting?.name} and everything in it is deleted.` : `${deleting?.name} is deleted.`}
        onConfirm={remove} onClose={() => setDeleting(null)} />
    </Stack>
  );
}
