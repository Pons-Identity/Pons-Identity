import { useEffect, useState } from 'react';
import { InputAdornment, Stack, TextField } from '@mui/material';
import { LdapQueryButton } from './LdapQueryBuilder.jsx';
import SearchIcon from '@mui/icons-material/Search';
import { api } from '../api/client.js';

const identity = (data) => data;

/**
 * The search field above a list. The list reloads from the server as the person types (see useSearchedList).
 * `ldap` adds a button that opens the LDAP query builder, for lists whose search takes an LDAP filter.
 */
export function ListSearch({ value, onChange, label, helperText, ldap = false }) {
  const field = (
    <TextField
      size="small"
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      helperText={helperText}
      slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
      sx={{ width: { xs: '100%', sm: 380 } }}
    />
  );
  if (!ldap) return field;
  return (
    <Stack direction="row" spacing={1} alignItems="flex-start">
      {field}
      <LdapQueryButton value={value.trim().startsWith('(') ? value.trim() : ''} onApply={onChange} title="LDAP query builder for people" />
    </Stack>
  );
}

/**
 * Loads `path` with ?q= set to the search text. Waits a moment after typing, and drops answers to searches that were
 * overtaken by a newer one. `pick` takes the part of the response that is the list; `enabled` false skips the request.
 */
export function useSearchedList(path, text, { pick = identity, enabled = true } = {}) {
  const [state, setState] = useState({ rows: null, error: '' });

  useEffect(() => {
    if (!enabled) return undefined;
    let stale = false;
    const q = text.trim();
    const timer = setTimeout(() => {
      const query = q ? `?${new URLSearchParams({ q })}` : '';
      api(`${path}${query}`)
        .then((data) => { if (!stale) setState({ rows: pick(data), error: '' }); })
        .catch((e) => { if (!stale) setState((s) => ({ ...s, error: e.message })); });
    }, q ? 250 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [path, text, pick, enabled]);

  return state;
}
