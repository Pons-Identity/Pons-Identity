import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Chip, FormControlLabel, Menu, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import AddIcon from '@mui/icons-material/Add';
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { useCan } from '../../auth/permissions.js';
import { api } from '../../api/client.js';
import { ListSearch, useSearchedList } from '../../components/ListSearch.jsx';
import UsersTabs from './UsersTabs.jsx';
import UserViewDialog from './UserViewDialog.jsx';

// Every built-in column the list can show. `key` is the person field it reads, and the search's `matched` names the same keys.
// Administrator-defined attributes add a column each, keyed `attr:<name>` (see attributeColumns).
const COLUMNS = [
  { key: 'username', label: 'Username', fixed: true },
  { key: 'display_name', label: 'Name' },
  { key: 'emails', label: 'Email' },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'employee_id', label: 'Employee ID' },
  { key: 'department', label: 'Department' },
  { key: 'title', label: 'Title' },
  { key: 'upn', label: 'UPN' },
  { key: 'sam_account_name', label: 'sAMAccountName' },
  { key: 'group_count', label: 'Groups' },
  { key: 'status', label: 'Status' },
];
const DEFAULT_COLUMNS = ['username', 'display_name', 'emails', 'group_count', 'status'];
const COLUMNS_KEY = 'simpleidp.users.columns';

// The orders the list can be sorted in. `value` reads the sort key from a person.
const SORTS = [
  { key: 'username', label: 'Username', value: (u) => u.username },
  { key: 'display_name', label: 'Name', value: (u) => u.display_name },
  { key: 'email', label: 'Email', value: (u) => (u.emails || [])[0] },
  { key: 'group_count', label: 'Groups', value: (u) => u.group_count },
];

// The flags a person can be filtered on. Each filter is 'any', 'yes' (has the flag) or 'no' (does not have it).
const FLAGS = [
  { key: 'disabled', label: 'Disabled', flag: (u) => !u.active },
  { key: 'mfa', label: 'MFA required', flag: (u) => Boolean(u.mfa_required) },
  { key: 'locked_down', label: 'Locked down', flag: (u) => Boolean(u.locked_down) },
];
const NO_FLAG_FILTERS = Object.fromEntries(FLAGS.map((f) => [f.key, 'any']));

// One column per attribute an administrator defined, after the built-in ones.
const attributeColumns = (defs) => defs.map((d) => ({ key: `attr:${d.name}`, label: d.label, attr: d.name }));

function loadColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_KEY) || 'null');
    // Attribute columns are kept even before their definitions load; a column that no longer exists is not shown.
    return Array.isArray(saved) ? saved.filter((k) => COLUMNS.some((c) => c.key === k) || k.startsWith('attr:')) : DEFAULT_COLUMNS;
  } catch { return DEFAULT_COLUMNS; }
}
const saveColumns = (keys) => { try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(keys)); } catch { /* optional */ } };

// The server's answer for these people as { id: required }. Each request covers at most 500 people, the server's limit.
async function policyMfaFor(ids) {
  const found = {};
  for (let i = 0; i < ids.length; i += 500) {
    const part = await api(`/admin/users/mfa-required?${new URLSearchParams({ ids: ids.slice(i, i + 500).join(',') })}`);
    for (const [id, state] of Object.entries(part)) found[id] = state.required;
  }
  return found;
}

