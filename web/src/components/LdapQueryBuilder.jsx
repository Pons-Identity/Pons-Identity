import { useEffect, useMemo, useState } from 'react';
import { Alert, Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { api } from '../api/client.js';

// A builder for LDAP (RFC 4515) filters: pick the attribute, how to compare it and the value for each condition, choose whether
// all or any of them must hold, and the filter is written for you. The server checks the syntax (and, for the people in this IdP,
// the attribute names and who matches) as you go. The filter can also be edited by hand, and the rows are rebuilt from it when it
// is simple enough.

export const OPERATORS = [
  { id: 'eq', label: 'equals', needsValue: true },
  { id: 'ne', label: 'does not equal', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'notcontains', label: 'does not contain', needsValue: true },
  { id: 'starts', label: 'starts with', needsValue: true },
  { id: 'ends', label: 'ends with', needsValue: true },
  { id: 'present', label: 'has a value', needsValue: false },
  { id: 'absent', label: 'has no value', needsValue: false },
  { id: 'ge', label: 'is at least (≥)', needsValue: true },
  { id: 'le', label: 'is at most (≤)', needsValue: true },
  { id: 'approx', label: 'sounds like (~=)', needsValue: true },
];

// Common attributes of a directory server, offered when the filter is for one (a person's own attribute names are fetched from the server).
const DIRECTORY_ATTRIBUTES = ['uid', 'sAMAccountName', 'userPrincipalName', 'cn', 'mail', 'displayName', 'givenName', 'sn', 'memberOf', 'department', 'title', 'employeeID', 'objectClass', 'telephoneNumber'];
// What each of those is for, shown beside its name in the attribute list.
const ATTRIBUTE_DETAILS = new Map([
  ['uid', 'Login name'],
  ['sAMAccountName', 'Login name in Active Directory'],
  ['userPrincipalName', 'Sign-in name in Active Directory (user@domain)'],
  ['cn', 'Full name'],
  ['mail', 'Email address'],
  ['displayName', 'Name shown in the directory'],
  ['givenName', 'First name'],
  ['sn', 'Last name'],
  ['memberOf', 'Groups the person belongs to'],
  ['department', 'Department'],
  ['title', 'Job title'],
  ['employeeID', 'Employee number'],
  ['objectClass', 'Object type (e.g. person)'],
  ['telephoneNumber', 'Phone number'],
]);

// RFC 4515: these characters in a value are written as \XX.
const escapeValue = (v) => String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const unescapeValue = (v) => v.replace(/\\([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

export function clause({ attr, op, value }) {
  const a = attr.trim();
  const v = escapeValue(value ?? '');
  switch (op) {
    case 'eq': return `(${a}=${v})`;
    case 'ne': return `(!(${a}=${v}))`;
    case 'contains': return `(${a}=*${v}*)`;
    case 'notcontains': return `(!(${a}=*${v}*))`;
    case 'starts': return `(${a}=${v}*)`;
    case 'ends': return `(${a}=*${v})`;
    case 'present': return `(${a}=*)`;
    case 'absent': return `(!(${a}=*))`;
    case 'ge': return `(${a}>=${v})`;
    case 'le': return `(${a}<=${v})`;
    case 'approx': return `(${a}~=${v})`;
    default: return '';
  }
}

/** The filter for rows: nothing for none, the clause for one, otherwise joined with & (all) or | (any). Rows without an attribute are skipped. */
export function buildFilter(rows, joiner) {
  const parts = rows.filter((r) => r.attr.trim() && (!OPERATORS.find((o) => o.id === r.op)?.needsValue || r.value !== '')).map(clause);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : `(${joiner === 'or' ? '|' : '&'}${parts.join('')})`;
}

// Splits "(a)(b)" into its top-level parenthesised pieces, or null if the parentheses do not balance.
function topLevel(text) {
  const out = []; let depth = 0; let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '(') { if (depth === 0) start = i; depth += 1; }
    else if (text[i] === ')') { depth -= 1; if (depth < 0) return null; if (depth === 0) out.push(text.slice(start, i + 1)); }
  }
  return depth === 0 ? out : null;
}

function rowOf(text) {
  let m = /^\(!\(([^=<>~()]+)=\*\)\)$/.exec(text);
  if (m) return { attr: m[1], op: 'absent', value: '' };
  m = /^\(!\(([^=<>~()]+)=(.*)\)\)$/.exec(text);
  if (m && !/^\(/.test(m[2])) {
    const sub = rowOf(`(${m[1]}=${m[2]})`);
    if (sub && sub.op === 'eq') return { ...sub, op: 'ne' };
    if (sub && sub.op === 'contains') return { ...sub, op: 'notcontains' };
    return null;
  }
  m = /^\(([^=<>~()!&|]+)(>=|<=|~=|=)(.*)\)$/.exec(text);
  if (!m || /[()]/.test(m[3].replace(/\\../g, ''))) return null;
  const [, attr, sign, raw] = m;
  if (sign === '>=') return { attr, op: 'ge', value: unescapeValue(raw) };
  if (sign === '<=') return { attr, op: 'le', value: unescapeValue(raw) };
  if (sign === '~=') return { attr, op: 'approx', value: unescapeValue(raw) };
  if (raw === '*') return { attr, op: 'present', value: '' };
  const stars = raw.split('*');
  if (stars.length === 1) return { attr, op: 'eq', value: unescapeValue(raw) };
  if (stars.length === 2 && stars[0] === '' && stars[1] !== '') return { attr, op: 'ends', value: unescapeValue(stars[1]) };
  if (stars.length === 2 && stars[1] === '' && stars[0] !== '') return { attr, op: 'starts', value: unescapeValue(stars[0]) };
  if (stars.length === 3 && stars[0] === '' && stars[2] === '' && stars[1] !== '') return { attr, op: 'contains', value: unescapeValue(stars[1]) };
  return null;
}

/** Rows and joiner for a filter the builder can show, or null when it is too complex (nested groups, several wildcards). */
export function parseFilter(text) {
  const t = String(text || '').trim();
  if (!t) return { joiner: 'and', rows: [] };
  const single = rowOf(t);
  if (single) return { joiner: 'and', rows: [single] };
  const m = /^\(([&|])(.*)\)$/.exec(t);
  if (!m) return null;
  const pieces = topLevel(m[2]);
  if (!pieces || !pieces.length || pieces.join('') !== m[2]) return null;
  const rows = pieces.map(rowOf);
  return rows.every(Boolean) ? { joiner: m[1] === '|' ? 'or' : 'and', rows } : null;
}

let nextKey = 1;
const blankRow = () => ({ key: nextKey++, attr: '', op: 'eq', value: '' });
const withKeys = (rows) => rows.map((r) => ({ key: nextKey++, ...r }));

/**
 * The builder dialog. `scope` is 'people' (the filter is run against the people in this IdP: attributes are checked and matches
 * counted) or 'syntax' (only the form is checked, for a filter that another server will run). `placeholders` are tokens such as
 * {username} that the value may contain. onApply(filter) is called with the text to use.
 */
export default function LdapQueryBuilder({ open, onClose, value = '', onApply, scope = 'people', placeholders = [], title = 'LDAP query builder' }) {
  const [rows, setRows] = useState([]);
  const [joiner, setJoiner] = useState('and');
  const [text, setText] = useState('');
  const [simple, setSimple] = useState(true);
  const [attributes, setAttributes] = useState(scope === 'syntax' ? DIRECTORY_ATTRIBUTES : []);
  const [check, setCheck] = useState(null);

  // Start from what is in the field.
  useEffect(() => {
    if (!open) return;
    const parsed = parseFilter(value);
    setSimple(Boolean(parsed));
    setRows(parsed && parsed.rows.length ? withKeys(parsed.rows) : [blankRow()]);
    setJoiner(parsed ? parsed.joiner : 'and');
    setText(String(value || ''));
    setCheck(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The attribute list comes with every check, but a check needs a filter, and a condition with no value adds none. Ask once on open.
  useEffect(() => {
    if (!open || scope !== 'people') return undefined;
    let stale = false;
    api('/admin/ldap-query/check', { method: 'POST', body: { filter: '', scope } })
      .then((r) => { if (!stale && r.attributes) setAttributes(r.attributes); })
      .catch(() => {});
    return () => { stale = true; };
  }, [open, scope]);

  // The server checks the filter a moment after it stops changing.
  useEffect(() => {
    if (!open) return undefined;
    if (!text.trim()) { setCheck(null); return undefined; }
    let stale = false;
    const t = setTimeout(() => {
      api('/admin/ldap-query/check', { method: 'POST', body: { filter: text, scope } })
        .then((r) => {
          if (stale) return;
          setCheck(r);
          if (scope === 'people' && r.attributes) setAttributes(r.attributes);
        })
        .catch((e) => { if (!stale) setCheck({ ok: false, error: e.message }); });
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [open, text, scope]);

  const rebuild = (nextRows, nextJoiner) => {
    setRows(nextRows);
    setJoiner(nextJoiner);
    setSimple(true);
    setText(buildFilter(nextRows, nextJoiner));
  };
  const setRow = (key, patch) => rebuild(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)), joiner);
  const addRow = () => setRows((r) => [...r, blankRow()]);
  const removeRow = (key) => rebuild(rows.length > 1 ? rows.filter((r) => r.key !== key) : [blankRow()], joiner);

  const edited = (next) => {
    setText(next);
    const parsed = parseFilter(next);
    setSimple(Boolean(parsed));
    if (parsed) { setRows(parsed.rows.length ? withKeys(parsed.rows) : [blankRow()]); setJoiner(parsed.joiner); }
  };

  const options = useMemo(() => attributes, [attributes]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" aria-labelledby="ldap-builder-title">
      <DialogTitle id="ldap-builder-title">{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Build an LDAP query.
            {scope === 'people' && ' It is run against the people in this IdP.'}
          </Typography>
          {simple && rows.length > 1 && (
            <TextField select size="small" label="A person matches when" value={joiner} onChange={(e) => rebuild(rows, e.target.value)} sx={{ maxWidth: 320 }}>
              <MenuItem value="and">all of these are true</MenuItem>
              <MenuItem value="or">any of these is true</MenuItem>
            </TextField>
          )}
          {!simple && <Alert severity="info">This query has nested groups or other structure the rows cannot show. Edit it in the box below; adding or changing a row replaces it.</Alert>}
          {rows.map((r, i) => {
            const op = OPERATORS.find((o) => o.id === r.op);
            return (
              <Stack key={r.key} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-start' }} role="group" aria-label={`Condition ${i + 1}`}>
                <Autocomplete freeSolo size="small" options={options} value={r.attr} sx={{ minWidth: 200, flex: 1 }}
                  onChange={(_, v) => setRow(r.key, { attr: v || '' })} onInputChange={(_, v, reason) => { if (reason === 'input') setRow(r.key, { attr: v }); }}
                  renderOption={(props, option) => (
                    <Box component="li" {...props} key={option} sx={{ display: 'flex', gap: 1.5, alignItems: 'baseline' }}>
                      <code>{option}</code>
                      <Typography variant="caption" color="text.secondary">{ATTRIBUTE_DETAILS.get(option)}</Typography>
                    </Box>
                  )}
                  renderInput={(p) => <TextField {...p} label="Attribute" placeholder="Choose or type a name" />} />
                <TextField select size="small" label="Compare" value={r.op} onChange={(e) => setRow(r.key, { op: e.target.value })} sx={{ minWidth: 190 }}>
                  {OPERATORS.map((o) => <MenuItem key={o.id} value={o.id}>{o.label}</MenuItem>)}
                </TextField>
                <TextField size="small" label="Value" value={r.value} disabled={!op.needsValue} onChange={(e) => setRow(r.key, { value: e.target.value })} sx={{ flex: 1 }}
                  slotProps={placeholders.length ? { input: { endAdornment: <InputAdornment position="end">{placeholders.map((p) => (
                    <Tooltip key={p} title={`Insert ${p}`}><Chip size="small" label={p} onClick={() => setRow(r.key, { value: r.value + p })} /></Tooltip>))}</InputAdornment> } } : undefined} />
                <Tooltip title="Remove this condition"><span><IconButton aria-label={`Remove condition ${i + 1}`} onClick={() => removeRow(r.key)}><DeleteOutlineIcon /></IconButton></span></Tooltip>
              </Stack>
            );
          })}
          <Box><Button onClick={addRow} disabled={!simple}>Add a condition</Button></Box>

          <TextField label="Query" value={text} onChange={(e) => edited(e.target.value)} multiline minRows={2} fullWidth spellCheck={false}
            helperText="You can also write or paste a query here. Special characters in a value are escaped as \2a, \28, \29 and \5c."
            slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }} />

          {check && check.ok && (
            <Alert severity="success" aria-live="polite">
              The syntax is valid.
              {check.matches !== undefined && ` ${check.matches.toLocaleString()} ${check.matches === 1 ? 'person matches' : 'people match'}${check.sample?.length ? `, including ${check.sample.slice(0, 5).map((p) => p.username).join(', ')}` : ''}.`}
            </Alert>
          )}
          {check && !check.ok && <Alert severity="error" aria-live="polite">{check.error}</Alert>}
          {!check && text.trim() === '' && <Typography variant="body2" color="text.secondary">Fill in a condition to see the query.</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!text.trim() || (check && !check.ok)} onClick={() => { onApply(text.trim()); onClose(); }}>Use this query</Button>
      </DialogActions>
    </Dialog>
  );
}

/** A button that opens the builder for a field. `value` is the field's text; onApply(filter) sets it. */
export function LdapQueryButton({ value, onApply, scope, placeholders, title, size = 'small', variant = 'text', label = 'Query builder' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} startIcon={<AccountTreeIcon />} onClick={() => setOpen(true)} sx={{ whiteSpace: 'nowrap' }}>{label}</Button>
      <LdapQueryBuilder open={open} onClose={() => setOpen(false)} value={value} onApply={onApply} scope={scope} placeholders={placeholders} title={title} />
    </>
  );
}
