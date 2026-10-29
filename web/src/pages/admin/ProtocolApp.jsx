import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, CardContent, Checkbox, FormControlLabel, FormGroup, MenuItem, Paper, Stack, TextField, Typography,
} from '@mui/material';
import { Link as RouterLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useNotify } from '../../components/Notify.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import ReadOnlyField from '../../components/ReadOnlyField.jsx';
import CopyTextField from '../../components/CopyTextField.jsx';
import RepeaterRows from '../../components/RepeaterRows.jsx';
import UserAccess from './sp/UserAccess.jsx';
import { GRANTS, GRANTS_FOR, OIDC_SCOPES, PROTOCOLS, toForm, toPayload } from './app/appForm.js';
import { useProductName } from '../../auth/AuthContext.jsx';

const ENDPOINT_LABELS = {
  issuer: 'Issuer', discovery: 'Discovery URL', authorization: 'Authorization endpoint', token: 'Token endpoint', userinfo: 'UserInfo endpoint',
  jwks: 'JWKS URI', introspection: 'Introspection endpoint', revocation: 'Revocation endpoint', endSession: 'End-session (logout) endpoint',
  login: 'Login URL', logout: 'Logout URL', validate: 'Validate URL (CAS 1.0)', serviceValidate: 'Service validate URL (CAS 2.0)',
  p3ServiceValidate: 'Service validate URL (CAS 3.0, with attributes)',
};

function Section({ id, title, children }) {
  return (
    <Card variant="outlined" component="section" aria-labelledby={id}>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" id={id}>{title}</Typography>
          {children}
        </Stack>
      </CardContent>
    </Card>
  );
}

