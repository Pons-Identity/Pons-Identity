import { useEffect, useState } from 'react';
import { Alert, Button, Paper, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { AccessPanel, AddMembersPanel, AuditPanel, ManagersPanel, MemberGroupsPanel, PipelinePanel, StructurePanel, atLeast, PRIVILEGE_LABELS } from '../components/GroupPanels.jsx';
import { useProductName } from '../auth/AuthContext.jsx';

const BASE = '/my/groups';

// One delegated group. What shows depends on the privilege the server reports for the signed-in person.
export default function MyGroup() {
  const productName = useProductName();
  const { id } = useParams();
  const [group, setGroup] = useState(null);
  const [privilege, setPrivilege] = useState('view');
  const [tab, setTab] = useState('members');
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const local = group?.source === 'local';

  useEffect(() => {
    api(BASE).then((all) => {
      const g = all.find((x) => x.id === Number(id));
      if (!g) throw new Error('No such group.');
      setGroup(g);
      setPrivilege(g.privilege);
    }).catch((e) => setError(e.message));
  }, [id]);

  async function removeMember(uid) {
    try {
      await api(`${BASE}/${id}/members/${uid}`, { method: 'DELETE' });
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    }
  }

  if (!group) return error ? <Alert severity="error">{error}</Alert> : null;
  const canRead = atLeast(privilege, 'read');

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">{group.name}</Typography>
      <Typography color="text.secondary">Your access: {PRIVILEGE_LABELS[privilege]}</Typography>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      {!local && <Alert severity="info">This group is managed outside {productName}, so it can only be viewed here.</Alert>}
      {!canRead && <Alert severity="info">You can see that this group exists. Ask a group administrator for read access to see its members.</Alert>}

      {canRead && (
        <>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto">
            <Tab value="members" label="Members" />
            {atLeast(privilege, 'admin') && local && <Tab value="access" label="Delegated access" />}
            {local && (group.manager || atLeast(privilege, 'admin')) && <Tab value="managers" label="Managers & attestation" />}
            <Tab value="history" label="History" />
          </Tabs>

          {tab === 'members' && (
            <Stack spacing={3}>
              <MemberList version={version} groupId={id} canRemove={local && atLeast(privilege, 'update')} onRemove={removeMember}
                privilege={privilege} local={local} onChanged={() => setVersion((v) => v + 1)} />
            </Stack>
          )}
          {tab === 'access' && <AccessPanel base={BASE} groupId={id} groupsPath={BASE} />}
          {tab === 'managers' && <ManagersPanel base={BASE} groupId={id} />}
          {tab === 'history' && <AuditPanel base={BASE} groupId={id} />}
        </>
      )}
    </Stack>
  );
}

// Direct members (removable with update access), then member groups and the effective membership.
function MemberList({ groupId, privilege, local, canRemove, onRemove, version, onChanged }) {
  const [direct, setDirect] = useState(null);
  useEffect(() => {
    if (local) api(`${BASE}/${groupId}/members`).then(setDirect).catch(() => setDirect([]));
  }, [groupId, local, version]);
  return (
    <Stack spacing={3}>
      <AddMembersPanel base={BASE} groupId={groupId} groupsPath={BASE} privilege={privilege} local={local} version={version} onChanged={onChanged} />
      {local && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead><TableRow><TableCell>Direct member</TableCell><TableCell>Name</TableCell><TableCell align="right" /></TableRow></TableHead>
            <TableBody>
              {direct && direct.length === 0 && <TableRow><TableCell colSpan={3}><Typography color="text.secondary">No direct members.</Typography></TableCell></TableRow>}
              {(direct || []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.username}</TableCell>
                  <TableCell>{m.display_name}</TableCell>
                  <TableCell align="right">{canRemove && <Button size="small" color="error" onClick={() => onRemove(m.id)}>Remove</Button>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <PipelinePanel base={BASE} groupId={groupId} privilege={privilege} local={local} />
      <MemberGroupsPanel base={BASE} groupId={groupId} privilege={privilege} local={local} version={version} onChanged={onChanged} />
      <StructurePanel base={BASE} groupId={groupId} groupsPath={BASE} privilege={privilege} local={local} />
    </Stack>
  );
}
