import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Paper, Stack, Typography, Card, CardContent } from '@mui/material';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useNotify } from '../../components/Notify.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import CopyTextField from '../../components/CopyTextField.jsx';
import UserAccess from './sp/UserAccess.jsx';
import IdpMetadata from './sp/IdpMetadata.jsx';
import SpMetadata from './sp/SpMetadata.jsx';
import ResponseAttributes from './sp/ResponseAttributes.jsx';
import Transformations from './sp/Transformations.jsx';
import { toForm, toPayload } from './sp/spForm.js';
import { useProductName } from '../../auth/AuthContext.jsx';

// One page per application: its name, the IdP metadata to hand over, the SP's settings, the SAML response
// and attribute transformations. Everything is edited here and saved together.
// Opening New creates the application straight away as a draft, so its IdP metadata exists before anything is typed.
// Edits to an application created this way are saved automatically; other applications still need Save.
export default function Sp() {
  const productName = useProductName();
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const location = useLocation();
  const notify = useNotify();
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [opts, setOpts] = useState(null);
  const [errors, setErrors] = useState([]);
  const [autosaveError, setAutosaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const creating = useRef(false);
  const savedJson = useRef('');
  const autosave = Boolean(location.state?.autosave);

  const load = useCallback(() => {
    setForm(null);
    setErrors([]);
    setAutosaveError('');
    if (isNew) {
      if (creating.current) return;
      creating.current = true;
      api('/admin/sps/blank')
        .then((blank) => api('/admin/sps', { method: 'POST', body: { ...toPayload(toForm(blank)), draft: true } }))
        .then((d) => navigate(`/admin/sps/${d.sp.id}`, { replace: true, state: { autosave: true } }))
        .catch((e) => {
          creating.current = false;
          setErrors([e.message]);
        });
      return;
    }
    Promise.all([api(`/admin/sps/${id}`), api('/admin/options')])
      .then(([d, o]) => {
        savedJson.current = JSON.stringify(toPayload(toForm(d.sp)));
        setDetail(d);
        setForm(toForm(d.sp));
        setOpts(o);
      })
      .catch((e) => setErrors([e.message]));
  }, [id, isNew, navigate]);

  useEffect(load, [load]);

  // Autosave: once an edit settles, send the whole application. Errors stay on the page and the next edit tries again.
  useEffect(() => {
    if (!autosave || !form || isNew) return undefined;
    const body = toPayload(form);
    const json = JSON.stringify(body);
    if (json === savedJson.current) return undefined;
    const timer = setTimeout(() => {
      api(`/admin/sps/${id}`, { method: 'PUT', body })
        .then((d) => {
          savedJson.current = json;
          setDetail(d);
          setAutosaveError('');
        })
        .catch((e) => setAutosaveError((e.data?.errors || [e.message]).join(' ')));
    }, 800);
    return () => clearTimeout(timer);
  }, [form, autosave, id, isNew]);

  if (!form || !opts) return errors.length ? <Alert severity="error">{errors[0]}</Alert> : null;

  const update = (fn) => setForm(fn);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      const d = await api(`/admin/sps/${id}`, { method: 'PUT', body: toPayload(form) });
      notify('Application saved');
      setDetail(d);
      setForm(toForm(d.sp));
    } catch (err) {
      setErrors(err.data?.errors || [err.message]);
      window.scrollTo?.({ top: 0 });
    } finally {
      setSaving(false);
    }
  }

  async function regenerate() {
    setConfirm(null);
    try {
      setDetail(await api(`/admin/sps/${id}/regenerate-cert`, { method: 'POST' }));
      notify('Certificate regenerated');
    } catch (err) {
      setErrors([err.message]);
    }
  }

  async function remove() {
    setConfirm(null);
    try {
      await api(`/admin/sps/${id}`, { method: 'DELETE' });
      navigate('/admin/sps', { replace: true });
    } catch (err) {
      setErrors([err.message]);
    }
  }

  return (
    <Stack component="form" spacing={3} onSubmit={save} noValidate>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button component={RouterLink} to="/admin/sps" size="small">← Applications</Button>
        <Typography variant="h5" component="h1">{detail?.sp.name || form.name}</Typography>
      </Stack>
      {errors.length > 0 && <Alert severity="error">{errors.map((m) => <div key={m}>{m}</div>)}</Alert>}
      {autosave && (autosaveError
        ? <Alert severity="warning">Not saved yet: {autosaveError}</Alert>
        : <Typography variant="caption" color="text.secondary">Changes are saved automatically.</Typography>)}

      <Card variant="outlined" component="section" aria-labelledby="application">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2" id="application">Application</Typography>
            <CopyTextField label="Application Name" required value={form.name} onChange={(e) => set('name', e.target.value)} />
            <CopyTextField label="Application Description" multiline minRows={2} value={form.description}
              onChange={(e) => set('description', e.target.value)} helperText="For your own reference. It is not used in SAML messages." />
          </Stack>
        </CardContent>
      </Card>

      <UserAccess form={form} set={set} opts={opts} />

      <IdpMetadata id={id} detail={detail} onRegenerate={() => setConfirm('cert')} />
      <SpMetadata form={form} set={set} update={update} />
      <ResponseAttributes form={form} set={set} update={update} opts={opts} onError={(m) => setErrors([m])} />
      <Transformations form={form} set={set} />

      <Paper variant="outlined" sx={{ position: 'sticky', bottom: 0, p: 1.5, zIndex: 1 }}>
        <Stack direction="row" spacing={1} justifyContent="space-between" flexWrap="wrap" useFlexGap>
          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained" disabled={saving}>Save</Button>
            <Button onClick={load}>Discard changes</Button>
          </Stack>
          <Button color="error" onClick={() => setConfirm('delete')}>Delete application</Button>
        </Stack>
      </Paper>

      <ConfirmDialog
        open={confirm === 'cert'}
        title="Regenerate certificate?"
        message="The service provider must be given the new certificate or signatures will fail."
        confirmLabel="Regenerate"
        color="warning"
        onConfirm={regenerate}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete application?"
        message={`This removes ${detail?.sp.name || 'this application'} from ${productName}.`}
        confirmLabel="Delete"
        onConfirm={remove}
        onClose={() => setConfirm(null)}
      />
    </Stack>
  );
}
