import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tab, Tabs, TextField, Typography } from '@mui/material';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useNotify } from '../../components/Notify.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { AccessPanel, AddMembersPanel, AuditPanel, ManagersPanel, MemberGroupsPanel, MembershipHow, PipelinePanel, RoleBadge, StructurePanel } from '../../components/GroupPanels.jsx';
import GroupRulePanel from '../../components/GroupRulePanel.jsx';
import { useCan } from '../../auth/permissions.js';
import SchedulePanel from '../../components/SchedulePanel.jsx';

export default function Group() {
  const { id } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const can = useCan();
  const [tab, setTab] = useState('members');
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const managed = data && data.group.source !== 'local';
  const pinnable = data?.group.source === 'grouper';
  const privilege = can('groups.manage') ? 'admin' : 'read';

  const load = useCallback(async () => {
    const [d, effective] = await Promise.all([api(`/admin/groups/${id}`), api(`/admin/groups/${id}/effective-members`)]);
    setData(d);
    setPeople(effective);
    setName(d.group.name);
    setDescription(d.group.description || '');
  }, [id]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  // Adding or removing members and member groups reloads the page; the panels refresh when `version` changes.
  function changed() {
    setVersion((v) => v + 1);
    load().catch((e) => setError(e.message));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      await api(`/admin/groups/${id}`, { method: 'PUT', body: { name, description } });
      notify('Group saved');
      await load();
    } catch (err) {
      setError(err.data?.errors?.join(' ') || err.message);
    }
  }

  async function removeMember(uid) {
    try {
      await api(`/admin/groups/${id}/members/${uid}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    try {
      await api(`/admin/groups/${id}`, { method: 'DELETE' });
      navigate('/admin/groups', { replace: true });
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button component={RouterLink} to="/admin/groups" size="small">← Groups</Button>
        <Typography variant="h5" component="h1">{data.group.name}</Typography>
        <Typography variant="body2" color="text.secondary" title="Use this number to refer to the group from a script, such as idp.groups.addMember">ID {data.group.id}</Typography>
        <RoleBadge role={data.role} />
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {managed && (
        <Alert severity="info">
          This group is provisioned by {pinnable ? 'Grouper' : 'an external directory'}, so its name and members can only be changed there. Deleting it here lasts only until it is next provisioned.{pinnable && ' You can pin extra members below: Grouper can never add, replace or remove them, so they keep this group, and any role or access it carries, even if a Grouper sync goes wrong.'}
        </Alert>
      )}

      <Card variant="outlined">
        <CardContent>
          <Stack component="form" spacing={2} onSubmit={save}>
            <TextField label="Name" required value={name} disabled={managed} onChange={(e) => setName(e.target.value)} />
            <TextField label="Description" value={description} disabled={managed} onChange={(e) => setDescription(e.target.value)} />
            <Stack direction="row" spacing={1}>
              {!managed && <Button type="submit" variant="contained">Save</Button>}
              <Button color="error" onClick={() => setConfirmDelete(true)}>Delete group</Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <PipelinePanel base="/admin/groups" groupId={id} privilege={privilege} local={!managed} />

      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto">
        <Tab value="members" label="Members" />
        <Tab value="structure" label="Composite & effective members" />
        {!managed && <Tab value="query" label="Membership query" />}
        {!managed && can('groups.manage') && <Tab value="access" label="Delegated access" />}
        <Tab value="managers" label="Managers & attestation" />
        <Tab value="history" label="History" />
      </Tabs>

      {tab === 'structure' && <StructurePanel base="/admin/groups" groupId={id} groupsPath="/admin/groups" privilege={privilege} local={!managed} />}
      {tab === 'query' && <GroupRulePanel groupId={id} canManage={can('groups.manage')} onChanged={() => load().catch((e) => setError(e.message))} />}
      {tab === 'access' && <AccessPanel base="/admin/groups" groupId={id} groupsPath="/admin/groups" />}
      {tab === 'managers' && <ManagersPanel base="/admin/groups" groupId={id} />}
      {tab === 'history' && <AuditPanel base="/admin/groups" groupId={id} />}

      {tab === 'members' && (<>
      {(!managed || pinnable) && (
        <AddMembersPanel version={version} base="/admin/groups" groupId={id} groupsPath="/admin/groups" privilege={privilege} local={!managed}
          people={pinnable ? data.candidates : undefined} pinning={pinnable} onChanged={changed} />
      )}
      <MemberGroupsPanel version={version} base="/admin/groups" groupId={id} privilege={privilege} local={!managed} onChanged={changed} />
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Username</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Membership</TableCell>
              <TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {people.length === 0 && (
              <TableRow><TableCell colSpan={4}><Typography color="text.secondary">No members yet.</Typography></TableCell></TableRow>
            )}
            {people.map((m) => {
              const pinned = data.members.find((d) => d.id === m.id)?.pinned;
              return (
                <TableRow key={m.id}>
                  <TableCell>{m.username}{pinnable && pinned ? <Chip label="Pinned" size="small" color="primary" sx={{ ml: 1 }} /> : null}</TableCell>
                  <TableCell>{m.display_name}</TableCell>
                  <TableCell><MembershipHow member={m} /></TableCell>
                  <TableCell align="right">
                    {m.direct && (!managed || pinned) && <Button size="small" color="error" onClick={() => removeMember(m.id)}>{pinnable ? 'Unpin' : 'Remove'}</Button>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      </>)}

      {can('users.schedule') && can('users.manage') && <SchedulePanel groupId={data.group.id} />}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete group?"
        message={`Members stay in the directory, but ${data.group.name} is removed from them.`}
        confirmLabel="Delete"
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </Stack>
  );
}
