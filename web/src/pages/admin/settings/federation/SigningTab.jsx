import { FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import KeyRollover from './KeyRollover.jsx';
import ReadOnlyField from '../../../../components/ReadOnlyField.jsx';
import { Choice, IdentityForm, Section } from './IdentityForm.jsx';

// How this server signs and encrypts what it sends to the federation, and the keys it uses.
export default function SigningTab({ identity, canManage }) {
  return (
    <IdentityForm identity={identity} canManage={canManage} label="Signing and encryption">
      <SigningSection identity={identity} disabled={!canManage} />
    </IdentityForm>
  );
}

function SigningSection({ identity, disabled }) {
  const { view, cfg, set, setKeys } = identity;
  return (
    <Section id="fed-signing" title="Signing and encryption">
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <Choice label="Signature algorithm" value={cfg.signatureAlgorithm} onChange={(v) => set({ signatureAlgorithm: v })} disabled={disabled}
          options={view.algorithms.signature} />
      </Stack>
      <FormControlLabel label="Encrypt assertions for service providers that publish an encryption key"
        control={<Switch checked={cfg.encryptAssertions} onChange={(e) => set({ encryptAssertions: e.target.checked })} disabled={disabled} />} />
      {cfg.encryptAssertions && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Choice label="Assertion encryption algorithm" value={cfg.encryptionAlgorithm} onChange={(v) => set({ encryptionAlgorithm: v })} disabled={disabled}
            options={view.algorithms.encryption} />
          <Choice label="Key transport algorithm" value={cfg.keyTransportAlgorithm} onChange={(v) => set({ keyTransportAlgorithm: v })} disabled={disabled}
            options={view.algorithms.keyTransport} />
        </Stack>
      )}
      <KeyRollover kind="idp" keys={view.keys} canManage={!disabled} onKeys={setKeys} />
      <ReadOnlyField label="Metadata URL" value={view.urls.metadata} />
      <ReadOnlyField label="Signed metadata URL" value={view.urls.signedMetadata} />
      <Typography variant="body2" color="text.secondary" sx={{ mt: '0 !important' }}>
        Submit the metadata to your federation's registration tool. The signed copy carries an expiry and is for consumers that fetch it directly.
      </Typography>
    </Section>
  );
}
