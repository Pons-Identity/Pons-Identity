import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Autocomplete, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { api } from '../api/client.js';
import { useNotify } from './Notify.jsx';
import MultiCombobox from './MultiCombobox.jsx';

// Panels shared by the admin console's group page and "My groups". `base` is the API prefix that serves the group
// routes: '/admin/groups' or '/my/groups'. The server enforces privileges; panels are shown only where they apply.

export const PRIVILEGES = ['view', 'read', 'update', 'admin'];
export const SELF_SERVICE = ['optin', 'optout'];
export const PRIVILEGE_LABELS = { view: 'View', read: 'Read', update: 'Update', admin: 'Admin', optin: 'Join themselves', optout: 'Leave themselves' };
export const atLeast = (held, needed) => PRIVILEGES.indexOf(held) >= PRIVILEGES.indexOf(needed);

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const stamp = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '');
// <input type="datetime-local"> works in local time without a zone suffix.
const toInput = (sec) => (sec ? new Date(sec * 1000 - new Date(sec * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromInput = (v) => (v ? Math.floor(new Date(v).getTime() / 1000) : null);

/** How someone is in a group, in words: Direct, Indirect or Direct, Indirect, with what they came in through. */
export function MembershipHow({ member }) {
  const how = member.how || (member.direct ? 'Direct' : 'Indirect');
  const notes = [];
  if (member.by_rule) notes.push('added by the group\'s query');
  if (member.via?.length) notes.push(member.composite ? `through ${member.composite === 'union' ? 'either' : member.composite === 'intersect' ? 'both' : 'the first'} of ${member.via.map((v) => v).join(' and ')}` : `through member group${member.via.length === 1 ? '' : 's'} ${member.via.join(', ')}`);
  return (
    <>
      <Typography variant="body2" component="span" sx={{ fontWeight: 500 }}>{how}</Typography>
      {notes.length > 0 && <Typography variant="caption" color="text.secondary" display="block">{notes.join('; ')}</Typography>}
    </>
  );
}

function useStructure(base, groupId) {
  const [structure, setStructure] = useState(null);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api(`${base}/${groupId}/structure`), api(`${base}/${groupId}/effective-members`)]);
      setStructure(s);
      setMembers(m);
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  }, [base, groupId]);
  useEffect(() => { reload(); }, [reload]);
  return { structure, members, error, setError, reload };
}

function GroupPicker({ label, options, value, onChange }) {
  return (
    <Autocomplete size="small" sx={{ minWidth: 220, flex: 1 }} options={options} value={value} onChange={(_, v) => onChange(v)}
      getOptionLabel={(o) => o.name} isOptionEqualToValue={(a, b) => a.id === b.id}
      renderInput={(params) => <TextField {...params} label={label} />} />
  );
}

