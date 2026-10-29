import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, ListItemText, Menu, MenuItem,
  Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CalculateIcon from '@mui/icons-material/Calculate';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import GroupsIcon from '@mui/icons-material/Groups';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useSearchParams, Link as RouterLink } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useCan } from '../../auth/permissions.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { useNotify } from '../../components/Notify.jsx';
import { ListSearch, useSearchedList } from '../../components/ListSearch.jsx';
import { buildIndex, folderChoices, resolveDrop, visibleRows } from './groupTree.js';
import { RoleBadge } from '../../components/GroupPanels.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const OPEN_KEY = 'simpleidp.groupFolders.open';

function loadOpen() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null');
    return Array.isArray(saved) ? new Set(saved) : null;
  } catch { return null; }
}
const saveOpen = (set) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* optional */ } };

// Name + parent folder for a new folder, or just the name when renaming.
function FolderDialog({ state, choices, onClose, onSave }) {
  const [name, setName] = useState(state?.folder?.name || '');
  const [parent, setParent] = useState(state?.parentId ?? '');
  useEffect(() => { setName(state?.folder?.name || ''); setParent(state?.parentId ?? ''); }, [state]);
  return (
    <Dialog open={Boolean(state)} onClose={onClose} fullWidth maxWidth="xs" component="form"
      onSubmit={(e) => { e.preventDefault(); onSave({ name, parent_id: parent === '' ? null : parent }); }}>
      <DialogTitle>{state?.folder ? 'Rename folder' : 'New folder'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Folder name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
          {!state?.folder && (
            <TextField select label="Inside" value={parent} onChange={(e) => setParent(e.target.value)}>
              <MenuItem value="">Top level</MenuItem>
              {choices.map((c) => <MenuItem key={c.id} value={c.id}>{c.label}</MenuItem>)}
            </TextField>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="contained">{state?.folder ? 'Rename' : 'Create folder'}</Button>
      </DialogActions>
    </Dialog>
  );
}

// The keyboard- and touch-friendly alternative to dragging.
function MoveDialog({ node, choices, current, onClose, onMove }) {
  const [dest, setDest] = useState('');
  useEffect(() => { setDest(current ?? ''); }, [node, current]);
  return (
    <Dialog open={Boolean(node)} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Move “{node?.item.name}”</DialogTitle>
      <DialogContent>
        <TextField select fullWidth label="Move to" value={dest} onChange={(e) => setDest(e.target.value)} sx={{ mt: 1 }}>
          <MenuItem value="">Top level</MenuItem>
          {choices.map((c) => <MenuItem key={c.id} value={c.id}>{c.label}</MenuItem>)}
        </TextField>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => onMove(dest === '' ? null : dest)}>Move</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function Groups() {
  const can = useCan();
  const notify = useNotify();
  const manage = can('groups.manage');
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(null); // { kind, id }
  const [over, setOver] = useState(null); // { key, hint }
  const [menu, setMenu] = useState(null); // { anchor, node }
  const [folderDialog, setFolderDialog] = useState(null);
  const [moving, setMoving] = useState(null);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    api('/admin/group-folders/tree').then((t) => {
      setData(t);
      // Folders start open the first time; after that the last choice is remembered.
      setExpanded(loadOpen() || new Set(t.folders.map((f) => f.id)));
    }).catch((e) => setError(e.message));
  }, []);

  // While the search box has text, the page lists matching groups flat instead of the folder tree.
  const [params] = useSearchParams();
  const [text, setText] = useState(() => params.get('q') || '');
  const searching = text.trim() !== '';
  const { rows: matches, error: searchError } = useSearchedList('/admin/groups', text, { enabled: searching });

  const index = useMemo(() => buildIndex(data || { folders: [], groups: [] }), [data]);
  const treeRows = useMemo(() => visibleRows(index, expanded), [index, expanded]);
  const rows = searching ? (matches || []).map((item) => ({ kind: 'group', item, depth: 0 })) : treeRows;

  const toggle = (id) => setExpanded((cur) => {
    const next = new Set(cur);
    if (!next.delete(id)) next.add(id);
    saveOpen(next);
    return next;
  });

  async function run(fn, done) {
    setError('');
    try {
      const out = await fn();
      if (out) setData(out);
      if (done) notify(done);
    } catch (err) { setError(errorText(err)); }
  }
  const move = (kind, id, dest) => run(() => api('/admin/group-folders/move', { method: 'POST', body: { type: kind, id, ...dest } }));
  const reload = () => api('/admin/group-folders/tree');

  const createFolder = ({ name: n, parent_id: p }) => {
    setFolderDialog(null);
    run(async () => {
      const f = await api('/admin/group-folders', { method: 'POST', body: { name: n, parent_id: p } });
      if (p !== null) setExpanded((cur) => new Set(cur).add(p));
      setExpanded((cur) => new Set(cur).add(f.id));
      return reload();
    }, 'Folder created');
  };
  const renameFolder = (folder, { name: n }) => {
    setFolderDialog(null);
    run(async () => { await api(`/admin/group-folders/${folder.id}`, { method: 'PUT', body: { name: n } }); return reload(); }, 'Folder renamed');
  };
  const deleteFolder = (folder) => {
    setDeleting(null);
    run(async () => { await api(`/admin/group-folders/${folder.id}`, { method: 'DELETE' }); return reload(); }, 'Folder deleted');
  };

  /* Drag and drop */

  const dropFor = (target, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return resolveDrop(index, expanded, drag, target, rect.height ? (e.clientY - rect.top) / rect.height : 0.5);
  };
  const dragProps = (kind, item) => (!manage ? {} : {
    draggable: true,
    onDragStart: (e) => {
      setDrag({ kind, id: item.id });
      e.dataTransfer?.setData('text/plain', `${kind}:${item.id}`);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => { setDrag(null); setOver(null); },
    onDragOver: (e) => {
      const drop = dropFor({ kind, id: item.id }, e);
      if (!drop) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      setOver((cur) => (cur?.key === `${kind}:${item.id}` && cur.hint === drop.hint ? cur : { key: `${kind}:${item.id}`, hint: drop.hint }));
    },
    onDrop: (e) => {
      const drop = dropFor({ kind, id: item.id }, e);
      e.preventDefault();
      const d = drag;
      setDrag(null); setOver(null);
      if (!drop || !d) return;
      const { hint, ...dest } = drop;
      if (hint === 'into' && dest.parent_id !== null) setExpanded((cur) => new Set(cur).add(dest.parent_id));
      move(d.kind, d.id, dest);
    },
  });

  const edge = (key) => {
    if (over?.key !== key) return {};
    if (over.hint === 'into') return { bgcolor: 'action.selected', outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '-2px' };
    return { boxShadow: (t) => `inset 0 ${over.hint === 'before' ? 2 : -2}px 0 ${t.palette.primary.main}` };
  };

  const openMenu = (e, node) => { e.preventDefault(); e.stopPropagation(); setMenu({ anchor: e.currentTarget, node }); };
  const closeMenu = () => setMenu(null);
  const node = menu?.node;

  return (
    <Stack spacing={3}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography variant="h5" component="h1">Groups</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" component={RouterLink} to="/admin/groups/calculator" startIcon={<CalculateIcon />}>Group calculator</Button>
          {manage && <Button variant="contained" component={RouterLink} to="/admin/groups/new" startIcon={<AddIcon />}>New group</Button>}
        </Stack>
      </Stack>
      {(error || searchError) && <Alert severity="error" onClose={() => setError('')}>{error || searchError}</Alert>}

      <ListSearch label="Search groups" value={text} onChange={setText} helperText="Name or description." />
      <Stack direction="row" spacing={2} alignItems="center">
        {manage && <Button variant="outlined" startIcon={<FolderIcon />} onClick={() => setFolderDialog({ parentId: '' })}>New folder</Button>}
        <Typography variant="body2" color="text.secondary">
          {manage ? 'Drag groups and folders to organize them, or use the row menu. Folders only file groups; names and access are unchanged.' : 'Groups are organized in folders.'}
        </Typography>
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Groups">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell align="right">ID</TableCell>
              <TableCell>Description</TableCell>
              <TableCell align="right">Direct</TableCell>
              <TableCell align="right">Effective</TableCell>
              {manage && <TableCell padding="checkbox"><span style={{ position: 'absolute', left: -9999 }}>Actions</span></TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {manage && drag && (
              <TableRow
                onDragOver={(e) => { if (resolveDrop(index, expanded, drag, 'root')) { e.preventDefault(); setOver({ key: 'root', hint: 'into' }); } }}
                onDrop={(e) => { e.preventDefault(); const d = drag; setDrag(null); setOver(null); if (d) move(d.kind, d.id, { parent_id: null }); }}
                sx={edge('root')}
              >
                <TableCell colSpan={6}><Typography variant="body2" color="text.secondary">Drop here to move to the top level</Typography></TableCell>
              </TableRow>
            )}
            {rows.length === 0 && data && (
              <TableRow><TableCell colSpan={6}><Typography color="text.secondary">{searching ? 'No groups match.' : 'No groups yet.'}</Typography></TableCell></TableRow>
            )}
            {rows.map(({ kind, item, depth }) => {
              const key = `${kind}:${item.id}`;
              const open = kind === 'folder' && expanded.has(item.id);
              return (
                <TableRow key={key} hover {...dragProps(kind, item)} sx={{ ...edge(key), cursor: manage ? 'grab' : 'default', opacity: drag?.kind === kind && drag.id === item.id ? 0.5 : 1 }}>
                  <TableCell sx={{ pl: 2 + depth * 3 }}>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      {kind === 'folder' ? (
                        <>
                          <IconButton size="small" onClick={() => toggle(item.id)} aria-label={`${open ? 'Collapse' : 'Expand'} ${item.name}`} aria-expanded={open}>
                            {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                          </IconButton>
                          {open ? <FolderOpenIcon fontSize="small" color="primary" /> : <FolderIcon fontSize="small" color="primary" />}
                          <Typography component="span" fontWeight={500} onClick={() => toggle(item.id)} sx={{ cursor: 'pointer' }}>{item.name}</Typography>
                        </>
                      ) : (
                        <>
                          <Box sx={{ width: 28 }} />
                          <GroupsIcon fontSize="small" color="action" />
                          <Typography component={RouterLink} to={`/admin/groups/${item.id}`} color="inherit" sx={{ textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }} draggable={false}>
                            {item.name}
                          </Typography>
                          <RoleBadge role={item.role} />
                          {item.source !== 'local' && <Chip label={item.source === 'grouper' ? 'Grouper' : 'Directory'} size="small" sx={{ ml: 1 }} />}
                        </>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">{kind === 'group' ? item.id : ''}</TableCell>
                  <TableCell>{item.description}</TableCell>
                  <TableCell align="right">{kind === 'group' ? item.member_count : ''}</TableCell>
                  <TableCell align="right">{kind === 'group' ? item.effective_count : ''}</TableCell>
                  {manage && (
                    <TableCell padding="checkbox">
                      <IconButton size="small" aria-label={`Actions for ${item.name}`} onClick={(e) => openMenu(e, { kind, item })}><MoreVertIcon fontSize="small" /></IconButton>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Menu open={Boolean(menu)} anchorEl={menu?.anchor} onClose={closeMenu}>
        <MenuItem onClick={() => { setMoving(node); closeMenu(); }}><ListItemText>Move to…</ListItemText></MenuItem>
        {node?.kind === 'folder' && <MenuItem onClick={() => { setFolderDialog({ folder: node.item }); closeMenu(); }}><ListItemText>Rename</ListItemText></MenuItem>}
        {node?.kind === 'folder' && <MenuItem onClick={() => { setFolderDialog({ parentId: node.item.id }); closeMenu(); }}><ListItemText>New subfolder</ListItemText></MenuItem>}
        {node?.kind === 'folder' && <MenuItem onClick={() => { setDeleting(node.item); closeMenu(); }}><ListItemText>Delete folder</ListItemText></MenuItem>}
      </Menu>

      <FolderDialog
        state={folderDialog}
        choices={folderChoices(index)}
        onClose={() => setFolderDialog(null)}
        onSave={(v) => (folderDialog.folder ? renameFolder(folderDialog.folder, v) : createFolder(v))}
      />
      <MoveDialog
        node={moving}
        choices={folderChoices(index, moving?.kind === 'folder' ? moving.item.id : null)}
        current={moving ? (moving.kind === 'folder' ? moving.item.parent_id : moving.item.folder_id) : null}
        onClose={() => setMoving(null)}
        onMove={(dest) => { const m = moving; setMoving(null); if (dest !== null) setExpanded((cur) => new Set(cur).add(dest)); move(m.kind, m.item.id, { parent_id: dest }); }}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this folder?"
        message={deleting ? `“${deleting.name}” is removed. The groups and folders inside it are kept and move up one level.` : ''}
        confirmLabel="Delete folder"
        onConfirm={() => deleteFolder(deleting)}
        onClose={() => setDeleting(null)}
      />
    </Stack>
  );
}
