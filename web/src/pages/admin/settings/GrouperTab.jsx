import { useEffect, useState } from 'react';
import { Alert, Autocomplete, Button, Card, CardContent, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import PageIntro from './PageIntro.jsx';
import { api } from '../../../api/client.js';
import { useCan } from '../../../auth/permissions.js';
import RepeaterRows from '../../../components/RepeaterRows.jsx';
import { useNotify } from '../../../components/Notify.jsx';
import ConfirmDialog from '../../../components/ConfirmDialog.jsx';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import GrouperExport from './GrouperExport.jsx';
import { useProductName } from '../../../auth/AuthContext.jsx';

// Common names for the attribute that carries group membership; any other name can be typed.
const ATTRIBUTE_SUGGESTIONS = ['isMemberOf', 'memberOf', 'groups', 'eduPersonEntitlement', 'urn:oid:1.3.6.1.4.1.5923.1.5.1.1'];

export default function GrouperTab() {
  const productName = useProductName();
  const notify = useNotify();
  const can = useCan();
  const canRoles = can('roles.manage');
  const canExport = can('groups.view');
  const [roleOptions, setRoleOptions] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [data, setData] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [attributeName, setAttributeName] = useState('');
  const [token, setToken] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState('');

  const load = (d) => {
    setData(d);
    setEnabled(d.enabled);
    setAttributeName(d.attributeName);
    setMappings(d.roleMappings.map((m) => ({ group_name: m.group_name, role_id: String(m.role_id) })));
  };

  useEffect(() => {
    api('/admin/grouper').then(load).catch((e) => setError(e.message));
    api('/admin/options').then((o) => setRoleOptions(o.roles.map((r) => ({ value: String(r.id), label: r.name })))).catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      load(await api('/admin/grouper', { method: 'PUT', body: { enabled, attributeName, ...(canRoles && { roleMappings: mappings }) } }));
      notify('Grouper settings saved');
    } catch (err) {
      setError(err.data?.errors?.join(' ') || err.message);
    }
  }

  async function createToken() {
    setConfirm(null);
    setError('');
    try {
      const { token: t, ...rest } = await api('/admin/grouper/token', { method: 'POST' });
      setData(rest);
      setToken(t);
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeToken() {
    setConfirm(null);
    setError('');
    try {
      load(await api('/admin/grouper/token', { method: 'DELETE' }));
      setToken('');
      notify('Token revoked and the integration disabled');
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;

  return (
    <Stack spacing={3}>
      <PageIntro title="Grouper">
        Internet2 Grouper provisions groups and their members to {productName} over SCIM 2.0. Members are matched to existing
        users by username or GUID, and each service provider can release the groups in a SAML attribute.
      </PageIntro>
      {error && <Alert severity="error">{error}</Alert>}

      <Card variant="outlined">
        <CardContent>
          <Stack component="form" spacing={2} onSubmit={save}>
            <Typography variant="h6" component="h2">Settings</Typography>
            <FormControlLabel label="Accept provisioning from Grouper"
              control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!data.tokenSet} />} />
            {!data.tokenSet && <Typography variant="body2" color="text.secondary">Create a provisioning token below before enabling.</Typography>}
            <Autocomplete freeSolo options={ATTRIBUTE_SUGGESTIONS} value={attributeName}
              onChange={(_, v) => setAttributeName(v || '')} onInputChange={(_, v) => setAttributeName(v)}
              renderInput={(params) => (
                <TextField {...params} label="Group attribute name" required
                  helperText="The SAML attribute that carries a user's Grouper groups, e.g. isMemberOf, memberOf or groups." />
              )} />

            <Typography variant="subtitle1" component="h3">Role mapping</Typography>
            <Typography variant="body2" color="text.secondary">
              Members of a Grouper group get the chosen role in addition to the roles assigned in the console, and lose it when
              Grouper removes them. Use the full Grouper group name, e.g. ref:it:admins. Roles are only granted while the integration is enabled.
              {!canRoles && ' Changing mappings needs the Manage roles permission.'}
            </Typography>
            {canRoles ? (
              <RepeaterRows rows={mappings} onChange={setMappings} emptyRow={{ group_name: '', role_id: '' }} addLabel="Add role mapping"
                fields={[{ key: 'group_name', label: 'Grouper group name' }, { key: 'role_id', label: 'Role', options: roleOptions }]} />
            ) : (
              mappings.map((m) => <Typography key={`${m.group_name}${m.role_id}`} variant="body2">{m.group_name} → {roleOptions.find((o) => o.value === m.role_id)?.label}</Typography>)
            )}
            <Button type="submit" variant="contained" sx={{ alignSelf: 'flex-start' }}>Save</Button>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2">Connection</Typography>
            <Typography variant="body2" color="text.secondary">
              Point Grouper's SCIM provisioner at this URL and send the token as a bearer token.
            </Typography>
            <ReadOnlyField label="SCIM base URL" value={data.scimUrl} />

            {token && (
              <Alert severity="success">
                <Stack spacing={1}>
                  <span>Copy this token now. It is not shown again.</span>
                  <ReadOnlyField label="Provisioning token" value={token} />
                </Stack>
              </Alert>
            )}
            <Typography variant="body2">
              {data.tokenSet
                ? `A token was created ${new Date(data.tokenCreatedAt).toLocaleString()}.`
                : 'No token has been created.'}
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" onClick={() => (data.tokenSet ? setConfirm('rotate') : createToken())}>
                {data.tokenSet ? 'Replace token' : 'Create token'}
              </Button>
              {data.tokenSet && <Button color="error" onClick={() => setConfirm('revoke')}>Revoke token</Button>}
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1}>
            <Typography variant="h6" component="h2">Status</Typography>
            <Typography variant="body2">{data.groupCount} group{data.groupCount === 1 ? '' : 's'} provisioned by Grouper.</Typography>
            <Typography variant="body2" color="text.secondary">
              {data.lastActivity.at
                ? `Last change from Grouper: ${data.lastActivity.summary}, ${new Date(data.lastActivity.at).toLocaleString()}.`
                : 'Grouper has not provisioned anything yet.'}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      {canExport && <GrouperExport />}

      <ConfirmDialog open={confirm === 'rotate'} title="Replace the token?"
        message="Grouper stops working until it is given the new token."
        confirmLabel="Replace" onConfirm={createToken} onClose={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === 'revoke'} title="Revoke the token?"
        message="Grouper can no longer provision, and the integration is disabled. Existing groups and memberships stay."
        confirmLabel="Revoke" onConfirm={revokeToken} onClose={() => setConfirm(null)} />
    </Stack>
  );
}
