import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Chip, FormControlLabel, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import { useNotify } from '../../../components/Notify.jsx';

const errorText = (err) => err.data?.errors?.join(' ') || err.message;
const STATUS = {
  match: { label: 'Matches Grouper', color: 'success' },
  differs: { label: 'Differs', color: 'warning' },
  missing: { label: 'Not in Grouper', color: 'error' },
  unverified: { label: 'Not checked', color: 'default' },
};

// Hands groups over to Grouper: check they match, then make them Grouper-managed here. Every cutover can be reverted.
export default function GrouperCutover({ subjectField, rootStem, conn, lookup }) {
  const notify = useNotify();
  const [plan, setPlan] = useState(null);
  const [rows, setRows] = useState({}); // verification detail by group id
  const [picked, setPicked] = useState([]);
  const [pinRoles, setPinRoles] = useState(true);
  const [force, setForce] = useState(false);
  const [history, setHistory] = useState([]);
  const [confirm, setConfirm] = useState(null); // 'apply' | { revert: id }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const options = { subjectField, rootStem, ...lookup };
  const loadHistory = () => api('/admin/grouper/cutover/history').then(setHistory).catch(() => {});
  useEffect(() => { loadHistory(); }, []);

  async function loadPlan(keepPicked = false) {
    setError('');
    try {
      const p = await api('/admin/grouper/cutover/plan', { method: 'POST', body: { options } });
      setPlan(p);
      setPicked((cur) => (keepPicked ? cur.filter((id) => p.groups.some((g) => g.id === id)) : p.groups.filter((g) => g.verification === 'match' && !g.conflict).map((g) => g.id)));
    } catch (err) { setError(errorText(err)); }
  }

  async function verify() {
    setBusy(true);
    setError('');
    try {
      const v = await api('/admin/grouper/cutover/verify', { method: 'POST', body: { connection: conn, options } });
      setRows(Object.fromEntries(v.rows.map((r) => [r.id, r])));
      const p = await api('/admin/grouper/cutover/plan', { method: 'POST', body: { options } });
      setPlan(p);
      setPicked(p.groups.filter((g) => g.verification === 'match' && !g.conflict).map((g) => g.id));
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  async function apply() {
    setConfirm(null);
    setError('');
    try {
      const r = await api('/admin/grouper/cutover/apply', { method: 'POST', body: { options, groupIds: picked, confirm: true, force, pinRoleMembers: pinRoles } });
      setResult({ kind: 'applied', ...r });
      setForce(false);
      await loadPlan();
      loadHistory();
      notify('Groups handed to Grouper');
    } catch (err) { setError(errorText(err)); }
  }

  async function revert(id) {
    setConfirm(null);
    setError('');
    try {
      const r = await api(`/admin/grouper/cutover/history/${id}/revert`, { method: 'POST', body: { confirm: true } });
      setResult({ kind: 'reverted', ...r });
      await loadPlan();
      loadHistory();
    } catch (err) { setError(errorText(err)); }
  }

  const toggle = (id) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const chosen = plan ? plan.groups.filter((g) => picked.includes(g.id)) : [];
  const unverified = chosen.filter((g) => g.verification !== 'match');
  const renamed = chosen.filter((g) => g.renamed);
  const canVerify = conn.url && conn.username && conn.password;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        When Grouper holds your groups, make it the source of truth. Chosen groups become read-only here and take the name Grouper gives them; Grouper's
        provisioner then keeps their members. Nested groups and composites are flattened into plain members first, so nobody loses access in between.
        Check each group against Grouper first. Enable Grouper's SCIM provisioning for this IdP (above) so it can take the groups over.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {result?.kind === 'applied' && <Alert severity="success" onClose={() => setResult(null)}>{result.converted} group{result.converted === 1 ? '' : 's'} handed to Grouper ({result.renamed} renamed). You can revert this below.</Alert>}
      {result?.kind === 'reverted' && (
        <Alert severity={result.skipped.length ? 'warning' : 'success'} onClose={() => setResult(null)}>
          {result.reverted} group{result.reverted === 1 ? '' : 's'} restored.
          {result.skipped.map((s) => ` ${s.name}: ${s.reason}`).join('')}
        </Alert>
      )}

      <Stack direction="row" spacing={1}>
        <Button variant="outlined" onClick={() => loadPlan()}>Load groups</Button>
        <Button variant="outlined" disabled={!plan || !canVerify || busy} onClick={verify}>{busy ? 'Checking…' : 'Check against Grouper'}</Button>
      </Stack>
      {plan && !canVerify && <Typography variant="body2" color="text.secondary">Enter the connection above to check groups against Grouper.</Typography>}

      {plan && (
        <>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow><TableCell padding="checkbox" /><TableCell>Group</TableCell><TableCell align="right">Members</TableCell><TableCell>Becomes</TableCell><TableCell>Flattened</TableCell><TableCell>Grouper</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {plan.groups.length === 0 && <TableRow><TableCell colSpan={6}><Typography color="text.secondary">No groups are managed here.</Typography></TableCell></TableRow>}
                {plan.groups.map((g) => {
                  const d = rows[g.id];
                  const s = STATUS[g.verification] || STATUS.unverified;
                  const notes = [g.nested && `${g.nested} nested`, g.composite && 'composite', g.delegations && `${g.delegations} delegated`, g.carries_role && 'carries a role'].filter(Boolean);
                  const why = d && [
                    d.missingCount && `${d.missingCount} here but not in Grouper: ${d.missing.join(', ')}`,
                    d.extraCount && `${d.extraCount} in Grouper but not here`,
                    d.unpushedCount && `${d.unpushedCount} never pushed (no identifier): ${d.unpushed.join(', ')}`,
                    d.unknownCount && `${d.unknownCount} not found in Grouper: ${d.unknown.join(', ')}`,
                    d.status === 'missing' && 'the group does not exist in Grouper',
                  ].filter(Boolean).join('; ');
                  return (
                    <TableRow key={g.id}>
                      <TableCell padding="checkbox"><Checkbox checked={picked.includes(g.id)} disabled={Boolean(g.conflict)} onChange={() => toggle(g.id)} inputProps={{ 'aria-label': `Select ${g.name}` }} /></TableCell>
                      <TableCell>{g.name}</TableCell>
                      <TableCell align="right">{g.effective}</TableCell>
                      <TableCell>{g.conflict ? <Typography variant="body2" color="error">{g.conflict}</Typography> : g.renamed ? g.grouper_name : 'same name'}</TableCell>
                      <TableCell>{notes.join(', ')}</TableCell>
                      <TableCell>{why ? <Tooltip title={why}><Chip size="small" color={s.color} label={s.label} /></Tooltip> : <Chip size="small" color={s.color} label={s.label} />}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          {Object.values(rows).some((r) => r.status !== 'match') && (
            <Alert severity="warning">
              Hover a status for what differs. People with no identifier were never pushed to Grouper and would lose the group; give them one, or leave that group here.
            </Alert>
          )}

          <FormControlLabel control={<Checkbox checked={pinRoles} onChange={(e) => setPinRoles(e.target.checked)} />}
            label="Pin the members of groups that carry a role, so a bad Grouper sync cannot lock administrators out" />
          {unverified.length > 0 && (
            <FormControlLabel control={<Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} />}
              label={<Typography color="error" variant="body2">Hand over {unverified.length} group{unverified.length === 1 ? '' : 's'} that {unverified.length === 1 ? 'is' : 'are'} not confirmed identical in Grouper</Typography>} />
          )}
          <Button variant="contained" sx={{ alignSelf: 'flex-start' }} disabled={!chosen.length || (unverified.length > 0 && !force)} onClick={() => setConfirm('apply')}>
            Hand {chosen.length} group{chosen.length === 1 ? '' : 's'} to Grouper…
          </Button>
        </>
      )}

      {history.length > 0 && (
        <Stack spacing={1}>
          <Typography variant="subtitle2">Earlier cutovers</Typography>
          {history.map((h) => (
            <Stack key={h.id} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="body2">
                {new Date(h.ts * 1000).toLocaleString()} by {h.actor}: {h.groups} group{h.groups === 1 ? '' : 's'} ({h.names.slice(0, 3).join(', ')}{h.groups > 3 ? ', …' : ''})
              </Typography>
              {h.reverted_at ? <Chip size="small" label="Reverted" /> : <Button size="small" color="error" onClick={() => setConfirm({ revert: h.id })}>Revert</Button>}
            </Stack>
          ))}
        </Stack>
      )}

      <ConfirmDialog open={confirm === 'apply'} color="primary" title="Hand these groups to Grouper?" confirmLabel="Hand over"
        message={`${chosen.length} group${chosen.length === 1 ? '' : 's'} become read-only here${renamed.length ? `, and ${renamed.length} ${renamed.length === 1 ? 'is' : 'are'} renamed (applications that match on the old name will see the new one)` : ''}. Nesting, composites and delegated access are removed from them; Grouper becomes responsible. You can revert.`}
        onConfirm={apply} onClose={() => setConfirm(null)} />
      <ConfirmDialog open={Boolean(confirm?.revert)} title="Revert this cutover?" confirmLabel="Revert"
        message="The groups become editable here again with their old names and structure. Members Grouper added since stay, and members added only by flattening are removed."
        onConfirm={() => revert(confirm.revert)} onClose={() => setConfirm(null)} />
    </Stack>
  );
}