// Text sorts ignoring case and counts digits in order (group 2 before group 10). Numbers sort by value.
const compare = (a, b) => (typeof a === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base', numeric: true }));

// The cell for one column of one person.
function cellOf(u, key) {
  if (key.startsWith('attr:')) return u.attributes?.[key.slice('attr:'.length)] ?? '';
  switch (key) {
    case 'emails': return (u.emails || []).join(', ');
    case 'group_count': return u.group_count;
    case 'status': return (
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
        {u.locked_down ? <Chip size="small" label="Locked down" color="error" /> : null}
        {u.is_admin ? <Chip size="small" label="Admin" color="primary" /> : null}
        {u.directory ? <Chip size="small" label={u.directory} variant="outlined" /> : null}
        {u.mfa_required ? <Chip size="small" label="MFA required" /> : null}
        {!u.active ? <Chip size="small" label="Disabled" color="warning" /> : null}
      </Stack>
    );
    default: return u[key];
  }
}

export default function Users() {
  const can = useCan();
  const [params] = useSearchParams();
  const [text, setText] = useState(() => params.get('q') || '');
  const [chosen, setChosen] = useState(loadColumns);
  const [menu, setMenu] = useState(null);
  // The list row of the person whose view dialog is open, or null.
  const [viewing, setViewing] = useState(null);
  const [sortKey, setSortKey] = useState('username');
  const [order, setOrder] = useState('asc');
  const [flags, setFlags] = useState(NO_FLAG_FILTERS);
  const [defs, setDefs] = useState([]);
  const { rows: found, error } = useSearchedList('/admin/users', text);
  // Whether sign-in policy requires a second factor, by person id. Looked up after the list shows, so the list is not held up by it.
  const [policyMfa, setPolicyMfa] = useState({});

  useEffect(() => {
    api('/admin/attribute-defs').then((list) => { if (Array.isArray(list)) setDefs(list); }).catch(() => { /* the list works without them */ });
  }, []);

  useEffect(() => {
    // Someone who already has the flag set needs no lookup.
    const ids = (found || []).filter((u) => !u.mfa_enabled).map((u) => u.id);
    if (!ids.length) return undefined;
    let stale = false;
    policyMfaFor(ids).then((p) => { if (!stale) setPolicyMfa(p); }).catch(() => { /* the flag shows as set by the person only */ });
    return () => { stale = true; };
  }, [found]);

  const users = useMemo(() => found && found.map((u) => ({ ...u, mfa_required: Boolean(u.mfa_enabled || policyMfa[u.id]) })), [found, policyMfa]);

  const columns = useMemo(() => [...COLUMNS, ...attributeColumns(defs)], [defs]);

  // A column shows when the admin chose it, or when a person in this search matched the search text exactly in that field.
  const visible = useMemo(() => {
    const forced = new Set((users || []).flatMap((u) => u.matched || []));
    return columns.filter((c) => c.fixed || chosen.includes(c.key) || forced.has(c.key));
  }, [users, chosen, columns]);

  // The people who pass every flag filter, in the chosen order.
  const shown = useMemo(() => {
    if (!users) return null;
    const sort = SORTS.find((s) => s.key === sortKey);
    const sign = order === 'desc' ? -1 : 1;
    return users
      .filter((u) => FLAGS.every((f) => flags[f.key] === 'any' || f.flag(u) === (flags[f.key] === 'yes')))
      .sort((a, b) => sign * compare(sort.value(a), sort.value(b)));
  }, [users, sortKey, order, flags]);

  const filtered = sortKey !== 'username' || order !== 'asc' || FLAGS.some((f) => flags[f.key] !== 'any');
  const clearFilters = () => {
    setSortKey('username');
    setOrder('asc');
    setFlags(NO_FLAG_FILTERS);
  };

  const toggle = (key) => {
    const next = chosen.includes(key) ? chosen.filter((k) => k !== key) : columns.filter((c) => c.key === key || chosen.includes(c.key)).map((c) => c.key);
    setChosen(next);
    saveColumns(next);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Typography variant="h5" component="h1">Users</Typography>
        <Stack direction="row" spacing={1}>
          {can('users.schedule') && <Button component={RouterLink} to="/admin/users/schedules">Schedules</Button>}
          {can('users.manage') && <Button variant="outlined" component={RouterLink} to="/admin/users/import">Import</Button>}
          {can('users.manage') && (
            <Button variant="contained" component={RouterLink} to="/admin/users/new" startIcon={<AddIcon />}>New user</Button>
          )}
        </Stack>
      </Stack>
      <UsersTabs />
      <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap>
        <ListSearch
          label="Search people"
          ldap
          value={text}
          onChange={setText}
          helperText="Name, username, email, ID, department or any custom attribute. Start with ( to use an LDAP filter, such as (&(department=Underwater Basket-Weaving)(mail=*))."
        />
        <Button variant="outlined" startIcon={<ViewColumnIcon />} onClick={(e) => setMenu(e.currentTarget)} aria-haspopup="true">
          Columns
        </Button>
        <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
          {columns.map((c) => (
            <MenuItem key={c.key} dense disabled={c.fixed} onClick={() => toggle(c.key)}>
              <FormControlLabel
                label={c.label}
                control={<Checkbox size="small" checked={c.fixed || chosen.includes(c.key)} disabled={c.fixed} tabIndex={-1} disableRipple />}
                sx={{ m: 0, pointerEvents: 'none' }}
              />
            </MenuItem>
          ))}
        </Menu>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField select size="small" label="Sort by" value={sortKey} onChange={(e) => setSortKey(e.target.value)} sx={{ minWidth: 160 }}>
          {SORTS.map((s) => <MenuItem key={s.key} value={s.key}>{s.label}</MenuItem>)}
        </TextField>
        <TextField select size="small" label="Order" value={order} onChange={(e) => setOrder(e.target.value)} sx={{ minWidth: 140 }}>
          <MenuItem value="asc">Ascending</MenuItem>
          <MenuItem value="desc">Descending</MenuItem>
        </TextField>
        {FLAGS.map((f) => (
          <TextField
            key={f.key}
            select
            size="small"
            label={f.label}
            value={flags[f.key]}
            onChange={(e) => setFlags({ ...flags, [f.key]: e.target.value })}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="any">Any</MenuItem>
            <MenuItem value="yes">Yes</MenuItem>
            <MenuItem value="no">No</MenuItem>
          </TextField>
        ))}
        {filtered && <Button onClick={clearFilters}>Clear filters</Button>}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              {visible.map((c) => <TableCell key={c.key} align={c.key === 'group_count' ? 'right' : 'left'}>{c.label}</TableCell>)}
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {shown && shown.length === 0 && !error && <TableRow><TableCell colSpan={visible.length + 1}><Typography color="text.secondary">No people match.</Typography></TableCell></TableRow>}
            {(shown || []).map((u) => (
              <TableRow key={u.id} hover component={RouterLink} to={`/admin/users/${u.id}`} sx={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
                {visible.map((c) => (
                  <TableCell key={c.key} align={c.key === 'group_count' ? 'right' : 'left'}>{cellOf(u, c.key)}</TableCell>
                ))}
                {/* The row is a link to the edit page; this button opens the view dialog instead. */}
                <TableCell align="right">
                  <Button size="small" startIcon={<VisibilityIcon />} aria-label={`View ${u.username}`}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setViewing(u); }}>
                    View
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <UserViewDialog person={viewing} attrDefs={defs} onClose={() => setViewing(null)} />
    </Stack>
  );
}