function WindowDialog({ member, onClose, onSave }) {
  const [start, setStart] = useState(toInput(member.start_at));
  const [end, setEnd] = useState(toInput(member.end_at));
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Membership dates for {member.username}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField type="datetime-local" label="Starts" value={start} onChange={(e) => setStart(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} helperText="Leave empty to start now." />
          <TextField type="datetime-local" label="Ends" value={end} onChange={(e) => setEnd(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} helperText="Leave empty for no end date." />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => onSave(fromInput(start), fromInput(end))}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Groups added as members of this group. A member group is a direct member, so its members are indirect members of this
 * group. A composite group takes its members from two groups instead, so it has none.
 */
export function MemberGroupsPanel({ base, groupId, privilege, local = true, version = 0, onChanged }) {
  const notify = useNotify();
  const [structure, setStructure] = useState(null);
  const [error, setError] = useState('');
  const canAdmin = local && atLeast(privilege, 'admin');

  const reload = useCallback(() => api(`${base}/${groupId}/structure`).then(setStructure).catch((e) => setError(errorText(e))), [base, groupId]);
  useEffect(() => { reload(); }, [reload, version]);

  async function remove(g) {
    try {
      await api(`${base}/${groupId}/includes/${g.id}`, { method: 'DELETE' });
      notify('Member group removed');
      setError('');
      await reload();
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (!structure || structure.composite) return error ? <Alert severity="error">{error}</Alert> : null;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="subtitle1">Member groups</Typography>
          <Typography variant="body2" color="text.secondary">
            A member group is a direct member of this group. Its members are indirect members of this group too, and stay so as that group changes.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          {structure.includes.length === 0 && <Typography color="text.secondary">No member groups.</Typography>}
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {structure.includes.map((g) => (
              <Chip key={g.id} label={g.name} onDelete={canAdmin ? () => remove(g) : undefined} />
            ))}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

const byKind = (list) => [...list.filter((o) => o.kind === 'Groups'), ...list.filter((o) => o.kind === 'People')];

/**
 * One box for adding people and groups as members. Typing searches both: people are added directly, and a group becomes a
 * member group. `people`, when given, is the list to pick people from instead of a search; a Grouper group's members are
 * pinned that way, with `pinning` set, and groups are not offered.
 */
export function AddMembersPanel({ base, groupId, groupsPath, privilege, local = true, people: suppliedPeople, pinning = false, version = 0, onChanged }) {
  const notify = useNotify();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState([]);
  const [groups, setGroups] = useState([]);
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');
  const known = useRef(new Map());
  const canPeople = pinning || (local && atLeast(privilege, 'update'));
  const canGroups = local && !pinning && atLeast(privilege, 'admin');
  const searching = !suppliedPeople;
  const needle = query.trim().toLowerCase();

  // Each search waits briefly for typing to pause; a late answer to an older search is dropped.
  useEffect(() => {
    if (!searching || !canPeople) return undefined;
    let current = true;
    const t = setTimeout(() => {
      api(`${base}/${groupId}/candidates?q=${encodeURIComponent(query.trim())}`).then((r) => current && setFound(r)).catch(() => {});
    }, 200);
    return () => { current = false; clearTimeout(t); };
  }, [searching, canPeople, base, groupId, query]);

  // Groups already members, this group itself, and groups that depend on it (adding one would make a loop) are not offered.
  useEffect(() => {
    if (!canGroups) return;
    Promise.all([api(groupsPath), api(`${base}/${groupId}/structure`)])
      .then(([all, s]) => {
        const blocked = new Set([...s.includes.map((g) => g.id), ...s.would_loop]);
        setGroups(all.filter((g) => g.id !== Number(groupId) && !blocked.has(g.id)));
      })
      .catch(() => {});
  }, [canGroups, groupsPath, base, groupId, version]);

  if (!canPeople && !canGroups) return null;

  const groupOptions = groups.filter((g) => g.name.toLowerCase().includes(needle))
    .map((g) => ({ id: `g:${g.id}`, label: g.name, kind: 'Groups' }));
  const peopleList = searching ? found : (suppliedPeople || []).filter((u) => `${u.username} ${u.display_name || ''}`.toLowerCase().includes(needle));
  const personOptions = peopleList.map((u) => ({ id: `u:${u.id}`, label: u.username, secondary: u.display_name || '', kind: 'People' }));
  const fresh = [...groupOptions, ...personOptions];
  fresh.forEach((o) => known.current.set(o.id, o));
  // Picked choices stay in the list even when the search no longer returns them, so their chips still show.
  const extra = picked.map((id) => known.current.get(id)).filter((o) => o && !fresh.some((f) => f.id === o.id));
  const options = byKind([...fresh, ...extra]);

  async function add() {
    const userIds = picked.filter((id) => id.startsWith('u:')).map((id) => Number(id.slice(2)));
    const groupIds = picked.filter((id) => id.startsWith('g:')).map((id) => Number(id.slice(2)));
    try {
      if (userIds.length) await api(`${base}/${groupId}/members`, { method: 'POST', body: { user_ids: userIds } });
      for (const id of groupIds) await api(`${base}/${groupId}/includes`, { method: 'POST', body: { group_id: id } });
      const parts = [
        userIds.length && `${userIds.length} ${userIds.length === 1 ? 'person' : 'people'}`,
        groupIds.length && `${groupIds.length} member ${groupIds.length === 1 ? 'group' : 'groups'}`,
      ].filter(Boolean);
      notify(`${pinning ? 'Pinned' : 'Added'} ${parts.join(' and ')}`);
      setPicked([]);
      setError('');
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="subtitle1" component="h2">{pinning ? 'Pin members' : 'Add'}</Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <MultiCombobox label={canGroups ? 'People and groups' : 'People'} placeholder="Type a name, username or group"
            serverFiltered groupBy={(o) => o.kind} options={options} value={picked} onChange={setPicked}
            inputValue={query} onInputChange={(text) => setQuery(text)}
            helperText={canGroups ? 'A group is added as a member group: its members become indirect members of this group.' : undefined} />
          <Button variant="outlined" disabled={picked.length === 0} onClick={add} sx={{ alignSelf: 'flex-start' }}>
            {pinning ? 'Pin selected' : 'Add selected'}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

/** The composite definition, the groups this group is a member of, and the resulting effective members. */
export function StructurePanel({ base, groupId, groupsPath, privilege, local = true }) {
  const notify = useNotify();
  const { structure, members, error, setError, reload } = useStructure(base, groupId);
  const [candidates, setCandidates] = useState([]);
  const [op, setOp] = useState('union');
  const [left, setLeft] = useState(null);
  const [right, setRight] = useState(null);
  const [editing, setEditing] = useState(null);
  const canAdmin = local && atLeast(privilege, 'admin');
  const canUpdate = local && atLeast(privilege, 'update');

  useEffect(() => {
    if (canAdmin) api(groupsPath).then((all) => setCandidates(all.filter((g) => g.id !== Number(groupId)))).catch(() => {});
  }, [canAdmin, groupsPath, groupId]);

  async function act(fn, done) {
    try {
      await fn();
      if (done) notify(done);
      setError('');
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (!structure) return error ? <Alert severity="error">{error}</Alert> : null;
  const composite = structure.composite;

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}

      {canAdmin && structure.includes.length === 0 && (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="subtitle1">Composite</Typography>
              {composite ? (
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography>Members are <strong>{composite.left.name}</strong> {composite.op} <strong>{composite.right.name}</strong>.</Typography>
                  <Button size="small" color="error" onClick={() => act(() => api(`${base}/${groupId}/composite`, { method: 'DELETE' }), 'Composite removed')}>Remove composite</Button>
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">Instead of listing members, derive them from two other groups. This group must have no direct members.</Typography>
              )}
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                <GroupPicker label="First group" options={candidates} value={left} onChange={setLeft} />
                <TextField select size="small" label="Operation" value={op} onChange={(e) => setOp(e.target.value)} sx={{ minWidth: 220 }}>
                  <MenuItem value="union">in either (union)</MenuItem>
                  <MenuItem value="intersect">in both (intersection)</MenuItem>
                  <MenuItem value="minus">in first but not second (complement)</MenuItem>
                </TextField>
                <GroupPicker label="Second group" options={candidates} value={right} onChange={setRight} />
                <Button variant="outlined" disabled={!left || !right}
                  onClick={() => act(() => api(`${base}/${groupId}/composite`, { method: 'PUT', body: { op, left_id: left.id, right_id: right.id } }), 'Composite saved')}>
                  {composite ? 'Replace' : 'Make composite'}
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      )}

      {structure.included_in.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
          <Typography variant="subtitle2">Member of:</Typography>
          {structure.included_in.map((g) => <Chip key={g.id} label={g.name} size="small" variant="outlined" />)}
        </Stack>
      )}

      <Typography variant="h6" component="h2">Effective members ({structure.effective_count})</Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow><TableCell>Username</TableCell><TableCell>Name</TableCell><TableCell>How</TableCell><TableCell>Dates</TableCell><TableCell align="right" /></TableRow>
          </TableHead>
          <TableBody>
            {members.length === 0 && <TableRow><TableCell colSpan={5}><Typography color="text.secondary">No effective members.</Typography></TableCell></TableRow>}
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.username}</TableCell>
                <TableCell>{m.display_name}</TableCell>
                <TableCell><MembershipHow member={m} /></TableCell>
                <TableCell>{m.start_at ? `from ${stamp(m.start_at)} ` : ''}{m.end_at ? `until ${stamp(m.end_at)}` : ''}</TableCell>
                <TableCell align="right">{canUpdate && m.direct && <Button size="small" onClick={() => setEditing(m)}>Dates</Button>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {editing && (
        <WindowDialog member={editing} onClose={() => setEditing(null)}
          onSave={(start_at, end_at) => act(() => api(`${base}/${groupId}/members/${editing.id}/window`, { method: 'PUT', body: { start_at, end_at } }), 'Dates saved').then(() => setEditing(null))} />
      )}
    </Stack>
  );
}

/** Who may see or manage this group. */
export function AccessPanel({ base, groupId, groupsPath }) {
  const notify = useNotify();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [type, setType] = useState('user');
  const [privilege, setPrivilege] = useState('update');
  const everyone = type === 'everyone';
  const privilegeChoices = everyone ? SELF_SERVICE : [...PRIVILEGES, ...SELF_SERVICE];
  const [subject, setSubject] = useState(null);
  const [options, setOptions] = useState([]);
  const [input, setInput] = useState('');

  const load = useCallback(() => api(`${base}/${groupId}/admins`).then(setRows).catch((e) => setError(errorText(e))), [base, groupId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setSubject(null);
    if (type === 'everyone') return undefined;
    if (type === 'group') {
      api(groupsPath).then((all) => setOptions(all.map((g) => ({ id: g.id, name: g.name })))).catch(() => {});
      return undefined;
    }
    const t = setTimeout(() => {
      api(`${base}/${groupId}/people?q=${encodeURIComponent(input)}`)
        .then((p) => setOptions(p.map((u) => ({ id: u.id, name: u.display_name ? `${u.username} (${u.display_name})` : u.username }))))
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [type, input, base, groupId, groupsPath]);

  async function grant() {
    try {
      setRows(await api(`${base}/${groupId}/admins`, { method: 'POST', body: { subject_type: type, subject_id: everyone ? 0 : subject.id, privilege } }));
      setSubject(null);
      setError('');
      notify('Access granted');
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function revoke(id) {
    try {
      setRows(await api(`${base}/${groupId}/admins/${id}`, { method: 'DELETE' }));
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}
      <Typography variant="body2" color="text.secondary">
        <strong>View</strong> sees that the group exists. <strong>Read</strong> also sees members and history. <strong>Update</strong> adds and removes members and sets dates.
        <strong> Admin</strong> also adds member groups, builds composites and grants these privileges. <strong>Join themselves</strong> and <strong>Leave themselves</strong> let
        people add or remove only their own membership, which makes the group self-service; grant them to everyone for an open group. Granting to a group covers everyone in it, including the members of its member groups.
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead><TableRow><TableCell>Who</TableCell><TableCell>Privilege</TableCell><TableCell align="right" /></TableRow></TableHead>
          <TableBody>
            {rows && rows.length === 0 && <TableRow><TableCell colSpan={3}><Typography color="text.secondary">Nobody has been delegated access.</Typography></TableCell></TableRow>}
            {(rows || []).map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.subject_name}{r.subject_type !== 'everyone' && <Chip label={r.subject_type === 'group' ? 'Group' : 'Person'} size="small" sx={{ ml: 1 }} />}</TableCell>
                <TableCell>{PRIVILEGE_LABELS[r.privilege]}</TableCell>
                <TableCell align="right"><Button size="small" color="error" onClick={() => revoke(r.id)}>Revoke</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Card variant="outlined">
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <TextField select size="small" label="Grant to" value={type} sx={{ minWidth: 120 }}
              onChange={(e) => { setType(e.target.value); if (e.target.value === 'everyone' && !SELF_SERVICE.includes(privilege)) setPrivilege('optin'); }}>
              <MenuItem value="user">Person</MenuItem>
              <MenuItem value="group">Group</MenuItem>
              <MenuItem value="everyone">Everyone</MenuItem>
            </TextField>
            {!everyone && (
              <Autocomplete size="small" sx={{ flex: 1, minWidth: 220 }} options={options} value={subject} onChange={(_, v) => setSubject(v)}
                onInputChange={(_, v, reason) => { if (reason === 'input') setInput(v); }}
                getOptionLabel={(o) => o.name} isOptionEqualToValue={(a, b) => a.id === b.id} filterOptions={(o) => o}
                renderInput={(params) => <TextField {...params} label={type === 'user' ? 'Search people' : 'Group'} />} />
            )}
            <TextField select size="small" label="Privilege" value={privilege} onChange={(e) => setPrivilege(e.target.value)} sx={{ minWidth: 180 }}>
              {privilegeChoices.map((p) => <MenuItem key={p} value={p}>{PRIVILEGE_LABELS[p]}</MenuItem>)}
            </TextField>
            <Button variant="outlined" disabled={!everyone && !subject} onClick={grant}>Grant</Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

const FREQUENCY_LABELS = { monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' };
const STATUS_LABELS = { overdue: { label: 'Overdue', color: 'error' }, due_soon: { label: 'Due soon', color: 'warning' }, ok: { label: 'Up to date', color: 'success' } };
const day = (sec) => (sec ? new Date(sec * 1000).toLocaleDateString() : '');

/** Group managers, who attest to the membership, and the attestation schedule. */
export function ManagersPanel({ base, groupId }) {
  const notify = useNotify();
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  const [person, setPerson] = useState(null);
  const [options, setOptions] = useState([]);
  const [input, setInput] = useState('');
  const [frequency, setFrequency] = useState('quarterly');
  const [firstDue, setFirstDue] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState([]);

  const load = useCallback(() => api(`${base}/${groupId}/attestation`).then((v) => {
    setView(v);
    if (v.schedule) setFrequency(v.schedule.frequency);
    return api(`${base}/${groupId}/attestations`).then(setHistory).catch(() => {});
  }).catch((e) => setError(errorText(e))), [base, groupId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!view?.can_configure) return undefined;
    const t = setTimeout(() => {
      api(`${base}/${groupId}/people?q=${encodeURIComponent(input)}`)
        .then((p) => setOptions(p.map((u) => ({ id: u.id, name: u.display_name ? `${u.username} (${u.display_name})` : u.username }))))
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [input, base, groupId, view?.can_configure]);

  // Runs a change, shows its result and reloads the panel.
  async function run(fn, done) {
    try {
      await fn();
      if (done) notify(done);
      setError('');
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (!view) return error ? <Alert severity="error">{error}</Alert> : null;
  const { managers, schedule, last, can_attest: canAttest, can_configure: canConfigure } = view;
  const assigned = new Set(managers.map((m) => m.id));

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      <Typography variant="body2" color="text.secondary">
        Group managers look after this group&apos;s membership and attest, on a schedule, that it is still right. An administrator or a person with admin access
        to the group appoints them and sets how often they attest.
      </Typography>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="subtitle1">Group managers</Typography>
            {managers.length === 0 && <Typography color="text.secondary">No group managers.</Typography>}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {managers.map((m) => (
                <Chip key={m.id} label={m.username} onDelete={canConfigure ? () => run(() => api(`${base}/${groupId}/managers/${m.id}`, { method: 'DELETE' }), 'Manager removed') : undefined} />
              ))}
            </Stack>
            {canConfigure && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <Autocomplete size="small" sx={{ flex: 1 }} options={options.filter((o) => !assigned.has(o.id))} value={person} onChange={(_, v) => setPerson(v)}
                  onInputChange={(_, v, reason) => { if (reason === 'input') setInput(v); }}
                  getOptionLabel={(o) => o.name} isOptionEqualToValue={(a, b) => a.id === b.id} filterOptions={(o) => o}
                  renderInput={(params) => <TextField {...params} label="Add a manager" />} />
                <Button variant="outlined" disabled={!person}
                  onClick={() => run(() => api(`${base}/${groupId}/managers`, { method: 'POST', body: { user_id: person.id } }).then(() => setPerson(null)), 'Manager added')}>
                  Add
                </Button>
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle1">Attestation</Typography>
              {schedule && <Chip size="small" color={STATUS_LABELS[schedule.status].color} label={STATUS_LABELS[schedule.status].label} />}
            </Stack>
            {schedule ? (
              <Typography>
                {FREQUENCY_LABELS[schedule.frequency]}. Next due {day(schedule.next_due)}.
                {last && ` Last attested ${day(last.ts)} by ${last.attested_by}.`}
              </Typography>
            ) : (
              <Typography color="text.secondary">No attestation schedule.</Typography>
            )}

            {canConfigure && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                <TextField select size="small" label="Frequency" value={frequency} onChange={(e) => setFrequency(e.target.value)} sx={{ minWidth: 160 }}>
                  {Object.entries(FREQUENCY_LABELS).map(([k, label]) => <MenuItem key={k} value={k}>{label}</MenuItem>)}
                </TextField>
                <TextField size="small" type="date" label="First due" value={firstDue} onChange={(e) => setFirstDue(e.target.value)}
                  slotProps={{ inputLabel: { shrink: true } }} helperText="Leave empty to count one period from now or the last attestation." />
                <Button variant="outlined" onClick={() => run(() => api(`${base}/${groupId}/attestation`, { method: 'PUT', body: { frequency, first_due: firstDue ? fromInput(`${firstDue}T12:00`) : null } }), 'Schedule saved')}>
                  {schedule ? 'Save schedule' : 'Set schedule'}
                </Button>
                {schedule && <Button color="error" onClick={() => run(() => api(`${base}/${groupId}/attestation`, { method: 'DELETE' }), 'Schedule removed')}>Remove schedule</Button>}
              </Stack>
            )}

            {canAttest && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <TextField size="small" label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} sx={{ flex: 1 }} />
                <Button variant="contained" onClick={() => run(() => api(`${base}/${groupId}/attest`, { method: 'POST', body: { note } }).then(() => setNote('')), 'Membership attested')}>
                  Attest membership
                </Button>
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Typography variant="h6" component="h2">Attestation history</Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead><TableRow><TableCell>When</TableCell><TableCell>Attested by</TableCell><TableCell>Members</TableCell><TableCell>Note</TableCell></TableRow></TableHead>
          <TableBody>
            {history.length === 0 && <TableRow><TableCell colSpan={4}><Typography color="text.secondary">Nothing attested yet.</Typography></TableCell></TableRow>}
            {history.map((a) => (
              <TableRow key={a.id}>
                <TableCell>{stamp(a.ts)}</TableCell>
                <TableCell>{a.attested_by}</TableCell>
                <TableCell title={a.members.join(', ')}>{a.member_count}</TableCell>
                <TableCell>{a.note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}

const ACTIONS = {
  'group.create': 'created the group', 'group.update': 'edited the group', 'group.delete': 'deleted the group',
  'member.add': 'added member', 'member.remove': 'removed member', 'member.window': 'changed dates for',
  'include.add': 'added member group', 'include.remove': 'removed member group', 'composite.set': 'set composite',
  'composite.remove': 'removed composite', 'admin.grant': 'granted', 'admin.revoke': 'revoked',
  'member.expire': 'membership ended for', 'member.join': 'joined the group', 'member.leave': 'left the group', cutover: 'handed the group to Grouper',
};

export function AuditPanel({ base, groupId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`${base}/${groupId}/audit`).then(setRows).catch((e) => setError(errorText(e))); }, [base, groupId]);
  if (error) return <Alert severity="error">{error}</Alert>;
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead><TableRow><TableCell>When</TableCell><TableCell>Who</TableCell><TableCell>What</TableCell></TableRow></TableHead>
        <TableBody>
          {rows && rows.length === 0 && <TableRow><TableCell colSpan={3}><Typography color="text.secondary">No changes recorded yet.</Typography></TableCell></TableRow>}
          {(rows || []).map((r) => (
            <TableRow key={r.id}>
              <TableCell>{stamp(r.ts)}</TableCell>
              <TableCell>{r.actor}</TableCell>
              <TableCell>{ACTIONS[r.action] || r.action}{r.detail ? ` ${r.detail}` : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// Where a group sits in the pipeline that builds application groups, as Grouper describes it.
const ROLES = {
  basis: { label: 'Basis', title: 'Basis: a system of record. Its members come from a source, and other groups are built from it.' },
  reference: { label: 'Reference', title: 'Reference: an intermediate group, built from other groups and used to build another.' },
  application: { label: 'Application', title: 'Application: nothing is built from this group, and applications read it.' },
};

/** The badge saying which stage of the pipeline a group is. */
export function RoleBadge({ role }) {
  const r = ROLES[role];
  if (!r) return null;
  return <Chip size="small" variant="outlined" color={role === 'application' ? 'primary' : role === 'reference' ? 'secondary' : 'default'} label={r.label} title={r.title} sx={{ ml: 1 }} />;
}

const OP_WORDS = { union: 'or', intersect: 'and', minus: 'but not' };

// One step's inputs in words: what it is made of, then what is added to or taken from it.
function describeStep(step) {
  const words = (i) => (i.relation === 'direct' ? 'direct members' : i.relation === 'query' ? `people matching ${i.filter}` : i.group.name);
  const base = step.op
    ? step.inputs.filter((i) => i.relation === 'left' || i.relation === 'right').map((i) => i.group.name).join(` ${OP_WORDS[step.op]} `)
    : step.inputs.filter((i) => i.relation === 'direct' || i.relation === 'nested' || i.relation === 'query').map(words).join(', ');
  const changes = step.inputs.filter((i) => i.relation === 'include' || i.relation === 'exclude')
    .map((i) => (i.relation === 'include' ? `plus ${i.group.name}` : `minus ${i.group.name}`));
  return [base, ...changes].filter(Boolean).join(', ') || 'nothing yet';
}

/**
 * How a group's membership is built, in the order Grouper's pipeline builds it: basis groups first, then reference groups,
 * then this group. Also offers to make include and exclude groups when a group has none (a name clash stopped them).
 */
export function PipelinePanel({ base, groupId, privilege, local = true }) {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const canAdmin = local && atLeast(privilege, 'admin');

  const load = useCallback(() => Promise.all([api(`${base}/${groupId}/pipeline`), api(`${base}/${groupId}/structure`)])
    .then(([pipe, structure]) => setData({ ...pipe, hasPair: Boolean(structure.include_exclude) }))
    .catch((e) => setError(errorText(e))), [base, groupId]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    setError('');
    try {
      await api(`${base}/${groupId}/include-exclude`, { method: 'POST', body: {} });
      notify('Include and exclude groups created');
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (!local || !data) return error ? <Alert severity="error">{error}</Alert> : null;
  const steps = data.steps || [];
  const last = steps[steps.length - 1];

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="subtitle1" component="h2">Membership pipeline</Typography>
          {error && <Alert severity="error">{error}</Alert>}
          {data.part_of && (
            <Alert severity="info">This is the {data.part_of.kind} group of {data.part_of.name}.</Alert>
          )}
          {!data.hasPair && !data.part_of && canAdmin && (
            <Alert severity="info" action={<Button color="inherit" size="small" onClick={create}>Create include and exclude groups</Button>}>
              This group has no include and exclude groups, most likely because their names were taken when it was made. Rename the group that has the name, or create them once the names are free.
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary">
            Membership is built in steps, each from the steps before it: basis groups first, then reference groups, then this group. Each step shows how many people it has.
          </Typography>
          <Stack component="ol" spacing={1} sx={{ m: 0, pl: 3 }}>
            {steps.map((step) => (
              <Typography component="li" variant="body2" key={step.id} sx={{ fontWeight: step.id === last?.id ? 600 : 400 }}>
                {step.name} <RoleBadge role={step.role} />
                <Typography component="span" variant="body2" color="text.secondary"> · {step.count.toLocaleString()} {step.count === 1 ? 'person' : 'people'} · {describeStep(step)}</Typography>
              </Typography>
            ))}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
