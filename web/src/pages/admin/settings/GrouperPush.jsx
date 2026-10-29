import { useEffect, useRef, useState } from 'react';
import { Alert, Button, LinearProgress, Stack, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';

const PHASES = { groups: 'Groups', members: 'Members', nested: 'Nested groups', privileges: 'Delegated access' };
const errorText = (err) => err.data?.errors?.join(' ') || err.message;

// Pushes the built-in groups to a live Grouper over its web services. The connection (see GrouperConnection) is
// owned by the parent; the password is cleared once a push has started and never saved by the server.
export default function GrouperPush({ subjectField, rootStem, conn, onConn, lookup, pollMs = 1500 }) {
  const [check, setCheck] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const timer = useRef(null);

  // A check only describes the settings it was run with.
  useEffect(() => { setCheck(null); }, [conn.url, conn.version, conn.username, lookup.lookupBy, lookup.subjectSourceId, lookup.timeZone, subjectField, rootStem]);

  const body = () => ({ connection: conn, options: { subjectField, rootStem, ...lookup } });
  const running = job?.state === 'running';

  const poll = async () => {
    try {
      const s = await api('/admin/grouper/export/push/status');
      setJob(s);
      if (s?.state === 'running') timer.current = setTimeout(poll, pollMs);
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    poll();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runCheck() {
    setError('');
    setBusy(true);
    try {
      setCheck(await api('/admin/grouper/export/push/preflight', { method: 'POST', body: body() }));
    } catch (err) {
      setCheck(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setConfirm(false);
    setError('');
    try {
      setJob(await api('/admin/grouper/export/push', { method: 'POST', body: { ...body(), confirm: true } }));
      onConn((c) => ({ ...c, password: '' }));
      setCheck(null);
      clearTimeout(timer.current);
      timer.current = setTimeout(poll, pollMs);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const cancel = () => api('/admin/grouper/export/push/cancel', { method: 'POST' }).then(setJob).catch((e) => setError(errorText(e)));
  const host = (() => { try { return new URL(conn.url).host; } catch { return 'Grouper'; } })();
  const ready = conn.url && conn.username && conn.password;
  const r = job?.report;
  const pct = job?.progress?.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Create the groups in a running Grouper through its web services. It only adds: groups with the same name are updated, members are
        added and never removed, and the run can be repeated safely. The account needs permission to create groups and assign privileges.
        Composite groups cannot be pushed this way; use the bundle's script for those.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}

      <Stack direction="row" spacing={1}>
        <Button variant="outlined" disabled={!ready || busy || running} onClick={runCheck}>{busy ? 'Checking…' : 'Check connection and people'}</Button>
        <Button variant="contained" disabled={!check || running} onClick={() => setConfirm(true)}>Push to Grouper…</Button>
      </Stack>

      {check && (
        <Stack spacing={1}>
          <Alert severity={check.notFoundCount ? 'warning' : 'success'}>
            Connected. Grouper found {check.found} of {check.checked} people.
            {check.notFoundCount > 0 && ` ${check.notFoundCount} could not be found and will be left out of memberships and privileges: ${check.notFound.slice(0, 5).map((n) => n.subject).join(', ')}${check.notFoundCount > 5 ? ', …' : ''}.`}
          </Alert>
          {check.notPushed.composites > 0 && <Alert severity="info">{check.notPushed.composites} composite group{check.notPushed.composites === 1 ? '' : 's'} will not be pushed. The downloaded script creates them.</Alert>}
        </Stack>
      )}

      {job && (
        <Stack spacing={1}>
          <Typography variant="subtitle2">
            {running ? `Pushing to ${job.target}…` : `Last push (${job.state}) by ${job.actor}, ${new Date(job.started_at).toLocaleString()}`}
          </Typography>
          {running && (
            <>
              <LinearProgress variant="determinate" value={pct} />
              <Typography variant="body2">{PHASES[job.progress.phase]}: {job.progress.done} of {job.progress.total}</Typography>
              <Button size="small" color="error" onClick={cancel} sx={{ alignSelf: 'flex-start' }}>Cancel</Button>
            </>
          )}
          {!running && r?.error && <Alert severity="error">{r.error}</Alert>}
          {!running && r?.phases && (
            <Stack spacing={1}>
              {Object.entries(PHASES).map(([k, label]) => (
                <Typography key={k} variant="body2">{label}: {r.phases[k].ok} done{r.phases[k].failed ? `, ${r.phases[k].failed} failed` : ''}</Typography>
              ))}
              {job.state === 'cancelled' && <Alert severity="info">The push was cancelled. Run it again to finish; work already done is left as is.</Alert>}
              {r.failureCount > 0 && (
                <Alert severity="warning">
                  {r.failureCount} item{r.failureCount === 1 ? '' : 's'} failed. Fix the cause and push again.
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {r.failures.slice(0, 15).map((f) => <li key={`${f.phase}${f.target}${f.code}`}>{PHASES[f.phase]}: {f.target} ({f.code})</li>)}
                  </ul>
                  {r.failureCount > 15 && `…and ${r.failureCount - 15} more.`}
                </Alert>
              )}
              {r.notPushed?.composites?.length > 0 && <Alert severity="info">Not pushed (no web service for them): {r.notPushed.composites.map((c) => c.group).join(', ')}.</Alert>}
            </Stack>
          )}
        </Stack>
      )}

      <ConfirmDialog open={confirm} color="primary" title={`Write to ${host}?`} confirmLabel="Push"
        message={`This creates or updates ${check?.counts.groups ?? 0} groups, and adds ${check?.counts.memberships ?? 0} members, ${check?.counts.nested ?? 0} nested groups and ${check?.counts.privileges ?? 0} privileges in the live Grouper. It does not remove anything.`}
        onConfirm={start} onClose={() => setConfirm(false)} />
    </Stack>
  );
}
