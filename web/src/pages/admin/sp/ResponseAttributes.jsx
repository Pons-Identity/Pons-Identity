import {
  Button, Card, CardContent, Checkbox, FormControlLabel, IconButton, MenuItem, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import CopyTextField from '../../../components/CopyTextField.jsx';
import MultiCombobox from '../../../components/MultiCombobox.jsx';
import { readFile } from './spForm.js';

const KINDS = [{ value: 'idp', label: 'IdP attribute' }, { value: 'static', label: 'Static value' }];

function AssertionEncryption({ form, set, update, opts, onError }) {
  const off = !form.encrypt_assertion;
  const cert = form.encryption_cert;
  const clear = () => update((f) => ({ ...f, encryption_cert_pem: '', encryption_cert: null, encryption_cert_name: '' }));

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = (await readFile(file)).trim();
      update((f) => ({ ...f, encryption_cert_pem: text, encryption_cert: null, encryption_cert_name: file.name }));
    } catch (err) {
      onError(err.message);
    }
  }

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle1" component="h3">Assertion encryption</Typography>
      <FormControlLabel label="Encrypt assertions" control={
        <Checkbox checked={form.encrypt_assertion} onChange={(e) => set('encrypt_assertion', e.target.checked)} />} />
      <Stack spacing={1} alignItems="flex-start">
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button variant="outlined" component="label" disabled={off}>
            Upload encryption certificate
            <input type="file" hidden accept=".pem,.crt,.cer,.cert,application/x-x509-ca-cert,application/x-pem-file"
              aria-label="Encryption certificate file" onChange={upload} />
          </Button>
          {form.encryption_cert_pem && <Button disabled={off} onClick={clear}>Remove</Button>}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {!form.encryption_cert_pem && "No certificate. Assertions are encrypted with the public key in the service provider's certificate (PEM or DER text)."}
          {form.encryption_cert_pem && cert && `${cert.subject}. Expires ${cert.notAfter}. SHA-256 ${cert.sha256}`}
          {form.encryption_cert_pem && !cert && `${form.encryption_cert_name || 'Certificate'} selected. Details appear after you save.`}
        </Typography>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Assertion encryption algorithm" disabled={off} fullWidth
          value={form.encryption_algorithm} onChange={(e) => set('encryption_algorithm', e.target.value)}
          helperText="Cipher that encrypts the assertion contents.">
          {Object.entries(opts.encryptionAlgorithms).map(([k, v]) => <MenuItem key={k} value={k}>{v.label}</MenuItem>)}
        </TextField>
        <TextField select label="Key transport encryption algorithm" disabled={off} fullWidth
          value={form.key_transport_algorithm} onChange={(e) => set('key_transport_algorithm', e.target.value)}
          helperText="Algorithm that wraps the assertion key with the service provider's public key.">
          {Object.entries(opts.keyTransportAlgorithms).map(([k, v]) => <MenuItem key={k} value={k}>{v.label}</MenuItem>)}
        </TextField>
      </Stack>
    </Stack>
  );
}

