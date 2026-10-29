import { LdapQueryButton } from '../../../components/LdapQueryBuilder.jsx';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, CardContent, Chip, FormControlLabel, MenuItem, Stack, Switch, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import ProvisioningFeed from './ProvisioningFeed.jsx';

const TYPES = [
  { value: 'ad', label: 'Active Directory' },
  { value: 'ldap', label: 'LDAP (OpenLDAP, 389 DS, …)' },
];

// Pons Identity user fields that can be filled from a directory attribute.
const FIELD_LABELS = {
  username: 'Username', first_name: 'First name', last_name: 'Last name', display_name: 'Display name', email: 'Email address',
  employee_id: 'Employee / ID number', department: 'Department', title: 'Title', phone: 'Phone', upn: 'User principal name',
  sam_account_name: 'sAMAccountName', distinguished_name: 'Distinguished name', mail_nickname: 'Mail nickname', company: 'Company',
  manager: 'Manager', office: 'Office', mobile: 'Mobile', street_address: 'Street address', city: 'City', state: 'State / province',
  postal_code: 'Postal code', country: 'Country', description: 'Description',
};

const blank = (defaults) => ({
  id: null, name: '', type: 'ad', enabled: false,
  config: { ...defaults.ad, bindPasswordSet: false },
});

export default function DirectoriesTab() {
  const notify = useNotify();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [token, setToken] = useState('');
  const [testUser, setTestUser] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [doomed, setDoomed] = useState(null); // the directory a delete confirmation is about
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const d = await api('/admin/directories');
    setData(d);
    return d;
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  const edit = (dir) => {
    setForm(structuredClone({ ...dir, config: { ...dir.config, bindPassword: '' } }));
    setToken('');
    setTestResult(null);
    setError('');
  };

  const setField = (name, value) => setForm((f) => ({ ...f, [name]: value }));
  const setConfig = (name, value) => setForm((f) => ({ ...f, config: { ...f.config, [name]: value } }));
  const setMapping = (field, value) => setForm((f) => ({ ...f, config: { ...f.config, attributeMap: { ...f.config.attributeMap, [field]: value } } }));

  function changeType(type) {
    // Only a directory that has not been saved gets the other type's suggested filter and mapping.
    if (!form.id) setForm((f) => ({ ...f, type, config: { ...data.defaults[type], url: f.config.url, bindPasswordSet: false } }));
    else setField('type', type);
  }

  const ldapOn = Boolean(form?.config.url);

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      const body = { name: form.name, type: form.type, enabled: form.enabled, config: form.config };
      const saved = await api(form.id ? `/admin/directories/${form.id}` : '/admin/directories', { method: form.id ? 'PUT' : 'POST', body });
      await load();
      edit(saved);
      notify(form.id ? 'Directory saved' : 'Directory created. Test it, then turn it on.');
    } catch (err) {
      setError(err.data?.errors?.join(' ') || err.message);
    }
  }

  async function test() {
    setTestResult(null);
    try {
      setTestResult(await api(`/admin/directories/${form.id}/test`, { method: 'POST', body: { username: testUser } }));
    } catch (err) {
      setTestResult({ ok: false, message: err.data?.errors?.join(' ') || err.message });
    }
  }

  async function makeToken() {
    setConfirm(null);
    try {
      const { token: t, ...rest } = await api(`/admin/directories/${form.id}/token`, { method: 'POST' });
      setToken(t);
      await load();
      setForm((f) => ({ ...f, tokenSet: rest.tokenSet, tokenCreatedAt: rest.tokenCreatedAt }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeToken() {
    setConfirm(null);
    try {
      const rest = await api(`/admin/directories/${form.id}/token`, { method: 'DELETE' });
      setToken('');
      await load();
      setForm((f) => ({ ...f, tokenSet: rest.tokenSet, tokenCreatedAt: rest.tokenCreatedAt }));
      notify('Token revoked');
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove() {
    setConfirm(null);
    try {
      await api(`/admin/directories/${doomed.id}`, { method: 'DELETE' });
      if (form?.id === doomed.id) setForm(null);
      setDoomed(null);
      await load();
      notify('Directory deleted');
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;

  return (
    <Stack spacing={3}>
      <PageIntro title="Directories">
        An external directory can federate sign-in (users enter their LDAP or Active Directory password here, and the account is
        created on first sign-in) and can update the identities it owns through the REST API at <code>{data.apiUrl}</code>.
      </PageIntro>
      {error && !form && <Alert severity="error">{error}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6" component="h2">Directories</Typography>
              <Button variant="contained" onClick={() => edit(blank(data.defaults))}>Add directory</Button>
            </Stack>
            {data.directories.length === 0 ? <Typography color="text.secondary">No external directories yet.</Typography> : (
              <Table size="small">
                <TableHead>
                  <TableRow><TableCell>Name</TableCell><TableCell>Type</TableCell><TableCell>Sign-in</TableCell><TableCell align="right">Users</TableCell><TableCell>Status</TableCell><TableCell /></TableRow>
                </TableHead>
                <TableBody>
                  {data.directories.map((d) => (
                    <TableRow key={d.id} hover onClick={() => edit(d)} sx={{ cursor: 'pointer' }}>
                      <TableCell>{d.name}</TableCell>
                      <TableCell>{TYPES.find((t) => t.value === d.type)?.label}</TableCell>
                      <TableCell>{d.config.url ? 'LDAP bind' : 'REST only'}</TableCell>
                      <TableCell align="right">{d.userCount}</TableCell>
                      <TableCell><Chip size="small" label={d.enabled ? 'Enabled' : 'Disabled'} color={d.enabled ? 'success' : 'default'} /></TableCell>
                      <TableCell align="right">
                        <Button size="small" color="error" aria-label={`Delete ${d.name}`}
                          onClick={(e) => { e.stopPropagation(); setDoomed(d); setConfirm('delete'); }}>Delete</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Stack>
        </CardContent>
      </Card>

      {form && (
        <Stack component="form" spacing={3} onSubmit={save} aria-label="Directory settings">
          <Typography variant="h6" component="h2">{form.id ? form.name : 'New directory'}</Typography>
          {error && <Alert severity="error">{error}</Alert>}

          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="subtitle1" component="h3">General</Typography>
                <TextField label="Name" required value={form.name} onChange={(e) => setField('name', e.target.value)} />
                <TextField select label="Directory type" value={form.type} onChange={(e) => changeType(e.target.value)}
                  helperText="Sets the suggested search filter and attribute names.">
                  {TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
                </TextField>
                <FormControlLabel label="Enabled" control={<Switch checked={form.enabled} onChange={(e) => setField('enabled', e.target.checked)} />} />
                <Typography variant="body2" color="text.secondary">
                  While disabled, its users cannot sign in and its REST token is refused.
                </Typography>
              </Stack>
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="subtitle1" component="h3">LDAP sign-in</Typography>
                <Typography variant="body2" color="text.secondary">
                  Leave the server URL empty for a directory that only pushes identities over the REST API.
                </Typography>
                <TextField label="Server URL" value={form.config.url} onChange={(e) => setConfig('url', e.target.value)}
                  placeholder="ldaps://dc.example.com:636" helperText="Use ldaps://, or ldap:// with StartTLS, so passwords are encrypted." />
                {ldapOn && (
                  <>
                    <FormControlLabel label="Use StartTLS (for ldap:// URLs)" control={<Switch checked={form.config.startTls} onChange={(e) => setConfig('startTls', e.target.checked)} />} />
                    <FormControlLabel label="Verify the server certificate" control={<Switch checked={form.config.rejectUnauthorized} onChange={(e) => setConfig('rejectUnauthorized', e.target.checked)} />} />
                    {!form.config.rejectUnauthorized && <Alert severity="warning">Without verification anyone on the network path could capture users' passwords.</Alert>}
                    <TextField label="CA certificate (PEM)" multiline minRows={3} value={form.config.caCertificate}
                      onChange={(e) => setConfig('caCertificate', e.target.value)}
                      helperText="Only needed when the server's certificate is issued by a CA this server does not already trust."
                      slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }} />
                    <TextField label="Service account DN" value={form.config.bindDn} onChange={(e) => setConfig('bindDn', e.target.value)}
                      helperText="Used to search for the user. Leave empty for anonymous search." />
                    <TextField label="Service account password" type="password" autoComplete="new-password" value={form.config.bindPassword}
                      onChange={(e) => setConfig('bindPassword', e.target.value)}
                      helperText={form.config.bindPasswordSet ? 'A password is saved. Leave blank to keep it.' : undefined} />
                    <TextField label="Search base DN" required value={form.config.baseDn} onChange={(e) => setConfig('baseDn', e.target.value)} placeholder="DC=example,DC=com" />
                    <Stack direction="row" spacing={1} alignItems="flex-start">
                      <TextField label="User search filter" required value={form.config.userFilter} onChange={(e) => setConfig('userFilter', e.target.value)} sx={{ flex: 1 }}
                        helperText="{username} is replaced by what the person types. It is escaped, so it cannot change the filter."
                        slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }} />
                      <LdapQueryButton value={form.config.userFilter} onApply={(f) => setConfig('userFilter', f)} scope="syntax" placeholders={['{username}']} title="LDAP query builder for the user search filter" />
                    </Stack>
                    <TextField label="Group membership attribute" value={form.config.groupAttribute} onChange={(e) => setConfig('groupAttribute', e.target.value)}
                      helperText="e.g. memberOf. Each value becomes a read-only group, refreshed at every sign-in. Leave empty to ignore groups." />
                    <FormControlLabel label="Create accounts at first sign-in" control={<Switch checked={form.config.autoProvision} onChange={(e) => setConfig('autoProvision', e.target.checked)} />} />
                    <TextField select label="Script access" value={form.config.scriptAccess || 'off'} onChange={(e) => setConfig('scriptAccess', e.target.value)} sx={{ maxWidth: 320 }}
                      helperText="Whether integration scripts may connect to this directory (they also need the directory:read / directory:write scope). Changing people needs the service account above and write rights in the directory.">
                      <MenuItem value="off">Not available to scripts</MenuItem>
                      <MenuItem value="read">Read only</MenuItem>
                      <MenuItem value="write">Read and write</MenuItem>
                    </TextField>
                    <TextField label="Timeout (seconds)" type="number" value={form.config.timeoutSeconds} onChange={(e) => setConfig('timeoutSeconds', Number(e.target.value))} sx={{ maxWidth: 200 }} />
                  </>
                )}
              </Stack>
            </CardContent>
          </Card>

          {ldapOn && (
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={2}>
                  <Typography variant="subtitle1" component="h3">Attribute mapping</Typography>
                  <Typography variant="body2" color="text.secondary">
                    The LDAP attribute that fills each field at sign-in. Leave a field empty to keep it as it is.
                  </Typography>
                  <Stack spacing={1.5}>
                    {Object.entries(FIELD_LABELS).map(([field, label]) => (
                      <TextField key={field} size="small" label={label} value={form.config.attributeMap[field] || ''}
                        onChange={(e) => setMapping(field, e.target.value)} required={field === 'username'} />
                    ))}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          )}

          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained">Save</Button>
            <Button onClick={() => setForm(null)}>Close</Button>
            {form.id && <Button color="error" sx={{ ml: 'auto !important' }} onClick={() => { setDoomed(form); setConfirm('delete'); }}>Delete directory</Button>}
          </Stack>
        </Stack>
      )}

      {form?.id && (
        <>
          {ldapOn && (
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={2}>
                  <Typography variant="subtitle1" component="h3">Test connection</Typography>
                  <Typography variant="body2" color="text.secondary">Tests the saved settings. Enter a username to also see what would be read for that person.</Typography>
                  <Stack direction="row" spacing={1}>
                    <TextField size="small" label="Username (optional)" value={testUser} onChange={(e) => setTestUser(e.target.value)} />
                    <Button variant="outlined" onClick={test}>Test</Button>
                  </Stack>
                  {testResult && <Alert severity={testResult.ok ? 'success' : 'error'}>{testResult.message}</Alert>}
                  {testResult?.attributes && (
                    <Typography component="pre" variant="body2" sx={{ fontFamily: 'monospace', m: 0, whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify({ attributes: testResult.attributes, groups: testResult.groups }, null, 2)}
                    </Typography>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}

          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="subtitle1" component="h3">REST API</Typography>
                <Typography variant="body2" color="text.secondary">
                  The external directory calls this API with the token as a bearer token to create, read, update and delete the users this
                  directory owns (<code>/users</code>). It cannot see or change local accounts, other directories' users, or roles.
                </Typography>
                <ReadOnlyField label="API base URL" value={data.apiUrl} />
                {token && (
                  <Alert severity="success">
                    <Stack spacing={1}>
                      <span>Copy this token now. It is not shown again.</span>
                      <ReadOnlyField label="API token" value={token} />
                    </Stack>
                  </Alert>
                )}
                <Typography variant="body2">
                  {form.tokenSet ? `A token was created ${new Date(form.tokenCreatedAt).toLocaleString()}.` : 'No token has been created.'}
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Button variant="outlined" onClick={() => (form.tokenSet ? setConfirm('rotate') : makeToken())}>{form.tokenSet ? 'Replace token' : 'Create token'}</Button>
                  {form.tokenSet && <Button color="error" onClick={() => setConfirm('revoke')}>Revoke token</Button>}
                </Stack>
              </Stack>
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1}>
                <Typography variant="subtitle1" component="h3">Status</Typography>
                <Typography variant="body2">{form.userCount} user{form.userCount === 1 ? '' : 's'} and {form.groupCount} group{form.groupCount === 1 ? '' : 's'} from this directory.</Typography>
                <Typography variant="body2" color="text.secondary">
                  {form.lastActivity.at ? `Last change: ${form.lastActivity.summary}, ${new Date(form.lastActivity.at).toLocaleString()}.` : 'Nothing has been created or changed by this directory yet.'}
                </Typography>
              </Stack>
            </CardContent>
          </Card>

          {form.id && <ProvisioningFeed key={form.id} directory={form} />}
        </>
      )}

      <ConfirmDialog open={confirm === 'rotate'} title="Replace the token?" message="The external directory stops working until it is given the new token."
        confirmLabel="Replace" onConfirm={makeToken} onClose={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'revoke'} title="Revoke the token?" message="The external directory can no longer use the REST API."
        confirmLabel="Revoke" onConfirm={revokeToken} onClose={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'delete'} title={`Delete ${doomed?.name || 'this directory'}?`}
        message="Its groups are deleted. Its users stay as ordinary accounts, but they can no longer sign in until an administrator sets a password."
        confirmLabel="Delete" onConfirm={remove} onClose={() => setConfirm(null)} />
    </Stack>
  );
}
