import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, MenuItem, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import GrouperConnection, { DEFAULT_LOOKUP, EMPTY_CONNECTION } from './GrouperConnection.jsx';
import GrouperPush from './GrouperPush.jsx';
import GrouperLoader from './GrouperLoader.jsx';
import GrouperCutover from './GrouperCutover.jsx';

// Moving the built-in groups to Grouper: download an import bundle, push over web services, let Grouper's loader
// follow a feed, then hand the groups over. The connection to Grouper is shared by the push and the cutover check.
export default function GrouperExport() {
  const can = useCan();
  const [fields, setFields] = useState({});
  const [subjectField, setSubjectField] = useState('username');
  const [rootStem, setRootStem] = useState('simpleidp');
  const [conn, setConn] = useState(EMPTY_CONNECTION);
  const [lookup, setLookup] = useState(DEFAULT_LOOKUP);
  const [tab, setTab] = useState('bundle');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/admin/grouper/export/fields').then((d) => setFields(d.subjectFields)).catch(() => {});
  }, []);

  const query = new URLSearchParams({ subjectField, rootStem }).toString();

  async function run() {
    setError('');
    try {
      setPreview(await api(`/admin/grouper/export/preview?${query}`));
    } catch (err) {
      setPreview(null);
      setError(err.data?.errors?.join(' ') || err.message);
    }
  }

  const c = preview?.counts;
  const shared = tab === 'bundle' || tab === 'push' || tab === 'cutover';
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Move groups to Grouper</Typography>
          <Typography variant="body2" color="text.secondary">
            Move this IdP's own groups to Grouper in stages: export or push them, optionally let Grouper's loader follow this IdP for a while, then hand
            the groups over. Groups that already come from Grouper or an external directory are never moved.
          </Typography>

          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto">
            <Tab value="bundle" label="Export bundle" />
            <Tab value="push" label="Push" />
            <Tab value="loader" label="Loader feed" />
            {can('groups.manage') && <Tab value="cutover" label="Cut over" />}
          </Tabs>

          {shared && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField select label="Grouper identifies people by" value={subjectField} onChange={(e) => { setSubjectField(e.target.value); setPreview(null); }}
                sx={{ minWidth: 260 }} helperText="Must match a field in Grouper's subject source.">
                {Object.entries(fields).map(([k, label]) => <MenuItem key={k} value={k}>{label}</MenuItem>)}
              </TextField>
              <TextField label="Folder for names without ':'" value={rootStem} onChange={(e) => { setRootStem(e.target.value); setPreview(null); }}
                helperText="Names such as org:dept:team become folders as written." sx={{ minWidth: 260 }} />
            </Stack>
          )}
          {(tab === 'push' || tab === 'cutover') && <GrouperConnection conn={conn} onConn={setConn} lookup={lookup} onLookup={setLookup} />}

          {tab === 'bundle' && (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                Download CSV files and a Grouper Shell script that recreate the groups, members, nested groups, composites and delegated access.
                Nothing is sent to Grouper from here.
              </Typography>
              {error && <Alert severity="error">{error}</Alert>}
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" onClick={run}>Preview</Button>
                <Button variant="contained" component="a" href={`/api/admin/grouper/export/download?${query}`} disabled={!preview}>Download bundle</Button>
              </Stack>
              {c && (
                <Stack spacing={1}>
                  <Typography variant="body2">
                    {c.groups} groups in {c.stems} folders, {c.memberships} memberships, {c.nested} nested groups, {c.composites} composites, {c.privileges} delegated privileges.
                  </Typography>
                  {preview.unresolved.length > 0 && (
                    <Alert severity="warning">
                      {c.unresolved} entr{c.unresolved === 1 ? 'y has' : 'ies have'} no {fields[subjectField]?.toLowerCase()} and will be left out:{' '}
                      {preview.unresolved.slice(0, 5).map((u) => u.username).join(', ')}{preview.unresolved.length > 5 ? ', …' : ''}.
                      The bundle lists them all in unresolved.csv.
                    </Alert>
                  )}
                  {preview.warnings.map((w) => <Alert key={w} severity="warning">{w}</Alert>)}
                  <Alert severity="info">The script has not been run against your Grouper version. Try it on a test Grouper first.</Alert>
                </Stack>
              )}
            </Stack>
          )}
          {tab === 'push' && <GrouperPush subjectField={subjectField} rootStem={rootStem} conn={conn} onConn={setConn} lookup={lookup} />}
          {tab === 'loader' && <GrouperLoader fields={fields} />}
          {tab === 'cutover' && <GrouperCutover subjectField={subjectField} rootStem={rootStem} conn={conn} lookup={lookup} />}
        </Stack>
      </CardContent>
    </Card>
  );
}
