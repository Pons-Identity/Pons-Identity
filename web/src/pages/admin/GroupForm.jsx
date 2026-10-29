import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Divider, FormControl, FormControlLabel, FormLabel, MenuItem, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { api } from '../../api/client.js';
import { useCan } from '../../auth/permissions.js';
import { useNotify } from '../../components/Notify.jsx';
import MultiCombobox from '../../components/MultiCombobox.jsx';
import { RuleFields, useQueryCheck } from '../../components/GroupRulePanel.jsx';

// What a composite group keeps: people in the first group, the second, or both, as the chosen operation says.
const OPS = [
  { value: 'union', label: 'Either', help: 'Everyone in the first group or the second.' },
  { value: 'intersect', label: 'Both', help: 'Only people in the first group and the second.' },
  { value: 'minus', label: 'First, not second', help: 'People in the first group who are not in the second.' },
];

/** Starts a new group with its name and its membership: people added by hand with an optional query, or a composite of two groups. */
export default function GroupForm() {
  const navigate = useNavigate();
  const notify = useNotify();
  const can = useCan();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState('people');
  const [people, setPeople] = useState([]);
  const [groups, setGroups] = useState([]);
  const [userIds, setUserIds] = useState([]);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState('ongoing');
  const [op, setOp] = useState('union');
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const check = useQueryCheck(filter);
  const canSeePeople = can('users.view');
  const composite = kind === 'composite';
  const compositeReady = leftId !== '' && rightId !== '' && leftId !== rightId;
  const ready = name.trim() && (composite ? compositeReady : !(check && !check.ok));

  useEffect(() => {
    if (canSeePeople) api('/admin/users').then((list) => { if (Array.isArray(list)) setPeople(list); }).catch(() => { /* the group can still be made without people to pick */ });
  }, [canSeePeople]);

  useEffect(() => {
    api('/admin/groups').then((list) => { if (Array.isArray(list)) setGroups(list); }).catch(() => { /* the factors cannot be picked without the list */ });
  }, []);

  if (!can('groups.manage')) return <Alert severity="error">Creating a group needs the Manage groups permission.</Alert>;

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const body = composite
        ? { name, description, user_ids: [], rule: null, composite: { op, left_id: Number(leftId), right_id: Number(rightId) } }
        : { name, description, user_ids: userIds, rule: filter.trim() ? { filter, mode } : null, composite: null };
      const g = await api('/admin/groups', { method: 'POST', body });
      if (g.ran?.error) notify(g.ran.error);
      else notify(g.ran ? `Group created: ${g.ran.added} added by the query` : 'Group created');
      navigate(`/admin/groups/${g.group.id}`, { replace: true });
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
    } finally {
      setSaving(false);
    }
  }

  const factorField = (label, value, onChange, other) => (
    <TextField select label={label} value={value} onChange={(e) => onChange(e.target.value)} fullWidth
      helperText={value !== '' && value === other ? 'Choose a different group.' : ''} error={value !== '' && value === other}>
      {groups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}
    </TextField>
  );

  return (
    <Stack spacing={3}>
      <Button component={RouterLink} to="/admin/groups" startIcon={<ArrowBackIcon />} sx={{ alignSelf: 'flex-start' }}>Back to groups</Button>
      <Typography variant="h5" component="h1">New group</Typography>
      {errors.length > 0 && (
        <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>
      )}

      <Card variant="outlined">
        <CardContent>
          <Stack component="form" spacing={2} onSubmit={save}>
            <TextField label="Name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} fullWidth />
            <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth
              helperText="Optional. Say what the group is for, who it is for, and where its members come from." />
            <Typography variant="body2" color="text.secondary">
              Every group is made with two more, {name.trim() || 'this group'}:include and {name.trim() || 'this group'}:exclude. People added to the include group become members of this group, and people in the exclude group are removed from it, whatever else puts them there.
            </Typography>

            <Divider />
            <FormControl>
              <FormLabel id="membership-kind">How the members are set</FormLabel>
              <RadioGroup aria-labelledby="membership-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <FormControlLabel value="people" control={<Radio />} label="People: add people by hand, and optionally a query" />
                <FormControlLabel value="composite" control={<Radio />} label="Composite: the members come from two groups combined" />
              </RadioGroup>
            </FormControl>

            {!composite && (
              <>
                <Typography variant="subtitle2" component="h2">Members</Typography>
                {canSeePeople ? (
                  <MultiCombobox label="Added directly to" placeholder="Search people by username or name"
                    options={people.map((p) => ({ id: p.id, label: p.username, secondary: p.display_name }))}
                    value={userIds} onChange={setUserIds}
                    helperText="People added by hand. A query below can add more, and these stay even if they stop matching it." />
                ) : (
                  <Typography variant="body2" color="text.secondary">Adding people needs the View users permission. You can add them after the group is made.</Typography>
                )}

                <Typography variant="subtitle2" component="h2">Membership query</Typography>
                <Typography variant="body2" color="text.secondary">
                  People whose profile matches the query become direct members of this group. The query reads the same attributes as the people search, for example <code>(&amp;(department=Underwater Basket-Weaving)(title=*Master Weaver*))</code>. Leave it empty to add people by hand only.
                </Typography>
                <RuleFields filter={filter} onFilter={setFilter} mode={mode} onMode={setMode} check={check} editable />
              </>
            )}

            {composite && (
              <>
                <Typography variant="subtitle2" component="h2">Composite of two groups</Typography>
                <Typography variant="body2" color="text.secondary">
                  A composite has no people of its own and no query: its members are worked out from the two groups below, and they change as those groups change.
                </Typography>
                <TextField select label="Combine" value={op} onChange={(e) => setOp(e.target.value)} fullWidth
                  helperText={OPS.find((o) => o.value === op).help}>
                  {OPS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
                </TextField>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  {factorField('First group', leftId, setLeftId, rightId)}
                  {factorField('Second group', rightId, setRightId, leftId)}
                </Stack>
              </>
            )}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button type="submit" variant="contained" disabled={saving || !ready}>Create group</Button>
              <Button component={RouterLink} to="/admin/groups">Cancel</Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
