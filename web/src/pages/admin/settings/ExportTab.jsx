import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, Checkbox, FormControlLabel, FormGroup, MenuItem, Stack, TextField, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';

const PARTS = {
  config: ['Configuration', 'Settings, roles, policies, attribute definitions, SAML and OpenID Connect applications, directories.'],
  users: ['Users', 'Accounts with their emails, attributes, roles and group memberships (needs permission to view users).'],
  groups: ['Groups and group structure', 'Groups, folders, nesting, composite and include/exclude groups, rules and members (needs permission to view groups).'],
  integrations: ['Integrations', 'Integrations with their scripts, functions and variables (needs permission to view integrations).'],
};

// Downloads configuration, users, groups and integrations. Password hashes, second-factor secrets, private keys, client secrets, tokens and secret
// variables are never included.
export default function ExportTab() {
  const [parts, setParts] = useState(null);
  const [chosen, setChosen] = useState({ config: true, users: true, groups: true, integrations: true });
  const [format, setFormat] = useState('json');
  const [error, setError] = useState('');

  useEffect(() => { api('/admin/export').then((r) => setParts(r.parts)).catch((e) => setError(e.message)); }, []);
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!parts) return null;

  const include = parts.filter((p) => p.allowed && chosen[p.id]).map((p) => p.id);
  const href = `/api/admin/export/download?include=${include.join(',')}&format=${format}`;

  return (
    <Stack spacing={3}>
      <PageIntro title="Export">
        Download what is configured here as files you can read, keep or hand to someone else. Password hashes, second-factor secrets, private keys, client secrets, tokens
        and the values of secret variables are never included, so an export cannot be used to sign in.
      </PageIntro>
      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">What to export</Typography>
          <FormGroup>
            {parts.map((p) => (
              <FormControlLabel key={p.id} disabled={!p.allowed}
                control={<Checkbox checked={Boolean(p.allowed && chosen[p.id])} onChange={(e) => setChosen({ ...chosen, [p.id]: e.target.checked })} />}
                label={<span><b>{PARTS[p.id][0]}</b> — {PARTS[p.id][1]}{!p.allowed && ' You do not have access to this part.'}</span>} />
            ))}
          </FormGroup>
          <TextField select size="small" label="Format" value={format} onChange={(e) => setFormat(e.target.value)} sx={{ maxWidth: 360 }}
            helperText={format === 'zip' ? 'One file for each part, plus users.csv.' : 'One JSON file.'}>
            <MenuItem value="json">JSON file</MenuItem>
            <MenuItem value="zip">Zip of separate files (with users.csv)</MenuItem>
          </TextField>
          <Button variant="contained" startIcon={<DownloadIcon />} component="a" href={href} disabled={!include.length} sx={{ alignSelf: 'flex-start' }}>Download export</Button>
          <Typography variant="caption" color="text.secondary">The export is a record of what is set up, not a backup: it cannot restore passwords or second factors. Every download is recorded in the audit log.</Typography>
        </Stack>
      </CardContent></Card>
    </Stack>
  );
}
