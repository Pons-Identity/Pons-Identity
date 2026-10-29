import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { api } from '../api/client.js';
import { useNotify } from './Notify.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import { LdapQueryButton } from './LdapQueryBuilder.jsx';

const stamp = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : 'never');
const errorText = (err) => err.data?.errors?.join(' ') || err.message;

/** Who the query matches right now, as it is typed: { ok, error?, matches? }, or null while the query is empty. */
export function useQueryCheck(filter) {
  const [check, setCheck] = useState(null);
  useEffect(() => {
    if (!filter.trim()) { setCheck(null); return undefined; }
    let stale = false;
    const t = setTimeout(() => {
      api('/admin/ldap-query/check', { method: 'POST', body: { filter } }).then((r) => { if (!stale) setCheck(r); }).catch(() => {});
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [filter]);
  return check;
}

/** The query text, its builder, and whether it runs once or is kept up to date. Shared by a group's query panel and the new group page. */
export function RuleFields({ filter, onFilter, mode, onMode, check, editable }) {
  return (
    <>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField label="LDAP query" value={filter} onChange={(e) => onFilter(e.target.value)} disabled={!editable} fullWidth spellCheck={false}
          slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
          error={Boolean(check && !check.ok)} helperText={check ? (check.ok ? `The syntax is valid. ${check.matches.toLocaleString()} ${check.matches === 1 ? 'person matches' : 'people match'} right now.` : check.error) : 'Starts with ( and is written like an LDAP search filter.'} />
        {editable && <LdapQueryButton value={filter} onApply={onFilter} title="LDAP query builder for group membership" />}
      </Stack>
      <FormControl disabled={!editable}>
        <FormLabel id="rule-mode">How the query is used</FormLabel>
        <RadioGroup aria-labelledby="rule-mode" value={mode} onChange={(e) => onMode(e.target.value)}>
          <FormControlLabel value="ongoing" control={<Radio />}
            label="Ongoing: keep the group in step with the query. People are added when they start to match and removed when they stop (checked every few minutes and after people change). People you add by hand are never removed." />
          <FormControlLabel value="snapshot" control={<Radio />}
            label="Snapshot: run the query once now and add whoever matches as ordinary members. Nothing is tracked afterwards." />
        </RadioGroup>
      </FormControl>
    </>
  );
}

/** Builds a group's members from an LDAP query over the people in this IdP: once (snapshot) or kept up to date (ongoing). */
export default function GroupRulePanel({ groupId, canManage, onChanged }) {
  const notify = useNotify();
  const [state, setState] = useState(null);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState('ongoing');
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const check = useQueryCheck(filter);

  const load = useCallback(async () => {
    const r = await api(`/admin/groups/${groupId}/rule`);
    setState(r);
    if (r.rule) { setFilter(r.rule.filter); setMode(r.rule.mode); }
  }, [groupId]);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  if (!state) return error ? <Alert severity="error">{error}</Alert> : null;
  const { rule, unsuitable } = state;
  const editable = canManage && !unsuitable;

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      const r = await api(`/admin/groups/${groupId}/rule`, { method: 'PUT', body: { filter, mode } });
      setState((s) => ({ ...s, rule: r.rule }));
      notify(r.ran?.error ? r.ran.error : `Query saved: ${r.ran.added} added${r.ran.removed ? `, ${r.ran.removed} removed` : ''}`);
      onChanged?.();
    } catch (err) { setError(errorText(err)); }
  }

  async function runNow() {
    setError('');
    try {
      const r = await api(`/admin/groups/${groupId}/rule/run`, { method: 'POST', body: {} });
      setState((s) => ({ ...s, rule: r.rule }));
      notify(`${r.ran.added} added${r.ran.removed ? `, ${r.ran.removed} removed` : ''}`);
      onChanged?.();
    } catch (err) { setError(errorText(err)); }
  }

  async function remove(keep) {
    setRemoving(false);
    try {
      await api(`/admin/groups/${groupId}/rule?keep_members=${keep ? 1 : 0}`, { method: 'DELETE' });
      setFilter(''); setState((s) => ({ ...s, rule: null }));
      notify('Query removed');
      onChanged?.();
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      {unsuitable && <Alert severity="info">{unsuitable}</Alert>}
      <Card variant="outlined">
        <CardContent>
          <Stack component="form" spacing={2} onSubmit={save} aria-label="Membership query">
            <Typography variant="subtitle1" component="h2">Build membership from an LDAP query</Typography>
            <Typography variant="body2" color="text.secondary">
              People whose profile matches the query become direct members of this group. The query reads the same attributes as the people search, for example <code>(&amp;(department=Underwater Basket-Weaving)(title=*Master Weaver*))</code>.
            </Typography>
            <RuleFields filter={filter} onFilter={setFilter} mode={mode} onMode={setMode} check={check} editable={editable} />
            {editable && (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Button type="submit" variant="contained" disabled={!filter.trim() || Boolean(check && !check.ok)}>{rule ? 'Save and run' : mode === 'snapshot' ? 'Run once' : 'Save and start'}</Button>
                {rule && <Button onClick={runNow}>Run again now</Button>}
                {rule && <Button color="error" onClick={() => setRemoving(true)}>Remove the query</Button>}
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>
      {rule && (
        <Typography variant="body2" color="text.secondary">
          Last run {stamp(rule.last_run_at)}: {rule.last_matched.toLocaleString()} matched, {rule.last_added} added, {rule.last_removed} removed.
          {rule.mode === 'ongoing' && ` ${rule.members_by_rule.toLocaleString()} members are here because of the query.`}
          {rule.last_error && <Typography component="span" color="error"> {rule.last_error}</Typography>}
        </Typography>
      )}
      <ConfirmDialog open={removing} title="Remove the query?" confirmLabel="Remove, keep members"
        message="The group stops following the query. The people it added stay as ordinary members; remove them from the member list if you do not want them."
        onConfirm={() => remove(true)} onClose={() => setRemoving(false)} />
    </Stack>
  );
}
