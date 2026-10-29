import { useState } from 'react';
import { Alert, Button, LinearProgress, Stack, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Link as RouterLink } from 'react-router-dom';
import CalculatorPicker from '../../components/CalculatorPicker.jsx';
import CalculatorResult, { CalculatorError, useCalculation } from '../../components/CalculatorResult.jsx';
import { useCan } from '../../auth/permissions.js';

// The sentence above the detail: what the answer comes to.
function Summary({ result }) {
  if (result.mode === 'membership') {
    const n = result.routes.length;
    return result.member
      ? <Alert severity="success"><strong>{result.user.username}</strong> is a member of <strong>{result.group.name}</strong>, by {n} {n === 1 ? 'route' : 'routes'}.</Alert>
      : <Alert severity="warning"><strong>{result.user.username}</strong> is not a member of <strong>{result.group.name}</strong>. The detail says what keeps them out.</Alert>;
  }
  if (result.mode === 'user') {
    return <Alert severity="info"><strong>{result.user.username}</strong> is in {result.groups.length} {result.groups.length === 1 ? 'group' : 'groups'}.</Alert>;
  }
  return <Alert severity="info"><strong>{result.group.name}</strong> has {result.construction.count} {result.construction.count === 1 ? 'person' : 'people'}. Open any group in the diagram to edit it.</Alert>;
}

/**
 * Groups → Group calculator: pick a person, a group, or both. A person and a group shows every route that put the person in the
 * group (or why not); a person alone shows every group they are in and how; a group alone shows how the group is built.
 */
export default function GroupCalculator() {
  const can = useCan();
  const [person, setPerson] = useState(null);
  const [group, setGroup] = useState(null);
  const params = new URLSearchParams();
  if (person) params.set('user_id', person.id);
  if (group) params.set('group_id', group.id);
  const { result, error, loading } = useCalculation(person || group ? `/admin/calculators/group?${params}` : null);

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button component={RouterLink} to="/admin/groups" startIcon={<ArrowBackIcon />}>Groups</Button>
        <Typography variant="h5" component="h1">Group calculator</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Choose a <strong>person and a group</strong> to see every route that put the person in the group: their own membership, a query, a nested group,
        the factors of a composite, an include group; or what keeps them out. Choose a <strong>person</strong> alone to see all their groups and how they got into each.
        Choose a <strong>group</strong> alone to see how it is built: its members, query, nested groups, composite factors, and include and exclude groups, and the groups those use in turn.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'flex-start' }}>
        <CalculatorPicker type="user" label="Person" value={person} onChange={setPerson} disabled={!can('users.view')}
          helperText={can('users.view') ? 'Optional. Name or username.' : 'You need permission to view people.'} />
        <CalculatorPicker type="group" label="Group" value={group} onChange={setGroup} helperText="Optional. Name or description." />
      </Stack>
      {!person && !group && <Typography color="text.secondary">Choose a person, a group, or both.</Typography>}
      {loading && <LinearProgress aria-label="Calculating" />}
      <CalculatorError message={error} />
      {result && <CalculatorResult result={result} summary={<Summary result={result} />} />}
    </Stack>
  );
}
