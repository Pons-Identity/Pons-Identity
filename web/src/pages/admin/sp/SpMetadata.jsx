import { useState } from 'react';
import { Alert, Button, Card, CardContent, MenuItem, Stack, TextField, Typography } from '@mui/material';
import RepeaterRows from '../../../components/RepeaterRows.jsx';
import CopyTextField from '../../../components/CopyTextField.jsx';
import { api } from '../../../api/client.js';
import { useNotify } from '../../../components/Notify.jsx';
import { METADATA_MODES, applyMetadata, readFile } from './spForm.js';

// The service provider's side: discover it from its metadata or enter the values by hand.
export default function SpMetadata({ form, set, update }) {
  const notify = useNotify();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');

  async function importFrom(body) {
    setError('');
    setBusy(true);
    try {
      const d = await api('/admin/sps/parse-metadata', { method: 'POST', body });
      update((f) => applyMetadata(f, d));
      notify('Metadata imported. Review the values before saving.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileName(file.name);
    try {
      await importFrom({ xml: await readFile(file) });
    } catch (err) {
      setError(err.message);
    }
  }

  const cert = form.signing_cert;
  const clearCert = () => update((f) => ({ ...f, signing_cert_pem: '', signing_cert: null, signing_cert_name: '' }));

  async function uploadCert(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = (await readFile(file)).trim();
      update((f) => ({ ...f, signing_cert_pem: text, signing_cert: null, signing_cert_name: file.name }));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Card variant="outlined" component="section" aria-labelledby="sp-metadata">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" id="sp-metadata">SP Metadata</Typography>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField select label="Metadata discovery" value={form.metadata_mode} onChange={(e) => set('metadata_mode', e.target.value)}
            helperText="Fill the fields below from the service provider's metadata, or enter them yourself.">
            {METADATA_MODES.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
          </TextField>
          {form.metadata_mode === 'url' && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <CopyTextField label="Metadata XML URL" value={form.metadata_url} onChange={(e) => set('metadata_url', e.target.value)} fullWidth
                helperText="Public URL of the service provider's SAML metadata XML." />
              <Button variant="outlined" disabled={busy || !form.metadata_url} onClick={() => importFrom({ url: form.metadata_url })}
                sx={{ flexShrink: 0 }}>Fetch and apply</Button>
            </Stack>
          )}
          {form.metadata_mode === 'upload' && (
            <Stack direction="row" spacing={2} alignItems="center">
              <Button variant="outlined" component="label" disabled={busy}>
                Choose metadata XML file
                <input type="file" hidden accept=".xml,text/xml,application/xml,application/samlmetadata+xml" aria-label="Metadata XML file" onChange={upload} />
              </Button>
              {fileName && <Typography variant="body2" color="text.secondary">{fileName}</Typography>}
            </Stack>
          )}

          <CopyTextField label="Entity ID" value={form.sp_entity_id} onChange={(e) => set('sp_entity_id', e.target.value)}
            helperText="The unique identifier of the service provider." />
          <Typography variant="subtitle2" component="h3">ACS URL</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: '0 !important' }}>
            The service provider endpoint that receives and processes SAML assertions.
          </Typography>
          <RepeaterRows copyable rows={form.acs} onChange={(rows) => set('acs', rows)} emptyRow={{ url: '' }} addLabel="Add ACS URL"
            fields={[{ key: 'url', label: 'ACS URL' }]} />
          <CopyTextField label="SLO URL" value={form.slo_url} onChange={(e) => set('slo_url', e.target.value)}
            helperText="Optional. The service provider endpoint that receives and processes SAML logout requests." />
          <CopyTextField label="Service Provider Login URL" helperText="Optional. A URL provided by your service provider that will start a SAML authentication. Leave blank if unsure."
            value={form.login_url} onChange={(e) => set('login_url', e.target.value)} />
          <Stack spacing={1} alignItems="flex-start">
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Button variant="outlined" component="label">
                Upload request signing certificate
                <input type="file" hidden accept=".pem,.crt,.cer,.cert,application/x-x509-ca-cert,application/x-pem-file"
                  aria-label="Request signing certificate file" onChange={uploadCert} />
              </Button>
              {form.signing_cert_pem && <Button onClick={clearCert}>Remove</Button>}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {!form.signing_cert_pem && 'Optional. When set, every sign-in request from this service provider must be signed with this certificate; unsigned or wrongly signed requests are rejected.'}
              {form.signing_cert_pem && cert && `${cert.subject}. Expires ${cert.notAfter}. SHA-256 ${cert.sha256}. Sign-in requests must be signed.`}
              {form.signing_cert_pem && !cert && `${form.signing_cert_name || 'Certificate'} selected. Details appear after you save.`}
            </Typography>
          </Stack>
          <CopyTextField label="Default Relay State" value={form.default_relay_state} onChange={(e) => set('default_relay_state', e.target.value)}
            helperText="Optional. When set, all IdP-initated requests include this relaystate. Configure if instructed by your service provider." />
        </Stack>
      </CardContent>
    </Card>
  );
}