function AttributeMapping({ form, set, opts }) {
  const update = (i, patch) => set('attrs', form.attrs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => set('attrs', form.attrs.filter((_, j) => j !== i));

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle1" component="h3">Attribute mapping</Typography>
      <Typography variant="body2" color="text.secondary">
        Map the values of an IdP attribute to another attribute name to be included in the SAML response (e.g. Username to User.Username). Enter an IdP attribute or use a preconfigured attribute that automatically chooses the SAML response attribute based on the IdP. Specify static attributes with hard-coded values to optionally send in the SAML response (e.g. accountNumber with value of 48152547). Consult your service provider for more information.
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Attribute mapping">
          <TableHead>
            <TableRow>
              <TableCell>Source</TableCell>
              <TableCell>Value</TableCell>
              <TableCell>SAML attribute name</TableCell>
              <TableCell padding="checkbox"><span hidden>Actions</span></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {form.attrs.length === 0 && <TableRow><TableCell colSpan={4}>No attributes are sent besides the NameID.</TableCell></TableRow>}
            {form.attrs.map((row, i) => (
              <TableRow key={i}>
                <TableCell sx={{ minWidth: 150 }}>
                  <TextField select size="small" fullWidth value={row.kind} slotProps={{ htmlInput: { 'aria-label': `Source ${i + 1}` } }}
                    onChange={(e) => update(i, { kind: e.target.value, source: '' })}>
                    {KINDS.map((k) => <MenuItem key={k.value} value={k.value}>{k.label}</MenuItem>)}
                  </TextField>
                </TableCell>
                <TableCell sx={{ minWidth: 240 }}>
                  {row.kind === 'idp' ? (
                    <TextField select size="small" fullWidth value={row.source} slotProps={{ htmlInput: { 'aria-label': `IdP attribute ${i + 1}` } }}
                      onChange={(e) => update(i, { source: e.target.value })}>
                      {opts.attributes.map((a) => <MenuItem key={a.key} value={a.key}>{a.label}</MenuItem>)}
                    </TextField>
                  ) : (
                    <CopyTextField size="small" fullWidth value={row.source} copyLabel={`static value ${i + 1}`} slotProps={{ htmlInput: { 'aria-label': `Static value ${i + 1}` } }}
                      onChange={(e) => update(i, { source: e.target.value })} />
                  )}
                </TableCell>
                <TableCell sx={{ minWidth: 220 }}>
                  <CopyTextField size="small" fullWidth value={row.saml_name} copyLabel={`SAML attribute name ${i + 1}`} slotProps={{ htmlInput: { 'aria-label': `SAML attribute name ${i + 1}` } }}
                    onChange={(e) => update(i, { saml_name: e.target.value })} />
                </TableCell>
                <TableCell padding="checkbox">
                  <IconButton aria-label={`Remove attribute ${i + 1}`} onClick={() => remove(i)}><DeleteIcon /></IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Button startIcon={<AddIcon />} sx={{ alignSelf: 'flex-start' }}
        onClick={() => set('attrs', [...form.attrs, { kind: 'idp', source: '', saml_name: '' }])}>Add attribute</Button>
    </Stack>
  );
}

function RoleMappings({ form, set, opts }) {
  const update = (i, patch) => set('roleMappings', form.roleMappings.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const remove = (i) => set('roleMappings', form.roleMappings.filter((_, j) => j !== i));
  const groupOptions = opts.groups.map((g) => ({ id: String(g.id), label: g.name }));

  return (
    <Stack spacing={1.5}>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Role mapping">
          <TableHead>
            <TableRow>
              <TableCell>SP role</TableCell>
              <TableCell>IdP groups</TableCell>
              <TableCell padding="checkbox"><span hidden>Actions</span></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {form.roleMappings.length === 0 && <TableRow><TableCell colSpan={3}>No roles are sent.</TableCell></TableRow>}
            {form.roleMappings.map((row, i) => (
              <TableRow key={i}>
                <TableCell sx={{ minWidth: 200 }}>
                  <CopyTextField size="small" fullWidth value={row.role} copyLabel={`SP role ${i + 1}`} slotProps={{ htmlInput: { 'aria-label': `SP role ${i + 1}` } }}
                    onChange={(e) => update(i, { role: e.target.value })} />
                </TableCell>
                <TableCell sx={{ minWidth: 300 }}>
                  <MultiCombobox label={`IdP groups ${i + 1}`} placeholder="Search groups" options={groupOptions} value={row.groups}
                    noOptionsText="No groups yet." onChange={(groups) => update(i, { groups })} />
                </TableCell>
                <TableCell padding="checkbox">
                  <IconButton aria-label={`Remove role ${i + 1}`} onClick={() => remove(i)}><DeleteIcon /></IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Button startIcon={<AddIcon />} sx={{ alignSelf: 'flex-start' }}
        onClick={() => set('roleMappings', [...form.roleMappings, { role: '', groups: [] }])}>Add role mapping</Button>
    </Stack>
  );
}

// How the assertion is built: NameID, signing, encryption, attributes and roles.
export default function ResponseAttributes({ form, set, update, opts, onError }) {
  const nameIdFromTransform = form.transform_enabled && form.transforms.some((t) => t.nameid);

  return (
    <Card variant="outlined" component="section" aria-labelledby="saml-response">
      <CardContent>
        <Stack spacing={3}>
          <Typography variant="h6" component="h2" id="saml-response">SAML Response Attributes</Typography>

          <Stack spacing={2}>
            <Stack spacing={2}>
              <TextField select label="Name ID Format" value={form.nameid_format} onChange={(e) => set('nameid_format', e.target.value)} fullWidth
                helperText="The format that specifies how NameID is sent to the service provider.">
                {Object.entries(opts.nameIdFormats).map(([k, urn]) => (
                  <MenuItem key={k} value={k}>
                    <Stack>
                      <span>{k}</span>
                      <Typography variant="caption" color="text.secondary">{urn}</Typography>
                    </Stack>
                  </MenuItem>
                ))}
              </TextField>
              <TextField select label="Name ID Attribute" value={form.nameid_source} onChange={(e) => set('nameid_source', e.target.value)} fullWidth
                helperText={form.nameid_format === 'transient' ? 'Not used: a transient NameID is a random value.'
                  : nameIdFromTransform ? 'Not used: a transformation is set as the NameID attribute.'
                    : "NameID is a SAML attribute that identifies the user. Enter an IdP attribute or select a preconfigured attribute that automatically chooses the NameID attribute based on the IdP."}>
                {opts.nameIdSources.map((a) => <MenuItem key={a.key} value={a.key}>{a.label}</MenuItem>)}
              </TextField>
            </Stack>
            <TextField select label="Signature Algorithm" value={form.signature_algorithm} onChange={(e) => set('signature_algorithm', e.target.value)}
              helperText="Signature algorithm used for the SAML assertion and response.">
              {Object.entries(opts.signatureAlgorithms).map(([k, v]) => <MenuItem key={k} value={k}>{v.label}</MenuItem>)}
            </TextField>
            <Stack>
              <Typography variant="subtitle1" component="h3">Signing Options</Typography>
              <Typography variant="body2" color="text.secondary">
                Choose at least one option for signing the SAML response. Your service provider will use these to verify the response's authenticity.
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }}>
                <FormControlLabel label="Sign response" control={<Checkbox checked={form.sign_response} onChange={(e) => set('sign_response', e.target.checked)} />} />
                <FormControlLabel label="Sign assertion" control={<Checkbox checked={form.sign_assertion} onChange={(e) => set('sign_assertion', e.target.checked)} />} />
              </Stack>
            </Stack>
          </Stack>

          <AssertionEncryption form={form} set={set} update={update} opts={opts} onError={onError} />
          <AttributeMapping form={form} set={set} opts={opts} />

          <Stack spacing={2}>
            <Typography variant="subtitle1" component="h3">Role attributes</Typography>
            <Typography variant="body2" color="text.secondary">
              Map each role value this service provider expects to the IdP groups whose members receive it. A person in any of the groups receives the role under the attribute name below.
            </Typography>
            <CopyTextField label="Attribute name the SP expects" helperText="Optional. The SAML attribute name your service provider expects. Mapped roles are sent under this name; group names too, if you release them."
              value={form.groups_attribute} onChange={(e) => set('groups_attribute', e.target.value)} />
            <FormControlLabel label="Release Grouper groups"
              control={<Checkbox checked={form.grouper_groups} onChange={(e) => set('grouper_groups', e.target.checked)} />} />
            <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
              Sends the names of the user's Grouper groups in the group attribute set under Grouper settings. Nothing is sent while the Grouper integration is disabled.
            </Typography>
          </Stack>
          <Stack spacing={2}>
            <Typography variant="subtitle1" component="h3">Role-group mapping</Typography>
            <RoleMappings form={form} set={set} opts={opts} />
            <Typography variant="body2" color="text.secondary">
              Set roles in the service provider application to groups defined in the IdP.
            </Typography>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