// One page per CAS, OpenID Connect or OAuth 2.0 application: its name, who may use it, the details to give the
// application, how it connects, and the attributes it receives. Saved together.
export default function ProtocolApp() {
  const productName = useProductName();
  const { id } = useParams();
  const isNew = !id;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [app, setApp] = useState(null);
  const [opts, setOpts] = useState(null);
  const [preview, setPreview] = useState(null); // a new application's client ID and endpoints, known before it is saved
  const [secret, setSecret] = useState(location.state?.secret || ''); // arrives with the redirect that follows creating the app
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(() => {
    setForm(null);
    setErrors([]);
    const one = isNew
      ? api(`/admin/apps/blank?protocol=${encodeURIComponent(params.get('protocol') || '')}`).then((blank) => ({ app: null, form: toForm(blank), preview: { client_id: blank.client_id, urls: blank.urls } }))
      : api(`/admin/apps/${id}`).then((d) => ({ app: d.app, form: toForm(d.app) }));
    Promise.all([one, api('/admin/options')])
      .then(([o, options]) => { setApp(o.app); setPreview(o.preview || null); setForm(o.form); setOpts(options); })
      .catch((e) => setErrors([e.message]));
  }, [id, isNew, params]);

  useEffect(load, [load]);

  if (!form || !opts) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const { protocol } = form;
  const oauth = protocol !== 'cas';
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key, value, on) => set(key, on ? [...form[key], value] : form[key].filter((v) => v !== value));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const body = toPayload(form);
      if (isNew && preview?.client_id) body.client_id = preview.client_id;
      const d = isNew
        ? await api('/admin/apps', { method: 'POST', body })
        : await api(`/admin/apps/${id}`, { method: 'PUT', body });
      notify(isNew ? 'Application created' : 'Application saved');
      if (isNew) {
        setSecret(d.secret || '');
        navigate(`/admin/apps/${d.app.id}`, { replace: true, state: { secret: d.secret || '' } });
      } else {
        if (d.secret) setSecret(d.secret);
        setApp(d.app);
        setForm(toForm(d.app));
      }
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
      window.scrollTo?.({ top: 0 });
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    setConfirm(null);
    try {
      const d = await api(`/admin/apps/${id}/rotate-secret`, { method: 'POST' });
      setSecret(d.secret);
      setApp(d.app);
      notify('Client secret replaced');
    } catch (err) {
      setErrors([err.message]);
    }
  }

  async function remove() {
    setConfirm(null);
    try {
      await api(`/admin/apps/${id}`, { method: 'DELETE' });
      navigate('/admin/sps', { replace: true });
    } catch (err) {
      setErrors([err.message]);
    }
  }

  const clientAttrs = opts.attributes.map((a) => ({ value: a.key, label: a.label }));
  const urlLabel = protocol === 'cas' ? 'Service URL' : 'Redirect URI';

  return (
    <Stack component="form" spacing={3} onSubmit={save} noValidate>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button component={RouterLink} to="/admin/sps" size="small">← Applications</Button>
        <Typography variant="h5" component="h1">
          {isNew ? `New ${PROTOCOLS[protocol].label} application` : app?.name || form.name}
        </Typography>
      </Stack>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      {secret && (
        <Alert severity="warning" role="status">
          <Stack spacing={1}>
            <span>Copy the client secret now. It is not shown again; to get a new one you must replace it.</span>
            <ReadOnlyField label="Client secret" value={secret} />
          </Stack>
        </Alert>
      )}

      <Section id="application" title="Application">
        <CopyTextField label="Application Name" required value={form.name} onChange={(e) => set('name', e.target.value)} />
        <CopyTextField label="Application Description" multiline minRows={2} value={form.description}
          onChange={(e) => set('description', e.target.value)} helperText="For your own reference." />
      </Section>

      <UserAccess form={form} set={set} opts={opts} />

      <Section id="connection" title="Connection details">
        {(() => {
          const shown = app || preview;
          if (!shown) return null;
          return (
            <>
              {!app && <Alert severity="info">{oauth ? 'This client ID is reserved for the application and is used when you save it.' : 'These addresses are ready now.'} {oauth && form.confidential ? 'The client secret is created when you save, and shown once.' : ''}</Alert>}
              {oauth && <ReadOnlyField label="Client ID" value={shown.client_id} />}
              {Object.entries(shown.urls || {}).map(([k, v]) => <ReadOnlyField key={k} label={ENDPOINT_LABELS[k] || k} value={v} />)}
            </>
          );
        })()}
      </Section>

      {oauth && (
        <Section id="client" title="Client">
          <FormControlLabel label="Confidential client (has a client secret)" control={
            <Checkbox checked={form.confidential} onChange={(e) => set('confidential', e.target.checked)} />} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
            Choose this for a server-side application that can keep a secret. Single-page and mobile apps are public clients and always use PKCE.
          </Typography>
          {app && app.confidential && (
            <Button color="warning" sx={{ alignSelf: 'flex-start' }} onClick={() => setConfirm('rotate')}>Replace client secret</Button>
          )}
          <FormControlLabel label="Require PKCE" control={
            <Checkbox checked={form.require_pkce || !form.confidential} disabled={!form.confidential}
              onChange={(e) => set('require_pkce', e.target.checked)} />} />

          <Typography variant="subtitle1" component="h3" id="grants">Allowed grant types</Typography>
          <FormGroup aria-labelledby="grants">
            {GRANTS_FOR[protocol].map((g) => (
              <FormControlLabel key={g} label={GRANTS[g]} control={
                <Checkbox checked={form.grant_types.includes(g)} onChange={(e) => toggle('grant_types', g, e.target.checked)} />} />
            ))}
          </FormGroup>

          <Typography variant="subtitle1" component="h3" id="scopes">Scopes</Typography>
          {protocol === 'oidc' ? (
            <FormGroup aria-labelledby="scopes">
              {OIDC_SCOPES.map((s) => (
                <FormControlLabel key={s.value} label={`${s.label} — ${s.help}`} control={
                  <Checkbox checked={s.value === 'openid' || form.scopes.includes(s.value)} disabled={s.value === 'openid'}
                    onChange={(e) => toggle('scopes', s.value, e.target.checked)} />} />
              ))}
            </FormGroup>
          ) : (
            <CopyTextField label="Allowed scopes" value={form.scopes_text} onChange={(e) => set('scopes_text', e.target.value)}
              helperText="Space-separated, for example: read write. Use profile, email or groups to release those claims from UserInfo." />
          )}

          <CopyTextField label="Access token lifetime (seconds)" type="number" value={form.access_token_ttl}
            onChange={(e) => set('access_token_ttl', e.target.value)} slotProps={{ htmlInput: { min: 60, max: 86400 } }} sx={{ maxWidth: 320 }} />
        </Section>
      )}

      <Section id="urls" title={protocol === 'cas' ? 'Services' : 'Redirect URIs'}>
        <Typography variant="body2" color="text.secondary">
          {protocol === 'cas'
            ? 'Where tickets may be sent. Use an exact URL, or end it with /* to allow everything below that path on the same host, for example https://app.example.net/app/*. The * must be last and the host cannot contain one.'
            : 'The only addresses authorization codes may be returned to. They must match exactly.'}
        </Typography>
        <RepeaterRows copyable rows={form.redirect_uris} onChange={(v) => set('redirect_uris', v)} fields={[{ key: 'url', label: urlLabel }]}
          emptyRow={{ url: '' }} addLabel={`Add ${urlLabel.toLowerCase()}`} />
        {protocol === 'oidc' && (
          <>
            <Typography variant="subtitle1" component="h3">Post-logout redirect URIs</Typography>
            <RepeaterRows copyable rows={form.post_logout_uris} onChange={(v) => set('post_logout_uris', v)}
              fields={[{ key: 'url', label: 'Post-logout redirect URI' }]} emptyRow={{ url: '' }} addLabel="Add post-logout redirect URI" />
          </>
        )}
      </Section>

      <Section id="attributes" title={protocol === 'cas' ? 'User and attributes' : 'Subject and claims'}>
        <TextField select label={protocol === 'cas' ? 'User identifier' : 'Subject (sub) attribute'} value={form.subject_source}
          onChange={(e) => set('subject_source', e.target.value)}
          helperText={protocol === 'cas' ? 'Sent as the CAS user name.' : 'Identifies the person to this application. Keep it stable; the GUID never changes.'}>
          {opts.nameIdSources.map((a) => <MenuItem key={a.key} value={a.key}>{a.label}</MenuItem>)}
        </TextField>
        <Typography variant="body2" color="text.secondary">
          {protocol === 'cas'
            ? 'Attributes released to the service in CAS 3.0 validation responses.'
            : 'Extra claims released in the ID token (OpenID Connect) and from UserInfo, in addition to those the granted scopes provide.'}
        </Typography>
        <RepeaterRows copyable rows={form.maps} onChange={(v) => set('maps', v)} emptyRow={{ idp_attribute: '', claim_name: '' }}
          addLabel="Add attribute" fields={[
            { key: 'idp_attribute', label: 'IdP attribute', options: clientAttrs },
            { key: 'claim_name', label: protocol === 'cas' ? 'Attribute name' : 'Claim name' },
          ]} />
      </Section>

      <Paper variant="outlined" sx={{ position: 'sticky', bottom: 0, p: 1.5, zIndex: 1 }}>
        <Stack direction="row" spacing={1} justifyContent="space-between" flexWrap="wrap" useFlexGap>
          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained" disabled={saving}>Save</Button>
            <Button onClick={() => (isNew ? navigate('/admin/sps') : load())}>{isNew ? 'Cancel' : 'Discard changes'}</Button>
          </Stack>
          {!isNew && <Button color="error" onClick={() => setConfirm('delete')}>Delete application</Button>}
        </Stack>
      </Paper>

      <ConfirmDialog
        open={confirm === 'rotate'}
        title="Replace client secret?"
        message="The current secret stops working immediately. The application must be given the new one."
        confirmLabel="Replace"
        color="warning"
        onConfirm={rotate}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete application?"
        message={`This removes ${app?.name || 'this application'} from ${productName} and invalidates its tokens.`}
        confirmLabel="Delete"
        onConfirm={remove}
        onClose={() => setConfirm(null)}
      />
    </Stack>
  );
}
