import { useState } from 'react';
import { Button, Card, CardContent, Stack, Typography } from '@mui/material';
import ReadOnlyField from '../../../components/ReadOnlyField.jsx';
import { useCopy } from '../../../components/CopyButton.jsx';
import TextViewDialog from '../../../components/TextViewDialog.jsx';

// What to give the service provider: the IdP's endpoints, signing certificate and metadata. Read-only.
export default function IdpMetadata({ id, detail, onRegenerate }) {
  const [view, setView] = useState(null);
  const copy = useCopy();

  return (
    <Card variant="outlined" component="section" aria-labelledby="idp-metadata">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" id="idp-metadata">IdP Metadata</Typography>
          <ReadOnlyField label="Entity ID" value={detail.sp.urls.entityId} />
          <ReadOnlyField label="SSO URL" value={detail.sp.urls.sso} />
          <ReadOnlyField label="SLO URL" value={detail.sp.urls.slo} />
          <ReadOnlyField label="Metadata URL" value={detail.sp.urls.metadata} />
          <ReadOnlyField label="IdP-initiated sign-on URL" value={detail.sp.urls.idpInitiated} />

          <Typography variant="subtitle1" component="h3">Certificate Fingerprints</Typography>
          <ReadOnlyField label="SHA-1 Fingerprint" value={detail.fingerprints.sha1} />
          <ReadOnlyField label="SHA-256 Fingerprint" value={detail.fingerprints.sha256} />
          <Typography variant="body2" color="text.secondary">Certificate expires {detail.fingerprints.notAfter}.</Typography>

          <Typography variant="subtitle1" component="h3">Downloads</Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="body2" sx={{ minWidth: 120 }}>Certificate</Typography>
            <Button size="small" variant="outlined" onClick={() => setView('cert')}>View</Button>
            <Button size="small" variant="outlined" href={`/admin/sps/${id}/cert.pem`}>Download</Button>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="body2" sx={{ minWidth: 120 }}>SAML Metadata</Typography>
            <Button size="small" variant="outlined" onClick={() => setView('metadata')}>View</Button>
            <Button size="small" variant="outlined" onClick={() => copy(detail.metadata)}>Copy</Button>
          </Stack>

          <Button color="warning" onClick={onRegenerate} sx={{ alignSelf: 'flex-start' }}>Regenerate certificate</Button>

          <TextViewDialog open={view === 'cert'} title="IdP signing certificate" text={detail.sp.cert_pem} onClose={() => setView(null)} />
          <TextViewDialog open={view === 'metadata'} title="IdP SAML metadata" text={detail.metadata} onClose={() => setView(null)} />
        </Stack>
      </CardContent>
    </Card>
  );
}
